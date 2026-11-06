import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Clock3, ExternalLink, Eye, ImageIcon, X, XCircle } from "lucide-react";
import { dateLabel, money } from "../api";
import { Link } from "../router";
import { departureLabel } from "../pages/booking-model";
import { PaymentCard } from "./PaymentCard";
import type { Payment } from "./model";

export function PaymentStatusBadge({ status }: Pick<Payment, "status">) {
  const Icon = status === "approved" ? CheckCircle2 : status === "rejected" ? XCircle : Clock3;
  return <span className={`payment-status payment-status-${status}`}><Icon size={13} aria-hidden="true" />{status === "pending" ? "Pending" : status === "approved" ? "Approved" : "Rejected"}</span>;
}

export function PaymentTable({ payments, organizationId, timeZone, canReview, showCustomer = false, onOpen }: {
  payments: Payment[]; organizationId: string; timeZone: string; canReview: boolean; showCustomer?: boolean;
  onOpen: (payment: Payment, receipts?: boolean) => void;
}) {
  return <div className="payment-table-scroll" role="region" aria-label="Payment submissions" tabIndex={0}>
    <table className={`payment-table ${showCustomer ? "payment-table-wide" : ""}`}>
      <caption className="sr-only">Payment submissions. Open a review to see receipts and payment details.</caption>
      <thead><tr><th scope="col">{showCustomer ? "Customer / booking" : "Payment ID"}</th><th scope="col">Payment date</th><th scope="col" className="payment-number">Amount</th><th scope="col">Status</th><th scope="col">Receipts</th><th scope="col" className="payment-row-actions-heading">Actions</th></tr></thead>
      <tbody>{payments.map(payment => {
        const review = canReview && payment.status === "pending";
        return <tr key={payment.id}>
          <td className="payment-identity">{showCustomer ? <><strong title={payment.customer_name}>{payment.customer_name}</strong><span><span>{payment.customer_code}</span><span aria-hidden="true"> · </span><Link to={`/o/${organizationId}/users/${payment.customer_id}/bookings/${payment.booking_id}`} title={payment.booking_reference}>{payment.booking_reference}</Link></span></> : <><strong className="payment-id" title={payment.id}>{payment.id.slice(0, 8).toUpperCase()}</strong><span>{payment.note || "Payment submission"}</span></>}</td>
          <td className="payment-date"><time dateTime={payment.payment_date}>{dateLabel(payment.payment_date)}</time><small title={departureLabel(payment.submitted_at, timeZone)}>Added {dateLabel(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(payment.submitted_at)))}</small></td>
          <td className="payment-number"><strong className={payment.status === "approved" ? "money-payment" : payment.status === "rejected" ? "money-charge" : ""}>{money(payment.amount_minor, payment.currency, 2)}</strong>{showCustomer && <small className="payment-id" title={`Payment ID: ${payment.id}`}>ID {payment.id.slice(0, 8).toUpperCase()}</small>}</td>
          <td><PaymentStatusBadge status={payment.status} /></td>
          <td><span className="payment-receipt-count"><ImageIcon size={14} aria-hidden="true" />{payment.receipts.length}<span className="sr-only"> {payment.receipts.length === 1 ? "receipt" : "receipts"}</span></span></td>
          <td><div className="payment-row-actions"><button type="button" className={`button ${review ? "" : "secondary"}`} onClick={() => onOpen(payment)} aria-label={`${review ? "Review" : "View details for"} payment ${payment.id} from ${payment.customer_name}`}><Eye size={14} aria-hidden="true" />{review ? "Review" : "Details"}</button>{showCustomer ? <Link className="button secondary" to={`/o/${organizationId}/users/${payment.customer_id}/bookings/${payment.booking_id}`} aria-label={`Open booking ${payment.booking_reference}`}><ExternalLink size={13} aria-hidden="true" />Booking</Link> : <button type="button" className="button secondary" onClick={() => onOpen(payment, true)} aria-label={`View receipts for payment ${payment.id}`}><ImageIcon size={14} aria-hidden="true" />Receipts</button>}</div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

export function PaymentDetailsDialog({ payment, organizationId, timeZone, canReview, receipts = false, onClose, onReviewed }: {
  payment: Payment; organizationId: string; timeZone: string; canReview: boolean; receipts?: boolean;
  onClose: () => void; onReviewed: (payment: Payment) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    if (receipts) {
      const receipt = element.querySelector<HTMLAnchorElement>(".payment-receipt");
      receipt?.focus();
    }
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLButtonElement>("[aria-label='Refresh payment submissions']")?.focus();
    };
  }, [receipts]);
  return <dialog ref={dialog} className="payment-detail-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="payment-dialog-heading"><div><h2 id={titleId}>{canReview && payment.status === "pending" ? "Review payment" : "Payment details"}</h2><p>{payment.customer_name} <span>· {payment.booking_reference}</span></p></div><button type="button" className="icon-button" disabled={busy} aria-label="Close payment details" onClick={onClose}><X size={19} /></button></header>
    <div className="payment-dialog-body"><PaymentCard payment={payment} organizationId={organizationId} timeZone={timeZone} canReview={canReview} showBooking onBusyChange={setBusy} onReviewed={onReviewed} /></div>
    <footer className="payment-dialog-footer"><span>Payment ID <code>{payment.id}</code></span><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Close</button></footer>
  </dialog>;
}
