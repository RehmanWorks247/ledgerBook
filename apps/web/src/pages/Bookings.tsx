import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { dateLabel, errorMessage, money, mutate, useResource, type Customer } from "../api";
import { Badge, Empty, ErrorNotice, Loading, TableSkeleton, PageHeading, Pagination } from "../components";
import { Link, Navigate, useNavigate, useParams } from "../router";
import { AuthContext, useOrganization } from "../state";
import { UserFileExplorer } from "../user-files/UserFileExplorer";
import type { FileNode } from "../user-files/model";
import { bookingAmountInput, bookingServices, businessDate, departureInstant, departureLabel, departureLocal, filterBookings, type BookingFilters } from "./booking-model";
import "./Bookings.css";
import { CustomerPicker } from "../CustomerPicker";
import { BookingPayments } from "../payments/BookingPayments";
import { BookingInvoices } from "../invoices/BookingInvoices";
import { amountTone } from "../money-tone";
import { bookingDraftKey, readBookingDraft, removeBookingDraft, writeBookingDraft, type BookingDraftFields } from "./booking-draft";

type Booking = {
  id: string;
  customer_id: string;
  customer_code?: string;
  reference: string;
  departure_at: string;
  required_services: string[];
  total_minor: string;
  version: number;
  effective_date: string;
  deleted_at?: string | null;
  time_zone?: string;
  instalments?: { id: string; due_date: string; amount_minor: string }[];
};
type BookingsResponse = { items: Booking[]; time_zone: string };

