import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingDraftKey, bookingSubmissionRetryPayload, matchesBookingSubmissionRetry, readBookingDraft, removeBookingDraft, writeBookingDraft, type BookingDraft } from '../src/pages/booking-draft';

function storage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
}
const draft: BookingDraft = {
  fields: { reference: 'DRAFT-1', departure: '2026-12-20T10:30', amount: '500.00', instalmentTotal: '600.00', effectiveDate: '2026-11-09',
    required: ['flight', 'makkah'], instalments: [{ key: '7a634eea-c833-4c68-bf54-008f45ced383', due_date: '2026-12-01', amount: '495.00' }] },
  submission: { payload: '{"reference":"DRAFT-1"}', key: 'd0dcc7df-3f43-4345-9c8a-45c0f52333dc' },
};

test('drafts retain all entered fields and retry identity, isolated by customer, member and workspace', () => {
  const store = storage(), key = bookingDraftKey('workspace', 'member', 'customer');
  assert.equal(writeBookingDraft(key, draft, store), true);
  assert.deepEqual(readBookingDraft(key, store), draft);
  for (const other of [bookingDraftKey('other', 'member', 'customer'), bookingDraftKey('workspace', 'other', 'customer'), bookingDraftKey('workspace', 'member', 'other')])
    assert.equal(readBookingDraft(other, store), null);
  assert.equal(removeBookingDraft(key, store), true);
  assert.equal(readBookingDraft(key, store), null);
});

test('incomplete inputs survive draft restoration without requiring a valid booking', () => {
  const store = storage(), partial = { ...draft, fields: { ...draft.fields, amount: '12.', departure: '',
    instalments: [{ ...draft.fields.instalments[0], due_date: '', amount: '' }] } };
  writeBookingDraft('draft', partial, store);
  assert.deepEqual(readBookingDraft('draft', store), partial);
});

test('drafts from before the calculation-total field retain their fields and retry key', () => {
  const store = storage();
  const { instalmentTotal: _total, ...fields } = draft.fields;
  store.setItem('draft', JSON.stringify({ version: 1, ...draft, fields }));
  assert.deepEqual(readBookingDraft('draft', store), { ...draft, fields: { ...fields, instalmentTotal: '' } });
});

test('instalment assistance and preserved prefix survive drafts without changing retry identity', () => {
  const store = storage();
  for (const instalmentMode of ['auto', 'manual'] as const) {
    const plan = { ...draft, fields: { ...draft.fields, instalmentMode, instalmentAnchor: draft.fields.instalments[0].key } };
    writeBookingDraft('draft', plan, store);
    assert.deepEqual(readBookingDraft('draft', store), plan);
  }
  writeBookingDraft('legacy', draft, store);
  assert.equal(readBookingDraft('legacy', store)?.fields.instalmentMode, undefined);
});

test('paid instalments retain received dates and existing ledger selections across draft reloads', () => {
  const store = storage();
  const fields = { ...draft.fields, instalments: [{ ...draft.fields.instalments[0], paid: true, paid_date: '2026-11-01', payment_choice: 'existing' as const, payment_entry_id: '12345' }] };
  writeBookingDraft('paid', { ...draft, fields }, store);
  assert.deepEqual(readBookingDraft('paid', store), { ...draft, fields });
  for (const patch of [{ paid: 'yes' }, { paid_date: 123 }, { payment_choice: 'unknown' }, { payment_entry_id: '-1' }]) {
    store.setItem('invalid', JSON.stringify({ version: 1, ...draft, fields: { ...fields, instalments: [{ ...fields.instalments[0], ...patch }] } }));
    assert.equal(readBookingDraft('invalid', store), null);
  }
});

test('explicit existing payments survive draft reloads and reject corrupt or duplicate ledger IDs', () => {
  const store = storage();
  const fields = { ...draft.fields, existingPaymentEntryIds: ['12345', '67890'] };
  writeBookingDraft('existing', { ...draft, fields }, store);
  assert.deepEqual(readBookingDraft('existing', store), { ...draft, fields });
  for (const existingPaymentEntryIds of [['12345', '12345'], ['-1'], [0], '12345', ['../foreign']]) {
    store.setItem('invalid', JSON.stringify({ version: 1, ...draft, fields: { ...fields, existingPaymentEntryIds } }));
    assert.equal(readBookingDraft('invalid', store), null);
  }
});

