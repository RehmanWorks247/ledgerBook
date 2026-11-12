import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FileText, ImagePlus, RefreshCw, Upload, X } from "lucide-react";
import { errorMessage, useResource } from "../api";
import { Empty, ErrorNotice, TableSkeleton, Pagination } from "../components";
import { Link } from "../router";
import { useOrganization } from "../state";
import { businessDate } from "../pages/booking-model";
import { PaymentDetailsDialog, PaymentTable } from "./PaymentTable";
import { MAX_RECEIPT_FILES, PaymentUploader, RECEIPT_ACCEPT, paymentHistoryNotices, paymentsPath, validateReceiptFiles, type Payment, type PaymentHistoryAction, type PaymentReviewStatus, type PaymentsResponse } from "./model";
import { filterBookingPayments } from "./payment-filter";
import { AdminPaymentActions } from "./AdminPaymentForm";
export { PaymentReviewPage } from "./PaymentReviewPage";

function FilePreview({ file, index, onRemove, disabled }: { file: File; index: number; onRemove: () => void; disabled: boolean }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <div className="payment-preview">{file.type === "application/pdf" ? <FileText size={40} aria-label="PDF receipt" /> : url && <img src={url} alt={`Selected receipt ${index + 1}`} />}<div><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024).toLocaleString()} KB</small></div><button type="button" className="icon-button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${file.name}`}><X size={17} /></button></div>;
}

