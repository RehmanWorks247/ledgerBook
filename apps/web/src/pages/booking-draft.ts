import { bookingServices } from './booking-model';

export type BookingDraftFields = {
  reference: string; departure: string; amount: string; instalmentTotal: string; effectiveDate: string;
  required: string[]; instalments: { key: string; due_date: string; amount: string }[];
};
export type BookingDraft = {
  fields: BookingDraftFields;
  submission: { payload: string; key: string };
};
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function bookingDraftKey(organizationId: string, membershipId: string, customerId: string) {
  return `ledgerbook:booking-draft:v1:${JSON.stringify([organizationId, membershipId, customerId])}`;
}

export function readBookingDraft(key: string, storage?: DraftStorage): BookingDraft | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(key);
    if (!raw || raw.length > 100_000) return null;
    const draft = JSON.parse(raw);
    const fields = draft?.fields, submission = draft?.submission;
    if (draft?.version !== 1 || !fields || !submission ||
      !text(fields.reference, 160) || !text(fields.departure, 32) || !text(fields.amount, 20) || !text(fields.effectiveDate, 10) ||
      (fields.instalmentTotal !== undefined && !text(fields.instalmentTotal, 20)) ||
      !Array.isArray(fields.required) || fields.required.length > 6 ||
      !fields.required.every((key: unknown) => bookingServices.some(service => service.key === key)) ||
      !Array.isArray(fields.instalments) || fields.instalments.length > 100 ||
      !fields.instalments.every((item: BookingDraftFields['instalments'][number]) => item && text(item.key, 36) && uuid.test(item.key) && text(item.due_date, 10) && text(item.amount, 20)) ||
      !text(submission.payload, 50_000) || !text(submission.key, 36) || !uuid.test(submission.key)) return null;
    return { fields: { ...fields, instalmentTotal: fields.instalmentTotal ?? '' }, submission };
  } catch { return null; }
}

export function writeBookingDraft(key: string, draft: BookingDraft, storage?: DraftStorage): boolean {
  try {
    (storage ?? window.localStorage).setItem(key, JSON.stringify({ version: 1, ...draft }));
    return true;
  } catch { return false; }
}

export function removeBookingDraft(key: string, storage?: DraftStorage): boolean {
  try { (storage ?? window.localStorage).removeItem(key); return true; }
  catch { return false; }
}
