import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { AccessService } from '../apps/api/src/access/access.service';
import { BookingsService } from '../apps/api/src/bookings/bookings.service';
import { BookingManagementService } from '../apps/api/src/bookings/booking-management.service';
import { businessDate } from '../apps/api/src/dashboard/time';
import { LedgerService } from '../apps/api/src/ledger/ledger.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { setupTestDatabase, type TestDatabase, type TestSeed } from './helpers';

describe('customer account lifetime totals', () => {
  let database: TestDatabase, seed: TestSeed;
  let ledger: LedgerService, bookings: BookingsService, management: BookingManagementService, payments: PaymentsService;
  before(async () => {
    database = await setupTestDatabase();
    seed = await database.seed();
    await database.db.query("UPDATE organizations SET currency='GBP' WHERE id=$1", [seed.orgId]);
    const access = new AccessService(database.db);
    seed.admin = await access.membership(seed.adminId, seed.orgId);
    seed.customerMember = await access.membership(seed.customerUserId, seed.orgId);
    ledger = new LedgerService(database.db, access);
    bookings = new BookingsService(database.db, access);
    management = new BookingManagementService(database.db, access);
    payments = new PaymentsService(database.db, access);
  });
  after(async () => { await database?.close(); });

  it('combines every booking and confirmed payment, including edits, cancellations and payment reversals', async () => {
    const effective_date = businessDate();
    const input = (amount: string) => ({ reference: `ACCOUNT-${randomUUID()}`, amount, effective_date,
      departure_at: '2030-01-01T12:00:00Z', required_services: [], idempotency_key: randomUUID() });
    async function totals(amount: string, paid: string, balance: string) {
      for (const filters of [{ page_size: 1 }, { search: 'No matching entry', start: '2000-01-01', end: '2000-01-02' }]) {
        const result = await ledger.statement(seed.customerMember, seed.customerId, filters);
        assert.equal(result.total_amount_minor, amount);
        assert.equal(result.total_paid_minor, paid);
        assert.equal(result.current_balance_minor, balance);
        assert.equal(BigInt(result.total_amount_minor) - BigInt(result.total_paid_minor), BigInt(result.current_balance_minor));
      }
    }
    await totals('0', '0', '0');
    const first = await bookings.create(seed.admin, seed.customerId, input('500'));
    const second = await bookings.create(seed.admin, seed.customerId, input('750'));
    await bookings.create(seed.admin, seed.secondCustomerId, input('999'));
    await totals('125000', '0', '125000');

    async function submit(bookingId: string, amount: string, color: string) {
      const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
      return payments.submit(seed.customerMember, seed.customerId, bookingId,
        { amount, payment_date: effective_date, idempotency_key: randomUUID() },
        [{ originalname: 'receipt.png', mimetype: 'image/png', buffer, size: buffer.length }]);
    }
    const firstPayment = await submit(first.id, '125', '#008800');
    const secondPayment = await submit(second.id, '75', '#000088');
    const rejected = await submit(second.id, '50', '#880000');
    await payments.reject(seed.admin, seed.customerId, second.id, rejected.id, { reason: 'Incorrect receipt' });
    await totals('125000', '0', '125000');
    const approvedFirst = await payments.approve(seed.admin, seed.customerId, first.id, firstPayment.id);
    await payments.approve(seed.admin, seed.customerId, second.id, secondPayment.id);
    await totals('125000', '20000', '105000');

    await management.update(seed.admin, seed.customerId, first.id, {
      ...input('600'), reference: first.reference, expected_version: 1, reason: 'Updated package',
      instalments: [{ due_date: effective_date, amount: '600' }],
    });
    await totals('135000', '20000', '115000');
    await management.cancel(seed.admin, seed.customerId, second.id, {
      confirmation: second.reference, effective_date, expected_version: 1, reason: 'Cancelled trip', idempotency_key: randomUUID(),
    });
    await totals('60000', '12500', '47500');
    await ledger.post(seed.admin, seed.customerId, {
      kind: 'reversal', reversal_of: approvedFirst.ledger_entry_id!, effective_date,
      description: 'Payment returned', idempotency_key: randomUUID(),
    });
    await totals('60000', '0', '60000');
    await management.cancel(seed.admin, seed.customerId, first.id, {
      confirmation: first.reference, effective_date, expected_version: 2, reason: 'Cancelled trip', idempotency_key: randomUUID(),
    });
    await totals('0', '0', '0');
    await assert.rejects(ledger.statement(seed.customerMember, seed.secondCustomerId), /not found/);
  });
});
