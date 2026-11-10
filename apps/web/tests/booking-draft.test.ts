import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingDraftKey, readBookingDraft, removeBookingDraft, writeBookingDraft, type BookingDraft } from '../src/pages/booking-draft';

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

test('corrupt or unsupported saved drafts are ignored safely', () => {
  const store = storage();
  for (const value of ['{', 'null', '{}', JSON.stringify({ version: 2, ...draft }),
    JSON.stringify({ version: 1, ...draft, fields: { ...draft.fields, instalments: [null] } }),
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
