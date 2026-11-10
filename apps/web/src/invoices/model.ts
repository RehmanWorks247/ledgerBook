import { ApiError, api, errorMessage } from "../api";
import { loadPrivateAsset } from "../private-assets";

export type InvoiceContext = { organizationId: string; customerId: string; bookingId: string };
export type BookingInvoice = {
  id: string;
  invoice_number: string;
  version: number;
  reason: "booking_created" | "payment_approved" | "payment_reversed" | "charge_reversed" | "booking_updated" | "booking_cancelled" | "legacy_snapshot";
  issued_at: string;
  total_minor: string;
  paid_minor: string;
  balance_minor: string;
  currency: string;
  status: "unpaid" | "partially_paid" | "paid" | "overpaid" | "cancelled";
  filename: string;
};
type InvoicePage = { invoices: BookingInvoice[]; has_more: boolean; next_before_version: number | null };
type InvoiceHistoryState = {
  invoices: BookingInvoice[];
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  nextBeforeVersion: number | null;
};

export const invoiceReasonLabels: Record<BookingInvoice["reason"], string> = {
  booking_created: "Booking created",
  payment_approved: "Payment approved",
  payment_reversed: "Payment reversed",
  charge_reversed: "Charge reversed",
  booking_updated: "Booking updated",
  booking_cancelled: "Booking cancelled",
  legacy_snapshot: "Opening invoice",
};

export function bookingInvoicesPath(context: InvoiceContext) {
  if (![context.organizationId, context.customerId, context.bookingId].every(value => value && /^[a-zA-Z0-9-]+$/.test(value)))
    throw new Error("Open a booking to view its invoices.");
  return `/organizations/${context.organizationId}/customers/${context.customerId}/bookings/${context.bookingId}/invoices`;
}

// One store belongs to one booking. A new refresh invalidates earlier pages,
// including transports that finish after their AbortSignal has been cancelled.
export class BookingInvoiceHistory {
  private state: InvoiceHistoryState = { invoices: [], loaded: false, loading: false, loadingMore: false, error: "", nextBeforeVersion: null };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private request = 0;
  private retryBeforeVersion?: number;
  private readonly path: string;

  constructor(context: InvoiceContext) { this.path = bookingInvoicesPath(context); }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<InvoiceHistoryState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  cancel = () => {
    this.request += 1;
    this.controller?.abort();
  };
  refresh = () => this.load();
  retry = () => this.load(this.retryBeforeVersion);
  loadMore = () => {
    if (this.state.loading || this.state.loadingMore || this.state.nextBeforeVersion === null) return Promise.resolve();
    return this.load(this.state.nextBeforeVersion);
  };
  private async load(beforeVersion?: number) {
    this.cancel();
    const request = this.request;
    const controller = new AbortController();
    this.controller = controller;
    const more = beforeVersion !== undefined;
    this.retryBeforeVersion = beforeVersion;
    this.update({ loading: !more, loadingMore: more, error: "" });
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (more) query.set("before_version", String(beforeVersion));
      const page = await api<InvoicePage>(`${this.path}?${query}`, { signal: controller.signal });
      if (request !== this.request || controller.signal.aborted) return;
      const next = page.has_more ? page.next_before_version : null;
      if (page.has_more && (next === null || !Number.isSafeInteger(next) || next <= 0 || (more && next >= beforeVersion)))
        throw new Error("Invoice history could not be loaded. Please refresh and try again.");
      const invoices = [...new Map([...(more ? this.state.invoices : []), ...page.invoices].map(invoice => [invoice.id, invoice])).values()]
        .sort((a, b) => b.version - a.version);
      this.update({ invoices, nextBeforeVersion: next, loaded: true });
    } catch (cause) {
      if (request !== this.request || controller.signal.aborted) return;
      // A revoked account must never retain financial records from an earlier load.
      const unavailable = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      this.update({ error: errorMessage(cause), ...(unavailable ? { invoices: [], nextBeforeVersion: null, loaded: false } : {}) });
    } finally {
      if (request === this.request && !controller.signal.aborted) this.update({ loading: false, loadingMore: false });
    }
  }
}

export async function loadInvoicePdf(context: InvoiceContext, invoiceId: string, signal?: AbortSignal) {
  if (!invoiceId || !/^[a-zA-Z0-9-]+$/.test(invoiceId)) throw new Error("The invoice address is invalid.");
  const blob = await loadPrivateAsset(`/api${bookingInvoicesPath(context)}/${invoiceId}/pdf`, signal);
  signal?.throwIfAborted();
  if (!blob.size || blob.type.split(";")[0].toLowerCase() !== "application/pdf")
    throw new Error("The invoice PDF could not be loaded. Please try again.");
  return blob;
}

export function invoiceFilename(invoice: Pick<BookingInvoice, "filename" | "invoice_number" | "version">) {
  const name = (invoice.filename || `${invoice.invoice_number}-v${invoice.version}.pdf`)
    .replace(/[\\/]/g, "_").split("").map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character).join("").slice(0, 180);
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}
