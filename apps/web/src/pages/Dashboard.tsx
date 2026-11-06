import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Clock3, Plane, Plus, Users } from 'lucide-react';
import { dateLabel, useResource, type Entry } from '../api';
import { Badge, Empty, ErrorNotice, Loading, PageHeading, Pagination, Stat } from '../components';
import { useLedgerMoney } from '../currency';
import { Link, Navigate, useNavigate, useSearch } from '../router';
import { useOrganization } from '../state';
import { CustomerPicker } from '../CustomerPicker';
import { PeriodPicker } from '../PeriodPicker';
import { amountTone } from '../money-tone';

type Attention = { id: string; customer_id: string; customer_name: string; customer_code?: string; booking_id: string; booking_reference: string;
  unpaid_minor: string; due_date: string; status: string; reminder_status: string | null; reminder_at: string | null };
type Departure = { id: string; customer_id: string; customer_name: string; customer_code?: string; reference: string; departure_at: string;
  within_24_hours: boolean; services: { key: string; name: string; required: boolean; issued: boolean; document_count: number }[];
  missing_documents: string[] };
export type DashboardData = { today: string; time_zone: string; period: { start: string; end: string }; customer_count: number;
  customers_added_this_month: number; total_debt_minor: string; payments_received_minor: string; overdue_minor: string;
  overdue_customer_count: number; attention: Attention[]; departures: Departure[];
  activity: { id: string; action: string; created_at: string; customer_id: string; customer_name: string; customer_code?: string; booking_id?: string; object_id: string }[];
  currency: string; currency_exponent: number };

export function recordLink(root: string, customer: string) { return `${root}/users/${customer}`; }
export function bookingLink(root: string, customer: string, booking: string) { return `${recordLink(root, customer)}/bookings/${booking}`; }
export function paymentLink(root: string, customer: string) { return `${root}/customers/${customer}/payments/new`; }
export function timestamp(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value));
}

export function CustomerSearch({ payment = false }: { payment?: boolean }) {
  const member = useOrganization();
  const navigate = useNavigate();
  return <section className="customer-search" aria-label={payment ? 'Select a customer for payment' : 'Find a customer'}>
    <CustomerPicker activeOnly={payment} onSelect={customer => {
      if (customer) navigate(payment ? paymentLink(`/o/${member.organization_id}`, customer.id) : recordLink(`/o/${member.organization_id}`, customer.id));
    }} />
  </section>;
}

