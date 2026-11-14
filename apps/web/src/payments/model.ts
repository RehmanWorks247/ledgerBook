import { ApiError, authenticatedFetch } from "../api";
import { bookingFilesPath } from "../user-files/remote";

export const MAX_RECEIPT_FILES = 5;
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const RECEIPT_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
export type PaymentStatus = "pending" | "approved" | "rejected";
export type Payment = {
  id: string;
  booking_id: string | null;
  booking_reference: string | null;
  invoice_id?: string | null;
  invoice_number?: string | null;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  amount_minor: string;
  currency: "GBP";
  payment_date: string;
  submitted_at: string;
  status: PaymentStatus;
  source?: 'customer_receipt' | 'booking_instalment';
  reversed?: boolean;
  version?: number;
  deleted_at?: string | null;
  deletion_reason?: string | null;
  restore_credit?: boolean | null;
  note: string;
  reviewed_at: string | null;
  reviewed_by_name?: string;
  rejection_reason: string | null;
  ledger_entry_id: string | null;
  receipts: { id: string; name: string; mime_type: string; size: number; url: string }[];
};
export type PaymentReviewStatus = PaymentStatus | "all";
export type PaymentHistoryAction = "updated" | "deleted" | "restored" | "purged";
export const paymentHistoryNotices: Record<PaymentHistoryAction, string> = {
  updated: "Payment updated. The account balance has been refreshed.",
  deleted: "Payment moved to trash. You can restore it from the Trash tab.",
  restored: "Payment restored. The account balance has been refreshed.",
  purged: "Payment and receipts permanently deleted. The ledger and audit history are retained.",
};
export type PaymentReviewCounts = Record<PaymentReviewStatus, number>;
export type PaymentsResponse = { items: Payment[]; time_zone: string; total?: number; page?: number;
  page_size?: number; total_pages?: number; counts?: PaymentReviewCounts };
export type PaymentReviewResponse = PaymentsResponse & { total: number; page: number; page_size: number;
  total_pages: number; counts: PaymentReviewCounts };
export type PaymentDraft = { amount: string; paymentDate: string; note: string; files: readonly File[]; invoiceId?: string };

export function validateReceiptFiles(files: readonly File[]) {
  if (files.length > MAX_RECEIPT_FILES)
    throw new Error("Attach no more than 5 receipt files.");
  for (const file of files) {
    if (!RECEIPT_ACCEPT.split(",").includes(file.type) || !(file.type === "application/pdf" ? /\.pdf$/i : /\.(jpe?g|png|webp)$/i).test(file.name))
      throw new Error(`${file.name}: choose a PDF, JPG, PNG or WebP file.`);
    if (file.size === 0 || file.size > MAX_RECEIPT_BYTES)
      throw new Error(`${file.name}: files must be nonempty and no larger than 5 MB.`);
  }
}

export function validatePaymentDraft(draft: PaymentDraft, today: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(draft.amount) || draft.amount.length > 20)
    throw new Error("Enter the amount paid in GBP, with up to two decimal places.");
  const [whole, fraction = ""] = draft.amount.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount < 1n || amount > 100000000000000n)
    throw new Error("Enter a positive payment amount no greater than GBP 1,000,000,000,000.00.");
  const date = new Date(`${draft.paymentDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paymentDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== draft.paymentDate)
    throw new Error("Enter a valid payment date.");
  if (draft.paymentDate > today) throw new Error("The payment date cannot be in the future.");
  if (draft.note.length > 1000) throw new Error("Keep the payment note within 1,000 characters.");
  validateReceiptFiles(draft.files);
}

export type PaymentContext = { organizationId: string; customerId: string; bookingId?: string | null };

export function paymentsPath(context: PaymentContext) {
  if (context.bookingId != null) return `${bookingFilesPath({ ...context, bookingId: context.bookingId })}/payments`;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![context.organizationId, context.customerId].every(id => uuid.test(id)))
    throw new Error("Select a customer account before submitting a payment.");
  return `/organizations/${context.organizationId}/customers/${context.customerId}/payments`;
}

// Never use an arbitrary server-supplied URL for a private financial attachment.
export function receiptPath(organizationId: string, payment: Pick<Payment, "id" | "customer_id" | "booking_id">, receiptId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![payment.id, receiptId].every(id => uuid.test(id))) throw new Error("The receipt address is invalid.");
  return `/api${paymentsPath({ organizationId, customerId: payment.customer_id, bookingId: payment.booking_id })}/${payment.id}/receipts/${receiptId}`;
}

/** Retains the exact retry key after a lost response; edited drafts receive a new key. */
export class PaymentUploader {
  private signature = "";
  private key = "";
  private fileIds = new WeakMap<File, string>();
  readonly path: string;
  constructor(context: PaymentContext) { this.path = paymentsPath(context); }

  reset() { this.signature = ""; this.key = ""; }

  async submit(draft: PaymentDraft, today: string): Promise<Payment> {
    validatePaymentDraft(draft, today);
    const signature = JSON.stringify([draft.amount, draft.paymentDate, draft.note, draft.invoiceId, draft.files.map(file => {
      if (!this.fileIds.has(file)) this.fileIds.set(file, crypto.randomUUID());
      return this.fileIds.get(file);
    })]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.key = crypto.randomUUID();
    }
    const form = new FormData();
    form.set("amount", draft.amount);
    form.set("payment_date", draft.paymentDate);
    form.set("note", draft.note);
    form.set("idempotency_key", this.key);
    if (draft.invoiceId) form.set("invoice_id", draft.invoiceId);
    draft.files.forEach(file => form.append("receipts", file, file.name));
    const response = await authenticatedFetch(this.path, {
      method: "POST", body: form,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string | string[] };
      throw new ApiError(Array.isArray(payload.message) ? payload.message.join(" ") : payload.message || "The receipt upload could not be completed. Please try again.", response.status);
    }
    const payment = await response.json() as Payment;
    this.reset();
    return payment;
  }
}
