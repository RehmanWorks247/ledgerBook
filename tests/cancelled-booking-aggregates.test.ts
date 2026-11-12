import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { CustomersService } from '../apps/api/src/customers/customers.service';
import { DashboardService } from '../apps/api/src/dashboard/dashboard.service';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { InvitationService } from '../apps/api/src/invitations/invitation.service';
import { setupTestDatabase } from './helpers';

it('excludes old and new cancellations from every report while preserving independent payments and audit history', async () => {
  const database = await setupTestDatabase();
  try {
    await database.applyMigration('DROP VIEW account_ledger_entries; DROP INDEX audit_booking_ledger_entry;');
    const seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP'");
    const access = new AccessService(database.db);
    const admin = await access.membership(seed.adminId, seed.orgId);
    const consumer = await access.membership(seed.customerUserId, seed.orgId);
    const bookings = new BookingsService(database.db, access);
    const management = new BookingManagementService(database.db, access);
    const payments = new PaymentsService(database.db, access);
    const ledger = new LedgerService(database.db, access);
    const dashboard = new DashboardService(database.db, access);
    const customers = new CustomersService(database.db, access, {} as InvitationService);
    const create = (amount: string, effective_date: string, customerId = seed.customerId) => bookings.create(admin, customerId, {
      reference: `CANCEL-${randomUUID()}`, amount, effective_date, departure_at: '2030-01-01T12:00:00Z',
      required_services: [], idempotency_key: randomUUID(),
    });
    const cancel = async (id: string) => {
      const current = await bookings.get(admin, seed.customerId, id);
      return management.cancel(admin, seed.customerId, id, { expected_version: current.version,
        confirmation: current.reference, effective_date: '2020-03-01', reason: 'Trip cancelled', idempotency_key: randomUUID() });
    };
    const old = await create('500', '2020-01-01');
    const paid = await payments.record(admin, seed.customerId, old.id, {
      amount: '100', payment_date: '2020-01-02', idempotency_key: randomUUID(),
    });
    const revised = await payments.manage(admin, seed.customerId, old.id, paid.id, 'edit', {
      version: paid.version, amount: '80', payment_date: '2020-01-03', note: '', reason: 'Correct receipt',
    });
    assert.ok(revised);
    const current = await bookings.get(admin, seed.customerId, old.id);
    await management.update(admin, seed.customerId, old.id, { expected_version: current.version,
      reference: old.reference, amount: '600', effective_date: '2020-01-04', departure_at: '2030-01-01T12:00:00Z',
      required_services: [], instalments: [{ due_date: '2020-01-05', amount: '600' }],
      reason: 'Correct package', idempotency_key: randomUUID() });
    await cancel(old.id);
    const active = await create('300', '2020-02-01');
    const next = await create('200', '2020-02-01');
    await create('100', '2020-02-01', seed.secondCustomerId);
    for (const [id, amount] of [[active.id, '30'], [next.id, '20']]) await payments.record(admin, seed.customerId, id, {
      amount, payment_date: '2020-02-02', idempotency_key: randomUUID(),
    });
    const accountPayment = await payments.submit(consumer, seed.customerId, null, {
      amount: '50', payment_date: '2020-02-03', idempotency_key: randomUUID(),
    }, []);
    await payments.approve(admin, seed.customerId, null, accountPayment.id);
    await ledger.post(admin, seed.customerId, { kind: 'payment', amount: '10', effective_date: '2020-02-03',
      reference: old.reference, description: 'Independent payment with matching reference', idempotency_key: randomUUID() });

    const snapshot = async () => Promise.all(['ledger_entries', 'booking_payments', 'booking_invoices', 'audit_events'].map(async table =>
      (await database.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows));
    const before = await snapshot();
    await database.applyMigration(await readFile('apps/api/src/database/migrations/029_cancelled_booking_aggregates.sql', 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await ledger.statement(consumer, seed.customerId)).current_balance_minor, '39000');
    // Warm report caches, then cancel another booking and verify immediate invalidation.
    assert.equal((await dashboard.overview(admin)).total_debt_minor, '49000');
    const cancelled = await cancel(next.id);
    assert.equal(cancelled.retained_payments_minor, '0');
    assert.equal(cancelled.excluded_payments_minor, '2000');
    const statement = await ledger.statement(consumer, seed.customerId);
    assert.deepEqual([statement.total_amount_minor, statement.total_paid_minor, statement.current_balance_minor], ['30000', '9000', '21000']);
    assert.equal(statement.total, 4);
    assert.equal(statement.entries.at(-1)?.running_balance_minor, '21000');
    assert.equal((await customers.get(admin, seed.customerId)).balance_minor, '21000');
    assert.equal((await customers.list(admin, {})).items.find(row => row.id === seed.customerId)?.balance_minor, '21000');
    const overview = await dashboard.overview(admin, { start: '2020-01-01', end: '2030-01-01' });
    assert.deepEqual([overview.total_debt_minor, overview.total_credit_minor, overview.payments_received_minor, overview.overdue_minor], ['31000', '0', '9000', '31000']);
    assert.ok(overview.attention.every(row => ![old.id, next.id].includes(row.booking_id)));
    assert.equal((await ledger.dashboard(admin)).total_debt_minor, '31000');
    const combined = await dashboard.combinedLedger(admin);
    assert.deepEqual([combined.totals.charges_minor, combined.totals.payments_minor, combined.totals.outstanding_minor], ['40000', '9000', '31000']);
    assert.equal(combined.total, 5);
    // Earlier revisions and their later reversals must not leak into date-filtered reports.
    const january = { start: '2020-01-01', end: '2020-01-31' };
    assert.equal((await dashboard.overview(admin, january)).payments_received_minor, '0');
    assert.equal((await dashboard.combinedLedger(admin, january)).total, 0);
    const historical = await ledger.statement(consumer, seed.customerId, january);
    assert.equal(historical.total, 0);
    assert.equal(historical.closing_balance_minor, '0');
    assert.equal((await ledger.csv(consumer, seed.customerId, january)).trim().split('\r\n').length, 1);
    assert.deepEqual((await bookings.list(consumer, seed.customerId, true)).items.map(row => row.id), [active.id]);
    assert.equal((await bookings.list(admin, seed.customerId, true)).items.length, 3);
    const history = await payments.list(consumer, seed.customerId, null);
    assert.equal(history.items.length, 2);
    assert.ok(history.items.some(row => row.id === accountPayment.id));
    const reviews = await payments.reviewQueue(admin, { q: seed.customerId, status: 'all' });
    assert.equal(reviews.counts.all, 2);
    assert.equal((await payments.list(admin, seed.customerId, old.id)).items.length, 1);
    // Later audit corrections to cancelled payment records cannot change totals.
    const oldPayment = (await payments.list(admin, seed.customerId, old.id)).items[0];
    await payments.manage(admin, seed.customerId, old.id, oldPayment.id, 'delete', { version: oldPayment.version, reason: 'Archive receipt' });
    assert.equal((await ledger.statement(consumer, seed.customerId)).current_balance_minor, '21000');
    await assert.rejects(ledger.statement(consumer, seed.secondCustomerId), /not found/);
  } finally { await database.close(); }
});