export function ReceiptUploadForm({ organizationId, customerId, bookingId, timeZone, paymentRequest = 0, onSubmitted, onCancel }: {
  organizationId: string; customerId: string; bookingId?: string; timeZone: string; paymentRequest?: number; onSubmitted: (payment: Payment) => void; onCancel?: () => void;
}) {
  const [uploader] = useState(() => new PaymentUploader({ organizationId, customerId, bookingId }));
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => businessDate(timeZone));
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const inputId = useId();
  const helpId = useId();
  const today = businessDate(timeZone);
  useEffect(() => {
    if (!paymentRequest) return;
    form.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    form.current?.querySelector<HTMLInputElement>("input[inputmode='decimal']")?.focus({ preventScroll: true });
  }, [paymentRequest]);
  function changed() { uploader.reset(); setError(""); }
  function selectFiles(selected: FileList | null) {
    if (!selected?.length) return;
    const next = [...files, ...Array.from(selected)];
    try { validateReceiptFiles(next); changed(); setFiles(next); }
    catch (error) { setError(errorMessage(error)); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await uploader.submit({ amount, paymentDate, note, files }, businessDate(timeZone));
      setFiles([]);
      setAmount("");
      setNote("");
      setPaymentDate(businessDate(timeZone));
      onSubmitted(result);
    } catch (error) { setError(errorMessage(error)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <form ref={form} id={bookingId ? "booking-payment-form" : "account-payment-form"} className="payment-upload" onSubmit={submit} aria-busy={busy} aria-label={bookingId ? "Submit booking payment" : "Submit account payment"}>
    <fieldset disabled={busy}>
      <legend><Upload size={18} />Submit a payment for review</legend>
      <p className="muted">Already made a transfer? Enter the amount and payment date. Once approved, it reduces your total account balance across all bookings. Receipt files are optional.</p>
      <div className="form-columns"><label>Amount paid (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} placeholder="0.00" value={amount} onChange={event => { changed(); setAmount(event.target.value); }} /></label><label>Payment date<input aria-label="Payment date" required type="date" max={today} value={paymentDate} onChange={event => { changed(); setPaymentDate(event.target.value); }} /><small>Dates use {timeZone}.</small></label></div>
      <label>Payment note <span className="muted">(optional)</span><textarea rows={2} maxLength={1000} placeholder="Transfer reference or anything your administrator should know" value={note} onChange={event => { changed(); setNote(event.target.value); }} /></label>
      <div className="payment-file-picker"><label htmlFor={inputId}><ImagePlus size={20} />{files.length ? "Add more receipt files" : "Choose receipt files"}</label><input id={inputId} type="file" multiple accept={RECEIPT_ACCEPT} disabled={busy || files.length >= MAX_RECEIPT_FILES} aria-describedby={helpId} onChange={event => { selectFiles(event.target.files); event.target.value = ""; }} /><p id={helpId}>Optional · up to 5 PDF, JPG, PNG or WebP files · up to 5 MB each. You can submit a payment without an attachment.</p></div>
      {!!files.length && <div className="payment-previews" aria-label="Selected receipt files">{files.map((file, index) => <FilePreview key={`${index}/${file.name}/${file.lastModified}`} file={file} index={index} disabled={busy} onRemove={() => { changed(); setFiles(previous => previous.filter((_, fileIndex) => fileIndex !== index)); }} />)}</div>}
      <ErrorNotice message={error} />
      <div className="payment-upload-footer"><span>{files.length ? `${files.length} of ${MAX_RECEIPT_FILES} files selected` : "No attachments · optional"}</span><div className="payment-actions">{onCancel && <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button>}<button className="button" disabled={busy}><Upload size={16} />{busy ? "Submitting payment…" : "Submit payment for review"}</button></div></div>
    </fieldset>
  </form>;
}

export function BookingPayments({ customerId, bookingId, paymentRequest = 0, revision, onPaymentChanged, canRecordPayment = true }: { customerId: string; bookingId: string; paymentRequest?: number; revision?: number; onPaymentChanged?: () => void; canRecordPayment?: boolean }) {
  const member = useOrganization();
  const [notice, setNotice] = useState("");
  const [trash, setTrash] = useState(false);
  const admin = member.role === "admin";
  const resource = useResource<PaymentsResponse>(`${paymentsPath({ organizationId: member.organization_id, customerId, bookingId })}${admin && trash ? "?deleted=deleted" : ""}`);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) { previousRevision.current = revision; resource.refresh(); }
  }, [revision, resource.refresh]);
  function reviewed(payment: Payment) { setNotice(payment.status === "approved" ? "Payment approved and recorded. We’ll email the customer their confirmation." : "Payment rejected. The review note is visible to the customer."); resource.refresh(); if (payment.status === "approved") onPaymentChanged?.(); }
  function changed(action: PaymentHistoryAction) { setNotice(paymentHistoryNotices[action]); resource.refresh(); onPaymentChanged?.(); }
  return <section className="panel booking-payments" aria-labelledby="booking-payments-heading">
    <div className="panel-heading"><div><h2 id="booking-payments-heading">Payment history</h2><p>Past and current payments for this booking. Payments awaiting review count after approval.</p></div><div className="payment-actions">{admin && <Link className="text-link" to={`/o/${member.organization_id}/payment-reviews`}>All payment reviews</Link>}<button type="button" className="icon-button" onClick={resource.refresh} disabled={resource.loading} aria-label="Refresh payment submissions"><RefreshCw size={16} /></button></div></div>
    {notice && <div className="notice success payment-notice" role="status">{notice}</div>}
    {admin && <div className="payment-status-tabs" role="group" aria-label="Payment history view"><button type="button" aria-pressed={!trash} onClick={() => setTrash(false)}>Payment history</button><button type="button" aria-pressed={trash} onClick={() => setTrash(true)}>Trash</button></div>}
    {resource.error ? <div className="booking-message"><ErrorNotice message={resource.error} /><button className="button secondary" onClick={resource.refresh}>Try again</button></div>
      : !resource.data ? <TableSkeleton columns={["Payment date", "Amount", "Status", "Receipts", "Actions"]} label="Loading payments" /> : <>
        {admin && !trash && canRecordPayment && <AdminPaymentActions organizationId={member.organization_id} customerId={customerId} bookingId={bookingId} timeZone={resource.data.time_zone} onRecorded={() => { setNotice("Payment recorded. Paid so far and payment reminders have been updated."); resource.refresh(); onPaymentChanged?.(); }} />}
        {!admin && <ReceiptUploadForm organizationId={member.organization_id} customerId={customerId} bookingId={bookingId} timeZone={resource.data.time_zone} paymentRequest={paymentRequest} onSubmitted={() => { setNotice("Payment submitted for review. We’ll email you when it is approved."); resource.refresh(); }} />}
        {!resource.data.items.length ? <Empty title={trash ? "Payment trash is empty" : "No payments yet"} detail={trash ? "Payments moved to trash can be restored or permanently deleted here." : admin ? "Recorded payments and customer submissions for this booking will appear here." : "Submit the details after making a payment. Attachments are optional. Your balance updates after approval."} />
          : <BookingPaymentHistory key={trash ? "trash" : "active"} payments={resource.data.items} organizationId={member.organization_id} timeZone={resource.data.time_zone} canReview={admin} onReviewed={reviewed} onChanged={changed} onRefresh={resource.refresh} />}
      </>}
  </section>;
}