test('one hundred upcoming instalments and paid history survive draft refresh independently', () => {
  const store = storage();
  const due = Array.from({ length: 100 }, (_, index) => ({ ...draft.fields.instalments[0], key: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
  const paid = { ...draft.fields.instalments[0], key: '11111111-1111-4111-8111-111111111111', paid: true, amount: '100.00' };
  const many = { ...draft, fields: { ...draft.fields, instalments: [paid, ...due] } };
  writeBookingDraft('many', many, store);
  assert.deepEqual(readBookingDraft('many', store), many);
  writeBookingDraft('too-many-due', { ...many, fields: { ...many.fields, instalments: [...due, { ...paid, paid: false }] } }, store);
  assert.equal(readBookingDraft('too-many-due', store), null);
});

test('a lost-response draft permits only its exact prior request to retry after the selected payment becomes claimed', () => {
  const store = storage();
  const payload = { reference: 'DRAFT-1', amount: '5000', schedule_basis: 'remaining_balance', existing_payment_entry_ids: ['123'],
    instalments: [{ due_date: '2026-12-01', amount: '3000' }] };
  const submission = { payload: JSON.stringify(payload), key: draft.submission.key };
  writeBookingDraft('retry', { ...draft, fields: { ...draft.fields, existingPaymentEntryIds: ['123'] }, submission }, store);
  const restored = readBookingDraft('retry', store)!;
  assert.equal(matchesBookingSubmissionRetry(payload, restored.submission), true);
  assert.equal(restored.submission.key, submission.key);
  assert.equal(matchesBookingSubmissionRetry(payload, { ...submission, payload: '' }), false);
  for (const patch of [
    { amount: '5001' }, { existing_payment_entry_ids: ['456'] }, { existing_payment_entry_ids: [] },
    { instalments: [{ due_date: '2026-12-02', amount: '3000' }] }, { reference: 'CHANGED' },
  ]) assert.equal(matchesBookingSubmissionRetry({ ...payload, ...patch }, restored.submission), false);
});

test('unchanged pre-upgrade drafts replay the exact old contract, but any changed payment, amount or date must validate anew', () => {
  for (const instalmentTotal of ['', '5100']) {
    const legacy = { reference: 'LEGACY', departure_at: '2099-01-01T12:00:00Z', amount: '5000', effective_date: '2020-01-01', required_services: [],
      ...(instalmentTotal ? { instalment_total: instalmentTotal } : {}),
      instalments: [{ due_date: '2020-01-01', amount: '2000', paid: true, paid_date: '2020-01-01', payment_entry_id: '123' }, { due_date: '2099-01-01', amount: instalmentTotal ? '3100' : '3000' }] };
    const { instalment_total: _oldTotal, ...common } = legacy;
    const proposed = { ...common, schedule_basis: 'remaining_balance', existing_payment_entry_ids: [] };
    const submission = { payload: JSON.stringify(legacy), key: draft.submission.key };
    assert.deepEqual(bookingSubmissionRetryPayload(proposed, instalmentTotal, submission), legacy);
    assert.equal(JSON.stringify(bookingSubmissionRetryPayload(proposed, instalmentTotal, submission)), submission.payload, 'Retry preserves the original payload order and content.');
    for (const patch of [{ amount: '5001' }, { reference: 'CHANGED' }, { existing_payment_entry_ids: ['456'] },
      { instalments: [{ ...legacy.instalments[0], paid: false }, legacy.instalments[1]] }, { effective_date: '2020-01-02' }])
      assert.equal(bookingSubmissionRetryPayload({ ...proposed, ...patch }, instalmentTotal, submission), null);
    assert.equal(bookingSubmissionRetryPayload(proposed, 'changed', submission), null);
    assert.equal(bookingSubmissionRetryPayload(proposed, instalmentTotal, { ...submission, payload: '{' }), null);
  }
});

test('corrupt or unsupported saved drafts are ignored safely', () => {
  const store = storage();
  for (const value of ['{', 'null', '{}', JSON.stringify({ version: 2, ...draft }),
    JSON.stringify({ version: 1, ...draft, fields: { ...draft.fields, instalments: [null] } }),
    JSON.stringify({ version: 1, ...draft, fields: { ...draft.fields, instalmentMode: 'unknown' } }),
    JSON.stringify({ version: 1, ...draft, fields: { ...draft.fields, instalmentAnchor: 'invalid' } }),
    JSON.stringify({ version: 1, ...draft, submission: { payload: '', key: 'invalid' } })]) {
    store.setItem('draft', value);
    assert.equal(readBookingDraft('draft', store), null);
  }
});

test('blocked or full browser storage reports failure instead of breaking the booking form', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(readBookingDraft('draft', blocked), null);
  assert.equal(writeBookingDraft('draft', draft, blocked), false);
  assert.equal(removeBookingDraft('draft', blocked), false);
});