export function CustomerBookings({ customerId }: { customerId: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const [filters, setFilters] = useState<BookingFilters>({ search: "", start: "", end: "", service: "" });
  const [page, setPage] = useState(1);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const { data, error, loading, refresh } = useResource<BookingsResponse>(
    `/organizations/${member.organization_id}/customers/${customerId}/bookings${includeCancelled ? "?include_cancelled=1" : ""}`,
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
        <label className="record-filter-search">Search bookings<input type="search" placeholder={member.role === "admin" ? "ID, reference, date, service or amount" : "Booking reference, date or amount"} maxLength={200} value={filters.search} onChange={event => changeFilter("search", event.target.value)} /></label>
        <label className="record-filter-date">Departure from<input type="date" value={filters.start} max={filters.end || undefined} onChange={event => changeFilter("start", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
        <label className="record-filter-date">Departure to<input type="date" value={filters.end} min={filters.start || undefined} onChange={event => changeFilter("end", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
        <label className="record-filter-select">Required service<select value={filters.service} onChange={event => changeFilter("service", event.target.value)}><option value="">All services</option>{bookingServices.map(service => <option key={service.key} value={service.key}>{service.label}</option>)}</select></label>
        <label className="record-filter-select">Booking status<select value={includeCancelled ? "all" : "active"} onChange={event => { setIncludeCancelled(event.target.value === "all"); setPage(1); }}><option value="active">Active bookings</option><option value="all">Include cancelled</option></select></label>
      </div>
      {data && !loading && !error && <div className="record-filter-summary"><p role="status">{matches.length} of {data.items.length} bookings · Dates in {data.time_zone}</p>{filtered && <button type="button" className="text-link" onClick={clearFilters}>Clear filters</button>}</div>}
      {invalidDates && <div className="record-filter-error"><ErrorNotice message="Departure from must be on or before departure to." /></div>}
      {error ? <div className="booking-message"><ErrorNotice message={error} /><button className="button secondary" onClick={refresh}>Try again</button></div>
        : !data ? <TableSkeleton columns={["Booking reference", "Departure", "Booking total", "Actions"]} label="Loading bookings" />
        : !data.items.length ? <Empty title="No bookings yet" detail={member.role === "admin" ? "Each booking has its own tickets, hotel vouchers and other documents." : "Your bookings will appear here once your travel company adds them."} />
        : !matches.length ? <Empty title="No matching bookings" detail="Try another ID, reference, departure date or service, or clear the filters." />
        : <><div className="table-scroll"><table className="compact-record-table"><thead><tr><th>Booking reference</th><th>Departure</th><th className="align-right">Booking total</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{matches.slice((currentPage - 1) * 10, currentPage * 10).map((booking) => <tr key={booking.id}>
            <td><strong>{booking.reference}</strong>{member.role === "admin" && <small title={booking.id}>ID {booking.id.slice(0, 8)}</small>}{booking.deleted_at && <Badge value="cancelled" />}</td>
            <td>{departureLabel(booking.departure_at, data.time_zone)}<small>{data.time_zone}</small></td>
            <td className={`align-right amount ${amountTone(booking.total_minor, "charge")}`}>{money(booking.total_minor, "GBP", 2)}</td>
            <td><Link className="text-link" to={`${root}/users/${customerId}/bookings/${booking.id}${booking.deleted_at ? "/invoices" : ""}`}>{booking.deleted_at ? "Invoice history" : member.role === "admin" ? "Open Booking" : "View booking"}</Link></td>
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

export function BookingInvoicePage() {
  const member = useOrganization();
  const { session } = useContext(AuthContext);
  const { customerId, bookingId } = useParams();
  const root = `/o/${member.organization_id}`;
  if (!session || !customerId || !bookingId || (member.role !== "admin" && member.customer_id !== customerId))
    return <Navigate to={root} replace />;
  return <>
    <Link className="record-back" to={`${root}/users/${customerId}`}><ArrowLeft size={15} />{member.role === "admin" ? "Customer record" : "My bookings"}</Link>
    <PageHeading title="Booking invoices" description="Download an invoice or review earlier versions, including invoices for cancelled bookings." />
    <BookingInvoices key={`${member.id}/${customerId}/${bookingId}`} organizationId={member.organization_id} customerId={customerId} bookingId={bookingId} timeZone={member.time_zone || "UTC"} currencyExponent={member.currency_exponent} />
  </>;
}

function BookingContents({ customerId, bookingId, viewerId }: { customerId: string; bookingId: string; viewerId: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [issuing, setIssuing] = useState("");
  const [issueError, setIssueError] = useState("");
  const [notice, setNotice] = useState("");
  const [invoiceRevision, setInvoiceRevision] = useState(0);
  const { data, error, loading, refresh } = useResource<Booking>(`/organizations/${member.organization_id}/customers/${customerId}/bookings/${bookingId}`);
  const files = useResource<{ items: FileNode[] }>(`/organizations/${member.organization_id}/customers/${customerId}/bookings/${bookingId}/files`);
  async function setIssued(serviceKey: string, issued: boolean) {
    if (issuing) return;
    setIssuing(serviceKey); setIssueError("");
    try {
      await mutate(`/organizations/${member.organization_id}/customers/${customerId}/bookings/${bookingId}/services/${serviceKey}`, { issued }, "PATCH");
      files.refresh();
      setNotice(`${bookingServices.find(service => service.key === serviceKey)?.label} marked ${issued ? "issued" : "not issued"}.`);
    } catch (error) { setIssueError(errorMessage(error)); }
    finally { setIssuing(""); }
  }
  return <>
    <Link className="record-back" to={`${root}/users/${customerId}`}><ArrowLeft size={15} />{member.role === "admin" ? "Customer record" : "My bookings"}</Link>
    {error ? <><ErrorNotice message={error} /><button className="button secondary" onClick={refresh}>Try again</button></>
      : loading || !data ? <Loading /> : <>
        <PageHeading eyebrow={data.customer_code} title={data.reference} description={`Departs ${departureLabel(data.departure_at, data.time_zone || "UTC")} (${data.time_zone || "UTC"})`} actions={<div className="booking-actions"><Link className="button secondary" to={member.role === "admin" ? `${root}/customers/${customerId}` : root}><BookOpen size={16} />{member.role === "admin" ? "Open Ledger" : "My account"}</Link>{member.role === "admin" && <><button className="button secondary" onClick={() => { setEditing(true); setCancelling(false); }} disabled={editing}><Pencil size={16} />Edit booking</button><button className="button danger" onClick={() => { setCancelling(true); setEditing(false); }} disabled={cancelling}><Trash2 size={16} />Cancel booking</button></>}</div>} />
        {notice && <p className="booking-notice" role="status">{notice}</p>}
        {editing && <SelectedBookingForm key={`edit-${data.version}`} customerId={customerId} booking={data} onSaved={() => { setEditing(false); setNotice("Booking updated."); refresh(); }} onCancel={() => setEditing(false)} />}
        {cancelling && <CancelBookingForm customerId={customerId} booking={data} onCancel={() => setCancelling(false)} />}
        <section className="panel booking-summary" aria-label="Booking details">
          <div><span className="eyebrow">Booking total</span><strong className={amountTone(data.total_minor, "charge")}>{money(data.total_minor, "GBP", 2)}</strong></div>
          <div><span className="eyebrow">Required services</span><span>{bookingServices.filter((service) => data.required_services.includes(service.key)).map((service) => service.label).join(" · ") || "No required services"}</span></div>
        </section>
        <BookingInvoices organizationId={member.organization_id} customerId={customerId} bookingId={bookingId} timeZone={data.time_zone || "UTC"} currencyExponent={member.currency_exponent} revision={invoiceRevision} />
        <BookingPayments customerId={customerId} bookingId={bookingId} onPaymentChanged={() => setInvoiceRevision(value => value + 1)} />
        <UserFileExplorer viewerId={viewerId} organizationId={member.organization_id} userId={customerId} bookingId={bookingId} canManage={member.role === "admin"} onFilesChanged={files.refresh} />
        <section className="panel booking-list" aria-label="Service availability"><div className="panel-heading"><h2>Service availability</h2></div>
          {issueError && <div className="booking-message"><ErrorNotice message={issueError} /></div>}
          {files.error ? <div className="booking-message"><ErrorNotice message={files.error} /><button className="button secondary" onClick={files.refresh}>Try again</button></div> : !files.data ? <TableSkeleton columns={["Service", "Documents", "Issuance"]} label="Loading booking documents" /> : <div className="table-scroll"><table><thead><tr><th>Service</th><th>Documents</th><th>Issuance</th></tr></thead><tbody>{bookingServices.map((service) => {
            const count = files.data!.items.filter((node) => node.kind === "file" && node.serviceKey === service.key).length;
            const folder = files.data!.items.find((node) => node.defaultFolder && node.serviceKey === service.key);
            const required = data.required_services.includes(service.key);
            return <tr key={service.key}><td>{service.label}<small>{required ? "Required" : "Optional"}</small></td><td>{count ? `${count} document${count === 1 ? "" : "s"} uploaded` : required ? <Badge value="missing" /> : "No documents uploaded"}</td><td><div className="booking-issuance"><span>{folder?.issuedAt ? `Issued ${dateLabel(folder.issuedAt)}` : "Not issued"}</span>{member.role === "admin" && <button className="text-link" aria-label={`${folder?.issuedAt ? "Mark not issued" : "Mark issued"}: ${service.label}`} disabled={Boolean(issuing) || !folder} onClick={() => void setIssued(service.key, !folder?.issuedAt)}>{issuing === service.key ? "Saving…" : folder?.issuedAt ? "Mark not issued" : "Mark issued"}</button>}</div></td></tr>;
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
  return <BookingForm key={`${member.id}/${member.organization_id}/${customerId || "new"}`} selectedCustomerId={customerId} />;
}

function BookingForm({ selectedCustomerId }: { selectedCustomerId?: string }) {
  const member = useOrganization();
  const root = `/o/${member.organization_id}`;
  const navigate = useNavigate();
  return <>
    <Link className="record-back" to={selectedCustomerId ? `${root}/users/${selectedCustomerId}` : root}><ArrowLeft size={15} />{selectedCustomerId ? "Customer record" : "Overview"}</Link>
    <PageHeading title="Add Booking" />
    {!selectedCustomerId && <section className="booking-customer"><CustomerPicker onSelect={customer => {
      if (customer) navigate(`${root}/customers/${customer.id}/bookings/new`, { replace: true });
    }} /></section>}
    {selectedCustomerId && <SelectedBookingForm key={selectedCustomerId} customerId={selectedCustomerId} onSaved={(id) => navigate(`${root}/users/${selectedCustomerId}/bookings/${id}`)} />}
  </>;
}

function SelectedBookingForm({ customerId, onSaved, booking, onCancel }: { customerId: string; onSaved: (id: string) => void; booking?: Booking; onCancel?: () => void }) {
  const member = useOrganization();
  const base = `/organizations/${member.organization_id}/customers/${customerId}`;
  const account = useResource<Customer>(base);
  const existing = useResource<BookingsResponse>(`${base}/bookings`);
  const draftKey = booking ? null : bookingDraftKey(member.organization_id, member.id, customerId);
  const [restoredDraft] = useState(() => draftKey ? readBookingDraft(draftKey) : null);
  const [fields, setFields] = useState<BookingDraftFields>(() => restoredDraft?.fields ?? {
    reference: booking?.reference || "",
    departure: booking ? departureLocal(booking.departure_at, booking.time_zone || "UTC") : "",
    amount: booking ? bookingAmountInput(booking.total_minor) : "",
    effectiveDate: booking ? [booking.effective_date, businessDate(booking.time_zone || "UTC")].sort().at(-1)! : "",
    required: booking?.required_services || [],
    instalments: booking?.instalments?.map(item => ({ key: item.id, due_date: item.due_date, amount: bookingAmountInput(item.amount_minor) })) || [],
  });
  const { reference, departure, amount, effectiveDate, required, instalments } = fields;
  const currentFields = useRef(fields);
  const [draftStatus, setDraftStatus] = useState<"empty" | "saved" | "restored" | "error" | "discarded">(restoredDraft ? "restored" : "empty");
  const [reason, setReason] = useState("");
  const submission = useRef(restoredDraft?.submission ?? { payload: "", key: crypto.randomUUID() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function persistDraft(next = currentFields.current) {
    if (!draftKey) return;
    setDraftStatus(writeBookingDraft(draftKey, { fields: next, submission: submission.current }) ? "saved" : "error");
  }
  function change<K extends keyof BookingDraftFields>(field: K, value: BookingDraftFields[K] | ((previous: BookingDraftFields[K]) => BookingDraftFields[K])) {
    const next = { ...currentFields.current, [field]: typeof value === "function" ? value(currentFields.current[field]) : value };
    currentFields.current = next;
    setFields(next);
    // Write in the input event itself, so an immediate refresh keeps the last keystroke.
    persistDraft(next);
  }
  const setReference = (value: string) => change("reference", value);
  const setDeparture = (value: string) => change("departure", value);
  const setAmount = (value: string) => change("amount", value);
  const setEffectiveDate = (value: string) => change("effectiveDate", value);
  const setRequired = (value: (previous: string[]) => string[]) => change("required", value);
  const setInstalments = (value: (previous: BookingDraftFields['instalments']) => BookingDraftFields['instalments']) => change("instalments", value);
  function discardDraft() {
    const next = { reference: "", departure: "", amount: "", effectiveDate: businessDate(existing.data!.time_zone), required: [], instalments: [] };
    currentFields.current = next; setFields(next); setError("");
    submission.current = { payload: "", key: crypto.randomUUID() };
    setDraftStatus(draftKey && removeBookingDraft(draftKey) ? "discarded" : "error");
  }
  useEffect(() => {
    if (existing.data?.time_zone && !effectiveDate) setEffectiveDate(businessDate(existing.data.time_zone));
  }, [existing.data?.time_zone, effectiveDate]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!existing.data || !account.data || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = {
        reference, departure_at: departureInstant(departure, existing.data.time_zone),
        amount, effective_date: effectiveDate, required_services: required,
        instalments: (booking && !instalments.length ? [{ due_date: effectiveDate, amount }] : instalments).map(({ due_date, amount }) => ({ due_date, amount })),
        ...(booking ? { expected_version: booking.version, reason } : {}),
      };
      const signature = JSON.stringify(payload);
      if (submission.current.payload !== signature) submission.current = { payload: signature, key: crypto.randomUUID() };
      // Retain the retry key across refreshes, including a lost successful response.
      persistDraft();
      const saved = await mutate<Booking>(`${base}/bookings${booking ? `/${booking.id}` : ""}`, { ...payload, idempotency_key: submission.current.key }, booking ? "PATCH" : "POST");
      if (draftKey) removeBookingDraft(draftKey);
      onSaved(saved.id);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  if (account.error || existing.error) return <><ErrorNotice message={account.error || existing.error} /><button className="button secondary" onClick={() => { account.refresh(); existing.refresh(); }}>Try again</button></>;
  if (account.loading || existing.loading || !account.data || !existing.data) return <Loading />;
  return <section className="panel booking-editor"><form className="stack-form" onSubmit={submit} aria-busy={busy} aria-label={booking ? "Edit booking" : "Create booking"}>
    <div><span className="eyebrow">{account.data.customer_code}</span><h2>{booking ? "Edit booking" : account.data.name}</h2></div>
    {!booking && <div className="form-actions"><p className="booking-help" role="status">{draftStatus === "error" ? "Draft saving is unavailable in this browser. Keep this page open until the booking is created."
      : draftStatus === "restored" ? "Draft restored. Changes are saved automatically on this device."
      : draftStatus === "discarded" ? "Draft discarded. Start a new booking below."
      : "Draft saved automatically on this device."}</p><button type="button" className="text-link" disabled={busy} onClick={discardDraft}>Discard draft</button></div>}
    <ErrorNotice message={error} />
    {member.currency !== "GBP" && <ErrorNotice message="This workspace’s accounting currency is not GBP. GBP bookings require a GBP workspace; existing ledger amounts cannot be relabelled." />}
    <div className="form-columns">
      <label>Booking reference<input required maxLength={160} value={reference} onChange={(event) => setReference(event.target.value)} /></label>
      <label>Departure ({existing.data.time_zone})<input required type="datetime-local" value={departure} onChange={(event) => setDeparture(event.target.value)} /></label>
    </div>
    <div className="form-columns">
      <label>Booking total (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
      <label>{booking ? "Correction effective date" : "Charge effective date"}<input required type="date" min={booking?.effective_date} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>
    </div>
    {booking && <><p className="booking-help">Changing the total posts a reversal and replacement charge. Approved payments stay on the customer’s ledger.</p><label>Reason for change<textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label></>}
    <fieldset className="booking-services"><legend>Required services</legend><div>{bookingServices.map((service) => <label key={service.key}><input type="checkbox" checked={required.includes(service.key)} onChange={(event) => setRequired((previous) => event.target.checked ? [...previous, service.key] : previous.filter((key) => key !== service.key))} />{service.label}</label>)}</div></fieldset>
    <fieldset className="booking-instalments"><legend>Instalments (GBP)</legend><small>{instalments.length ? "The instalment total can be up to £5 above or below the booking total. Your booking total stays the same." : "Full amount due on charge date unless scheduled below."}</small>
      {instalments.map((instalment, index) => <div className="booking-instalment-row" key={instalment.key}><label>Due date {index + 1}<input required type="date" value={instalment.due_date} onChange={(event) => setInstalments((rows) => rows.map((row) => row.key === instalment.key ? { ...row, due_date: event.target.value } : row))} /></label><label>Amount (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} value={instalment.amount} onChange={(event) => setInstalments((rows) => rows.map((row) => row.key === instalment.key ? { ...row, amount: event.target.value } : row))} /></label><button type="button" className="icon-button" aria-label={`Remove instalment ${index + 1}`} onClick={() => setInstalments((rows) => rows.filter((row) => row.key !== instalment.key))}><X size={17} /></button></div>)}
      <button type="button" className="text-link" disabled={instalments.length >= 100} onClick={() => setInstalments((rows) => [...rows, { key: crypto.randomUUID(), due_date: effectiveDate, amount: rows.length ? "" : amount }])}><Plus size={15} />Add instalment</button>
    </fieldset>
    <div className="form-actions">{onCancel ? <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Discard changes</button> : <Link className="button secondary" to={`/o/${member.organization_id}/users/${customerId}`}>Cancel</Link>}<button className="button" disabled={busy || member.currency !== "GBP" || account.data.status !== "active"}>{busy ? "Saving…" : booking ? "Save booking" : "Create booking"}</button></div>
  </form></section>;
}

function CancelBookingForm({ customerId, booking, onCancel }: { customerId: string; booking: Booking; onCancel: () => void }) {
  const member = useOrganization();
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(() => [booking.effective_date, businessDate(booking.time_zone || "UTC")].sort().at(-1)!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submission = useRef({ payload: "", key: crypto.randomUUID() });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || confirmation !== booking.reference) return;
    setBusy(true); setError("");
    try {
      const payload = { confirmation, reason, effective_date: effectiveDate, expected_version: booking.version };
      const signature = JSON.stringify(payload);
      if (submission.current.payload !== signature) submission.current = { payload: signature, key: crypto.randomUUID() };
      await mutate(`/organizations/${member.organization_id}/customers/${customerId}/bookings/${booking.id}`, { ...payload, idempotency_key: submission.current.key }, "DELETE");
      navigate(`/o/${member.organization_id}/users/${customerId}`);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="panel booking-editor booking-cancellation"><form className="stack-form" onSubmit={submit} aria-label="Cancel booking" aria-busy={busy}>
    <h2>Cancel {booking.reference}</h2>
    <p>This removes the booking from active records and revokes access to its documents. The current booking charge is reversed. Approved payments remain as customer credit; pending submissions are rejected. Financial history is retained.</p>
    <ErrorNotice message={error} />
    <label>Cancellation reason<textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
    <label>Cancellation effective date<input type="date" required min={booking.effective_date} value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)} /></label>
    <label>Type {booking.reference} to confirm<input required autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
    <div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Keep booking</button><button className="button danger" disabled={busy || confirmation !== booking.reference || !reason.trim()}>{busy ? "Cancelling…" : "Confirm cancellation"}</button></div>
  </form></section>;
}
