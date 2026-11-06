import assert from "node:assert/strict";
import { test } from "node:test";
import { filterBookings, type BookingFilters } from "../src/pages/booking-model";

const bookings = [
  { id: "trip-001", customer_id: "customer-123", customer_code: "LB-0042", reference: "UMRAH-2026", departure_at: "2026-11-05T20:30:00Z", required_services: ["flight", "makkah"], total_minor: "250050" },
  { id: "trip-002", customer_id: "customer-123", customer_code: "LB-0042", reference: "WINTER-2026", departure_at: "2026-11-06T20:30:00Z", required_services: ["visas"], total_minor: "900719925474099125" },
];
const all: BookingFilters = { search: "", start: "", end: "", service: "" };

test("booking date filters use inclusive business dates across a UTC date boundary", () => {
  assert.deepEqual(filterBookings(bookings, { ...all, start: "2026-11-06", end: "2026-11-06" }, "Asia/Karachi").map(booking => booking.id), ["trip-001"]);
  assert.deepEqual(filterBookings(bookings, { ...all, start: "2026-11-07", end: "2026-11-06" }, "Asia/Karachi"), []);
  assert.deepEqual(filterBookings(bookings, { ...all, end: "2026-11-05" }, "Asia/Karachi"), []);
});

test("booking search combines ID, reference, date, service and exact large amount text", () => {
  for (const search of ["trip-001", "umrah 2026", "LB-0042 FLIGHT", "06 Nov 2026", "2026-11-06", "£2,500.50", "2500.50"]) {
    assert.deepEqual(filterBookings(bookings, { ...all, search }, "Asia/Karachi").map(booking => booking.id), ["trip-001"], search);
  }
  assert.equal(filterBookings(bookings, { ...all, search: "9007199254740991.25" }, "Asia/Karachi")[0].id, "trip-002");
  assert.equal(filterBookings(bookings, { ...all, search: "customer-123", service: "visas" }, "Asia/Karachi")[0].id, "trip-002");
  assert.deepEqual(filterBookings(bookings, { ...all, search: "UMRAH", service: "visas" }, "Asia/Karachi"), []);
});
