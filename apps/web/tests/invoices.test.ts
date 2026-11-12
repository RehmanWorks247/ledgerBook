import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setTokenProvider } from "../src/api";
import { BookingInvoiceHistory, bookingInvoicesPath, invoiceFilename, loadInvoicePdf, type BookingInvoice } from "../src/invoices/model";
import { InvoiceTable } from "../src/invoices/BookingInvoices";

const context = { organizationId: "org-1", customerId: "customer-1", bookingId: "booking-1" };
const invoice: BookingInvoice = {
  id: "invoice-3", invoice_number: "INV-2026-001", version: 3, reason: "payment_approved", issued_at: "2026-11-06T23:30:00Z",
  total_minor: "100000", paid_minor: "25000", balance_minor: "75000", currency: "GBP", status: "partially_paid", filename: "INV-2026-001-v3.pdf",
};
const page = (invoices: BookingInvoice[], next: number | null = null) => Response.json({ invoices, has_more: next !== null, next_before_version: next });
const settle = () => new Promise(resolve => setImmediate(resolve));

test("invoice history loads only metadata with authentication and paginates without duplicate versions", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  setTokenProvider(async () => "invoice-session");
  globalThis.fetch = async (input, options = {}) => {
    requests.push(String(input));
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer invoice-session");
    assert.equal(options.credentials, "include");
    assert.ok(options.signal);
    return requests.length === 1 ? page([invoice], 3) : page([{ ...invoice, id: "invoice-2", version: 2 }, invoice]);
  };
  try {
    const history = new BookingInvoiceHistory(context);
    assert.equal(requests.length, 0, "constructing history must not prefetch metadata or PDFs");
    await history.refresh();
    assert.equal(history.getSnapshot().invoices[0].id, invoice.id);
    await history.loadMore();
    assert.deepEqual(history.getSnapshot().invoices.map(item => item.version), [3, 2]);
    assert.deepEqual(requests, [`/api${bookingInvoicesPath(context)}?limit=25`, `/api${bookingInvoicesPath(context)}?limit=25&before_version=3`]);
    await history.loadMore();
    assert.equal(requests.length, 2, "the terminal page must not be reloaded");
    assert.equal(history.getSnapshot().loadingMore, false);
  } finally { globalThis.fetch = originalFetch; setTokenProvider(async () => null); }
});

test("a refresh invalidates a slower older page and duplicate load-more clicks share one request", async () => {
  const originalFetch = globalThis.fetch;
  let resolveOlder!: (response: Response) => void;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return page([invoice], 3);
    if (requests === 2) return new Promise<Response>(resolve => { resolveOlder = resolve; });
    return page([{ ...invoice, id: "invoice-4", version: 4 }], 4);
  };
  try {
    const history = new BookingInvoiceHistory(context);
    await history.refresh();
    const older = history.loadMore();
    await history.loadMore();
    await settle();
    assert.equal(requests, 2);
    await history.refresh();
    resolveOlder(page([{ ...invoice, id: "invoice-2", version: 2 }]));
    await older;
    assert.deepEqual(history.getSnapshot().invoices.map(item => item.version), [4]);
    assert.equal(history.getSnapshot().nextBeforeVersion, 4);
  } finally { globalThis.fetch = originalFetch; }
});

test("stale refresh failures and disposed booking responses cannot replace the current history", async () => {
  const originalFetch = globalThis.fetch;
  const resolves: ((value: Response) => void)[] = [];
  globalThis.fetch = () => new Promise(resolve => resolves.push(resolve));
  try {
    const history = new BookingInvoiceHistory(context);
    const previous = history.refresh();
    const current = history.refresh();
    await settle();
    resolves[1](page([invoice]));
    await current;
    resolves[0](Response.json({ message: "Expired old request" }, { status: 401 }));
    await previous;
    assert.equal(history.getSnapshot().error, "");
    assert.equal(history.getSnapshot().invoices.length, 1);
    const leaving = new BookingInvoiceHistory({ ...context, bookingId: "booking-2" });
    const response = leaving.refresh();
    await settle();
    leaving.cancel();
    resolves[2](page([invoice]));
    await response;
    assert.equal(leaving.getSnapshot().loaded, false);
    assert.deepEqual(leaving.getSnapshot().invoices, []);
  } finally { globalThis.fetch = originalFetch; }
});

