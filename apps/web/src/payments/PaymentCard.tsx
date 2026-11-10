import { usePrivateAsset } from "../private-assets";
import { FilePreviewModal } from "../file-preview/FilePreviewModal";
import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Clock3, Expand, ExternalLink, ImageIcon, XCircle } from "lucide-react";
import { dateLabel, errorMessage, money, mutate } from "../api";
import { ErrorNotice } from "../components";
import { departureLabel } from "../pages/booking-model";
import { paymentsPath, receiptPath, type Payment } from "./model";

export function PaymentCard({ payment, organizationId, timeZone, canReview, showBooking = false, onReviewed, onBusyChange }: {
  payment: Payment;
  organizationId: string;
  timeZone: string;
  canReview: boolean;
  showBooking?: boolean;
  onReviewed?: (payment: Payment) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [current, setCurrent] = useState(payment);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [verified, setVerified] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const controls = useRef<HTMLDivElement>(null);
  const previousDecision = useRef(decision);
  useEffect(() => {
    if (decision) controls.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    else if (previousDecision.current) controls.current?.querySelector<HTMLButtonElement>("button")?.focus();
    previousDecision.current = decision;
  }, [decision]);
  const reasonId = useId();
  const confirmationId = useId();
  const amount = money(current.amount_minor, current.currency, 2);
  async function review() {
    if (!decision || submitting.current || (decision === "approve" && !verified)) return;
    if (decision === "reject" && !reason.trim()) { setError("Explain why this payment could not be approved."); return; }
    submitting.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      const path = paymentsPath({ organizationId, customerId: current.customer_id, bookingId: current.booking_id });
      const result = await mutate<Payment>(`${path}/${current.id}/${decision}`, decision === "approve" ? {} : { reason: reason.trim() });
      setCurrent(result);
      setDecision(null);
      onReviewed?.(result);
    } catch (error) { setError(errorMessage(error)); }
    finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  }
  const StatusIcon = current.status === "approved" ? CheckCircle2 : current.status === "rejected" ? XCircle : Clock3;
  return <article className="payment-card" aria-label={`${amount} payment ${current.status}`}>
    <div className="payment-card-heading">
      <div><strong className={`payment-amount ${current.status === "approved" ? "money-payment" : current.status === "rejected" ? "money-charge" : ""}`}>{amount}</strong><span className={`payment-status payment-status-${current.status}`}><StatusIcon size={14} />{current.status === "pending" ? "Pending review" : current.status === "approved" ? "Approved" : "Rejected"}</span></div>
      {showBooking && <a className="text-link" href={`/o/${organizationId}/users/${current.customer_id}/bookings/${current.booking_id}`}>Open booking <ExternalLink size={14} /></a>}
    </div>
    {showBooking && <p className="payment-booking"><strong>{current.customer_name}</strong> <span>{current.customer_code} · {current.booking_reference}</span></p>}
    <dl className="payment-metadata">
      <div><dt>Payment date</dt><dd>{dateLabel(current.payment_date)}</dd></div>
      <div><dt>Uploaded</dt><dd>{departureLabel(current.submitted_at, timeZone)} <small>({timeZone})</small></dd></div>
      {current.reviewed_at && <div><dt>{current.status === "approved" ? "Approved" : "Reviewed"}</dt><dd>{departureLabel(current.reviewed_at, timeZone)}</dd></div>}
      {current.ledger_entry_id && <div><dt>Ledger entry</dt><dd>#{current.ledger_entry_id}</dd></div>}
      {current.reviewed_by_name && <div><dt>Reviewed by</dt><dd>{current.reviewed_by_name}</dd></div>}
    </dl>
    {current.note && <p className="payment-note"><span>Customer note</span>{current.note}</p>}
    {current.status === "rejected" && <p className="payment-rejection"><strong>Review note</strong>{current.rejection_reason || "This submission was not approved."}{!canReview && <span>Check the details, then submit new receipts above if you need another review.</span>}</p>}
    <div className="payment-receipts" aria-label="Payment receipt images">{current.receipts.map((receipt, index) => {
      const url = receiptPath(organizationId, current, receipt.id);
      return <ReceiptImage key={receipt.id} path={url} name={receipt.name} mimeType={receipt.mime_type} size={receipt.size} index={index} bookingReference={current.booking_reference} />;
    })}</div>
    {current.status === "pending" && <p className="payment-pending-note">Awaiting manual verification. This submission has not changed the account balance.</p>}
    {current.status === "approved" && <p className="payment-pending-note">Payment approved and recorded in the account ledger.</p>}
    <ErrorNotice message={error} />
    {canReview && current.status === "pending" && <div ref={controls} className="payment-review-controls" aria-busy={busy}>
      {!decision ? <div className="payment-actions"><button type="button" className="button button-success" onClick={() => { setVerified(false); setError(""); setDecision("approve"); }}><CheckCircle2 size={16} />Approve payment</button><button type="button" className="button secondary button-danger" onClick={() => { setError(""); setDecision("reject"); }}><XCircle size={16} />Reject submission</button></div> : <fieldset disabled={busy} className="payment-confirmation">
        <legend>{decision === "approve" ? "Confirm payment approval" : "Reject this submission"}</legend>
        {decision === "approve" ? <>
          <p id={confirmationId}>Approval records <strong>{amount}</strong> as a payment dated <strong>{dateLabel(current.payment_date)}</strong>, reduces the customer’s balance and emails their confirmation. Check that this payment has not already been entered manually.</p>
          <label className="payment-verified"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} aria-describedby={confirmationId} />I have checked the receipts and verified that the money was received.</label>
        </> : <label htmlFor={reasonId}>Reason visible to the customer<textarea id={reasonId} required maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain what needs to be corrected." /></label>}
        <div className="payment-actions"><button type="button" className={`button ${decision === "approve" ? "button-success" : "button-danger"}`} disabled={busy || (decision === "approve" ? !verified : !reason.trim())} onClick={() => void review()}>{busy ? "Saving…" : decision === "approve" ? "Confirm approval" : "Confirm rejection"}</button><button type="button" className="button secondary" onClick={() => setDecision(null)}>Cancel</button></div>
      </fieldset>}
    </div>}
  </article>;
}

function ReceiptImage({ path, name, mimeType, size, index, bookingReference }: { path: string; name: string; mimeType: string; size: number; index: number; bookingReference: string }) {
  const { url, error, blob } = usePrivateAsset(path);
  const [previewing, setPreviewing] = useState(false);
  if (error) return <div className="payment-receipt"><ErrorNotice message={`${name}: ${error}`} /></div>;
  if (!url) return <div className="payment-receipt" role="status">Loading {name}…</div>;
  return <><button type="button" className="payment-receipt" style={{ padding: 0, textAlign: "left", background: "var(--surface)", width: "100%" }} aria-label={`Preview receipt ${index + 1}: ${name}`} aria-haspopup="dialog" onClick={() => setPreviewing(true)}>
    <img src={url} alt={`Receipt ${index + 1} for ${bookingReference}`} loading="lazy" />
    <span><ImageIcon size={13} /><span>{name}</span><Expand size={13} /></span>
  </button>{previewing && <FilePreviewModal file={{ name, mimeType, size, url: path, blob }} onClose={() => setPreviewing(false)} />}</>;
}
