import { ArrowRight, BookOpen, CalendarDays, ReceiptText, RefreshCw, Wallet } from "lucide-react";
import { useResource, type Statement } from "../api";
import { Empty, ErrorNotice, DashboardSkeleton, PageHeading, Stat } from "../components";
import { useLedgerMoney } from "../currency";
import { Link } from "../router";
import { useOrganization } from "../state";
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
  const { data, loading, error, refresh } = useResource<Statement>(
    `/organizations/${member.organization_id}/customers/${customerId}/statement?page_size=1`, { cache: true },
  );

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
      <button className="button secondary" disabled={loading} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />{loading ? "Updating…" : "Refresh balance"}</button>
    } />
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
    <section className="panel customer-account-next" aria-labelledby="account-bookings-title">
      <div>
        <h2 id="account-bookings-title">Your bookings and documents</h2>
        <p>Open a booking to see your trip details, download documents or send a payment receipt.</p>
      </div>
      <Link className="button" to={`${root}/users/${customerId}`}><CalendarDays size={18} aria-hidden="true" />My bookings<ArrowRight size={16} aria-hidden="true" /></Link>
    </section>
    <Link className="text-link customer-account-statement" to={`${root}/customers/${customerId}`}><BookOpen size={16} aria-hidden="true" />View account statement</Link>
  </article>;
}
