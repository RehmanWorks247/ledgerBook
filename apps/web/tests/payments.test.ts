import { setTokenProvider } from "../src/api";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentCard } from "../src/payments/PaymentCard";
import { MAX_RECEIPT_BYTES, PaymentUploader, paymentsPath, receiptPath, validatePaymentDraft, validateReceiptFiles, type Payment } from "../src/payments/model";

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  bookingId: "33333333-3333-4333-8333-333333333333",
};
const payment: Payment = {
  id: "44444444-4444-4444-8444-444444444444",
  customer_id: context.customerId, customer_name: "Aster Studio", customer_code: "CU001",
  booking_id: context.bookingId, booking_reference: "TRIP-2026", amount_minor: "12550", currency: "GBP",
  payment_date: "2026-11-06", submitted_at: "2026-11-06T12:00:00Z", status: "pending", note: "Bank transfer AB123",
  reviewed_at: null, rejection_reason: null, ledger_entry_id: null,
  receipts: [{ id: "55555555-5555-4555-8555-555555555555", name: "receipt.png", mime_type: "image/png", size: 1234, url: "https://untrusted.test/receipt.png" }],
};
const file = (name = "receipt.png", content = "image content") => new File([content], name, { type: "image/png" });
const draft = () => ({ amount: "125.50", paymentDate: "2026-11-06", note: "Bank transfer AB123", files: [file()] });

test("multiple receipt uploads use authenticated multipart and reuse a lost response's submission key", async () => {
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  setTokenProvider(async () => "payment-session");
  const submission = { ...draft(), files: [file("first.png"), file("second.png")] };
  let loseResponse = true;
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(input, `/api${paymentsPath(context)}`);
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "include");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("X-CSRF-Protection"), "1");
    assert.equal(headers.get("Authorization"), "Bearer payment-session");
    assert.equal(headers.has("Content-Type"), false, "browser must supply the multipart boundary");
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("amount"), "125.50");
    assert.equal(options.body.get("payment_date"), "2026-11-06");
    assert.equal(options.body.get("note"), "Bank transfer AB123");
    assert.equal(options.body.getAll("receipts").length, 2);
    assert.deepEqual(options.body.getAll("receipts").map(value => (value as File).name), ["first.png", "second.png"]);
    keys.push(options.body.get("idempotency_key") as string);
    if (loseResponse) { loseResponse = false; throw new Error("Connection interrupted"); }
    return Response.json(payment);
  };
  try {
    const uploader = new PaymentUploader(context);
    await assert.rejects(uploader.submit(submission, "2026-11-06"), /Connection interrupted/);
    assert.equal((await uploader.submit(submission, "2026-11-06")).id, payment.id);
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^[0-9a-f-]{36}$/);
    await uploader.submit(submission, "2026-11-06");
    assert.notEqual(keys[2], keys[1], "a new submission after success has a new key");
  } finally { globalThis.fetch = originalFetch; setTokenProvider(async () => null); }
});

test("edited amounts, dates, notes and receipt selections cannot reuse a previous draft's key", async () => {
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  globalThis.fetch = async (_input, options = {}) => {
    keys.push((options.body as FormData).get("idempotency_key") as string);
    throw new Error("Response unavailable");
  };
  try {
    const uploader = new PaymentUploader(context);
    const original = draft();
    for (const changed of [original, { ...original, amount: "125.51" }, { ...original, paymentDate: "2026-11-05" }, { ...original, note: "Corrected reference" }, { ...original, files: [file("replacement.png")] }])
      await assert.rejects(uploader.submit(changed, "2026-11-06"), /Response unavailable/);
    assert.equal(new Set(keys).size, 5);
    uploader.reset();
    await assert.rejects(uploader.submit(original, "2026-11-06"), /Response unavailable/);
    assert.notEqual(keys[5], keys[0]);
  } finally { globalThis.fetch = originalFetch; }
});

