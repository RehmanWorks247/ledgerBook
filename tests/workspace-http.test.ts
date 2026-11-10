import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/app';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { config } from '../apps/api/src/config';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('workspace HTTP permissions and permanent deletion', () => {
  let database: TestDatabase, seed: TestSeed, app: NestExpressApplication, base: string;
  let admin: string, customer: string, other: string;
  before(async () => {
    database = await setupTestDatabase(); seed = await database.seed();
    app = await createApp({ database: database.db, logger: false, paymentEmails: false, reminderEmails: false });
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const auth = app.get(AuthService);
    [admin, customer, other] = await Promise.all([seed.adminId, seed.customerUserId, seed.otherAdminId]
      .map(async id => `${config.sessionCookie}=${await auth.createSession(id)}`));
  });
  after(async () => { await app?.close(); await database?.close(); });
  const request = (path: string, cookie = admin, method = 'GET', body?: unknown, csrf = true) => fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie,
      ...(csrf ? { Origin: config.appUrl, 'X-CSRF-Protection': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const input = () => ({ name: `Workspace ${randomUUID().slice(0, 8)}`, description: 'Independent business', color: '#285bb1', idempotency_key: randomUUID() });

  it('enforces login, CSRF, admin capability and tenant-scoped profile access', async () => {
    assert.equal((await request('/organizations', '', 'POST', input())).status, 401);
    assert.equal((await request('/organizations', admin, 'POST', input(), false)).status, 403);
    assert.equal((await request('/organizations', customer, 'POST', input())).status, 403);
    assert.equal((await request(`/organizations/${seed.otherOrgId}`)).status, 404);
    assert.equal((await request(`/organizations/${seed.orgId}`, customer)).status, 200);
    assert.equal((await request(`/organizations/${seed.orgId}`, customer, 'PATCH', { name: 'Unauthorized', expected_version: 1 })).status, 403);
    const adminSession = await (await request('/auth/session')).json();
    const customerSession = await (await request('/auth/session', customer)).json();
    assert.equal(adminSession.can_create_workspaces, true);
    assert.equal(customerSession.can_create_workspaces, false);
    assert.equal(adminSession.memberships.some((row: { organization_id: string }) => row.organization_id === seed.otherOrgId), false);
  });

  it('creates one workspace on retries and exposes committed customizations through session and profile', async () => {
    const body = input();
    const created = await request('/organizations', admin, 'POST', body);
    assert.equal(created.status, 201, await created.clone().text());
    const workspace = await created.json();
    const retry = await request('/organizations', admin, 'POST', body);
    assert.deepEqual(await retry.json(), workspace);
    assert.equal(workspace.currency, 'GBP');
    assert.equal(workspace.version, 1);
    assert.equal((await request(`/organizations/${workspace.id}`, other)).status, 404);
    const edited = await request(`/organizations/${workspace.id}`, admin, 'PATCH', {
      name: 'Custom travel workspace', description: 'Travel accounts', color: '#ad4764', expected_version: 1,
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.equal((await edited.json()).version, 2);
    assert.equal((await request(`/organizations/${workspace.id}`, admin, 'PATCH', { name: 'Stale edit', expected_version: 1 })).status, 409);
    assert.equal((await request(`/organizations/${workspace.id}`, admin, 'PATCH', { currency: 'USD', expected_version: 2 })).status, 400);
    const session = await (await request('/auth/session')).json();
    const member = session.memberships.find((row: { organization_id: string }) => row.organization_id === workspace.id);
    assert.equal(member.organization_name, 'Custom travel workspace');
    assert.equal(member.organization_color, '#ad4764');
    assert.equal(member.organization_description, 'Travel accounts');
    assert.equal(member.organization_version, 2);
  });

  it('requires current confirmation and erases the tenant while preserving unrelated workspaces and login identities', async () => {
    const body = input();
    const workspace = await (await request('/organizations', admin, 'POST', body)).json();
    const confirmation = { confirmation_name: workspace.name, expected_version: 1 };
    assert.equal((await request(`/organizations/${workspace.id}`, other, 'DELETE', confirmation)).status, 404);
    assert.equal((await request(`/organizations/${workspace.id}`, admin, 'DELETE', { ...confirmation, confirmation_name: 'Wrong' })).status, 400);
    assert.equal((await request(`/organizations/${workspace.id}`, admin, 'DELETE', { ...confirmation, expected_version: 2 })).status, 409);
    const deleted = await request(`/organizations/${workspace.id}`, admin, 'DELETE', confirmation);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.deepEqual(await deleted.json(), { id: workspace.id, deleted: true, files_pending: 0 });
    assert.equal((await request(`/organizations/${workspace.id}`, admin, 'DELETE', confirmation)).status, 200);
    assert.equal((await request(`/organizations/${workspace.id}`, other, 'DELETE', confirmation)).status, 404);
    assert.equal((await request(`/organizations/${workspace.id}`)).status, 404);
    assert.equal((await request(`/organizations/${workspace.id}/customers`)).status, 404);
    assert.equal((await request(`/organizations/${workspace.id}/dashboard`)).status, 404);
    assert.equal((await request('/organizations', admin, 'POST', body)).status, 409, 'An old create retry cannot resurrect a deleted workspace.');
    for (const table of ['organizations', 'memberships', 'audit_events']) {
      const column = table === 'organizations' ? 'id' : 'organization_id';
      assert.equal((await database.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [workspace.id])).rows[0].n, 0);
    }
    const session = await (await request('/auth/session')).json();
    assert.equal(session.user.id, seed.adminId);
    assert.equal(session.memberships.some((row: { organization_id: string }) => row.organization_id === workspace.id), false);
    assert.equal((await request(`/organizations/${seed.orgId}`)).status, 200);
    assert.equal((await request(`/organizations/${seed.otherOrgId}`, other)).status, 200);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 3);
  });

  it('lets the deleting administrator create a replacement after permanently deleting the last workspace', async () => {
    const workspace = await (await request(`/organizations/${seed.otherOrgId}`, other)).json();
    const deleted = await request(`/organizations/${seed.otherOrgId}`, other, 'DELETE', { confirmation_name: workspace.name, expected_version: workspace.version });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const session = await (await request('/auth/session', other)).json();
    assert.deepEqual(session.memberships, []);
    assert.equal(session.can_create_workspaces, true);
    const replacement = await request('/organizations', other, 'POST', input());
    assert.equal(replacement.status, 201, await replacement.clone().text());
    assert.equal((await (await request('/auth/session', other)).json()).memberships.length, 1);
  });
});