function BookingPaymentHistory({ payments, organizationId, timeZone, canReview, onReviewed, onChanged, onRefresh }: {
  payments: Payment[]; organizationId: string; timeZone: string; canReview: boolean; onReviewed: (payment: Payment) => void;
  onChanged: (action: PaymentHistoryAction) => void;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PaymentReviewStatus>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ payment: Payment; receipts: boolean } | null>(null);
  const invalidDates = Boolean(from && to && from > to);
  const matches = filterBookingPayments(payments, { search, status, from, to }, timeZone);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(matches.length / 10)));
  const filtered = Boolean(search || status !== "all" || from || to);
  function clear() { setSearch(""); setStatus("all"); setFrom(""); setTo(""); setPage(1); }
  return <div className="booking-payment-history">
    <div className="payment-query-toolbar" role="search" aria-label="Filter booking payments">
      <label className="payment-query-search">Search payments<input type="search" placeholder="ID, date, amount, note or receipt" value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <label>Status<select value={status} onChange={event => { setStatus(event.target.value as PaymentReviewStatus); setPage(1); }}><option value="all">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
      <label>Payment from<input type="date" value={from} max={to || undefined} aria-invalid={invalidDates || undefined} onChange={event => { setFrom(event.target.value); setPage(1); }} /></label>
      <label>Payment to<input type="date" value={to} min={from || undefined} aria-invalid={invalidDates || undefined} onChange={event => { setTo(event.target.value); setPage(1); }} /></label>
    </div>
    <div className="payment-query-summary"><p role="status">{matches.length} of {payments.length} payments · Dates in {timeZone}</p>{filtered && <button type="button" className="text-link" onClick={clear}>Clear filters</button>}</div>
    {invalidDates ? <div className="payment-state"><ErrorNotice message="Payment from must be on or before payment to." /></div> : matches.length ? <><PaymentTable payments={matches.slice((currentPage - 1) * 10, currentPage * 10)} organizationId={organizationId} timeZone={timeZone} canReview={canReview} onOpen={(payment, receipts = false) => setSelected({ payment, receipts })} /><Pagination page={currentPage} total={matches.length} size={10} onPage={setPage} /></> : <div className="payment-empty"><Empty title="No matching payments" detail="Try another ID, date, amount or status." /><button type="button" className="button secondary" onClick={clear}>Clear filters</button></div>}
    {selected && <PaymentDetailsDialog payment={selected.payment} organizationId={organizationId} timeZone={timeZone} canReview={canReview} receipts={selected.receipts} onClose={() => setSelected(null)} onReviewed={payment => { setSelected(null); onReviewed(payment); }} onChanged={action => { setSelected(null); onChanged(action); }} onRefresh={onRefresh} />}
  </div>;
}