export function Dashboard() {
  const member = useOrganization();
  const money = useLedgerMoney();
  const root = `/o/${member.organization_id}`;
  const [applied, setApplied] = useState({ start: '', end: '' });
  const query = new URLSearchParams(Object.fromEntries(Object.entries(applied).filter(([, value]) => value)));
  const { data, error, loading, refresh } = useResource<DashboardData>(`/organizations/${member.organization_id}/dashboard?${query}`);
  const format = (value: string) => money(value, data!.currency, data!.currency_exponent);
  const paymentQuery = new URLSearchParams({ kind: 'payment', ...(data?.period || {}) });
  return <>
    <PageHeading title="Overview"
      actions={<><Link className="button secondary" to={`${root}/customers/new`}><Plus size={16} />Add Customer</Link>
        <Link className="button secondary" to={`${root}/bookings/new`}><Plane size={16} />Add Booking</Link>
        <Link className="button button-success" to={`${root}/payments/new`}><ArrowDownLeft size={16} />Record Payment</Link></>} />
    <div className="dashboard-controls"><CustomerSearch />{data && <PeriodPicker today={data.today} value={data.period} onChange={setApplied} />}</div>
    <ErrorNotice message={error} />{error && <button className="button secondary" onClick={refresh}>Try again</button>}
    {loading && <Loading />}
    {data && !error && <div aria-busy={loading}>
      <div className="stats-grid customer-summary">
        <Link aria-label="Total Customers: open Customer Data" to={`${root}/customers`}><Stat label="Customers" value={data.customer_count.toLocaleString()} detail={`${data.customers_added_this_month} added this month`} icon={<Users size={21} />} tone="info" /></Link>
        <Link aria-label="Outstanding Customer Balance: open outstanding ledger" to={`${root}/customer-ledger?status=outstanding`}><Stat label="Outstanding" value={format(data.total_debt_minor)} detail="Customer balance" icon={<ArrowUpRight size={21} />} tone="danger" valueClassName={amountTone(data.total_debt_minor, 'charge')} primary /></Link>
        <Link aria-label="Payments Received: open reporting-period payments" to={`${root}/customer-ledger?${paymentQuery}`}><Stat label="Payments received" value={format(data.payments_received_minor)} detail={`${dateLabel(data.period.start)} – ${dateLabel(data.period.end)}`} icon={<ArrowDownLeft size={21} />} tone="success" valueClassName={amountTone(data.payments_received_minor, 'payment')} /></Link>
        <Link aria-label="Overdue Instalments: open overdue customer ledger" to={`${root}/customer-ledger?status=overdue`}><Stat label="Overdue" value={format(data.overdue_minor)} detail={`${data.overdue_customer_count} customers`} icon={<Clock3 size={21} />} tone="warning" valueClassName={amountTone(data.overdue_minor, 'charge')} /></Link>
      </div>
      <div className="daily-work-grid">
        <section className="panel"><div className="panel-heading"><div><h2>Payments due</h2><p>Overdue & next 7 days</p></div></div>
          {data.attention.length ? <ul className="work-list">{data.attention.map(item => <li key={item.id}>
            <div className="work-item-heading"><Link className="table-link" to={recordLink(root, item.customer_id)}>{item.customer_name}</Link><strong className={amountTone(item.unpaid_minor, 'charge')}>{format(item.unpaid_minor)}</strong></div>
            <small className="customer-reference">{item.customer_code}</small>
            <div className="work-item-meta"><Badge value={item.status} /><span>Due {dateLabel(item.due_date)}</span></div>
            <small>{item.booking_reference} · {(item.reminder_status || item.reminder_at) ? `Latest reminder: ${item.reminder_status || 'status unavailable'}${item.reminder_at ? ` · ${timestamp(item.reminder_at, data.time_zone)}` : ''}` : 'No reminder'}</small>
            <div className="work-actions"><Link className="text-link" to={`${root}/customers/${item.customer_id}`}>Open Ledger</Link><Link className="text-link money-payment" to={paymentLink(root, item.customer_id)}>Record Payment</Link></div>
          </li>)}</ul> : <p className="compact-empty">No payments due</p>}
        </section>
        <section className="panel"><div className="panel-heading"><div><h2>Upcoming departures</h2><p>Next 7 days · {data.time_zone}</p></div></div>
          {data.departures.length ? <ul className="work-list">{data.departures.map(item => <li key={item.id} className={item.within_24_hours ? 'departure-soon' : ''}>
            <div className="work-item-heading"><Link className="table-link" to={recordLink(root, item.customer_id)}>{item.customer_name}</Link>{item.within_24_hours && <Badge value="within_24_hours" />}</div>
            <small className="customer-reference">{item.customer_code}</small>
            <div className="work-item-meta"><strong>{item.reference}</strong><span>{timestamp(item.departure_at, data.time_zone)}</span></div>
            <div className="service-availability">{item.services.filter(service => service.required || service.document_count > 0).map(service => <small key={service.key}>
              {service.name}: {service.document_count ? `${service.document_count} document${service.document_count === 1 ? '' : 's'}` : 'document missing'}{service.issued ? ' · issued' : ''}
            </small>)}</div>
            {!item.services.some(service => service.required || service.document_count > 0) && <small>No required documents specified</small>}
            <div className="work-actions"><Link className="text-link" to={bookingLink(root, item.customer_id, item.id)}>Open Booking</Link></div>
          </li>)}</ul> : <p className="compact-empty">No upcoming departures</p>}
        </section>
      </div>
      <section className="panel customer-activity"><div className="panel-heading"><div><h2>Recent activity</h2><p>{dateLabel(data.period.start)} – {dateLabel(data.period.end)}</p></div></div>
        {data.activity.length ? <ul className="work-list activity-list">{data.activity.map(item => <li key={item.id}>
          <div><Link className="table-link" to={item.booking_id ? bookingLink(root, item.customer_id, item.booking_id) : item.action.startsWith('payment.') || item.action.startsWith('ledger.') ? `${root}/customers/${item.customer_id}` : recordLink(root, item.customer_id)}>{item.customer_name}</Link>
            <small>{item.action.replaceAll('.', ' · ').replaceAll('_', ' ')} · {item.customer_code}</small></div>
          <time dateTime={item.created_at}>{timestamp(item.created_at, data.time_zone)}</time>
        </li>)}</ul> : <p className="compact-empty">No activity in this period</p>}
      </section>
    </div>}
  </>;
}

export function PaymentPicker() {
  const member = useOrganization();
  if (member.role !== 'admin') return <Navigate to={`/o/${member.organization_id}`} replace />;
  return <><PageHeading title="Record Payment" /><CustomerSearch payment /></>;
}

type LedgerFilters = { start: string; end: string; status: string; kind: string; search: string; min_balance: string; max_balance: string };
export function ledgerFilters(search: string): LedgerFilters {
  const query = new URLSearchParams(search);
  return { start: query.get('start') || '', end: query.get('end') || '', status: query.get('status') || 'all', kind: query.get('kind') || 'all', search: query.get('search') || '', min_balance: query.get('min_balance') || '', max_balance: query.get('max_balance') || '' };
}
type CombinedLedger = { entries: (Entry & { customer_id: string; customer_name: string; customer_code?: string; current_balance_minor: string })[];
  total: number; page: number; page_size: number; customer_count: number; currency: string; currency_exponent: number;
  totals: { charges_minor: string; payments_minor: string; net_minor: string; current_balance_minor: string; outstanding_minor: string } };
