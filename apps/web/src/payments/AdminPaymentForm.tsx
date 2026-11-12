import { useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { dateLabel, errorMessage, money, useResource } from "../api";
import { ErrorNotice } from "../components";
import { businessDate } from "../pages/booking-model";
import type { BookingFileContext } from "../user-files/remote";
import { AdminPaymentRecorder, type ExistingPayment } from "./admin-payment";
import type { Payment } from "./model";

type Props = BookingFileContext & { timeZone: string; onRecorded: (payment: Payment) => void };

export function AdminPaymentActions(props: Props) {
  const [mode, setMode] = useState<"record" | "link" | null>(null);
  return <div className="admin-payment-entry">
    {mode === null ? <div className="payment-actions"><button type="button" className="button" onClick={() => setMode("record")}><Plus size={16} />Record payment</button><button type="button" className="button secondary" onClick={() => setMode("link")}>Use existing payment</button></div>
      : <AdminPaymentForm {...props} mode={mode} onCancel={() => setMode(null)} onRecorded={payment => { setMode(null); props.onRecorded(payment); }} />}
  </div>;
}

export function AdminPaymentForm({ organizationId, customerId, bookingId, timeZone, mode, onRecorded, onCancel }: Props & {
  mode: "record" | "link"; onCancel: () => void;
}) {
  const [recorder] = useState(() => new AdminPaymentRecorder({ organizationId, customerId, bookingId }));
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => businessDate(timeZone));
  const [note, setNote] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const options = useResource<{ items: ExistingPayment[] }>(mode === "link" ? `/organizations/${organizationId}/customers/${customerId}/bookings/payment-options?booking_id=${bookingId}` : null);
  const available = (options.data?.items ?? []).filter(item => !item.already_recorded_for_booking);
  const selected = available.find(item => item.id === selectedId);
  const today = businessDate(timeZone);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const payment = mode === "record" ? await recorder.record({ amount, paymentDate, note }, businessDate(timeZone)) : await recorder.link(selectedId);
      onRecorded(payment);
    } catch (error) { setError(errorMessage(error)); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <form className="payment-upload admin-payment-form" onSubmit={submit} aria-busy={busy} aria-label={mode === "record" ? "Record booking payment" : "Use existing booking payment"}>
    <fieldset disabled={busy}>
      <legend>{mode === "record" ? "Record payment" : "Use existing payment"}</legend>
      {mode === "record" ? <>
        <p className="muted">Record money you have received, including past payments. It counts toward Paid so far immediately.</p>
        <div className="form-columns"><label>Amount received (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>Date received<input required type="date" max={today} value={paymentDate} onChange={event => setPaymentDate(event.target.value)} /><small>Use the actual date the money was received.</small></label></div>
        <label>Note <span className="muted">(optional)</span><textarea rows={2} maxLength={1000} placeholder="Transfer reference or payment details" value={note} onChange={event => setNote(event.target.value)} /></label>
      </> : <>
        <p className="muted">Choose a payment already recorded in this customer’s account. Its full amount will count toward this booking once.</p>
        {options.error ? <><ErrorNotice message={options.error} /><button type="button" className="text-link" onClick={options.refresh}>Try again</button></>
          : !options.data ? <p role="status">Loading existing payments…</p>
          : !available.length ? <p>No unassigned payments are available for this customer.</p>
          : <label>Existing payment<select required value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Choose a payment</option>{available.map(item => <option key={item.id} value={item.id}>{money(item.amount_minor, "GBP", 2)} · {dateLabel(item.payment_date)}{item.reference ? ` · ${item.reference}` : ""}{item.description ? ` · ${item.description}` : ""}</option>)}</select></label>}
        {selected && <p>{money(selected.amount_minor, "GBP", 2)} received on {dateLabel(selected.payment_date)}. The original amount and date will be kept.</p>}
      </>}
      <ErrorNotice message={error} />
      <div className="payment-actions"><button type="submit" className="button" disabled={busy || (mode === "link" && !selected)}>{busy ? "Saving payment…" : mode === "record" ? "Record payment" : "Use payment"}</button><button type="button" className="button secondary" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}