test("transient errors retain history and retry the failed page, while revoked access clears records", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const responses = [page([invoice], 3), Response.json({ message: "Temporarily unavailable" }, { status: 503 }), page([{ ...invoice, id: "invoice-2", version: 2 }]), Response.json({ message: "Access denied" }, { status: 403 })];
  globalThis.fetch = async input => { requests.push(String(input)); return responses.shift()!; };
  try {
    const history = new BookingInvoiceHistory(context);
    await history.refresh();
    await history.loadMore();
    assert.equal(history.getSnapshot().error, "Temporarily unavailable");
    assert.equal(history.getSnapshot().invoices.length, 1);
    await history.retry();
    assert.equal(requests[1], requests[2]);
    assert.deepEqual(history.getSnapshot().invoices.map(item => item.version), [3, 2]);
    await history.refresh();
    assert.equal(history.getSnapshot().error, "Access denied");
    assert.deepEqual(history.getSnapshot().invoices, []);
    assert.equal(history.getSnapshot().nextBeforeVersion, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("refresh retry restarts the latest page and invalid pagination cannot loop forever", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const responses = [page([invoice], 3), Response.json({ message: "Retry latest" }, { status: 503 }), page([invoice], 3), page([{ ...invoice, id: "invoice-2", version: 2 }], 3)];
  globalThis.fetch = async input => { requests.push(String(input)); return responses.shift()!; };
  try {
    const history = new BookingInvoiceHistory(context);
    await history.refresh();
    await history.refresh();
    await history.retry();
    assert.equal(requests[1], requests[2]);
    assert.doesNotMatch(requests[2], /before_version/);
    await history.loadMore();
    assert.match(history.getSnapshot().error, /refresh and try again/);
    assert.equal(history.getSnapshot().invoices.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("invoice downloads authenticate the exact booking and reject error pages or cancelled responses", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let invalid = false;
  setTokenProvider(async () => "private-invoice-token");
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(String(input), `/api${bookingInvoicesPath(context)}/${invoice.id}/pdf`);
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer private-invoice-token");
    assert.equal(options.credentials, "include");
    assert.equal(options.signal, controller.signal);
    return new Response(invalid ? "<!doctype html>Sign in" : "%PDF-1.4 invoice", { headers: { "Content-Type": invalid ? "text/html" : "application/pdf" } });
  };
  try {
    assert.equal(await (await loadInvoicePdf(context, invoice.id, controller.signal)).text(), "%PDF-1.4 invoice");
    invalid = true;
    await assert.rejects(loadInvoicePdf(context, invoice.id, controller.signal), /PDF could not be loaded/);
    invalid = false;
    controller.abort();
    await assert.rejects(loadInvoicePdf(context, invoice.id, controller.signal), { name: "AbortError" });
    await assert.rejects(loadInvoicePdf(context, "../../other-booking"), /address is invalid/);
  } finally { globalThis.fetch = originalFetch; setTokenProvider(async () => null); }
});

test("invoice paths cannot escape the booking and download filenames remain local PDF filenames", () => {
  assert.throws(() => bookingInvoicesPath({ ...context, customerId: "../other" }), /Open a booking/);
  assert.throws(() => bookingInvoicesPath({ ...context, organizationId: "" }), /Open a booking/);
  assert.equal(invoiceFilename(invoice), invoice.filename);
  assert.equal(invoiceFilename({ ...invoice, filename: "../folder\\invoice\n" }), ".._folder_invoice_.pdf");
  assert.equal(invoiceFilename({ ...invoice, filename: "" }), "INV-2026-001-v3.pdf");
});

test("invoice rows expose historical amounts, local issue dates, credit and lazy accessible PDF actions", () => {
  const html = renderToStaticMarkup(h(InvoiceTable, {
    invoices: [invoice, { ...invoice, id: "invoice-2", version: 2, reason: "payment_reversed", status: "overpaid", total_minor: "900719925474099312", paid_minor: "900719925474099412", balance_minor: "-100" }],
    timeZone: "Asia/Karachi", currencyExponent: 2, downloading: "", onDownload: () => undefined, onPreview: () => undefined,
  }));
  assert.match(html, /<caption/);
  assert.match(html, /Version 3 · Latest/);
  assert.match(html, /7 Nov 2026, 04:30/);
  assert.match(html, /Payment approved/);
  assert.match(html, /Payment reversed/);
  assert.match(html, /GBP 750\.00/);
  assert.match(html, /GBP 9,007,199,254,740,993\.12/);
  assert.match(html, /−GBP 1\.00/);
  assert.match(html, /Credit/);
  assert.match(html, /aria-label="Download INV-2026-001 version 3 as PDF"/);
  assert.match(html, /aria-label="Preview INV-2026-001 version 3"/);
  assert.doesNotMatch(html, /href=|<iframe|<object|<embed/, "PDFs must be fetched with session headers only after a click");
});
