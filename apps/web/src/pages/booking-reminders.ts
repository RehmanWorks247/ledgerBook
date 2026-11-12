import { bookingAmountInput } from './booking-model';
import { bookingInstalmentBalances } from './booking-instalment-balances';
import { parseInstalmentAmount } from './booking-instalments';

export type ReminderRow = { key: string; id?: string; due_date: string; amount: string };
export type SavedReminder = { id: string; due_date: string; amount_minor: string; paid?: boolean; remaining_minor?: string; payment_status?: string };

export function validReminderDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Reminders describe only the current outstanding balance; they never record money. */
export function reminderSummary(total: string, paidMinor: string, rows: readonly ReminderRow[]) {
  const bookingTotal = parseInstalmentAmount(total);
  const paid = BigInt(paidMinor);
  const remaining = bookingTotal === null ? null : bookingTotal > paid ? bookingTotal - paid : 0n;
  const credit = bookingTotal !== null && paid > bookingTotal ? paid - bookingTotal : 0n;
  let scheduled = 0n;
  let incomplete = false;
  for (const row of rows) {
    const amount = parseInstalmentAmount(row.amount);
    if (amount === null || !validReminderDate(row.due_date)) incomplete = true;
    if (amount !== null) scheduled += amount;
  }
  const over = remaining !== null && scheduled > remaining ? scheduled - remaining : 0n;
  const unplanned = remaining !== null && remaining > scheduled ? remaining - scheduled : 0n;
  const next = [...rows].filter(row => validReminderDate(row.due_date) && parseInstalmentAmount(row.amount) !== null)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  return { bookingTotal, paid, remaining, credit, scheduled, unplanned, over, incomplete, next,
    valid: bookingTotal !== null && !incomplete && over === 0n && rows.length <= 100 };
}

/** Prefer the API's balances; the fallback also supports bookings created before reminder mode. */
export function bookingReminderBalances<T extends SavedReminder>(rows: readonly T[], total: string, paid: string, today: string,
  basis?: string, baseline = '0') {
  const fallback = basis === 'reminders'
    ? bookingInstalmentBalances(rows, (BigInt(total) > BigInt(baseline) ? BigInt(total) - BigInt(baseline) : 0n).toString(),
      (BigInt(paid) > BigInt(baseline) ? BigInt(paid) - BigInt(baseline) : 0n).toString(), today)
    : bookingInstalmentBalances(rows, total, paid, today);
  return fallback.filter(row => !row.paid).map(row => {
    const remaining_minor = rows.find(item => item.id === row.id)?.remaining_minor ?? row.remaining_minor;
    return { ...row, remaining_minor, payment_status: BigInt(remaining_minor) === 0n ? 'Completed'
      : row.due_date < today ? 'Overdue' : row.due_date === today ? 'Due today' : 'Upcoming' };
  }).sort((a, b) => a.due_date.localeCompare(b.due_date));
}

export function outstandingReminderRows(rows: readonly (SavedReminder & { remaining_minor: string })[]): ReminderRow[] {
  return rows.filter(row => !row.paid && BigInt(row.remaining_minor) > 0n)
    .map(row => ({ key: row.id, id: row.id, due_date: row.due_date, amount: bookingAmountInput(row.remaining_minor) }));
}
