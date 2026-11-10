import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import type { DatabaseService } from '../apps/api/src/database/database.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { EmailDeliveryService } from '../apps/api/src/notifications/email-delivery.service';
import { NotificationsService, type EmailMessage } from '../apps/api/src/notifications/notifications.service';
import { ReminderService } from '../apps/api/src/notifications/reminder.service';
import { PaymentEmailOutbox } from '../apps/api/src/payments/email-outbox.service';
import { setupTestDatabase, testPassword, type TestDatabase, type TestSeed } from './helpers';

const schedule = { enabled: true, due_soon_days: 3, repeat_days: 7, send_hour: 0, time_zone: 'UTC' };

function checkpoint() {
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { ready, gate, reached, release };
}

describe('deleted workspace invitation and background-work isolation', () => {
  let database: TestDatabase, seed: TestSeed, mail: NotificationsService, invitations: InvitationService;
  let access: AccessService, reminders: ReminderService, payments: PaymentEmailOutbox, messages: EmailMessage[];
  beforeEach(async () => {
    database = await setupTestDatabase(); seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    access = new AccessService(database.db); seed.admin = await access.membership(seed.adminId, seed.orgId);
    messages = []; mail = new NotificationsService();
    mail.send = async message => { messages.push(message); return { providerMessageId: randomUUID() }; };
    invitations = invitationService(database.db);
    reminders = reminderService(database.db);
    payments = new PaymentEmailOutbox(database.db, mail, access, false);
  });
  afterEach(async () => {
    await Promise.all([reminders?.beforeApplicationShutdown(), payments?.beforeApplicationShutdown()]);
    await database?.close();
  });

  function invitationService(db: DatabaseService) {
    return new InvitationService(db, new AccessService(db), new AuthService(db, mail), mail);
  }
  function reminderService(db: DatabaseService) {
    return new ReminderService(db, new AccessService(db), mail, new EmailDeliveryService(db), false);
  }
  async function deleteWorkspace(db = database.db) {
    await db.transaction(async client => {
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [seed.orgId]);
      await client.query('UPDATE organizations SET deleted_at=now() WHERE id=$1', [seed.orgId]);
    });
  }
  async function purgeWorkspace(db = database.db) {
    await db.transaction(async client => {
      await client.query('SELECT permanently_delete_workspace($1,$2,$3,1,$4)', [seed.adminId, seed.orgId, 'North Trading', 'a'.repeat(64)]);
    });
  }
  async function invite() {
    const invitation = await invitations.invite(seed.admin, seed.secondCustomerId);
    const token = messages.at(-1)?.text.match(/#([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token); return { invitation, token };
  }
  async function queuePayment(organizationId = seed.orgId) {
    const id = randomUUID();
    await database.db.query(`INSERT INTO payment_email_outbox(id,organization_id,recipient,subject,body,dedupe_key)
      VALUES($1::uuid,$2,'notification@example.test','Payment update','Private payment details',$1::text)`, [id, organizationId]);
    return id;
  }
  async function prepareReminder() {
    const today = businessDate(new Date(), 'UTC');
    const booking = await new BookingsService(database.db, access).create(seed.admin, seed.customerId, {
      reference: `WORKSPACE-${randomUUID()}`, departure_at: '2030-01-01T12:00:00Z', required_services: [],
      amount: '100', effective_date: today, instalments: [{ due_date: today, amount: '100' }], idempotency_key: randomUUID(),
    });
    await reminders.updateSettings(seed.admin, schedule);
    return { booking, now: new Date(`${today}T18:00:00Z`) };
  }
  async function queueReminder() {
    const prepared = await prepareReminder();
    assert.equal(await reminders.schedule(prepared.now), 1);
    return (await database.db.query('SELECT id FROM reminder_email_outbox WHERE organization_id=$1', [seed.orgId])).rows[0].id as string;
  }
  async function assertCancelled(table: 'payment_email_outbox' | 'reminder_email_outbox', id: string) {
    const row = (await database.db.query(`SELECT state,delivery_status,lease_token,lease_until FROM ${table} WHERE id=$1`, [id])).rows[0];
    assert.deepEqual(row, { state: 'cancelled', delivery_status: 'cancelled', lease_token: null, lease_until: null });
  }

  it('hides invitation details and blocks account creation while preserving another workspace', async () => {
    const { invitation, token } = await invite();
    await invitations.invite(seed.otherAdmin, seed.otherCustomerId);
    const otherToken = messages.at(-1)!.text.match(/#([A-Za-z0-9_-]{43})/)![1];
    await deleteWorkspace();
    assert.deepEqual(await invitations.inspect(token), { status: 'invalid' });
    await assert.rejects(invitations.accept(token, undefined, testPassword), /invalid/);
    assert.equal((await invitations.inspect(otherToken)).status, 'valid');
    assert.equal((await database.db.query('SELECT accepted_at FROM invitations WHERE id=$1', [invitation.id])).rows[0].accepted_at, null);
    assert.equal((await database.db.query("SELECT id FROM users WHERE email='beacon@example.test'")).rowCount, 0);
  });

  it('rechecks deletion after invitation acceptance has already found a valid candidate', async () => {
    const { token } = await invite(), point = checkpoint();
    const acceptingDb = Object.create(database.db) as DatabaseService;
    acceptingDb.query = async (sql, params) => {
      const result = await database.db.query(sql, params);
      if (sql.includes('WHERE i.token_hash=$1')) { point.reached(); await point.gate; }
      return result;
    };
    const accepting = invitationService(acceptingDb).accept(token, undefined, testPassword);
    void accepting.catch(() => undefined);
    try {
      await point.ready; await deleteWorkspace(); point.release();
      await assert.rejects(accepting, /invalid/);
      assert.equal((await database.db.query("SELECT id FROM users WHERE email='beacon@example.test'")).rowCount, 0);
    } finally { point.release(); await Promise.allSettled([accepting]); }
  });

  it('does not send a local invitation when deletion commits after it was saved', async () => {
    const point = checkpoint(), invitingDb = Object.create(database.db) as DatabaseService;
    invitingDb.transaction = async work => {
      const result = await database.db.transaction(work);
      if ((result as { invitation?: { id?: string } })?.invitation?.id) { point.reached(); await point.gate; }
      return result;
    };
    const sending = invitationService(invitingDb).invite(seed.admin, seed.secondCustomerId);
    void sending.catch(() => undefined);
    try {
      await point.ready; await deleteWorkspace(); point.release();
      await assert.rejects(sending, /access is unavailable/);
      assert.equal(messages.length, 0);
      assert.equal((await database.db.query('SELECT delivered_at FROM invitations WHERE customer_id=$1', [seed.secondCustomerId])).rows[0].delivered_at, null);
    } finally { point.release(); await Promise.allSettled([sending]); }
  });

  it('does not select deleted workspaces for reminder scheduling', async () => {
    const { now } = await prepareReminder(); await deleteWorkspace();
    assert.equal(await reminders.schedule(now), 0);
    assert.equal((await database.db.query('SELECT id FROM reminder_email_outbox')).rowCount, 0);
    assert.equal((await database.db.query('SELECT last_scheduled_date FROM reminder_settings WHERE organization_id=$1', [seed.orgId])).rows[0].last_scheduled_date, null);
  });

  it('rechecks deletion between the reminder scan and organization claim', async () => {
    const { now } = await prepareReminder(), point = checkpoint();
    const scanningDb = Object.create(database.db) as DatabaseService;
    scanningDb.query = async (sql, params) => {
      const result = await database.db.query(sql, params);
      if (sql.includes('FROM reminder_settings s')) { point.reached(); await point.gate; }
      return result;
    };
    const scanning = reminderService(scanningDb).schedule(now);
    void scanning.catch(() => undefined);
    try {
      await point.ready; await deleteWorkspace(); point.release();
      assert.equal(await scanning, 0);
      assert.equal((await database.db.query('SELECT id FROM reminder_email_outbox')).rowCount, 0);
    } finally { point.release(); await Promise.allSettled([scanning]); }
  });

  it('cancels both email queues for a deleted workspace and continues sending for active workspaces', async () => {
    const paymentId = await queuePayment(), reminderId = await queueReminder(), otherPaymentId = await queuePayment(seed.otherOrgId);
    await deleteWorkspace();
    assert.equal(await payments.flush(), 1); assert.equal(await reminders.deliver(), 0);
    await assertCancelled('payment_email_outbox', paymentId); await assertCancelled('reminder_email_outbox', reminderId);
    assert.equal(messages.length, 1);
    assert.equal((await database.db.query('SELECT state FROM payment_email_outbox WHERE id=$1', [otherPaymentId])).rows[0].state, 'sent');
    assert.equal((await database.db.query('SELECT id FROM bookings WHERE organization_id=$1', [seed.orgId])).rowCount, 1);
    assert.equal((await database.db.query('SELECT id FROM ledger_entries WHERE organization_id=$1', [seed.orgId])).rowCount, 1);
  });

  for (const kind of ['payment', 'reminder'] as const) for (const permanent of [false, true])
    it(`stops a previously claimed ${kind} email when workspace ${permanent ? 'permanent purge' : 'access removal'} wins the send race`, async () => {
    const id = kind === 'payment' ? await queuePayment() : await queueReminder();
    const point = checkpoint(), workerDb = Object.create(database.db) as DatabaseService;
    workerDb.transaction = async work => {
      const result = await database.db.transaction(work);
      const row = (result as { rows?: { id: string; state: string }[] })?.rows?.[0];
      if (row?.id === id && row.state === 'processing') { point.reached(); await point.gate; }
      return result;
    };
    const sending = kind === 'payment'
      ? new PaymentEmailOutbox(workerDb, mail, new AccessService(workerDb), false).flush()
      : reminderService(workerDb).deliver();
    void sending.catch(() => undefined);
    try {
      await point.ready; await (permanent ? purgeWorkspace() : deleteWorkspace()); point.release();
      assert.equal(await sending, 0); assert.equal(messages.length, 0);
      const table = kind === 'payment' ? 'payment_email_outbox' : 'reminder_email_outbox';
      if (permanent) assert.equal((await database.db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount, 0);
      else await assertCancelled(table, id);
    } finally { point.release(); await Promise.allSettled([sending]); }
  });

  for (const kind of ['payment', 'reminder', 'invitation'] as const) it(`serializes workspace deletion behind an in-flight ${kind} send`,
    { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 }, async () => {
      if (kind === 'payment') await queuePayment();
      if (kind === 'reminder') await queueReminder();
      const point = checkpoint();
      mail.send = async message => { point.reached(); await point.gate; messages.push(message); return { providerMessageId: randomUUID() }; };
      const sending = kind === 'payment' ? payments.flush() : kind === 'reminder' ? reminders.deliver() : invitations.invite(seed.admin, seed.secondCustomerId);
      void sending.catch(() => undefined);
      let deleting: Promise<void> | undefined;
      try {
        await point.ready;
        let pid = 0;
        const deletingDb = Object.create(database.db) as DatabaseService;
        deletingDb.transaction = work => database.db.transaction(async client => {
          pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          return work(client);
        });
        deleting = purgeWorkspace(deletingDb); void deleting.catch(() => undefined);
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          if (pid && (await database.db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') {
            blocked = true; break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'Workspace deletion must wait for an authorized send already in progress.');
        point.release(); await Promise.all([sending, deleting]);
        assert.equal(messages.length, 1);
        assert.equal(await payments.flush(), 0); assert.equal(await reminders.deliver(), 0);
      } finally { point.release(); await Promise.allSettled([sending, ...(deleting ? [deleting] : [])]); }
    });
});
