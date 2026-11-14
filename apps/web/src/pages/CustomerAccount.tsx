import { useRef, useState } from "react";
import { ArrowRight, Banknote, BookOpen, ReceiptText, RefreshCw, Wallet, X } from "lucide-react";
import { dateLabel, money as paymentMoney, useResource, type Statement } from "../api";
import { Empty, ErrorNotice, DashboardSkeleton, PageHeading, Stat } from "../components";
import { useLedgerMoney } from "../currency";
import { Link } from "../router";
import { useOrganization } from "../state";
import { ReceiptUploadForm } from "../payments/BookingPayments";
import { PaymentDetailsDialog, PaymentStatusBadge } from "../payments/PaymentTable";
import { paymentsPath, type Payment, type PaymentsResponse } from "../payments/model";
import { OutstandingInvoices } from "../invoices/OutstandingInvoices";
import { outstandingInvoicesPath, type OutstandingInvoicesResponse } from "../invoices/outstanding";
import "./Bookings.css";
import "./CustomerAccount.css";

export function CustomerAccount() {
  const member = useOrganization();
  if (!member.customer_id) return <Empty title="Account unavailable" detail="Please contact your travel company for help opening your account." />;
  return <AccountOverview key={`${member.id}/${member.customer_id}`} customerId={member.customer_id} />;
}

function AccountOverview({ customerId }: { customerId: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const money = useLedgerMoney();
  const [paying, setPaying] = useState(false);
  const [invoiceId,setInvoiceId] = useState<string>();
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Payment | null>(null);
  const paymentButton = useRef<HTMLButtonElement>(null);
  const { data, loading, error, refresh } = useResource<Statement>(
    `/organizations/${member.organization_id}/customers/${customerId}/statement?page_size=1`, { cache: true },
  );
  const payments = useResource<PaymentsResponse>(paymentsPath({ organizationId: member.organization_id, customerId }));
  const invoices = useResource<OutstandingInvoicesResponse>(outstandingInvoicesPath(member.organization_id,customerId));
  function refreshAccount() { refresh(); payments.refresh(); invoices.refresh(); }
  function closePaymentForm() { setPaying(false); requestAnimationFrame(() => paymentButton.current?.focus()); }
  function submitted() {
    closePaymentForm();
    setNotice("Payment submitted for review. Your account balance will update after approval.");
    refreshAccount();
  }

  if (error) return <>
    <PageHeading title="My account" />
    <ErrorNotice message={error} />
    <button className="button secondary" onClick={refresh}>Try again</button>
  </>;
  if (!data) return <><PageHeading title="My account" /><DashboardSkeleton /></>;

  const balance = BigInt(data.current_balance_minor);
  const format = (value: string) => money(value, data.currency, data.currency_exponent);
  return <article className="customer-account">
    <PageHeading eyebrow="My account" title={data.customer.name} description="Your account at a glance." actions={
      <div className="customer-account-actions"><button ref={paymentButton} className="button" disabled={paying} aria-expanded={paying} aria-controls="account-payment-form" onClick={() => { setNotice(""); setPaying(true); }}><Banknote size={17} aria-hidden="true" />Make a payment</button><button className="button secondary" disabled={loading || payments.loading} onClick={refreshAccount}><RefreshCw size={16} aria-hidden="true" />{loading ? "Updating…" : "Refresh balance"}</button></div>
    } />
    {notice && <div className="notice success payment-result-notice" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label="Dismiss payment notification" onClick={() => setNotice("")}><X size={16} /></button></div>}
    {paying && <div className="customer-account-payment"><ReceiptUploadForm organizationId={member.organization_id} customerId={customerId} selectedInvoiceId={invoiceId} timeZone={payments.data?.time_zone || member.time_zone || "UTC"} paymentRequest={1} onSubmitted={submitted} onCancel={closePaymentForm} /></div>}
    <OutstandingInvoices organizationId={member.organization_id} customerId={customerId} invoices={invoices.data?.invoices??[]} loading={invoices.loading} error={invoices.error} onRefresh={invoices.refresh} onPay={invoice=>{setInvoiceId(invoice.id);setNotice("");setPaying(true);}}/>
    <section className="panel customer-account-details" aria-labelledby="account-details-title">
      <h2 id="account-details-title">Account details</h2>
      <dl>
        <div><dt>Email address</dt><dd>{data.customer.email}</dd></div>
        <div><dt>Phone number</dt><dd>{data.customer.phone || "Not provided"}</dd></div>
        {data.customer.customer_code && <div><dt>Customer number</dt><dd>{data.customer.customer_code}</dd></div>}
      </dl>
    </section>
    <section aria-labelledby="account-totals-title">
      <div className="customer-account-section-heading">
        <h2 id="account-totals-title">All your bookings</h2>
        <p>One total across your whole account.</p>
      </div>
      <div className="stats-grid customer-account-totals" aria-label="Account totals" aria-busy={loading}>
        <Stat label="Total amount" value={format(data.total_amount_minor)} detail="All bookings, including account adjustments" icon={<ReceiptText aria-hidden="true" />} />
        <Stat label="Amount paid" value={format(data.total_paid_minor)} detail="Payments received and confirmed" icon={<Wallet aria-hidden="true" />} tone="success" valueClassName="money-payment" />
        <Stat label="Outstanding balance" value={format(data.current_balance_minor)} detail={balance > 0n ? "Amount left to pay" : balance < 0n ? "Your account is in credit. Nothing to pay." : "Nothing left to pay"} icon={<BookOpen aria-hidden="true" />} tone="danger" valueClassName="money-charge" />
      </div>
      <p className="customer-account-note">New payment receipts count towards your paid amount after they are approved.</p>
    </section>
    {payments.error ? <div className="customer-account-payment-error"><ErrorNotice message={payments.error} /><button type="button" className="text-link" onClick={payments.refresh}>Try loading payment history again</button></div> : !!payments.data?.items.length && <section className="customer-account-history" aria-labelledby="account-payment-history-title" aria-busy={payments.loading}>
      <div className="customer-account-section-heading"><h2 id="account-payment-history-title">Payment history</h2><p>Payments count towards your account balance after approval.</p></div>
      <div className="customer-account-payment-grid">{payments.data.items.map(payment => <article key={payment.id} className="panel customer-account-payment-card" aria-label={`${paymentMoney(payment.amount_minor, payment.currency, 2)} payment ${payment.reversed ? "reversed" : payment.status}`}>
        <div><strong>{paymentMoney(payment.amount_minor, payment.currency, 2)}</strong><PaymentStatusBadge status={payment.status} reversed={payment.reversed} deleted_at={payment.deleted_at} /></div>
        <time dateTime={payment.payment_date}>{dateLabel(payment.payment_date)}</time>
        {payment.invoice_number && <p>Invoice {payment.invoice_number} · {payment.booking_reference}</p>}
        {payment.note && <p>{payment.note}</p>}
        <button type="button" className="text-link" onClick={() => setSelected(payment)}>View payment<ArrowRight size={15} aria-hidden="true" /></button>
      </article>)}</div>
    </section>}
    <Link className="text-link customer-account-statement" to={`${root}/customers/${customerId}`}><BookOpen size={16} aria-hidden="true" />View account statement</Link>
    {selected && <PaymentDetailsDialog payment={selected} organizationId={member.organization_id} timeZone={payments.data?.time_zone || member.time_zone || "UTC"} canReview={false} onClose={() => setSelected(null)} onReviewed={() => { setSelected(null); refreshAccount(); }} onRefresh={refreshAccount} />}
  </article>;
}
