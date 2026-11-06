import { dateLabel, money } from "../api";
import { businessDate, departureLabel } from "../pages/booking-model";
import type { Payment, PaymentReviewStatus } from "./model";

export type PaymentHistoryFilters = { search: string; status: PaymentReviewStatus; from: string; to: string };

function searchTerms(value: string) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const iso = (original: string, day: string, month: string, year: string) => {
    const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : original;
  };
  // A displayed date is one search value, so "06" cannot accidentally match the year "2026".
  return value.replace(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\s+(\d{4})\b/gi,
    (original, day: string, month: string, year: string) => iso(original, day, String(months.indexOf(month.slice(0, 3).toLowerCase()) + 1), year))
    .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, iso)
    .replace(/£/g, "GBP ").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function filterBookingPayments(payments: Payment[], filters: PaymentHistoryFilters, timeZone: string) {
  if (filters.from && filters.to && filters.from > filters.to) return [];
  const terms = searchTerms(filters.search);
  return payments.filter(payment => {
    if ((filters.status !== "all" && payment.status !== filters.status)
      || (filters.from && payment.payment_date < filters.from)
      || (filters.to && payment.payment_date > filters.to)) return false;
    if (!terms.length) return true;
    const minor = BigInt(payment.amount_minor);
    const decimal = `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
    const timestampTerms = [payment.submitted_at, payment.reviewed_at].filter((value): value is string => Boolean(value))
      .flatMap(value => {
        const date = businessDate(timeZone, new Date(value));
        return [date, dateLabel(date), departureLabel(value, timeZone)];
      });
    const text = [payment.id, payment.booking_id, payment.booking_reference, payment.customer_id,
      payment.customer_name, payment.customer_code, payment.note, payment.rejection_reason,
      payment.ledger_entry_id, payment.status, payment.payment_date, dateLabel(payment.payment_date),
      decimal, money(payment.amount_minor, payment.currency, 2), ...timestampTerms,
      ...payment.receipts.flatMap(receipt => [receipt.id, receipt.name])].join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
