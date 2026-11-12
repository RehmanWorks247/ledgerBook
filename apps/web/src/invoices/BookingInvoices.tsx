import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Download, Eye, RefreshCw } from "lucide-react";
import { errorMessage, money } from "../api";
import { Badge, Empty, ErrorNotice } from "../components";
import { departureLabel } from "../pages/booking-model";
import { BookingInvoiceHistory, bookingInvoicesPath, invoiceFilename, invoiceReasonLabels, loadInvoicePdf, type BookingInvoice, type InvoiceContext } from "./model";
import { FilePreviewModal } from "../file-preview/FilePreviewModal";

export function BookingInvoices({ organizationId, customerId, bookingId, timeZone, currencyExponent, revision = 0 }: InvoiceContext & {
  timeZone: string; currencyExponent: number; revision?: number;
}) {
  const history = useMemo(() => new BookingInvoiceHistory({ organizationId, customerId, bookingId }), [organizationId, customerId, bookingId]);
  const state = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);
  const [downloading, setDownloading] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [preview, setPreview] = useState<BookingInvoice | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const headingId = useId();
  useEffect(() => { void history.refresh(); return history.cancel; }, [history, revision]);
  useEffect(() => {
    setDownloading(""); setDownloadError(""); setPreview(null);
    return () => { downloadController.current?.abort(); downloadController.current = null; };
  }, [history]);

  async function download(invoice: BookingInvoice) {
    if (downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(invoice.id); setDownloadError("");
    try {
      const blob = await loadInvoicePdf({ organizationId, customerId, bookingId }, invoice.id, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = invoiceFilename(invoice);
      document.body.append(anchor);
      try { anchor.click(); } finally {
        anchor.remove();
        // Keep the URL alive until the browser has started the download.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setDownloadError(errorMessage(cause));
    } finally {
      if (downloadController.current === controller) { downloadController.current = null; setDownloading(""); }
    }
  }

  return <section className="panel booking-invoices" aria-labelledby={headingId}>
    <div className="panel-heading"><div><h2 id={headingId}>Invoice history</h2><p>Each version records the booking total and approved payments at the time it was issued.</p></div><button type="button" className="icon-button" disabled={state.loading || state.loadingMore} onClick={() => void history.refresh()} aria-label="Refresh invoice history"><RefreshCw size={16} aria-hidden="true" /></button></div>
    {(state.error || downloadError) && <div className="invoice-message"><ErrorNotice message={state.error || downloadError} />{state.error && <button type="button" className="button secondary" disabled={state.loading || state.loadingMore} onClick={() => void history.retry()}>Try again</button>}</div>}
    {(state.loading || !state.loaded) && !state.error ? <p className="invoice-message" role="status">Loading invoice history…</p>
      : state.loaded && !state.invoices.length ? <Empty title="No invoices yet" detail="An invoice will appear here when it is available for this booking." />
      : !!state.invoices.length && <InvoiceTable invoices={state.invoices} timeZone={timeZone} currencyExponent={currencyExponent} downloading={downloading} onDownload={invoice => void download(invoice)} onPreview={setPreview} />}
    {preview && <FilePreviewModal key={preview.id} file={{ name: invoiceFilename(preview), mimeType: "application/pdf",
      url: `/api${bookingInvoicesPath({ organizationId, customerId, bookingId })}/${preview.id}/pdf` }} onClose={() => setPreview(null)} />}
    {downloading && <p className="sr-only" role="status">Preparing invoice PDF…</p>}
    {state.nextBeforeVersion !== null && <div className="invoice-pagination"><span>{state.invoices.length} invoice versions loaded</span><button type="button" className="button secondary" disabled={state.loading || state.loadingMore} onClick={() => void history.loadMore()}>{state.loadingMore ? "Loading older invoices…" : "Load older invoices"}</button></div>}
  </section>;
}

export function InvoiceTable({ invoices, timeZone, currencyExponent, downloading, onDownload, onPreview }: {
  invoices: BookingInvoice[]; timeZone: string; currencyExponent: number; downloading: string;
  onDownload: (invoice: BookingInvoice) => void;
  onPreview: (invoice: BookingInvoice) => void;
}) {
  return <div className="table-scroll invoice-table-scroll" role="region" aria-label="Booking invoice versions" tabIndex={0}><table className="compact-record-table invoice-table">
    <caption className="sr-only">Invoice versions, newest first. Amounts reflect each version’s issue date. Dates use {timeZone}.</caption>
    <thead><tr><th scope="col">Invoice / version</th><th scope="col">Issued</th><th scope="col" className="align-right">Total</th><th scope="col" className="align-right">Paid</th><th scope="col" className="align-right">Outstanding balance</th><th scope="col">Status</th><th scope="col"><span className="sr-only">PDF actions</span></th></tr></thead>
    <tbody>{invoices.map((invoice, index) => <tr key={invoice.id}>
      <td><strong>{invoice.invoice_number}</strong><small>Version {invoice.version}{index === 0 ? " · Latest" : ""}</small></td>
      <td><time dateTime={invoice.issued_at}>{departureLabel(invoice.issued_at, timeZone)}</time><small>{invoiceReasonLabels[invoice.reason] || invoice.reason.replaceAll("_", " ")}</small></td>
      <td className="align-right amount">{money(invoice.total_minor, invoice.currency, currencyExponent)}</td>
      <td className="align-right amount money-payment">{money(invoice.paid_minor, invoice.currency, currencyExponent)}</td>
      <td className="align-right amount"><span className={BigInt(invoice.balance_minor) > 0n ? "money-charge" : "money-payment"}>{money(invoice.balance_minor, invoice.currency, currencyExponent)}</span>{BigInt(invoice.balance_minor) < 0n && <small>Credit</small>}</td>
      <td><Badge value={invoice.status} /></td>
      <td><div className="invoice-actions"><button type="button" className="button secondary" onClick={() => onPreview(invoice)} aria-label={`Preview ${invoice.invoice_number} version ${invoice.version}`}><Eye size={14} aria-hidden="true" />Preview</button><button type="button" className="button secondary invoice-download" disabled={Boolean(downloading)} onClick={() => onDownload(invoice)} aria-label={`Download ${invoice.invoice_number} version ${invoice.version} as PDF`}><Download size={14} aria-hidden="true" />{downloading === invoice.id ? "Preparing…" : "Download"}</button></div></td>
    </tr>)}</tbody>
  </table></div>;
}
