import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DocumentVersionsService } from '../apps/api/src/bookings/document-versions.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { EmailDeliveryService } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('permanent workspace purge and tenant boundary', () => {
  let database: TestDatabase, seed: TestSeed, access: AccessService, ledger: LedgerService;
  const digest = 'a'.repeat(64);
  beforeEach(async () => {
    database = await setupTestDatabase(); seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    access = new AccessService(database.db); seed.admin = await access.membership(seed.adminId, seed.orgId);
    ledger = new LedgerService(database.db, access);
  });
  afterEach(async () => { await database?.close(); });

  async function purge(actor = seed.adminId, name = 'North Trading', version = 1, hash = digest) {
    return (await database.db.query('SELECT permanently_delete_workspace($1,$2,$3,$4,$5) AS result',
      [actor, seed.orgId, name, version, hash])).rows[0].result;
  }
  async function charge(customerId = seed.customerId, admin = seed.admin) {
    return ledger.post(admin, customerId, { kind: 'charge', amount: '10', effective_date: businessDate(), description: 'Purge fixture', idempotency_key: randomUUID() });
  }

  async function populate() {
    const today = businessDate(new Date(), 'UTC'), bookings = new BookingsService(database.db, access);
    const booking = await bookings.create(seed.admin, seed.customerId, {
      reference: 'PURGE-ALL', departure_at: '2030-01-01T12:00:00Z', required_services: ['makkah'], amount: '100',
      effective_date: today, instalments: [{ due_date: today, amount: '100' }], idempotency_key: randomUUID(),
    });
    const folder = (await bookings.files(seed.admin, seed.customerId, booking.id)).items.find(node => node.serviceKey === 'makkah')!.id;
    const local = await bookings.upload(seed.admin, seed.customerId, booking.id, folder, 'local.txt', randomUUID(), Buffer.from('Local private document'));
    await new DocumentVersionsService(database.db, access).proxy(seed.admin, seed.customerId, booking.id, local.id,
      folder, 'local.txt', randomUUID(), 1, Buffer.from('Revised private document'));
    const cloudIds = [randomUUID(), randomUUID(), randomUUID()], cloudNode = randomUUID();
    for (const [index, id] of cloudIds.entries()) {
      await database.db.query(`INSERT INTO document_objects(id,organization_id,customer_id,booking_id,bucket,object_key,checksum,size,state)
        VALUES($1,$2,$3,$4,'test-bucket',$5,$6,12,$7)`,
      [id, seed.orgId, seed.customerId, booking.id, `workspace/${id}`, 'b'.repeat(64), index === 2 ? 'pending' : 'ready']);
    }
    await database.db.query(`INSERT INTO booking_nodes(id,organization_id,customer_id,booking_id,parent_id,kind,name,service_key,
      storage_object_id,size,created_by,idempotency_key,request_hash,mime_type,content_version)
      VALUES($1,$2,$3,$4,$5,'file','cloud.txt','makkah',$6,12,$7,$8,$9,'text/plain',2)`,
    [cloudNode, seed.orgId, seed.customerId, booking.id, folder, cloudIds[0], seed.adminId, randomUUID(), 'c'.repeat(64)]);
    await database.db.query(`INSERT INTO document_versions(document_id,version,name,mime_type,size,storage_object_id,created_at)
      VALUES($1,1,'cloud.txt','text/plain',12,$2,now())`, [cloudNode, cloudIds[1]]);
    await database.db.query(`INSERT INTO document_uploads(id,organization_id,customer_id,booking_id,folder_id,created_by,filename,idempotency_key,request_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'pending.txt',$7,$8,now()+interval '10 minutes')`,
    [cloudIds[2], seed.orgId, seed.customerId, booking.id, folder, seed.adminId, randomUUID(), 'd'.repeat(64)]);
    await database.db.query(`INSERT INTO document_version_uploads(id,document_id,organization_id,created_by,idempotency_key,filename,size,checksum,expected_version,storage_object_id,expires_at)
      VALUES($1,$2,$3,$4,$5,'cloud.txt',12,$6,2,$7,now()+interval '10 minutes')`,
    [randomUUID(), cloudNode, seed.orgId, seed.adminId, randomUUID(), 'b'.repeat(64), cloudIds[2]]);
    const payments = new PaymentsService(database.db, access);
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#249a67' } }).png().toBuffer();
    const payment = await payments.submit(seed.customerMember, seed.customerId, booking.id,
      { amount: '25', payment_date: today, idempotency_key: randomUUID(), note: 'Private receipt' },
      [{ originalname: 'receipt.png', mimetype: 'image/png', buffer: bytes, size: bytes.length }]);
    await payments.approve(seed.admin, seed.customerId, booking.id, payment.id);
    const extra = await charge();
    await ledger.post(seed.admin, seed.customerId, { kind: 'reversal', reversal_of: extra.id,
      effective_date: today, description: 'Reverse fixture', idempotency_key: randomUUID() });
    const mail = new NotificationsService(); mail.send = async () => undefined;
    await new InvitationService(database.db, access, new AuthService(database.db, mail), mail).invite(seed.admin, seed.secondCustomerId);
    const reminders = new ReminderService(database.db, access, mail, new EmailDeliveryService(database.db), false);
    await reminders.updateSettings(seed.admin, { enabled: true, due_soon_days: 3, repeat_days: 7, send_hour: 0, time_zone: 'UTC' });
    assert.equal(await reminders.schedule(new Date(`${today}T18:00:00Z`)), 1);
    await reminders.preference(seed.admin, seed.customerId, { enabled: true });
    await database.db.query("UPDATE payment_email_outbox SET provider_message_id='own-provider' WHERE organization_id=$1", [seed.orgId]);
    await database.db.query(`INSERT INTO email_delivery_events(event_id,provider_message_id,status,occurred_at)
      VALUES('own-event','own-provider','delivered',now()),('other-event','other-provider','delivered',now())`);
    await database.db.query(`INSERT INTO email_suppressions(organization_id,recipient_hash,reason) VALUES($1,$2,'bounced')`, [seed.orgId, 'e'.repeat(64)]);
    await database.db.query(`INSERT INTO exchange_rate_overrides(organization_id,currency,rate,updated_by) VALUES($1,'EUR',1.2,$2)`, [seed.orgId, seed.adminId]);
    await database.db.query(`INSERT INTO booking_operations(organization_id,customer_id,booking_id,idempotency_key,request_hash,action,result)
      VALUES($1,$2,$3,$4,$5,'updated','{}')`, [seed.orgId, seed.customerId, booking.id, randomUUID(), 'f'.repeat(64)]);
    await database.db.query(`INSERT INTO workspace_create_requests(actor_id,idempotency_key,organization_id,request_hash,response)
      VALUES($1,$2,$3,$4,$5)`, [seed.adminId, randomUUID(), seed.orgId, '1'.repeat(64), { name: 'North Trading', description: 'Private business profile' }]);
    return { cloudIds };
  }

  it('purges financial records, documents, pending uploads, notifications and profiles while preserving other tenants and shared identities', async () => {
    const { cloudIds } = await populate(), other = await charge(seed.otherCustomerId, seed.otherAdmin);
    await database.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')", [randomUUID(), seed.otherOrgId, seed.adminId]);
    const session = await new AuthService(database.db, new NotificationsService()).createSession(seed.adminId);
    const beforeUsers = (await database.db.query('SELECT id,email FROM users ORDER BY id')).rows;
    assert.deepEqual(await purge(), { id: seed.orgId, deleted: true, files_pending: 3 });
    for (const table of ['customers', 'memberships', 'invitations', 'ledger_entries', 'audit_events', 'bookings', 'booking_nodes',
      'booking_instalments', 'booking_operations', 'booking_payments', 'booking_payment_receipts', 'document_objects', 'document_uploads',
      'document_version_uploads', 'payment_email_outbox', 'reminder_email_outbox', 'reminder_settings', 'customer_reminder_preferences',
      'email_suppressions', 'exchange_rate_overrides']) {
      assert.equal((await database.db.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [seed.orgId])).rowCount, 0, table);
    }
    const tenantTables = await database.db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND column_name='organization_id' AND table_name<>'workspace_delete_receipts'`);
    for (const { table_name: table } of tenantTables.rows) {
      assert.match(table, /^[a-z_]+$/);
      assert.equal((await database.db.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [seed.orgId])).rowCount, 0, `Schema inventory: ${table}`);
    }
    assert.equal((await database.db.query('SELECT id FROM organizations WHERE id=$1', [seed.orgId])).rowCount, 0);
    assert.equal((await database.db.query('SELECT 1 FROM document_versions')).rowCount, 0);
    assert.deepEqual((await database.db.query('SELECT id FROM document_purge_outbox ORDER BY id')).rows.map(row => row.id), cloudIds.sort());
    assert.deepEqual((await database.db.query('SELECT event_id FROM email_delivery_events')).rows, [{ event_id: 'other-event' }]);
    assert.deepEqual((await database.db.query('SELECT organization_id,response FROM workspace_create_requests')).rows, [{ organization_id: null, response: null }]);
    assert.equal((await database.db.query('SELECT workspace_creator FROM users WHERE id=$1', [seed.adminId])).rows[0].workspace_creator, true);
    assert.deepEqual((await database.db.query('SELECT id,email FROM users ORDER BY id')).rows, beforeUsers);
    assert.equal((await new AuthService(database.db, new NotificationsService()).authenticate(session))?.id, seed.adminId);
    assert.equal((await access.membership(seed.adminId, seed.otherOrgId)).role, 'admin');
    assert.equal((await ledger.statement(seed.otherAdmin, seed.otherCustomerId)).entries[0].id, other.id);
    assert.equal((await database.db.query('SELECT 1 FROM account_purge_context')).rowCount, 0);
    assert.deepEqual(await purge(), { id: seed.orgId, deleted: true, files_pending: 3 });
    await assert.rejects(purge(seed.otherAdminId), /not found/);
    await assert.rejects(purge(seed.adminId, 'North Trading', 1, 'b'.repeat(64)), /not found/);
  });

  it('enforces current administrator access, exact name, revision and immutable history outside the purge', async () => {
    const entry = await charge();
    await assert.rejects(purge(seed.customerUserId), /administrator/);
    await assert.rejects(purge(seed.otherAdminId), /administrator/);
    await assert.rejects(purge(seed.adminId, 'north trading'), /confirmation name/);
    await assert.rejects(purge(seed.adminId, 'North Trading', 2), /changed in another session/);
    await assert.rejects(purge(seed.adminId, 'North Trading', 1, 'invalid'), /digest/);
    await database.db.query("SELECT set_config('ledger.workspace_delete','true',false)");
    await assert.rejects(database.db.query('DELETE FROM ledger_entries WHERE id=$1', [entry.id]), /cannot be edited or deleted/);
    await database.db.query('UPDATE memberships SET is_active=false WHERE id=$1', [seed.admin.id]);
    await assert.rejects(purge(), /administrator/);
    assert.equal((await database.db.query('SELECT 1 FROM workspace_delete_receipts')).rowCount, 0);
    assert.equal((await database.db.query('SELECT 1 FROM account_purge_context')).rowCount, 0);
  });

  it('cannot delete another tenant through a trigger running inside authorized workspace purge', async () => {
    await charge(); const other = await charge(seed.otherCustomerId, seed.otherAdmin);
    await database.db.query(`CREATE FUNCTION attempt_cross_workspace_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      DELETE FROM ledger_entries WHERE id=${other.id}; RETURN OLD; END $$`);
    await database.db.query(`CREATE TRIGGER zz_attempt_cross_workspace_purge BEFORE DELETE ON ledger_entries FOR EACH ROW
      WHEN (OLD.organization_id='${seed.orgId}'::uuid) EXECUTE FUNCTION attempt_cross_workspace_purge()`);
    try { await assert.rejects(purge(), /cannot be edited or deleted/); }
    finally { await database.db.query('DROP TRIGGER zz_attempt_cross_workspace_purge ON ledger_entries'); }
    assert.equal((await database.db.query('SELECT 1 FROM account_purge_context')).rowCount, 0);
    assert.equal((await database.db.query('SELECT 1 FROM organizations')).rowCount, 2);
    assert.equal((await database.db.query('SELECT workspace_creator FROM users WHERE id=$1', [seed.adminId])).rows[0].workspace_creator, false);
    assert.equal((await ledger.statement(seed.otherAdmin, seed.otherCustomerId)).entries[0].id, other.id);
    await purge();
    await assert.rejects(database.db.query('DELETE FROM ledger_entries WHERE id=$1', [other.id]), /cannot be edited or deleted/);
  });

  it('rolls back all erased records, cleanup journals and capabilities when final deletion fails', async () => {
    await populate();
    await database.db.query(`CREATE FUNCTION reject_workspace_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated delete failure'; END $$`);
    await database.db.query('CREATE TRIGGER reject_workspace_purge BEFORE DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION reject_workspace_purge()');
    try { await assert.rejects(purge(), /simulated delete failure/); }
    finally { await database.db.query('DROP TRIGGER reject_workspace_purge ON organizations'); }
    assert.equal((await database.db.query('SELECT 1 FROM document_objects WHERE organization_id=$1', [seed.orgId])).rowCount, 3);
    assert.equal((await database.db.query('SELECT 1 FROM booking_payment_receipts WHERE organization_id=$1', [seed.orgId])).rowCount, 1);
    assert.equal((await database.db.query('SELECT 1 FROM document_purge_outbox')).rowCount, 0);
    assert.equal((await database.db.query('SELECT 1 FROM workspace_delete_receipts')).rowCount, 0);
    assert.equal((await database.db.query('SELECT 1 FROM account_purge_context')).rowCount, 0);
    assert.equal((await database.db.query('SELECT workspace_creator FROM users WHERE id=$1', [seed.adminId])).rows[0].workspace_creator, false);
    assert.notEqual((await database.db.query('SELECT response FROM workspace_create_requests')).rows[0].response, null);
    assert.deepEqual(await purge(), { id: seed.orgId, deleted: true, files_pending: 3 });
  });

  it('runs the checked purge as a nonowner runtime role without exposing the private bypass', { skip: !process.env.TEST_DATABASE_URL }, async () => {
    await populate();
    const schema = (await database.db.query('SELECT current_schema() AS name')).rows[0].name as string;
    const role = `workspace_runtime_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^test_[a-f0-9]+$/);
    await database.db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    const runtime = <T>(work: (client: PoolClient) => Promise<T>) => database.db.transaction(async client => {
      await client.query(`SET LOCAL ROLE "${role}"`);
      return work(client);
    });
    try {
      await database.db.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await database.db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      await database.db.query(`REVOKE ALL ON TABLE "${schema}".account_purge_context FROM "${role}"`);
      await database.db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
      await database.db.query(`GRANT EXECUTE ON FUNCTION "${schema}".permanently_delete_workspace(uuid,uuid,text,integer,text) TO "${role}"`);
      await assert.rejects(runtime(client => client.query('SELECT * FROM account_purge_context')), /permission denied/);
      await assert.rejects(runtime(client => client.query(`INSERT INTO account_purge_context(backend_pid,transaction_id,organization_id,workspace_delete)
        VALUES(pg_backend_pid(),txid_current(),$1,true)`, [seed.orgId])), /permission denied/);
      await assert.rejects(runtime(client => client.query("SELECT account_purge_allows('ledger_entries','DELETE','{}',NULL)")), /permission denied/);
      await assert.rejects(runtime(client => client.query('DELETE FROM ledger_entries WHERE organization_id=$1', [seed.orgId])), /cannot be edited or deleted/);
      await assert.rejects(runtime(client => client.query('SELECT permanently_delete_workspace($1,$2,$3,1,$4)',
        [seed.customerUserId, seed.orgId, 'North Trading', digest])), /administrator/);
      const result = await runtime(client => client.query('SELECT permanently_delete_workspace($1,$2,$3,1,$4) AS result',
        [seed.adminId, seed.orgId, 'North Trading', digest]));
      assert.deepEqual(result.rows[0].result, { id: seed.orgId, deleted: true, files_pending: 3 });
      assert.equal((await database.db.query('SELECT 1 FROM account_purge_context')).rowCount, 0);
    } finally {
      await database.db.query(`DROP OWNED BY "${role}"`);
      await database.db.query(`DROP ROLE "${role}"`);
    }
  });
});
