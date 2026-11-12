import { mutate } from "../api";
import type { BookingFileContext } from "../user-files/remote";
import { paymentsPath, validatePaymentDraft, type Payment } from "./model";

export type RecordedPaymentDraft = { amount: string; paymentDate: string; note: string };
export type ExistingPayment = { id: string; amount_minor: string; payment_date: string; description: string;
  reference: string | null; already_recorded_for_booking: boolean };

/** An unchanged draft keeps its key when the server response is lost. */
export class AdminPaymentRecorder {
  private signature = "";
  private key = "";
  readonly path: string;
  constructor(context: BookingFileContext) { this.path = paymentsPath(context); }

  async record(draft: RecordedPaymentDraft, today: string): Promise<Payment> {
    validatePaymentDraft({ ...draft, files: [] }, today);
    return this.send("record", { amount: draft.amount, payment_date: draft.paymentDate, note: draft.note.trim() });
  }

  async link(paymentEntryId: string): Promise<Payment> {
    if (!/^[1-9]\d{0,18}$/.test(paymentEntryId) || BigInt(paymentEntryId) > 9_223_372_036_854_775_807n)
      throw new Error("Choose an existing payment.");
    return this.send("link", { payment_entry_id: paymentEntryId });
  }

  private async send(operation: "record" | "link", body: Record<string, string>) {
    const signature = JSON.stringify([operation, body]);
    if (signature !== this.signature) { this.signature = signature; this.key = crypto.randomUUID(); }
    const payment = await mutate<Payment>(`${this.path}/${operation}`, { ...body, idempotency_key: this.key });
    this.signature = ""; this.key = "";
    return payment;
  }
}
