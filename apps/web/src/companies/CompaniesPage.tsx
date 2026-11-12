import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Building2, FileSpreadsheet, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { dateLabel, money, useResource } from "../api";
import { Empty, ErrorNotice, TableSkeleton, PageHeading, Pagination } from "../components";
import { Link, Navigate, useParams } from "../router";
import { useOrganization } from "../state";
import { CompanyPaidDialog } from "./CompanyPaidDialog";
import { CompanySpreadsheet } from "./CompanySpreadsheet";
import { CompanyEditor } from "./CompanyEditor";
import { DeleteCompanyDialog } from "./DeleteCompanyDialog";
import { companyDirectory, companyDateFields, companyMoneyFields, type Company, type CompanyDateField, type CompanyList } from "./model";
import "../pages/ListFilters.css";
import "./companies.css";

// Company voucher labels are fixed to SAR; stored amounts and precision stay unchanged.
const companyCurrency = "SAR";

export function CompaniesPage() {
  const member = useOrganization();
  const { companySlug } = useParams();
  if (member.role !== "admin") return <Navigate to={`/o/${member.organization_id}`} replace />;
  const root = `/o/${member.organization_id}/companies`;
  if (!companySlug) return <div className="companies-page">
    <PageHeading title="Companies" description="Choose a company to view and manage its customer records." />
    <div className="company-card-grid">
      {companyDirectory.map(company => <Link key={company.slug} to={`${root}/${company.slug}`} className="company-card" aria-label={company.name}>
        <span className="company-card-icon"><Building2 size={24} aria-hidden="true" /></span>
        <h2>{company.name}</h2>
        <p>Customer records, hotel stays and voucher details.</p>
        <span className="company-card-action">View records <ArrowRight size={17} aria-hidden="true" /></span>
      </Link>)}
    </div>
  </div>;
  const company = companyDirectory.find(item => item.slug === companySlug);
  if (!company) return <Navigate to={root} replace />;
  return <CompanyRecords key={`${member.organization_id}:${company.slug}`} organizationId={member.organization_id} companyName={company.name} />;
}

