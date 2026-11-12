import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingInstalmentPlan, splitRemainingInstalments, type ExistingInstalmentPayment, type InstalmentRow, type RecordedInstalment } from '../src/pages/booking-instalments';

const row = (amount: string, extra: Partial<InstalmentRow> = {}): InstalmentRow => ({ key: 'row', amount, due_date: '2099-01-01', ...extra });
const payment = (id: string, amount_minor: string, already_recorded_for_booking = false): ExistingInstalmentPayment => ({ id, amount_minor, payment_date: '2020-01-01', description: 'Received transfer', reference: '', already_recorded_for_booking });

test('an existing £2000 payment is explicitly applied to a £5000 booking and splits only £3000 into five instalments', () => {
  const context = { existingPayments: [payment('1', '200000')], existingPaymentEntryIds: ['1'] };
  const implicit = remainingInstalmentPlan('5000', [], context);
  assert.equal(implicit.paid, 200000n);
  assert.equal(implicit.target, 300000n);
  assert.equal(implicit.scheduled, 300000n);
  assert.equal(implicit.withinTolerance, true);
  assert.deepEqual(splitRemainingInstalments(implicit.target, Array.from({ length: 5 }, (_, index) => row('', { key: `${index}` })), 0).amounts, ['600.00', '600.00', '600.00', '600.00', '600.00']);
  assert.equal(remainingInstalmentPlan('5000', [], { existingPayments: context.existingPayments }).paid, 0n, 'Available payments do not count until selected.');
});

test('approved payments outside paid rows reduce validation, suggestions and overdue exactly once', () => {
  const rows = [row('1000', { due_date: '2020-01-01' }), row('1000'), row('1000')];
  const plan = remainingInstalmentPlan('5000', rows, { recordedPaidMinor: '200000' }, '2026-11-11');
  assert.equal(plan.paid, 200000n);
  assert.equal(plan.otherPaid, 200000n);
  assert.equal(plan.target, 300000n);
  assert.equal(plan.scheduled, 300000n);
  assert.equal(plan.overdue, 100000n, 'Received funds were already excluded from these remaining rows.');
  assert.equal(plan.withinTolerance, true);
  assert.deepEqual(splitRemainingInstalments(plan.target, rows, 0).amounts, ['1000.00', '1000.00', '1000.00']);
});

test('paid rows, other approved payments, selected existing payments and new advances are counted once', () => {
  const saved: RecordedInstalment[] = [{ id: 'saved', paid: true, amount_minor: '100000', payment_entry_id: '1' }];
  const rows = [
    row('1000', { id: 'saved', paid: true, payment_choice: 'existing', payment_entry_id: '1' }),
    row('1000', { key: 'assigned-existing', paid: true, payment_choice: 'existing', payment_entry_id: '2' }),
    row('300', { key: 'advance', paid: true, payment_choice: 'new' }),
    row('2500', { key: 'due' }),
  ];
  const context = { recordedPaidMinor: '200000', recordedInstalments: saved,
    existingPayments: [payment('2', '100000', true), payment('3', '20000')], existingPaymentEntryIds: ['2', '3'] };
  const plan = remainingInstalmentPlan('5000', rows, context);
  assert.equal(plan.paid, 250000n);
  assert.equal(plan.target, 250000n);
  assert.equal(plan.scheduled, 250000n);
  assert.equal(plan.withinTolerance, true);
  assert.deepEqual(splitRemainingInstalments(plan.target, rows, 0).amounts, ['1000', '1000', '300', '2500.00']);
});

test('changes to saved paid rows adjust the persisted total, while omitted paid history remains counted', () => {
  const context = { recordedPaidMinor: '200000', recordedInstalments: [{ id: 'saved', paid: true, amount_minor: '100000', payment_entry_id: '1' }] };
  const due = row('4000');
  const reversed = remainingInstalmentPlan('5000', [row('1000', { id: 'saved', paid: false, payment_entry_id: '1' }), row('3000')], context);
  assert.equal(reversed.paid, 100000n);
  assert.equal(reversed.target, 400000n);
  assert.equal(reversed.withinTolerance, true);
  const edited = remainingInstalmentPlan('5000', [row('1500', { id: 'saved', paid: true, payment_entry_id: '1' }), row('2500')], context);
  assert.equal(edited.paid, 250000n);
  assert.equal(edited.withinTolerance, true);
  assert.equal(remainingInstalmentPlan('5000', [due], context).paid, 200000n);
});

