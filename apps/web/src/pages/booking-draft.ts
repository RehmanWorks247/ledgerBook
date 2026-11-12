import { bookingServices } from './booking-model';
import type { InstalmentMode, InstalmentRow } from './booking-instalments';

export type BookingDraftFields = {
  reference: string; departure: string; amount: string; instalmentTotal: string; effectiveDate: string;
  required: string[]; instalments: InstalmentRow[];
  instalmentMode?: InstalmentMode;
  instalmentAnchor?: string;
  existingPaymentEntryIds?: string[];
  remindersOnly?: boolean;
  automaticReminder?: string;
  legacyPaymentsRemoved?: boolean;
};
export type BookingDraft = {
  fields: BookingDraftFields;
  submission: { payload: string; key: string };
};

/** Keep a legacy submission's retry identity, but never replay its financial inputs in the reminder editor. */
export function hasLegacyBookingSubmission(submission: BookingDraft['submission']) {
  if (!submission.payload) return false;
  try { return JSON.parse(submission.payload)?.schedule_basis !== 'reminders'; }
  catch { return true; }
}

export function prepareReminderDraft(draft: BookingDraft): BookingDraft {
  const fields = draft.fields;
  const legacyPaymentsRemoved = fields.legacyPaymentsRemoved || fields.instalments.some(row => row.paid) || !!fields.existingPaymentEntryIds?.length;
  const rows = fields.instalments.filter(row => !row.paid).map(({ key, id, due_date, amount }) => ({ key, ...(id ? { id } : {}), due_date, amount }));
  return { submission: draft.submission, fields: { reference: fields.reference, departure: fields.departure, amount: fields.amount,
    effectiveDate: fields.effectiveDate, required: fields.required, instalmentTotal: '', instalments: rows,
    remindersOnly: true, ...(fields.automaticReminder ? { automaticReminder: fields.automaticReminder } : {}),
    ...(legacyPaymentsRemoved ? { legacyPaymentsRemoved: true } : {}) } };
}

/** Only an unchanged previously attempted request may replay after its payments become claimed. */
export function matchesBookingSubmissionRetry(payload: unknown, submission: BookingDraft['submission']) {
  return submission.payload.length > 0 && JSON.stringify(payload) === submission.payload;
}

/** Preserve a lost response's old API contract only when every submitted value is unchanged. */
export function bookingSubmissionRetryPayload(payload: Record<string, unknown>, legacyInstalmentTotal: string, submission: BookingDraft['submission']): Record<string, unknown> | null {
  if (matchesBookingSubmissionRetry(payload, submission)) return payload;
  if (!submission.payload) return null;
  try {
    const previous = JSON.parse(submission.payload) as Record<string, unknown>;
    if (!previous || Array.isArray(previous) || typeof previous !== 'object' || previous.schedule_basis !== undefined || previous.existing_payment_entry_ids !== undefined) return null;
    const { schedule_basis: _basis, existing_payment_entry_ids: entries, ...legacy } = payload;
    if (!Array.isArray(entries) || entries.length) return null;
    if (legacyInstalmentTotal) legacy.instalment_total = legacyInstalmentTotal;
    const keys = Object.keys(legacy);
    if (keys.length !== Object.keys(previous).length || keys.some(key => JSON.stringify(legacy[key]) !== JSON.stringify(previous[key]))) return null;
    return previous;
  } catch { return null; }
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function bookingDraftKey(organizationId: string, membershipId: string, customerId: string) {
  return `ledgerbook:booking-draft:v1:${JSON.stringify([organizationId, membershipId, customerId])}`;
}

export function readBookingDraft(key: string, storage?: DraftStorage): BookingDraft | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(key);
    if (!raw || raw.length > 1_000_000) return null;
    const draft = JSON.parse(raw);
    const fields = draft?.fields, submission = draft?.submission;
    if (draft?.version !== 1 || !fields || !submission ||
      !text(fields.reference, 160) || !text(fields.departure, 32) || !text(fields.amount, 20) || !text(fields.effectiveDate, 10) ||
      (fields.instalmentTotal !== undefined && !text(fields.instalmentTotal, 20)) ||
      (fields.remindersOnly !== undefined && typeof fields.remindersOnly !== 'boolean') ||
      (fields.legacyPaymentsRemoved !== undefined && typeof fields.legacyPaymentsRemoved !== 'boolean') ||
      (fields.automaticReminder !== undefined && (!text(fields.automaticReminder, 36) || !uuid.test(fields.automaticReminder))) ||
      (fields.instalmentMode !== undefined && fields.instalmentMode !== 'auto' && fields.instalmentMode !== 'manual') ||
      (fields.instalmentAnchor !== undefined && (!text(fields.instalmentAnchor, 36) || !uuid.test(fields.instalmentAnchor))) ||
      (fields.existingPaymentEntryIds !== undefined && (!Array.isArray(fields.existingPaymentEntryIds) || fields.existingPaymentEntryIds.length > 100 || !fields.existingPaymentEntryIds.every((id: unknown) => text(id, 19) && /^[1-9]\d*$/.test(id)) || new Set(fields.existingPaymentEntryIds).size !== fields.existingPaymentEntryIds.length)) ||
      !Array.isArray(fields.required) || fields.required.length > 6 ||
      !fields.required.every((key: unknown) => bookingServices.some(service => service.key === key)) ||
      !Array.isArray(fields.instalments) || fields.instalments.length > 1000 || fields.instalments.filter((item: InstalmentRow | null) => item && !item.paid).length > 100 ||
      !fields.instalments.every((item: BookingDraftFields['instalments'][number]) => item && text(item.key, 36) && uuid.test(item.key) && text(item.due_date, 10) && text(item.amount, 20)
        && (item.paid === undefined || typeof item.paid === 'boolean')
        && (item.paid_date === undefined || text(item.paid_date, 10))
        && (item.id === undefined || (text(item.id, 36) && uuid.test(item.id)))
        && (item.payment_entry_id === undefined || (text(item.payment_entry_id, 19) && /^[1-9]\d*$/.test(item.payment_entry_id)))
        && (item.payment_choice === undefined || item.payment_choice === 'new' || item.payment_choice === 'existing')
        && (item.recorded_payment_source === undefined || item.recorded_payment_source === 'booking_instalment' || item.recorded_payment_source === 'customer_receipt')) ||
      !text(submission.payload, 500_000) || !text(submission.key, 36) || !uuid.test(submission.key)) return null;
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