function CompanyRecords({ organizationId, companyName }: { organizationId: string; companyName: string }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [dateField, setDateField] = useState<CompanyDateField>("booking_date");
  const [start, setStart] = useState(""), [end, setEnd] = useState("");
  const [page, setPage] = useState(1), [size, setSize] = useState(25);
  const [editor, setEditor] = useState<{ company?: Company; currency: string; exponent: number } | null>(null);
  const [deleting, setDeleting] = useState<Company | null>(null);
  const [notice, setNotice] = useState("");
  const [spreadsheet, setSpreadsheet] = useState(false);
  const [paidEditor, setPaidEditor] = useState<{ paidMinor: string; version: number; currency: string; exponent: number } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timeout);
  }, [search]);
  const invalidDates = Boolean(start && end && start > end);
  const filtered = Boolean(search || start || end || dateField !== "booking_date");
  const params = new URLSearchParams({ company_name: companyName, page: String(page), page_size: String(size), date_field: dateField });
  if (query) params.set("search", query);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const resource = useResource<CompanyList>(invalidDates ? null : `/organizations/${organizationId}/companies?${params}`, { cache: true });
  const data = resource.data;
  useEffect(() => {
    if (!data || resource.loading) return;
    const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
    if (page > lastPage) setPage(lastPage);
  }, [data, page, resource.loading]);
  function clearFilters() {
    setSearch(""); setQuery(""); setDateField("booking_date"); setStart(""); setEnd(""); setPage(1);
  }
  function refreshFromDialog() {
    setEditor(null); setDeleting(null); resource.refresh();
  }
  function saved(company: Company) {
    setNotice(`${company.customer_name || "Customer record"} ${editor?.company ? "updated" : "added"}.`);
    setEditor(null);
    resource.refresh();
  }
  function deleted() {
    setNotice(`${deleting?.customer_name || "Customer record"} deleted.`);
    setDeleting(null);
    if (data?.items.length === 1 && page > 1) setPage(page - 1);
    resource.refresh();
    requestAnimationFrame(() => addButton.current?.focus());
  }
  return <div className="companies-page">
    <Link className="company-back-link" to={`/o/${organizationId}/companies`}><ArrowLeft size={16} aria-hidden="true" />All companies</Link>
    <PageHeading title={companyName} description="Customer records with hotel, voucher and payment details."
      actions={<><button type="button" className="button secondary" onClick={event => { event.currentTarget.focus(); setSpreadsheet(true); }}><FileSpreadsheet size={17} />Preview Excel</button><button ref={addButton} type="button" className="button" disabled={!data} onClick={() => { if (data) setEditor({ currency: companyCurrency, exponent: data.currency_exponent }); }}><Plus size={17} />Add Voucher</button></>} />
    {data && <section className="panel company-totals" aria-label="Company totals">
      <div className="company-totals-heading"><h2>Company totals</h2><button type="button" className="button secondary small" disabled={data.totals.paid_version === null} onClick={() => setPaidEditor({ paidMinor: data.totals.paid_minor, version: data.totals.paid_version!, currency: companyCurrency, exponent: data.currency_exponent })}><Pencil size={14} />Edit paid</button></div>
      <p>{data.totals.voucher_count} {data.totals.voucher_count === 1 ? "voucher" : "vouchers"} · All vouchers in {companyName}</p>
      <dl>{[
        ["Voucher total", data.totals.total_minor], ["Total paid", data.totals.paid_minor],
        ["Unpaid", data.totals.unpaid_minor], ["Balance", data.totals.balance_minor],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null ? "—" : money(value, companyCurrency, data.currency_exponent)}</dd></div>)}</dl>
      {data.totals.unpriced_count > 0 && <p>Enter a voucher total for {data.totals.unpriced_count} {data.totals.unpriced_count === 1 ? "voucher" : "vouchers"} to calculate total and balance.</p>}
    </section>}
    {notice && <div className="notice success companies-notice" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label="Dismiss record notification" onClick={() => setNotice("")}><X size={16} /></button></div>}
    <section className="panel companies-panel" aria-label={`${companyName} customer records`}>
      <div className="record-filters companies-filters" role="search" aria-label="Filter records">
        <label className="record-filter-search">Search records<input type="search" maxLength={200} placeholder="Customer, hotel, voucher or remarks" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label className="record-filter-select">Date field<select value={dateField} onChange={event => { setDateField(event.target.value as CompanyDateField); setPage(1); }}>{companyDateFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label>
        <label className="record-filter-date">From date<input type="date" value={start} min="1900-01-01" max={end || "9999-12-31"} aria-invalid={invalidDates || undefined} onChange={event => { setStart(event.target.value); setPage(1); }} /></label>
        <label className="record-filter-date">To date<input type="date" value={end} min={start || "1900-01-01"} max="9999-12-31" aria-invalid={invalidDates || undefined} onChange={event => { setEnd(event.target.value); setPage(1); }} /></label>
        <button type="button" className="icon-button" aria-label="Refresh records" disabled={resource.loading || invalidDates} onClick={resource.refresh}><RefreshCw size={17} /></button>
      </div>
      <div className="record-filter-summary">
        <p role="status">{invalidDates ? "Check the date range" : resource.loading || search.trim() !== query ? "Searching…" : data ? `${data.total} ${data.total === 1 ? "record" : "records"} · Amounts in ${companyCurrency}` : "Customer records"}</p>
        {filtered && <button type="button" className="text-link" onClick={clearFilters}>Clear filters</button>}
      </div>
      {invalidDates ? <div className="companies-state"><ErrorNotice message="From date must be on or before To date." /></div> : resource.error ? <div className="companies-state"><ErrorNotice message={resource.error} /><button type="button" className="button secondary" onClick={resource.refresh}>Try again</button></div> : !data ? <TableSkeleton columns={["Customer name", "Hotel name", "Check-in", "Check-out", "Quantity", "Room type"]} label="Loading records" /> : <div aria-busy={resource.loading}>
        {data.items.length ? <><p className="companies-scroll-hint">Scroll horizontally to see all fields.</p><div className="table-scroll companies-table-scroll" tabIndex={0} role="region" aria-label="Customer records table, scroll horizontally for all columns">
          <table className="compact-record-table companies-table">
            <caption className="sr-only">Customer records for {companyName}. Amounts in {companyCurrency}.</caption>
            <thead><tr>
              <th scope="col">Customer name</th><th scope="col">Hotel name</th>
              <th scope="col">Check-in</th><th scope="col">Check-out</th><th scope="col">Quantity</th><th scope="col">Room type</th>
              <th scope="col">Booking date</th><th scope="col">Voucher number</th>
              {companyMoneyFields.map(field => <th scope="col" className="align-right" key={field.name}>{field.label}</th>)}
              <th scope="col">Remarks</th><th scope="col">Actions</th>
            </tr></thead>
            <tbody>{data.items.map(company => <tr key={company.id}>
              <th scope="row"><strong>{company.customer_name || "Unnamed customer"}</strong></th>
              <td className="companies-text">{company.hotel_name || "—"}</td>
              <td className="companies-date">{company.check_in ? dateLabel(company.check_in) : "—"}</td>
              <td className="companies-date">{company.check_out ? dateLabel(company.check_out) : "—"}</td>
              <td className="amount">{company.quantity}</td>
              <td className="companies-text">{company.room_type || "—"}</td>
              <td className="companies-date">{company.booking_date ? dateLabel(company.booking_date) : "—"}</td>
              <td className="companies-text">{company.voucher_number || "—"}</td>
              {companyMoneyFields.map(field => <td key={field.name} className="align-right amount">{company[field.minor] === null ? "—" : money(company[field.minor] ?? undefined, companyCurrency, data.currency_exponent)}</td>)}
              <td className="companies-remarks">{company.remarks || "—"}</td>
              <td><div className="companies-row-actions">
                <button type="button" className="icon-button" aria-label={`Edit ${company.customer_name || "record"}`} onClick={() => setEditor({ company, currency: companyCurrency, exponent: data.currency_exponent })}><Pencil size={16} /></button>
                <button type="button" className="icon-button danger-text" aria-label={`Delete ${company.customer_name || "record"}`} onClick={() => setDeleting(company)}><Trash2 size={16} /></button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div></> : <Empty title={filtered ? "No matching records" : "No records yet"} detail={filtered ? "Try another search or date range, or clear your filters." : `Add the first customer record for ${companyName}.`} />}
        <div className="companies-table-footer">
          <label>Rows<select aria-label="Records per page" value={size} onChange={event => { setSize(Number(event.target.value)); setPage(1); }}>{[10, 25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <Pagination page={data.page} total={data.total} size={data.page_size} onPage={setPage} />
        </div>
      </div>}
    </section>
    {spreadsheet && <CompanySpreadsheet organizationId={organizationId} companyName={companyName} onClose={() => setSpreadsheet(false)} />}
    {paidEditor && <CompanyPaidDialog organizationId={organizationId} companyName={companyName} {...paidEditor}
      onClose={() => setPaidEditor(null)} onSaved={() => { setPaidEditor(null); setNotice("Company paid amount updated."); resource.refresh(); }}
      onRefresh={() => { setPaidEditor(null); resource.refresh(); }} />}
    {editor && <CompanyEditor organizationId={organizationId} companyName={companyName} initial={editor.company} currency={editor.currency} exponent={editor.exponent} onClose={() => setEditor(null)} onSaved={saved} onRefresh={refreshFromDialog} />}
    {deleting && <DeleteCompanyDialog organizationId={organizationId} company={deleting} onClose={() => setDeleting(null)} onDeleted={deleted} onRefresh={refreshFromDialog} />}
  </div>;
}
