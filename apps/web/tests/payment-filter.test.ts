import assert from "node:assert/strict";
import { test } from "node:test";
import { filterBookingPayments, type PaymentHistoryFilters } from "../src/payments/payment-filter";
import type { Payment } from "../src/payments/model";

const payment: Payment = {
  id: "payment-identity", customer_id: "customer-identity", customer_name: "Aster Studio", customer_code: "CU001",
  booking_id: "booking-identity", booking_reference: "TRIP-2026", amount_minor: "125050", currency: "GBP",
  payment_date: "2026-11-04", submitted_at: "2026-11-06T23:30:00Z", status: "approved", note: "Transfer AB123",
  reviewed_at: "2026-11-07T23:30:00Z", rejection_reason: null, ledger_entry_id: "91",
  receipts: [{ id: "receipt-identity", name: "bank-evidence.webp", mime_type: "image/webp", size: 1234, url: "unused" }],
};
const filters: PaymentHistoryFilters = { search: "", status: "all", from: "", to: "" };
const search = (query: string, timeZone = "Asia/Karachi") => filterBookingPayments([payment], { ...filters, search: query }, timeZone);

test("booking payment search finds displayed business dates and prevents date token collisions", () => {
  for (const query of ["2026-11-07", "07 Nov 2026", "7 November 2026", "07/11/2026", "2026-11-08", "08 Nov 2026"])
    assert.equal(search(query).length, 1, query);
  assert.equal(search("06 Nov 2026").length, 0, "UTC upload date must not substitute for its displayed business date");
  assert.equal(search("06 Nov 2026", "UTC").length, 1);
  assert.equal(search("04 Nov 2026").length, 1, "payment dates remain date-only in every timezone");
  assert.equal(search("03 Nov 2026").length, 0);
  const september = { ...payment, payment_date: "2026-09-25" };
  assert.equal(filterBookingPayments([september], { ...filters, search: "25 Sept 2026" }, "UTC").length, 1);
});

test("booking payment search accepts grouped and plain decimals and pound or GBP notation", () => {
  for (const query of ["1250.50", "1,250.50", "GBP 1250.50", "GBP 1,250.50", "£1250.50", "£1,250.50"])
    assert.equal(search(query).length, 1, query);
  assert.equal(search("1250.51").length, 0);
});

test("booking payment search combines names, identifiers, notes and receipt fields with status and date filters", () => {
  for (const query of ["payment-identity", "customer-identity", "booking-identity", "receipt-identity", "ASTER studio", "CU001", "TRIP-2026 AB123", "bank-evidence", "91"])
    assert.equal(search(query).length, 1, query);
  const rejected: Payment = { ...payment, id: "rejected-payment", status: "rejected", rejection_reason: "Missing bank reference" };
  assert.equal(filterBookingPayments([payment, rejected], { ...filters, search: "missing reference", status: "rejected" }, "UTC")[0].id, rejected.id);
  assert.equal(filterBookingPayments([payment], { ...filters, from: "2026-11-04", to: "2026-11-04" }, "UTC").length, 1);
  assert.equal(filterBookingPayments([payment], { ...filters, from: "2026-11-05" }, "UTC").length, 0);
  assert.equal(filterBookingPayments([payment], { ...filters, from: "2026-11-05", to: "2026-11-04" }, "UTC").length, 0);
  assert.equal(filterBookingPayments([payment], { ...filters, status: "pending" }, "UTC").length, 0);
});
