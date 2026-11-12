import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { DashboardService } from '../apps/api/src/dashboard/dashboard.service';
import { positionCtes } from '../apps/api/src/dashboard/receivables';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { formatMoney, parseMoney } from '../apps/api/src/ledger/money';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('receivables with explicitly paid instalments', () => {
  let fixture: TestDatabase;
  let seed: TestSeed;
  let bookings: BookingsService;
  let management: BookingManagementService;
  let ledger: LedgerService;
  let dashboard: DashboardService;

  before(async () => {
    fixture = await setupTestDatabase();
    seed = await fixture.seed();
    await fixture.db.query("UPDATE organizations SET currency='GBP',currency_exponent=2 WHERE id=$1", [seed.orgId]);
    const access = new AccessService(fixture.db);
    seed.admin = await access.membership(seed.adminId, seed.orgId);
    bookings = new BookingsService(fixture.db, access);
    management = new BookingManagementService(fixture.db, access);
    ledger = new LedgerService(fixture.db, access);
    dashboard = new DashboardService(fixture.db, access);
  });
  after(async () => fixture?.close());

  async function customer() {
    const id = randomUUID();
    await fixture.db.query(`INSERT INTO customers(id,organization_id,name,email,created_by,idempotency_key,request_hash)
      VALUES($1,$2,'Paid instalment guest',$3,$4,$5,$6)`,
    [id, seed.orgId, `${id}@example.test`, seed.adminId, randomUUID(), '0'.repeat(64)]);
    return id;
  }

  async function booking(customerId: string, amounts: string[], firstDay = 1, chargeAmount?: string) {
    const amount = chargeAmount ?? formatMoney(amounts.reduce((sum, value) => sum + parseMoney(value, 2), 0n), 2);
    return bookings.create(seed.admin, customerId, {
      reference: `PAID-${randomUUID()}`, amount, effective_date: '2026-11-01',
      departure_at: '2026-12-01T12:00:00Z', required_services: [],
      instalments: amounts.map((value, index) => ({ amount: value, due_date: `2026-11-${String(firstDay + index).padStart(2, '0')}` })),
      idempotency_key: randomUUID(),
    });
  }

  async function payment(customerId: string, amount: string) {
    return ledger.post(seed.admin, customerId, { kind: 'payment', amount, effective_date: '2026-10-20',
      description: 'Advance received', idempotency_key: randomUUID() });
  }

  // Set up the persisted link directly so these reporting tests cover both
  // payment sources independently of the booking form and its creation flow.
  async function reserve(customerId: string, bookingId: string, index: number, source: 'booking_instalment' | 'customer_receipt' = 'booking_instalment') {
    const instalment = (await fixture.db.query<{id:string;amount_minor:string}>(`SELECT id,amount_minor::text FROM booking_instalments
      WHERE booking_id=$1 ORDER BY due_date,id`, [bookingId])).rows[index];
    const entry = await payment(customerId, formatMoney(instalment.amount_minor, 2));
    const id = randomUUID();
    await fixture.db.transaction(async client => {
      if (source === 'booking_instalment') {
        await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,
          status,source,idempotency_key,request_hash,reviewed_by,reviewed_at,ledger_entry_id)
          VALUES($1,$2,$3,$4,$5,'2026-10-20','approved','booking_instalment',$6,$7,$8,now(),$9)`,
        [id, seed.orgId, customerId, bookingId, instalment.amount_minor, randomUUID(), '0'.repeat(64), seed.adminId, entry.id]);
      } else {
        await client.query(`INSERT INTO booking_payments(id,organization_id,customer_id,booking_id,amount_minor,payment_date,
          submitted_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,'2026-10-20',$6,$7,$8)`,
        [id, seed.orgId, customerId, bookingId, instalment.amount_minor, seed.customerUserId, randomUUID(), '0'.repeat(64)]);
        await client.query(`INSERT INTO booking_payment_receipts(id,organization_id,customer_id,booking_id,payment_id,name,size,content,original_sha256)
          VALUES($1,$2,$3,$4,$5,'receipt.webp',1,$6,$7)`,
        [randomUUID(), seed.orgId, customerId, bookingId, id, Buffer.from([1]), '0'.repeat(64)]);
        await client.query(`UPDATE booking_payments SET version=version+1,status='approved',reviewed_by=$1,reviewed_at=now(),ledger_entry_id=$2 WHERE id=$3`,
        [seed.adminId, entry.id, id]);
      }
      await client.query('UPDATE booking_instalments SET payment_id=$1 WHERE id=$2', [id, instalment.id]);
    });
    return entry;
  }

  async function positions(customerId: string) {
    return (await fixture.db.query<{id:string;booking_id:string;amount_minor:string;unpaid_minor:string}>(`WITH ${positionCtes}
      SELECT id,booking_id,amount_minor::text,unpaid::text AS unpaid_minor FROM positioned
      WHERE customer_id=$2 ORDER BY due_date,priority,created_at,id`, [seed.orgId, customerId])).rows;
  }

  it('keeps earlier overdue instalments due when a later instalment was explicitly paid', async () => {
    const customerId = await customer();
    const created = await booking(customerId, ['1500', '875', '875', '875', '875']);
    await reserve(customerId, created.id, 1);
    const rows = await positions(customerId);
    assert.deepEqual(rows.map(row => [row.amount_minor, row.unpaid_minor]), [
      ['150000', '150000'], ['87500', '0'], ['87500', '87500'], ['87500', '87500'], ['87500', '87500'],
    ]);
    const overview = await dashboard.overview(seed.admin, {}, new Date('2026-11-06T12:00:00Z'));
    const attention = overview.attention.filter(row => row.customer_id === customerId);
    assert.equal(attention.length, 4);
    assert.ok(attention.every(row => row.status === 'overdue'));
    assert.equal(attention.reduce((sum, row) => sum + BigInt(row.unpaid_minor), 0n), 412500n);
    assert.equal((await ledger.statement(seed.admin, customerId)).current_balance_minor, '412500');
  });

  it('uses a general payment once and skips reserved amounts when allocating to later instalments', async () => {
    const customerId = await customer();
    const created = await booking(customerId, ['100', '100', '100']);
    await reserve(customerId, created.id, 0);
    await payment(customerId, '150');
    assert.deepEqual((await positions(customerId)).map(row => row.unpaid_minor), ['0', '0', '5000']);
    assert.equal((await ledger.statement(seed.admin, customerId)).current_balance_minor, '5000');
  });

  it('does not reuse reserved money or payments already consumed by legacy debt for another booking', async () => {
    const customerId = await customer();
    await ledger.post(seed.admin, customerId, { kind: 'charge', amount: '75', effective_date: '2026-09-01',
      description: 'Earlier unscheduled debt', idempotency_key: randomUUID() });
    await payment(customerId, '75');
    const earlier = await booking(customerId, ['100']);
    const later = await booking(customerId, ['100'], 2);
    await reserve(customerId, later.id, 0);
    assert.deepEqual((await positions(customerId)).map(row => [row.booking_id, row.unpaid_minor]), [[earlier.id, '10000'], [later.id, '0']]);
    await payment(customerId, '25');
    assert.deepEqual((await positions(customerId)).map(row => row.unpaid_minor), ['7500', '0']);
    assert.equal((await ledger.statement(seed.admin, customerId)).current_balance_minor, '7500');
  });

  it('restores the explicitly paid instalment when its ledger payment is reversed', async () => {
    const customerId = await customer();
    const created = await booking(customerId, ['100', '100']);
    const paid = await reserve(customerId, created.id, 1);
    assert.deepEqual((await positions(customerId)).map(row => row.unpaid_minor), ['10000', '0']);
    await ledger.post(seed.admin, customerId, { kind: 'reversal', reversal_of: paid.id, effective_date: '2026-11-06',
      description: 'Advance payment returned', idempotency_key: randomUUID() });
    assert.deepEqual((await positions(customerId)).map(row => row.unpaid_minor), ['10000', '10000']);
    assert.equal((await ledger.statement(seed.admin, customerId)).current_balance_minor, '20000');
  });

  for (const cancellation of ['cancel', 'reverse charge'] as const) {
    it(`handles linked paid money after ${cancellation}`, async () => {
      const customerId = await customer();
      const earlier = await booking(customerId, ['100', '100']);
      const cancelled = await booking(customerId, ['100'], 3);
      await reserve(customerId, cancelled.id, 0);
      if (cancellation === 'cancel') {
        const result = await management.cancel(seed.admin, customerId, cancelled.id, { expected_version: 1,
          reason: 'Trip cancelled', confirmation: cancelled.reference, effective_date: '2026-11-06', idempotency_key: randomUUID() });
        assert.equal(result.retained_payments_minor, '0');
        assert.equal(result.excluded_payments_minor, '10000');
      } else {
        await ledger.post(seed.admin, customerId, { kind: 'reversal', reversal_of: cancelled.charge_entry_id,
          effective_date: '2026-11-06', description: 'Cancelled charge', idempotency_key: randomUUID() });
      }
      const rows = await positions(customerId);
      assert.ok(rows.every(row => row.booking_id === earlier.id));
      assert.deepEqual(rows.map(row => row.unpaid_minor), cancellation === 'cancel' ? ['10000', '10000'] : ['0', '10000']);
      assert.equal((await ledger.statement(seed.admin, customerId)).current_balance_minor, cancellation === 'cancel' ? '20000' : '10000');
    });
  }

  it('reserves an approved customer receipt linked to an instalment exactly like a recorded advance', async () => {
    const created = await booking(seed.customerId, ['100', '100']);
    await reserve(seed.customerId, created.id, 1, 'customer_receipt');
    assert.deepEqual((await positions(seed.customerId)).map(row => row.unpaid_minor), ['10000', '0']);
  });

  it('keeps opening credit and the account debt cap when the schedule differs within tolerance', async () => {
    const customerId = await customer();
    await ledger.post(seed.admin, customerId, { kind: 'opening', amount: '-20', effective_date: '2026-09-01',
      description: 'Credit brought forward', idempotency_key: randomUUID() });
    const created = await booking(customerId, ['100', '105'], 1, '200');
    await reserve(customerId, created.id, 0);
    assert.deepEqual((await positions(customerId)).map(row => [row.amount_minor, row.unpaid_minor]), [['10000', '0'], ['10500', '8000']]);
    assert.equal((await ledger.statement(seed.admin, customerId)).current_balance_minor, '8000');
  });
});
