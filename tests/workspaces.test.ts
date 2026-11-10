import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('workspace profiles and administration', () => {
  let database: TestDatabase;
  let seed: TestSeed;
  let organizations: OrganizationsService;
  let access: AccessService;
  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    access = new AccessService(database.db);
    organizations = new OrganizationsService(database.db, access);
  });
  after(async () => { if (database) await database.close(); });
  const input = (name = 'Custom workspace') => ({ name, idempotency_key: randomUUID() });

  it('creates an isolated GBP workspace with normalized customization, administrator membership and audit atomically', async () => {
    const request = { ...input('  London Office  '), description: '  Corporate accounts  ', color: '#AA33BB' };
    const created = await organizations.create(seed.adminId, request);
    assert.equal(created.name, 'London Office');
    assert.equal(created.description, 'Corporate accounts');
    assert.equal(created.color, '#aa33bb');
    assert.equal(created.currency, 'GBP');
    assert.equal(created.currency_exponent, 2);
    assert.equal(created.version, 1);
    assert.equal((await access.membership(seed.adminId, created.id, true)).role, 'admin');
    assert.deepEqual(await organizations.get(seed.adminId, created.id), created);
    const audit = (await database.db.query("SELECT actor_id,metadata FROM audit_events WHERE organization_id=$1 AND action='workspace.created'", [created.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, seed.adminId);
    assert.equal(audit[0].metadata.profile.name, created.name);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM customers WHERE organization_id=$1', [created.id])).rows[0].n, 0);
    assert.equal('idempotency_key' in created, false);
    assert.equal('request_hash' in created, false);
    assert.equal('deleted_at' in created, false);
  });

  it('scopes idempotency to the actor and replays a stable result despite later edits', async () => {
    const request = input('Retry workspace');
    const results = await Promise.all(Array.from({ length: 5 }, () => organizations.create(seed.adminId, request)));
    for (const result of results) assert.deepEqual(result, results[0]);
    const created = results[0];
    await organizations.update(seed.adminId, created.id, { name: 'Renamed later', expected_version: 1 });
    assert.deepEqual(await organizations.create(seed.adminId, request), created);
    await assert.rejects(organizations.create(seed.adminId, { ...request, color: '#ffffff' }), /submission key/i);
    const other = await organizations.create(seed.otherAdminId, request);
    assert.notEqual(other.id, created.id);
    await assert.rejects(organizations.get(seed.adminId, other.id), /access is unavailable/i);
    const count = await database.db.query('SELECT count(*)::int AS n FROM workspace_create_requests WHERE actor_id=$1 AND idempotency_key=$2', [seed.adminId, request.idempotency_key]);
    assert.equal(count.rows[0].n, 1);
  });

  it('allows members to read their profile and rejects customer administration and foreign tenant access', async () => {
    assert.equal((await organizations.get(seed.customerUserId, seed.orgId)).name, 'North Trading');
    await assert.rejects(organizations.create(seed.customerUserId, input()), /administrator/i);
    await assert.rejects(organizations.update(seed.customerUserId, seed.orgId, { name: 'Forbidden', expected_version: 1 }), /administrator/i);
    await assert.rejects(organizations.get(seed.otherAdminId, seed.orgId), /access is unavailable/i);
    await assert.rejects(organizations.update(seed.otherAdminId, seed.orgId, { name: 'Foreign', expected_version: 1 }), /access is unavailable/i);
    await assert.rejects(organizations.create(randomUUID(), input()), /administrator/i);
  });

  it('does not give disabled or deleted administrators workspace creation capability', async () => {
    const userId = randomUUID();
    const membershipId = randomUUID();
    await database.db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test')", [userId, `disabled-${userId}@example.test`]);
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role,is_active) VALUES($1,$2,$3,'admin',false)", [membershipId, seed.orgId, userId]);
    await assert.rejects(organizations.create(userId, input()), /administrator/i);
    await database.db.query('UPDATE memberships SET deleted_at=now() WHERE id=$1', [membershipId]);
    await assert.rejects(organizations.create(userId, input()), /administrator/i);
  });

  it('allows an explicitly retained creator to start fresh without an old membership', async () => {
    const userId = randomUUID();
    await database.db.query("INSERT INTO users(id,email,password_hash,workspace_creator) VALUES($1,$2,'test',true)", [userId, `creator-${userId}@example.test`]);
    const created = await organizations.create(userId, input('Fresh workspace'));
    assert.equal((await access.membership(userId, created.id, true)).role, 'admin');
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1', [userId])).rows[0].n, 1);
  });

  it('updates only submitted fields, preserves currency, and resolves stale concurrent edits with a conflict', async () => {
    const created = await organizations.create(seed.adminId, { ...input(), description: 'Keep this description', color: '#123456' });
    const changed = await organizations.update(seed.adminId, created.id, { name: 'New name', expected_version: 1 });
    assert.equal(changed.name, 'New name');
    assert.equal(changed.description, created.description);
    assert.equal(changed.color, created.color);
    assert.equal(changed.currency, created.currency);
    assert.equal(changed.version, 2);
    const noChange = await organizations.update(seed.adminId, created.id, { name: 'New name', expected_version: 2 });
    assert.equal(noChange.version, 2);
    const edits = await Promise.allSettled([
      organizations.update(seed.adminId, created.id, { description: 'First edit', expected_version: 2 }),
      organizations.update(seed.adminId, created.id, { color: '#010203', expected_version: 2 }),
    ]);
    assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
    const failure = edits.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(failure.reason), /another session/i);
    const audits = (await database.db.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='workspace.updated' ORDER BY id", [created.id])).rows;
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[0].metadata.changed_fields, ['name']);
    assert.deepEqual(audits[0].metadata.before, { name: created.name });
    assert.deepEqual(audits[0].metadata.after, { name: 'New name' });
  });

  it('strictly validates customization and refuses accounting currency or arbitrary fields', async () => {
    const invalid = [
      { name: ' ' }, { name: 'x'.repeat(161) }, { name: 'two\nlines' }, { name: 'null\0character' },
      { description: 'x'.repeat(1001) }, { description: null }, { color: 'red' }, { color: '#fff' },
      { currency: 'USD' }, { currency_exponent: 0 }, { contact_email: 'unused@example.test' }, { extra: 'unknown' },
    ];
    for (const change of invalid) await assert.rejects(organizations.create(seed.adminId, { ...input(), ...change }));
    await assert.rejects(organizations.create(seed.adminId, { name: 'Missing idempotency' }));
    await assert.rejects(organizations.create(seed.adminId, { ...input(), idempotency_key: 'not-a-uuid' }));
    for (const change of [{}, { expected_version: '1' }, { expected_version: 0 }, { expected_version: 1.5 }, { currency: 'EUR', expected_version: 1 }]) {
      await assert.rejects(organizations.update(seed.adminId, seed.orgId, change));
    }
    const defaults = await organizations.create(seed.adminId, input('Default profile'));
    assert.equal(defaults.description, '');
    assert.equal(defaults.color, '#13795b');
    await assert.rejects(organizations.remove(seed.adminId, defaults.id, {
      confirmation_name: ` ${defaults.name} `, expected_version: 1,
    }), /exact workspace name/i);
    assert.equal((await organizations.get(seed.adminId, defaults.id)).id, defaults.id);
  });

  it('rolls back workspace creation, membership, request receipt and profile edits when audit persistence fails', async () => {
    const original = await organizations.create(seed.adminId, input('Audit rollback'));
    const request = input('Must roll back');
    await database.db.query(`CREATE FUNCTION reject_workspace_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action IN ('workspace.created','workspace.updated') THEN RAISE EXCEPTION 'simulated workspace audit failure'; END IF;
      RETURN NEW; END; $$;`);
    await database.db.query('CREATE TRIGGER reject_workspace_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_workspace_audit()');
    const membershipsBefore = (await database.db.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1', [seed.adminId])).rows[0].n;
    try {
      await assert.rejects(organizations.create(seed.adminId, request), /simulated workspace audit failure/);
      await assert.rejects(organizations.update(seed.adminId, original.id, { name: 'Must roll back edit', expected_version: 1 }), /simulated workspace audit failure/);
    } finally {
      await database.db.query('DROP TRIGGER reject_workspace_audit ON audit_events');
      await database.db.query('DROP FUNCTION reject_workspace_audit()');
    }
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1', [seed.adminId])).rows[0].n, membershipsBefore);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM workspace_create_requests WHERE actor_id=$1 AND idempotency_key=$2', [seed.adminId, request.idempotency_key])).rows[0].n, 0);
    assert.equal((await database.db.query('SELECT count(*)::int AS n FROM organizations WHERE name=$1', [request.name])).rows[0].n, 0);
    assert.deepEqual(await organizations.get(seed.adminId, original.id), original);
    assert.equal((await organizations.create(seed.adminId, request)).name, request.name);
  });
});
