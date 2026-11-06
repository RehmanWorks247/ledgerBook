import { useContext, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, Plus, X } from "lucide-react";
import { dateLabel, errorMessage, money, mutate, useResource, type Customer } from "../api";
import { Badge, Empty, ErrorNotice, Loading, PageHeading, Pagination } from "../components";
import { Link, Navigate, useNavigate, useParams } from "../router";
import { AuthContext, useOrganization } from "../state";
import { UserFileExplorer } from "../user-files/UserFileExplorer";
import type { FileNode } from "../user-files/model";
import { bookingServices, businessDate, departureInstant, departureLabel, filterBookings, type BookingFilters } from "./booking-model";
import "./Bookings.css";
import { CustomerPicker } from "../CustomerPicker";
import { BookingPayments } from "../payments/BookingPayments";
import { amountTone } from "../money-tone";

type Booking = {
  id: string;
  customer_id: string;
  customer_code?: string;
  reference: string;
  departure_at: string;
  required_services: string[];
  total_minor: string;
  time_zone?: string;
  instalments?: { id: string; due_date: string; amount_minor: string }[];
};
type BookingsResponse = { items: Booking[]; time_zone: string };

export function CustomerBookings({ customerId }: { customerId: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const [filters, setFilters] = useState<BookingFilters>({ search: "", start: "", end: "", service: "" });
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useResource<BookingsResponse>(
    `/organizations/${member.organization_id}/customers/${customerId}/bookings`,
  );
  const invalidDates = Boolean(filters.start && filters.end && filters.start > filters.end);
  const filtered = Object.values(filters).some(Boolean);
  const matches = data ? filterBookings(data.items, filters, data.time_zone) : [];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(matches.length / 10)));
  function changeFilter(name: keyof BookingFilters, value: string) {
    setFilters(previous => ({ ...previous, [name]: value }));
    setPage(1);
  }
  function clearFilters() { setFilters({ search: "", start: "", end: "", service: "" }); setPage(1); }
  return (
    <section className="panel booking-list" aria-label="Customer bookings">
      <div className="panel-heading">
        <div><h2>Bookings</h2></div>
        {member.role === "admin" && <Link className="button" to={`${root}/customers/${customerId}/bookings/new`}><Plus size={16} />Add Booking</Link>}
      </div>
      <div className="record-filters" role="search" aria-label="Filter customer bookings">
        <label className="record-filter-search">Search bookings<input type="search" placeholder="ID, reference, date, service or amount" maxLength={200} value={filters.search} onChange={event => changeFilter("search", event.target.value)} /></label>
        <label className="record-filter-date">Departure from<input type="date" value={filters.start} max={filters.end || undefined} onChange={event => changeFilter("start", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
        <label className="record-filter-date">Departure to<input type="date" value={filters.end} min={filters.start || undefined} onChange={event => changeFilter("end", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
        <label className="record-filter-select">Required service<select value={filters.service} onChange={event => changeFilter("service", event.target.value)}><option value="">All services</option>{bookingServices.map(service => <option key={service.key} value={service.key}>{service.label}</option>)}</select></label>
      </div>
      {data && !loading && !error && <div className="record-filter-summary"><p role="status">{matches.length} of {data.items.length} bookings · Dates in {data.time_zone}</p>{filtered && <button type="button" className="text-link" onClick={clearFilters}>Clear filters</button>}</div>}
      {invalidDates && <div className="record-filter-error"><ErrorNotice message="Departure from must be on or before departure to." /></div>}
      {error ? <div className="booking-message"><ErrorNotice message={error} /><button className="button secondary" onClick={refresh}>Try again</button></div>
        : loading || !data ? <Loading />
        : !data.items.length ? <Empty title="No bookings yet" detail="Each booking has its own tickets, hotel vouchers and other documents." />
        : !matches.length ? <Empty title="No matching bookings" detail="Try another ID, reference, departure date or service, or clear the filters." />
        : <><div className="table-scroll"><table className="compact-record-table"><thead><tr><th>Booking reference</th><th>Departure</th><th className="align-right">Booking total</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{matches.slice((currentPage - 1) * 10, currentPage * 10).map((booking) => <tr key={booking.id}>
            <td><strong>{booking.reference}</strong><small title={booking.id}>ID {booking.id.slice(0, 8)}</small></td>
            <td>{departureLabel(booking.departure_at, data.time_zone)}<small>{data.time_zone}</small></td>
            <td className={`align-right amount ${amountTone(booking.total_minor, "charge")}`}>{money(booking.total_minor, "GBP", 2)}</td>
            <td><Link className="text-link" to={`${root}/users/${customerId}/bookings/${booking.id}`}>Open Booking</Link></td>
          </tr>)}</tbody></table></div>{matches.length > 10 && <Pagination page={currentPage} total={matches.length} size={10} onPage={setPage} />}</>}
    </section>
  );
}

export function BookingPage() {
  const member = useOrganization();
  const { session } = useContext(AuthContext);
  const { customerId, bookingId } = useParams();
  if (!session || !customerId || !bookingId || (member.role !== "admin" && member.customer_id !== customerId))
    return <Navigate to={`/o/${member.organization_id}`} replace />;
  return <BookingContents key={`${member.id}/${customerId}/${bookingId}`} customerId={customerId} bookingId={bookingId} viewerId={session.user.id} />;
}

function BookingContents({ customerId, bookingId, viewerId }: { customerId: string; bookingId: string; viewerId: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const { data, error, loading, refresh } = useResource<Booking>(`/organizations/${member.organization_id}/customers/${customerId}/bookings/${bookingId}`);
  const files = useResource<{ items: FileNode[] }>(`/organizations/${member.organization_id}/customers/${customerId}/bookings/${bookingId}/files`);
  return <>
    <Link className="record-back" to={`${root}/users/${customerId}`}><ArrowLeft size={15} />Customer record</Link>
    {error ? <><ErrorNotice message={error} /><button className="button secondary" onClick={refresh}>Try again</button></>
      : loading || !data ? <Loading /> : <>
        <PageHeading eyebrow={data.customer_code} title={data.reference} description={`Departs ${departureLabel(data.departure_at, data.time_zone || "UTC")} (${data.time_zone || "UTC"})`} actions={<Link className="button secondary" to={member.role === "admin" ? `${root}/customers/${customerId}` : root}><BookOpen size={16} />Open Ledger</Link>} />
        <section className="panel booking-summary" aria-label="Booking details">
          <div><span className="eyebrow">BOOKING TOTAL</span><strong className={amountTone(data.total_minor, "charge")}>{money(data.total_minor, "GBP", 2)}</strong></div>
          <div><span className="eyebrow">REQUIRED SERVICES</span><span>{bookingServices.filter((service) => data.required_services.includes(service.key)).map((service) => service.label).join(" · ") || "No required services"}</span></div>
        </section>
        <BookingPayments customerId={customerId} bookingId={bookingId} />
        <UserFileExplorer viewerId={viewerId} organizationId={member.organization_id} userId={customerId} bookingId={bookingId} canManage={member.role === "admin"} onFilesChanged={files.refresh} />
        <section className="panel booking-list" aria-label="Service availability"><div className="panel-heading"><h2>Service availability</h2></div>
          {files.error ? <div className="booking-message"><ErrorNotice message={files.error} /><button className="button secondary" onClick={files.refresh}>Try again</button></div> : files.loading || !files.data ? <Loading /> : <div className="table-scroll"><table><thead><tr><th>Service</th><th>Documents</th><th>Issuance</th></tr></thead><tbody>{bookingServices.map((service) => {
            const count = files.data!.items.filter((node) => node.kind === "file" && node.serviceKey === service.key).length;
            const folder = files.data!.items.find((node) => node.defaultFolder && node.serviceKey === service.key);
            const required = data.required_services.includes(service.key);
            return <tr key={service.key}><td>{service.label}<small>{required ? "Required" : "Optional"}</small></td><td>{count ? `${count} document${count === 1 ? "" : "s"} uploaded` : required ? <Badge value="missing" /> : "No documents uploaded"}</td><td>{folder?.issuedAt ? `Issued ${dateLabel(folder.issuedAt)}` : "Not issued"}</td></tr>;
          })}</tbody></table></div>}
        </section>
        {!!data.instalments?.length && <section className="panel booking-list"><div className="panel-heading"><h2>Instalment schedule</h2><Badge value="GBP" /></div><div className="table-scroll"><table><thead><tr><th>Due date</th><th className="align-right">Scheduled amount</th></tr></thead><tbody>{data.instalments.map((instalment) => <tr key={instalment.id}><td>{dateLabel(instalment.due_date)}</td><td className={`align-right amount ${amountTone(instalment.amount_minor, "charge")}`}>{money(instalment.amount_minor, "GBP", 2)}</td></tr>)}</tbody></table></div></section>}
      </>}
  </>;
}

export function BookingEditor() {
  const member = useOrganization();
  const { customerId } = useParams();
  if (member.role !== "admin") return <Navigate to={`/o/${member.organization_id}`} replace />;
  return <BookingForm key={`${member.organization_id}/${customerId || "new"}`} selectedCustomerId={customerId} />;
}

function BookingForm({ selectedCustomerId }: { selectedCustomerId?: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const navigate = useNavigate();
  const [customerId, setCustomerId] = useState(selectedCustomerId || "");
  return <>
    <Link className="record-back" to={selectedCustomerId ? `${root}/users/${selectedCustomerId}` : root}><ArrowLeft size={15} />{selectedCustomerId ? "Customer record" : "Overview"}</Link>
    <PageHeading title="Add Booking" />
    {!selectedCustomerId && <section className="booking-customer"><CustomerPicker onSelect={customer => setCustomerId(customer?.id || '')} /></section>}
    {customerId && <SelectedBookingForm key={customerId} customerId={customerId} onSaved={(id) => navigate(`${root}/users/${customerId}/bookings/${id}`)} />}
  </>;
}

function SelectedBookingForm({ customerId, onSaved }: { customerId: string; onSaved: (id: string) => void }) {
  const member = useOrganization();
  const base = `/organizations/${member.organization_id}/customers/${customerId}`;
  const account = useResource<Customer>(base);
  const existing = useResource<BookingsResponse>(`${base}/bookings`);
  const [reference, setReference] = useState("");
  const [departure, setDeparture] = useState("");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [required, setRequired] = useState<string[]>([]);
  const [instalments, setInstalments] = useState<{ key: string; due_date: string; amount: string }[]>([]);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (existing.data?.time_zone && !effectiveDate) setEffectiveDate(businessDate(existing.data.time_zone));
  }, [existing.data?.time_zone, effectiveDate]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!existing.data || !account.data || busy) return;
    setBusy(true);
    setError("");
    try {
      const booking = await mutate<Booking>(`${base}/bookings`, {
        reference, departure_at: departureInstant(departure, existing.data.time_zone),
        amount, effective_date: effectiveDate, required_services: required,
        instalments: instalments.map(({ due_date, amount }) => ({ due_date, amount })),
        idempotency_key: idempotencyKey,
      });
      onSaved(booking.id);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  if (account.error || existing.error) return <><ErrorNotice message={account.error || existing.error} /><button className="button secondary" onClick={() => { account.refresh(); existing.refresh(); }}>Try again</button></>;
  if (account.loading || existing.loading || !account.data || !existing.data) return <Loading />;
  return <section className="panel booking-editor"><form className="stack-form" onSubmit={submit} aria-busy={busy}>
    <div><span className="eyebrow">{account.data.customer_code}</span><h2>{account.data.name}</h2></div>
    <ErrorNotice message={error} />
    {member.currency !== "GBP" && <ErrorNotice message="This workspace’s accounting currency is not GBP. GBP bookings require a GBP workspace; existing ledger amounts cannot be relabelled." />}
    <div className="form-columns">
      <label>Booking reference<input required maxLength={160} value={reference} onChange={(event) => setReference(event.target.value)} /></label>
      <label>Departure ({existing.data.time_zone})<input required type="datetime-local" value={departure} onChange={(event) => setDeparture(event.target.value)} /></label>
    </div>
    <div className="form-columns">
      <label>Booking total (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
      <label>Charge effective date<input required type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>
    </div>
    <fieldset className="booking-services"><legend>Required services</legend><div>{bookingServices.map((service) => <label key={service.key}><input type="checkbox" checked={required.includes(service.key)} onChange={(event) => setRequired((previous) => event.target.checked ? [...previous, service.key] : previous.filter((key) => key !== service.key))} />{service.label}</label>)}</div></fieldset>
    <fieldset className="booking-instalments"><legend>Instalments (GBP)</legend><small>{instalments.length ? "Scheduled amounts must add up to the booking total." : "Full amount due on charge date unless scheduled below."}</small>
      {instalments.map((instalment, index) => <div className="booking-instalment-row" key={instalment.key}><label>Due date {index + 1}<input required type="date" value={instalment.due_date} onChange={(event) => setInstalments((rows) => rows.map((row) => row.key === instalment.key ? { ...row, due_date: event.target.value } : row))} /></label><label>Amount (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={instalment.amount} onChange={(event) => setInstalments((rows) => rows.map((row) => row.key === instalment.key ? { ...row, amount: event.target.value } : row))} /></label><button type="button" className="icon-button" aria-label={`Remove instalment ${index + 1}`} onClick={() => setInstalments((rows) => rows.filter((row) => row.key !== instalment.key))}><X size={17} /></button></div>)}
      <button type="button" className="text-link" onClick={() => setInstalments((rows) => [...rows, { key: crypto.randomUUID(), due_date: effectiveDate, amount: rows.length ? "" : amount }])}><Plus size={15} />Add instalment</button>
    </fieldset>
    <div className="form-actions"><Link className="button secondary" to={`/o/${member.organization_id}/users/${customerId}`}>Cancel</Link><button className="button" disabled={busy || member.currency !== "GBP" || account.data.status !== "active"}>{busy ? "Creating…" : "Create booking"}</button></div>
  </form></section>;
}