test('upcoming edits preserve earlier due rows and skip paid rows without deducting paid money again', () => {
  const rows = [row('1500', { paid: true }), row('1000'), row('500', { paid: true }), row(''), row('')];
  const plan = remainingInstalmentPlan('5000.01', rows);
  assert.equal(plan.target, 300001n);
  const result = splitRemainingInstalments(plan.target, rows, 2);
  assert.deepEqual(result.amounts, ['500', '1000.00', '1000.01']);
  assert.equal(result.remaining, 200001n);
  assert.equal(rows[3].amount, '', 'Calculation does not mutate draft input.');
});

test('fully paid and overpaid plans allow no upcoming rows and never generate zero-value instalments', () => {
  const fullyPaid = remainingInstalmentPlan('5000', [], { recordedPaidMinor: '500000' });
  assert.equal(fullyPaid.target, 0n);
  assert.equal(fullyPaid.scheduled, 0n);
  assert.equal(fullyPaid.withinTolerance, true);
  const paidRows = remainingInstalmentPlan('5000', [row('5000', { paid: true })]);
  assert.equal(paidRows.target, 0n);
  assert.equal(paidRows.withinTolerance, true);
  const credit = remainingInstalmentPlan('5000', [], { existingPayments: [payment('1', '600000')], existingPaymentEntryIds: ['1'] });
  assert.equal(credit.target, 0n);
  assert.equal(credit.credit, 100000n);
  assert.equal(splitRemainingInstalments(credit.target, [row('')], 0).amounts, null);
});

test('missing, mismatched and duplicate existing payments cannot silently validate or inflate the paid total', () => {
  for (const rows of [
    [row('1000', { paid: true, payment_choice: 'existing' }), row('4000')],
    [row('1000', { paid: true, payment_choice: 'existing', payment_entry_id: 'missing' }), row('4000')],
    [row('999', { paid: true, payment_choice: 'existing', payment_entry_id: '1' }), row('4001')],
    [row('1000', { paid: true, payment_entry_id: '1' }), row('1000', { paid: true, payment_entry_id: '1' }), row('3000')],
  ]) {
    const plan = remainingInstalmentPlan('5000', rows, { existingPayments: [payment('1', '100000')] });
    assert.equal(plan.withinTolerance, false);
    assert.equal(plan.paymentsIncomplete, true);
    assert.ok(plan.paid <= 100000n);
  }
  const missing = remainingInstalmentPlan('5000', [], { existingPaymentEntryIds: ['missing'] });
  assert.deepEqual(missing.unavailablePaymentIds, ['missing']);
  assert.equal(missing.withinTolerance, false);
  const unresolved = remainingInstalmentPlan('5000', [
    row('1000', { key: 'unresolved', paid: true, payment_choice: 'existing', due_date: '2020-01-01' }),
    row('1000', { key: 'received', paid: true, payment_choice: 'existing', payment_entry_id: '1', due_date: '2020-01-02' }),
    row('1000', { key: 'due', due_date: '2020-01-03' }), row('1000'), row('1000'),
  ], { existingPayments: [payment('1', '100000')] }, '2026-11-11');
  assert.equal(unresolved.paid, 100000n);
  assert.equal(unresolved.target, 400000n);
  assert.equal(unresolved.overdue, 200000n, 'Checking Paid without a valid existing payment does not settle overdue debt.');
});

test('remaining-balance validation uses exact inclusive £5 boundaries and caps overdue to the true balance', () => {
  for (const [amount, valid, adjustment] of [['2995', true, 0n], ['3005', true, 0n], ['2994.99', false, 1n], ['3005.01', false, 1n]] as const) {
    const plan = remainingInstalmentPlan('5000', [row(amount, { due_date: '2020-01-01' })], { recordedPaidMinor: '200000' }, '2026-11-11');
    assert.equal(plan.withinTolerance, valid);
    assert.equal(plan.adjustment, adjustment);
    assert.ok(plan.overdue <= 300000n);
  }
});
