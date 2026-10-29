import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { CustomersService } from '../apps/api/src/customers/customers.service';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('customer account lifecycle', () => {
  let database: TestDatabase;
  let seed: TestSeed;
  let customers: CustomersService;
  let invitations: InvitationService;
  let ledger: LedgerService;
  let deliveryFails = false;
  const mail: EmailMessage[] = [];

  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    const access = new AccessService(database.db);
    const notifications = {
      send: async (message: EmailMessage) => {
        if (deliveryFails) throw new Error('Simulated mail provider outage');
        mail.push(message);
      },
    } as NotificationsService;
    const auth = new AuthService(database.db, notifications);
    invitations = new InvitationService(database.db, access, auth, notifications);
    customers = new CustomersService(database.db, access, invitations);
    ledger = new LedgerService(database.db, access);
  });

  after(async () => { if (database) await database.close(); });

  it('retains the customer after delivery failure and retries without duplicating the account', async () => {
    const input = { name: 'Failed Delivery', email: 'delivery@example.test', notes: 'Private risk note', idempotency_key: randomUUID() };
    deliveryFails = true;
    const created = await customers.create(seed.admin, input);
    assert.equal(created.delivery_status, 'failed');
    assert.equal(created.balance_minor, '0');
    const replay = await customers.create(seed.admin, input);
    assert.equal(replay.id, created.id);
    const count = await database.db.query('SELECT count(*)::integer AS count FROM customers WHERE organization_id=$1 AND email=$2', [seed.orgId, input.email]);
    assert.equal(count.rows[0].count, 1);
    deliveryFails = false;
    const resent = await invitations.invite(seed.admin, created.id);
    assert.equal(resent.delivery_status, 'sent');
    const history = await database.db.query('SELECT revoked_at,delivery_status FROM invitations WHERE customer_id=$1 ORDER BY created_at,id', [created.id]);
    assert.equal(history.rows.length, 2);
    assert.ok(history.rows[0].revoked_at);
    assert.equal(history.rows[1].delivery_status, 'sent');
    await assert.rejects(customers.create(seed.admin, { ...input, name: 'Changed request' }), /submission key/i);
  });

  it('prevents conflicting email associations while allowing the same customer email in another organization', async () => {
    await assert.rejects(customers.create(seed.admin, { name: 'Duplicate customer', email: 'CUSTOMER@example.test', idempotency_key: randomUUID() }), /already associated/i);
    await assert.rejects(customers.create(seed.admin, { name: 'Admin alias', email: 'admin@example.test', idempotency_key: randomUUID() }), /already associated/i);
    const created = await customers.create(seed.otherAdmin, { name: 'Shared Login', email: 'customer@example.test', idempotency_key: randomUUID() });
    assert.equal(created.organization_id, seed.otherOrgId);
    assert.equal(created.email, 'customer@example.test');
    const users = await database.db.query('SELECT count(*)::integer AS count FROM users WHERE email=$1', ['customer@example.test']);
    assert.equal(users.rows[0].count, 1);
  });

  it('serializes concurrent account creation and creates one invitation for an idempotent submission', async () => {
    const beforeMail = mail.length;
    const input = { name: 'Concurrent Customer', email: 'concurrent@example.test', idempotency_key: randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => customers.create(seed.admin, input)));
    assert.equal(new Set(results.map((item) => item.id)).size, 1);
    const count = await database.db.query('SELECT count(*)::integer AS count FROM invitations WHERE customer_id=$1', [results[0].id]);
    assert.equal(count.rows[0].count, 1);
    assert.equal(mail.length - beforeMail, 1);
  });

  it('protects private fields and rejects customer administration and cross-tenant reads', async () => {
    await database.db.query('UPDATE customers SET notes=$1 WHERE id=$2', ['For administrators only', seed.customerId]);
    const own = await customers.get(seed.customerMember, seed.customerId);
    assert.equal(own.email, 'customer@example.test');
    for (const privateField of ['notes', 'created_by', 'request_hash', 'idempotency_key', 'invitation_status', 'delivery_status']) {
      assert.equal(privateField in own, false, privateField);
    }
    await assert.rejects(customers.get(seed.customerMember, seed.secondCustomerId), /not found/i);
    await assert.rejects(customers.get(seed.admin, seed.otherCustomerId), /not found/i);
    await assert.rejects(customers.list(seed.customerMember, {}), /administrator/i);
    await assert.rejects(customers.create(seed.customerMember, { name: 'Not allowed', email: 'forbidden@example.test', idempotency_key: randomUUID() }), /administrator/i);
  });

  it('paginates searches and rejects malformed list filters', async () => {
    const result = await customers.list(seed.admin, { search: 'Concurrent', page: 1, page_size: 1 });
    assert.equal(result.items.length, 1);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].name, 'Concurrent Customer');
    const foreign = await customers.list(seed.admin, { search: 'Cedar' });
    assert.equal(foreign.total, 0);
    const literalWildcard = await customers.list(seed.admin, { search: '%' });
    assert.equal(literalWildcard.total, 0);
    await assert.rejects(customers.list(seed.admin, { page_size: 1000 }));
    await assert.rejects(customers.list(seed.admin, { search: ['one', 'two'] }));
  });

  it('archives without erasing financial history and records profile/access audits', async () => {
    await ledger.post(seed.admin, seed.customerId, {
      kind: 'charge', amount: '42.50', effective_date: '2026-02-01', description: 'Preserved charge', idempotency_key: randomUUID(),
    });
    const archived = await customers.update(seed.admin, seed.customerId, {
      name: 'Aster Studio Updated', email: 'customer@example.test', phone: '555-0101', notes: 'Updated internal note', status: 'archived',
    });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.balance_minor, '4250');
    const statement = await ledger.statement(seed.customerMember, seed.customerId);
    assert.equal(statement.current_balance_minor, '4250');
    await assert.rejects(ledger.post(seed.admin, seed.customerId, {
      kind: 'payment', amount: '2.00', effective_date: '2026-02-02', description: 'Blocked payment', idempotency_key: randomUUID(),
    }), /archived/i);
    await assert.rejects(customers.update(seed.admin, seed.customerId, {
      name: 'Changed Identity', email: 'new-owner@example.test', status: 'archived',
    }), /cannot be changed/i);
    await invitations.revokeAccess(seed.admin, seed.customerId);
    await assert.rejects(customers.get(seed.customerMember, seed.customerId), /access is unavailable/i);
    const stored = await database.db.query('SELECT amount_minor FROM ledger_entries WHERE customer_id=$1', [seed.customerId]);
    assert.equal(stored.rows[0].amount_minor, '4250');
    const audit = await database.db.query('SELECT action FROM audit_events WHERE organization_id=$1 AND object_id=$2', [seed.orgId, seed.customerId]);
    assert.ok(audit.rows.some((row) => row.action === 'customer.updated'));
    assert.ok(audit.rows.some((row) => row.action === 'customer.access_revoked'));
  });
});