export function CustomerLedger() {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const search = useSearch();
  const navigate = useNavigate();
  const money = useLedgerMoney();
  const [filters, setFilters] = useState(() => ledgerFilters(search));
  const [page, setPage] = useState(1);
  const [validation, setValidation] = useState('');
  useEffect(() => { setFilters(ledgerFilters(search)); setPage(1); setValidation(''); }, [search]);
  const query = new URLSearchParams(search);
  query.set('page', String(page)); query.set('page_size', '25');
  const { data, error, loading, refresh } = useResource<CombinedLedger>(`/organizations/${member.organization_id}/customer-ledger?${query}`);
  if (member.role !== 'admin') return <Navigate to={root} replace />;
  const format = (value: string | undefined) => money(value, data!.currency, data!.currency_exponent);
  const field = (name: keyof LedgerFilters) => ({ value: filters[name], onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters({ ...filters, [name]: event.target.value }) });
  function apply(event: FormEvent) {
    event.preventDefault();
    if (filters.start && filters.end && filters.start > filters.end) { setValidation('The start date must be on or before the end date.'); return; }
    setValidation('');
    navigate(`${root}/customer-ledger?${new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, value]) => value)))}`);
  }
  return <><PageHeading title="Customer Ledger"
    actions={<Link className="button button-success" to={`${root}/payments/new`}>Record Payment</Link>} />
    <ErrorNotice message={validation || error} />{error && <button className="button secondary" onClick={refresh}>Try again</button>}
    <section className="panel"><form className="record-filters combined-filters" onSubmit={apply} aria-label="Filter customer ledger">
      <label className="record-filter-search">Search ledger<input type="search" placeholder="ID, customer, date, description or reference" maxLength={200} {...field('search')} /></label>
      <label className="record-filter-date">From<input type="date" max={filters.end || undefined} {...field('start')} /></label><label className="record-filter-date">To<input type="date" min={filters.start || undefined} {...field('end')} /></label>
      <label className="record-filter-select">Status<select {...field('status')}><option value="all">All balances</option><option value="outstanding">Outstanding</option><option value="overdue">Overdue customers</option><option value="settled">Settled</option><option value="credit">Customer credit</option></select></label>
      <label className="record-filter-select">Entries<select {...field('kind')}><option value="all">All entries</option><option value="payment">Payments and reversals</option></select></label>
      <label className="record-filter-date">Minimum balance (GBP)<input inputMode="decimal" disabled={member.currency !== 'GBP'} {...field('min_balance')} /></label>
      <label className="record-filter-date">Maximum balance (GBP)<input inputMode="decimal" disabled={member.currency !== 'GBP'} {...field('max_balance')} /></label>
      <button className="button secondary" disabled={loading}>Apply filters</button><Link className="text-link" to={`${root}/customer-ledger`}>Clear</Link>
    </form>
    {member.currency !== 'GBP' && <p className="search-note">Historical balances are converted to GBP. Numeric balance filters require a GBP accounting workspace.</p>}
    {loading && <Loading />}
    {data && !error && <><div className="period-summary ledger-totals"><span>{data.customer_count} customers</span>
      <span>Charges <strong className={amountTone(data.totals.charges_minor, 'charge')}>{format(data.totals.charges_minor)}</strong></span><span>Payments <strong className={amountTone(data.totals.payments_minor, 'payment')}>{format(data.totals.payments_minor)}</strong></span>
      <span>Net movement <strong className={amountTone(data.totals.net_minor)}>{format(data.totals.net_minor)}</strong></span><span>Current outstanding <strong className={amountTone(data.totals.outstanding_minor, 'charge')}>{format(data.totals.outstanding_minor)}</strong></span></div>
      <p className="search-note">Date filters select transactions; status and balance filters use each customer’s current balance. Totals include every matching row, across all pages.</p>
      {data.entries.length ? <div className="table-scroll"><table className="compact-record-table"><thead><tr><th>Customer / ID</th><th>Date / entry</th><th>Description</th><th>Type</th><th className="align-right">Amount</th><th className="align-right">Running balance</th><th>Actions</th></tr></thead>
        <tbody>{data.entries.map(entry => <tr key={entry.id}><td><Link className="table-link" to={recordLink(root, entry.customer_id)}>{entry.customer_name}</Link><small className="customer-reference">{entry.customer_code}</small></td>
          <td>{dateLabel(entry.effective_date)}<small>#{entry.id}</small></td><td>{entry.description}<small>{entry.reference}</small></td><td><Badge value={entry.kind} /></td>
          <td className={`align-right amount ${amountTone(entry.amount_minor, entry.kind)}`}>{format(entry.amount_minor)}</td><td className={`align-right amount ${amountTone(entry.running_balance_minor)}`}>{format(entry.running_balance_minor)}</td>
          <td><Link className="text-link" to={`${root}/customers/${entry.customer_id}`}>Open Ledger</Link></td></tr>)}</tbody></table></div>
        : <Empty title="No matching ledger entries" detail="Change the filters or record a customer transaction." />}
      <Pagination page={data.page} total={data.total} size={data.page_size} onPage={setPage} /></>}
    </section></>;
}
