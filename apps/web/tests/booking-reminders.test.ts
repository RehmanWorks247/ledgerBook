import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingReminderBalances, outstandingReminderRows, reminderSummary } from '../src/pages/booking-reminders';
import { hasLegacyBookingSubmission, prepareReminderDraft, readBookingDraft, writeBookingDraft, type BookingDraft } from '../src/pages/booking-draft';

const today = '2026-11-12';
const rows = [
  { id: 'first', due_date: '2026-11-01', amount_minor: '35000' },
  { id: 'second', due_date: '2026-12-01', amount_minor: '35000' },
];

test('past payments are counted once and new money reduces the earliest reminder', () => {
  const before = bookingReminderBalances(rows, '100000', '30000', today, 'reminders', '30000');
  assert.deepEqual(before.map(row => row.remaining_minor), ['35000', '35000']);
  const after = bookingReminderBalances(rows, '100000', '50000', today, 'reminders', '30000');
  assert.deepEqual(after.map(row => [row.remaining_minor, row.payment_status]), [['15000', 'Overdue'], ['35000', 'Upcoming']]);
  const fields = outstandingReminderRows(after);
  assert.deepEqual(fields.map(row => row.amount), ['150.00', '350.00']);
  const summary = reminderSummary('1000', '50000', fields);
  assert.equal(summary.paid, 50000n);
  assert.equal(summary.remaining, 50000n);
  assert.equal(summary.valid, true);
});

test('empty and partially planned reminders are valid without tolerances', () => {
  assert.equal(reminderSummary('1000', '30000', []).valid, true);
  const summary = reminderSummary('1000', '30000', [{ key: 'one', due_date: today, amount: '200' }]);
  assert.equal(summary.valid, true);
  assert.equal(summary.unplanned, 50000n);
  assert.equal(reminderSummary('1000', '30000', [{ key: 'one', due_date: today, amount: '700.01' }]).valid, false);
  for (const row of [{ due_date: '2026-02-30', amount: '1' }, { due_date: '', amount: '1' }, { due_date: today, amount: '0' }, { due_date: today, amount: '' }])
    assert.equal(reminderSummary('1000', '0', [{ key: 'one', ...row }]).valid, false);
});

test('approved API balances take priority and fully covered rows are omitted when editing', () => {
  const balances = bookingReminderBalances([{ ...rows[0], remaining_minor: '0' }, { ...rows[1], remaining_minor: '12345' }], '100000', '50000', today, 'reminders', '30000');
  assert.deepEqual(balances.map(row => row.remaining_minor), ['0', '12345']);
  assert.deepEqual(outstandingReminderRows(balances), [{ key: 'second', id: 'second', due_date: '2026-12-01', amount: '123.45' }]);
});

test('legacy paid rows remain in payment history, while unlinked completed reminders show Completed', () => {
  const legacy = bookingReminderBalances([{ ...rows[0], paid: true }, rows[1]], '100000', '70000', today);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].payment_status, 'Completed');
  assert.deepEqual(outstandingReminderRows(legacy), []);
});

test('legacy draft payment inputs are removed with a persistent notice and submission identity survives', () => {
  const key = '7a634eea-c833-4c68-bf54-008f45ced383';
  const draft: BookingDraft = { fields: { reference: 'Old', departure: '', amount: '1000', instalmentTotal: '1000', effectiveDate: today, required: [],
    instalments: [{ key, due_date: today, amount: '300', paid: true, payment_entry_id: '123', payment_choice: 'existing' },
      { key: 'ef275382-d8d0-4830-9dbd-bf01c558fb21', due_date: today, amount: '700' }], existingPaymentEntryIds: ['456'] },
    submission: { key, payload: JSON.stringify({ schedule_basis: 'remaining_balance', amount: '1000' }) } };
  const converted = prepareReminderDraft(draft);
  assert.equal(converted.fields.instalments.length, 1);
  assert.equal(converted.fields.legacyPaymentsRemoved, true);
  assert.equal(converted.fields.existingPaymentEntryIds, undefined);
  assert.deepEqual(converted.submission, draft.submission);
  assert.equal(hasLegacyBookingSubmission(converted.submission), true);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  writeBookingDraft('draft', converted, storage);
  assert.deepEqual(prepareReminderDraft(readBookingDraft('draft', storage)!), converted);
  assert.equal(hasLegacyBookingSubmission({ ...draft.submission, payload: '' }), false);
  assert.equal(hasLegacyBookingSubmission({ ...draft.submission, payload: JSON.stringify({ schedule_basis: 'reminders' }) }), false);
});
