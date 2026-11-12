import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingInstalmentBalances } from '../src/pages/booking-instalment-balances';

const today = '2026-11-11';
const row = (id: string, due_date: string, amount_minor: string, paid = false) => ({ id, due_date, amount_minor, paid });

test('fully paid bookings settle historical rows even when approved payments are not linked to instalments', () => {
  const input = [row('first', '2026-10-01', '60000'), row('second', '2026-11-01', '40000')];
  const result = bookingInstalmentBalances(input, '100000', '100000', today);
  assert.deepEqual(result.map(item => [item.payment_status, item.remaining_minor]), [['Settled', '0'], ['Settled', '0']]);
});

test('unassigned payments settle the earliest due amounts while retaining the original display order', () => {
  const input = [
    row('future', '2026-12-01', '100000'),
    row('oldest', '2026-09-01', '100000'),
    row('partial', '2026-10-01', '100000'),
  ];
  const before = structuredClone(input);
  const result = bookingInstalmentBalances(input, '300000', '150000', today);
  assert.deepEqual(result.map(item => [item.id, item.payment_status, item.remaining_minor]), [
    ['future', 'Due', '100000'], ['oldest', 'Settled', '0'], ['partial', 'Overdue', '50000'],
  ]);
  assert.deepEqual(input, before, 'Allocation must not reorder or change persisted rows.');
});

test('an explicitly paid later instalment keeps its money rather than settling older debt', () => {
  const input: (ReturnType<typeof row> & { paid_date?: string; payment_entry_id?: string })[] = [
    row('oldest', '2026-09-01', '100000'),
    row('second', '2026-10-01', '100000'),
    { ...row('paid-later', '2026-12-01', '100000', true), paid_date: '2026-11-01', payment_entry_id: '123' },
  ];
  const result = bookingInstalmentBalances(input, '300000', '150000', today);
  assert.deepEqual(result.map(item => [item.payment_status, item.remaining_minor]), [
    ['Overdue', '50000'], ['Overdue', '100000'], ['Paid', '0'],
  ]);
  assert.equal(result[2].payment_entry_id, '123');
  assert.equal(result[2].paid_date, '2026-11-01');
});

test('rounding above the booking total is capped and does not create a false overdue amount', () => {
  const input = [row('main', '2026-10-01', '100000'), row('rounding', '2026-11-01', '500')];
  const unpaid = bookingInstalmentBalances(input, '100000', '0', today);
  assert.deepEqual(unpaid.map(item => [item.payment_status, item.remaining_minor]), [['Overdue', '100000'], ['Settled', '0']]);
  const complete = bookingInstalmentBalances(input, '100000', '100000', today);
  assert.deepEqual(complete.map(item => [item.payment_status, item.remaining_minor]), [['Settled', '0'], ['Settled', '0']]);
  const partial = bookingInstalmentBalances(input, '100000', '99500', today);
  assert.deepEqual(partial.map(item => item.remaining_minor), ['500', '0']);
});

test('today is due, equal due dates retain input priority, and credit never produces negative balances', () => {
  const input = [row('first', today, '50000'), row('second', today, '50000')];
  const partial = bookingInstalmentBalances(input, '100000', '75000', today);
  assert.deepEqual(partial.map(item => [item.payment_status, item.remaining_minor]), [['Settled', '0'], ['Due', '25000']]);
  const credit = bookingInstalmentBalances(input, '100000', '110000', today);
  assert.deepEqual(credit.map(item => item.remaining_minor), ['0', '0']);
  assert.deepEqual(bookingInstalmentBalances([], '100000', '0', today), []);
});

test('allocation keeps exact pennies at the maximum supported booking amount', () => {
  const input = [row('first', '2026-10-01', '50000000000000'), row('second', '2026-11-01', '50000000000000')];
  const result = bookingInstalmentBalances(input, '100000000000000', '99999999999999', today);
  assert.deepEqual(result.map(item => item.remaining_minor), ['0', '1']);
});