test("invalid receipt batches and payment dates fail before any network write", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("invalid payment must not be posted"); };
  try {
    const uploader = new PaymentUploader(context);
    const original = draft();
    for (const changed of [
      { ...original, files: [] },
      { ...original, files: Array.from({ length: 6 }, () => file()) },
      { ...original, files: [new File(["svg"], "receipt.svg", { type: "image/svg+xml" })] },
      { ...original, files: [new File([new Uint8Array(MAX_RECEIPT_BYTES + 1)], "large.png", { type: "image/png" })] },
      { ...original, files: [file("empty.png", "")] },
      { ...original, amount: "0" }, { ...original, amount: "-1.00" },
      { ...original, amount: "1.001" }, { ...original, amount: "1e3" },
      { ...original, paymentDate: "2026-02-31" }, { ...original, paymentDate: "2026-11-07" },
      { ...original, note: "a".repeat(1001) },
    ]) await assert.rejects(uploader.submit(changed, "2026-11-06"));
    assert.throws(() => new PaymentUploader({ ...context, bookingId: "../foreign" }), /Select a customer/);
  } finally { globalThis.fetch = originalFetch; }
});

test("money validation uses exact minor units at limits and accepts supported image types", () => {
  assert.doesNotThrow(() => validatePaymentDraft({ ...draft(), amount: "1000000000000.00" }, "2026-11-06"));
  assert.throws(() => validatePaymentDraft({ ...draft(), amount: "1000000000000.01" }, "2026-11-06"), /no greater/);
  assert.doesNotThrow(() => validatePaymentDraft({ ...draft(), amount: "0.01" }, "2026-11-06"));
  assert.doesNotThrow(() => validateReceiptFiles([
    new File(["image"], "BANK.JPG", { type: "image/jpeg" }),
    new File(["image"], "BANK.webp", { type: "image/webp" }),
  ]));
});

test("server validation messages are preserved and a failed submission stays retryable", async () => {
  const originalFetch = globalThis.fetch;
  const keys: FormDataEntryValue[] = [];
  globalThis.fetch = async (_input, options = {}) => {
    keys.push((options.body as FormData).get("idempotency_key")!);
    return Response.json({ message: ["Invalid image contents.", "Choose a different receipt."] }, { status: 400 });
  };
  try {
    const uploader = new PaymentUploader(context);
    const original = draft();
    await assert.rejects(uploader.submit(original, "2026-11-06"), /Invalid image contents\. Choose a different receipt\./);
    await assert.rejects(uploader.submit(original, "2026-11-06"));
    assert.equal(keys[0], keys[1]);
  } finally { globalThis.fetch = originalFetch; }
});

test("payment cards expose review actions only to admins and distinguish pending from credited funds", () => {
  const render = (canReview: boolean, item = payment) => renderToStaticMarkup(createElement(PaymentCard, {
    payment: item, organizationId: context.organizationId, timeZone: "UTC", canReview, showBooking: canReview,
  }));
  const customer = render(false);
  assert.match(customer, /Pending review/);
  assert.match(customer, /has not changed the account balance/);
  assert.doesNotMatch(customer, /Approve payment|Reject submission|Confirm approval/);
  const admin = render(true);
  assert.match(admin, /Approve payment/);
  assert.match(admin, /Reject submission/);
  assert.match(admin, /Aster Studio/);
  assert.match(admin, /TRIP-2026/);
  assert.match(admin, /GBP 125.50/);
  assert.match(admin, /6 Nov 2026/);
  assert.doesNotMatch(admin, /untrusted\.test/);
  assert.match(admin, /Loading receipt.png/);
  assert.doesNotMatch(admin, /(?:src|href)="\/api\//);
  assert.equal(receiptPath(context.organizationId, payment, payment.receipts[0].id), `/api${paymentsPath(context)}/${payment.id}/receipts/${payment.receipts[0].id}`);
  const approved = render(true, { ...payment, status: "approved", reviewed_at: "2026-11-06T13:00:00Z", ledger_entry_id: "91" });
  assert.match(approved, /Payment approved and recorded/);
  assert.match(approved, /#91/);
  assert.doesNotMatch(approved, /Approve payment|Reject submission|has not changed/);
  const rejected = render(false, { ...payment, status: "rejected", rejection_reason: "The transfer reference is incomplete." });
  assert.match(rejected, /transfer reference is incomplete/);
  assert.match(rejected, /submit new receipts/);
  assert.throws(() => receiptPath(context.organizationId, payment, "https://outside.test"), /invalid/);
});
