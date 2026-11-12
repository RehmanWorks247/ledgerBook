import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { ApiError, errorMessage, money, mutate } from "../api";
import { ErrorNotice } from "../components";
import { bookingAmountInput, businessDate } from "../pages/booking-model";
import { paymentsPath, type Payment, type PaymentHistoryAction } from "./model";

type Action = "edit" | "delete" | "restore" | "permanent-delete";
const actionLabels: Record<Action, string> = { edit: "Save payment changes", delete: "Move payment to trash", restore: "Restore payment", "permanent-delete": "Delete payment permanently" };

export function PaymentManagement({ payment, organizationId, timeZone, disabled, onBusyChange, onActionChange, onChanged, onReload }: {
  payment: Payment; organizationId: string; timeZone: string; disabled?: boolean;
  onBusyChange?: (busy: boolean) => void; onActionChange?: (active: boolean) => void; onChanged?: (action: PaymentHistoryAction) => void;
  onReload?: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [amount, setAmount] = useState(() => bookingAmountInput(payment.amount_minor));
  const [date, setDate] = useState(payment.payment_date);
  const [note, setNote] = useState(payment.note);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const previousAction = useRef<Action | null>(null);
  useEffect(() => {
    if (action) form.current?.querySelector<HTMLElement>("input:not([disabled]), textarea")?.focus();
    else if (previousAction.current) controls.current?.querySelector<HTMLButtonElement>("button")?.focus();
    previousAction.current = action;
  }, [action]);
  function choose(next: Action | null) { setAction(next); onActionChange?.(Boolean(next)); setError(""); setReason(""); setConfirmation(""); }
  const approved = payment.status === "approved";
  const activePayment = approved && !payment.reversed;
  const displayAmount = money(payment.amount_minor, "GBP", 2);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || submitting.current) return;
    if (!reason.trim()) { setError("Enter a reason for the payment history."); return; }
    if (action === "permanent-delete" && confirmation !== "DELETE") { setError("Type DELETE to confirm permanent deletion."); return; }
    submitting.current = true; setBusy(true); onBusyChange?.(true); setError("");
    try {
      const path = `${paymentsPath({ organizationId, customerId: payment.customer_id, bookingId: payment.booking_id })}/${payment.id}`;
      const body = { version: payment.version, reason: reason.trim() };
      if (action === "edit") await mutate<Payment>(path, { ...body, amount, payment_date: date, note }, "PATCH");
      else await mutate(`${path}/${action}`, { ...body, ...(action === "permanent-delete" ? { confirmation } : {}) });
      const result: PaymentHistoryAction = action === "edit" ? "updated" : action === "delete" ? "deleted" : action === "restore" ? "restored" : "purged";
      choose(null); onChanged?.(result);
    } catch (cause) { setError(errorMessage(cause)); setConflict(cause instanceof ApiError && cause.status === 409); }
    finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  }
  return <div className="payment-management" ref={controls} aria-busy={busy}>
    {!action ? <div className="payment-actions">
      {payment.deleted_at ? <><button type="button" className="button secondary" disabled={disabled} onClick={() => choose("restore")}><RotateCcw size={16} />Restore payment</button><button type="button" className="button secondary button-danger" disabled={disabled} onClick={() => choose("permanent-delete")}><Trash2 size={16} />Delete permanently</button></>
        : <><button type="button" className="button secondary" disabled={disabled} onClick={() => choose("edit")}><Pencil size={16} />Edit payment</button><button type="button" className="button secondary button-danger" disabled={disabled} onClick={() => choose("delete")}><Trash2 size={16} />Move to trash</button></>}
    </div> : <form ref={form} onSubmit={submit} aria-label={actionLabels[action]}>
      <fieldset className="payment-confirmation" disabled={busy}>
        <legend>{action === "edit" ? "Edit payment" : action === "delete" ? "Move payment to trash" : action === "restore" ? "Restore payment" : "Permanently delete payment"}</legend>
        {action === "edit" && <>
          <p>{activePayment ? `Changing the amount or payment date reverses the original ledger payment and records a corrected payment. The ledger keeps both entries. ${payment.booking_id ? "If the amount changes, the instalment schedule stays unchanged and the corrected payment counts towards the booking balance." : "The corrected payment counts towards the customer’s total account balance."}` : payment.reversed ? "This payment was already reversed. You can update its note; its amount and payment date cannot be changed." : "Update the payment details before review. This submission has not changed the account balance."}</p>
          <div className="form-columns"><label>Payment amount (GBP)<input required disabled={payment.reversed} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} value={amount} onChange={event => setAmount(event.target.value)} /></label><label>Payment date<input required disabled={payment.reversed} type="date" max={businessDate(timeZone)} value={date} onChange={event => setDate(event.target.value)} /></label></div>
          <label>Payment note<textarea aria-label="Payment note" rows={2} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label>
        </>}
        {action === "delete" && <p>{activePayment ? `Moving this payment to trash reverses ${displayAmount} and increases the remaining balance. ` : "This payment does not currently reduce the balance. "}The payment and receipts stay in admin Trash and can be restored. Customers will no longer see this payment in their payment history.</p>}
        {action === "restore" && <p>{payment.restore_credit === true ? `Restoring this approved payment records ${displayAmount} again and reduces the remaining balance. ` : approved ? "This payment was reversed before it was moved to trash. Restoring its history keeps that reversal and does not change the balance. " : "The submission will return with its previous review status and will not change the balance. "}The payment and its receipts will appear in the customer’s payment history.</p>}
        {action === "permanent-delete" && <><p>This permanently removes the payment record and receipt files. It cannot be restored. The ledger entries and audit history remain, and the current account balance will not change.</p><label>Type DELETE to confirm<input autoComplete="off" required value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></>}
        <label>Reason for {action === "edit" ? "change" : action === "restore" ? "restoration" : "deletion"}<textarea required maxLength={1000} rows={2} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain this change for the audit history." /></label>
        <ErrorNotice message={error} />
        {conflict && <p>The payment has changed or this action is no longer available. Close and refresh the history to check its current state before making another change.</p>}
        <div className="payment-actions">{conflict && onReload ? <button type="button" className="button" onClick={onReload}>Close and refresh history</button> : <button className={`button ${action.includes("delete") ? "button-danger" : ""}`} disabled={busy || conflict || !reason.trim() || (action === "permanent-delete" && confirmation !== "DELETE")}>{busy ? "Saving…" : actionLabels[action]}</button>}<button type="button" className="button secondary" disabled={busy} onClick={() => choose(null)}>Cancel</button></div>
      </fieldset>
    </form>}
  </div>;
}
