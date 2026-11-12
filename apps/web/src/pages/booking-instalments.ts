import { bookingAmountInput } from './booking-model';

export type InstalmentRow = {
  key: string;
  due_date: string;
  amount: string;
  paid?: boolean;
  paid_date?: string;
  id?: string;
  payment_entry_id?: string;
  payment_choice?: 'new' | 'existing';
  recorded_payment_source?: 'booking_instalment' | 'customer_receipt';
};
export type InstalmentMode = 'auto' | 'manual';
export type ExistingInstalmentPayment = { id: string; amount_minor: string; payment_date: string; description: string; reference: string; already_recorded_for_booking?: boolean };
export type RecordedInstalment = { id: string; paid?: boolean; amount_minor: string; payment_entry_id?: string | null };
export type RemainingPlanContext = {
  recordedPaidMinor?: string;
  recordedInstalments?: readonly RecordedInstalment[];
  existingPayments?: readonly ExistingInstalmentPayment[];
  existingPaymentEntryIds?: readonly string[];
};

/** Keep calculation inputs aligned with the API's positive GBP money amounts. */
export function parseInstalmentAmount(value: string): bigint | null {
  const text = value.trim();
  if (!/^\d{1,18}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return amount > 0n && amount <= 100_000_000_000_000n ? amount : null;
}

type InstalmentSplit =
  | { amounts: string[]; remaining: bigint; error: null }
  | { amounts: null; remaining: bigint | null; error: string };

/** Split unpaid amounts in the selected suffix, preserving earlier and paid amounts. */
export function splitInstalments(total: string, rows: readonly InstalmentRow[], start: number): InstalmentSplit {
  const target = parseInstalmentAmount(total);
  if (target === null) return { amounts: null, remaining: null, error: 'Enter a valid instalment total to calculate the remaining amounts.' };
  if (!Number.isInteger(start) || start < 0 || start >= rows.length)
    return { amounts: null, remaining: null, error: 'Add an instalment to split the remaining amount into.' };

  let remaining = target;
  for (let index = 0; index < start; index++) {
    const amount = parseInstalmentAmount(rows[index].amount);
    if (amount === null) return { amounts: null, remaining: null, error: `Enter a valid amount for instalment ${index + 1} before calculating later instalments.` };
    remaining -= amount;
  }
  let count = 0;
  for (let index = start; index < rows.length; index++) {
    if (!rows[index].paid) {
      count++;
      continue;
    }
    const amount = parseInstalmentAmount(rows[index].amount);
    if (amount === null) return { amounts: null, remaining: null, error: `Enter a valid amount for paid instalment ${index + 1} before calculating later instalments.` };
    remaining -= amount;
  }
  if (!count) return { amounts: null, remaining, error: 'All later instalments are paid. Add an unpaid instalment to split the remaining amount into.' };
  if (remaining < 0n) return { amounts: null, remaining, error: 'Earlier or paid instalments exceed the instalment total. Reduce an amount or increase the total.' };

  if (remaining < BigInt(count)) return { amounts: null, remaining, error: 'There is not enough remaining for at least £0.01 per instalment. Reduce the number of instalments or an earlier amount.' };
  const share = remaining / BigInt(count);
  const finalShare = share + remaining % BigInt(count);
  let unpaidIndex = 0;
  const amounts = rows.slice(start).map(row => row.paid ? row.amount : bookingAmountInput((++unpaidIndex === count ? finalShare : share).toString()));
  return { amounts, remaining, error: null };
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function instalmentSummary(total: string, rows: readonly InstalmentRow[], today?: string) {
  const target = parseInstalmentAmount(total);
  let scheduled = rows.length ? 0n : target ?? 0n;
  let paid = 0n;
  let overdue = 0n;
  let incomplete = target === null;
  const hasToday = today !== undefined && validCalendarDate(today);
  for (const row of rows) {
    const amount = parseInstalmentAmount(row.amount);
    if (amount === null) incomplete = true;
    else {
      scheduled += amount;
      if (row.paid && (row.payment_choice !== 'existing' || row.payment_entry_id)) paid += amount;
      else if (hasToday && validCalendarDate(row.due_date) && row.due_date < today!) overdue += amount;
    }
  }
  const minimum = target === null ? null : target > 500n ? target - 500n : 0n;
  const maximum = target === null ? null : target + 500n;
  const adjustment = minimum === null || maximum === null ? null
    : scheduled < minimum ? minimum - scheduled
    : scheduled > maximum ? scheduled - maximum : 0n;
  return {
    target, scheduled, remaining: target === null ? null : target - scheduled, incomplete,
    paid, outstanding: target !== null && target > paid ? target - paid : 0n, overdue,
    minimum, maximum, adjustment, withinTolerance: !incomplete && adjustment === 0n,
  };
}

/** Paid history is counted once; only unpaid rows form the new remaining-balance plan. */
export function remainingInstalmentPlan(total: string, rows: readonly InstalmentRow[], context: RemainingPlanContext = {}, today?: string, implicitDueDate?: string) {
  const bookingTotal = parseInstalmentAmount(total);
  const recorded = context.recordedInstalments ?? [];
  const options = context.existingPayments ?? [];
  const savedEntries = new Set(recorded.filter(row => row.paid && row.payment_entry_id).map(row => row.payment_entry_id!));
  const handledSaved = new Set<string>();
  const handledEntries = new Set<string>();
  const resolvedPaidRows = new Set<InstalmentRow>();
  const unavailablePaymentIds = new Set<string>();
  let paid = BigInt(context.recordedPaidMinor ?? '0');
  let incomplete = bookingTotal === null;
  let paymentsIncomplete = false;
  let currentPaidRows = 0n;
  for (const row of rows) {
    const saved = recorded.find(item => item.paid && (item.id === row.id || (!!row.payment_entry_id && item.payment_entry_id === row.payment_entry_id)));
    if (saved && !handledSaved.has(saved.id)) { paid -= BigInt(saved.amount_minor); handledSaved.add(saved.id); }
    if (!row.paid) continue;
    const amount = parseInstalmentAmount(row.amount);
    if (amount === null) { paymentsIncomplete = true; continue; }
    if (row.payment_entry_id) {
      if (handledEntries.has(row.payment_entry_id)) { paymentsIncomplete = true; continue; }
      handledEntries.add(row.payment_entry_id);
    }
    const existing = row.payment_choice === 'existing' || Boolean(row.payment_entry_id);
    const option = options.find(item => item.id === row.payment_entry_id);
    if (existing && !saved && (!row.payment_entry_id || (!option && !savedEntries.has(row.payment_entry_id)))) {
      paymentsIncomplete = true;
      if (row.payment_entry_id) unavailablePaymentIds.add(row.payment_entry_id);
      continue;
    }
    if (existing && !saved && option && BigInt(option.amount_minor) !== amount) { paymentsIncomplete = true; continue; }
    currentPaidRows += amount;
    resolvedPaidRows.add(row);
    if (saved || (!option?.already_recorded_for_booking && !savedEntries.has(row.payment_entry_id ?? ''))) paid += amount;
  }
  for (const id of new Set(context.existingPaymentEntryIds ?? [])) {
    if (handledEntries.has(id) || savedEntries.has(id)) continue;
    handledEntries.add(id);
    const payment = options.find(item => item.id === id);
    if (!payment) { unavailablePaymentIds.add(id); paymentsIncomplete = true; continue; }
    if (!payment.already_recorded_for_booking) paid += BigInt(payment.amount_minor);
  }
  if (paid < 0n) { paid = 0n; paymentsIncomplete = true; }
  const target = bookingTotal === null ? null : bookingTotal > paid ? bookingTotal - paid : 0n;
  const credit = bookingTotal !== null && paid > bookingTotal ? paid - bookingTotal : 0n;
  let scheduled = rows.length ? 0n : target ?? 0n;
  let overdue = 0n;
  if (!rows.length && target !== null && today && implicitDueDate && implicitDueDate < today) overdue = target;
  for (const row of rows) {
    if (row.paid) {
      const amount = parseInstalmentAmount(row.amount);
      if (!resolvedPaidRows.has(row) && amount !== null && today && validCalendarDate(row.due_date) && row.due_date < today) overdue += amount;
      continue;
    }
    const amount = parseInstalmentAmount(row.amount);
    if (amount === null) incomplete = true;
    else {
      scheduled += amount;
      if (today && validCalendarDate(row.due_date) && row.due_date < today) overdue += amount;
    }
  }
  incomplete ||= paymentsIncomplete;
  const minimum = target === null ? null : target > 500n ? target - 500n : 0n;
  const maximum = target === null ? null : target + 500n;
  const adjustment = minimum === null || maximum === null ? null : scheduled < minimum ? minimum - scheduled : scheduled > maximum ? scheduled - maximum : 0n;
  return { bookingTotal, target, paid, credit, scheduled, remaining: target === null ? null : target - scheduled,
    otherPaid: paid > currentPaidRows ? paid - currentPaidRows : 0n,
    overdue: target === null ? 0n : overdue < target ? overdue : target,
    incomplete, paymentsIncomplete, unavailablePaymentIds: [...unavailablePaymentIds], minimum, maximum, adjustment,
    withinTolerance: !incomplete && adjustment === 0n };
}

/** The supplied target already excludes paid money, so completed rows are skipped. */
export function splitRemainingInstalments(target: bigint | null, rows: readonly InstalmentRow[], start: number): InstalmentSplit {
  if (target === null) return { amounts: null, remaining: null, error: 'Enter a valid booking total to calculate the remaining amounts.' };
  if (!Number.isInteger(start) || start < 0 || start >= rows.length)
    return { amounts: null, remaining: null, error: 'Add an upcoming instalment to split the remaining balance into.' };
  let remaining = target;
  for (let index = 0; index < start; index++) {
    if (rows[index].paid) continue;
    const amount = parseInstalmentAmount(rows[index].amount);
    if (amount === null) return { amounts: null, remaining: null, error: `Enter a valid amount for instalment ${index + 1} before calculating later instalments.` };
    remaining -= amount;
  }
  const count = rows.slice(start).filter(row => !row.paid).length;
  if (!count) return { amounts: null, remaining, error: 'Add an upcoming instalment to split the remaining balance into.' };
  if (remaining < 0n) return { amounts: null, remaining, error: 'Earlier upcoming instalments exceed the remaining balance. Reduce an earlier amount.' };
  if (remaining < BigInt(count)) return { amounts: null, remaining, error: remaining === 0n ? 'Nothing remains to split. Remove unnecessary upcoming instalments.' : 'There is not enough remaining for at least £0.01 per instalment. Reduce the number of upcoming instalments.' };
  const share = remaining / BigInt(count);
  let index = 0;
  return { amounts: rows.slice(start).map(row => row.paid ? row.amount : bookingAmountInput((++index === count ? share + remaining % BigInt(count) : share).toString())), remaining, error: null };
}
