import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { dateLabel, money, useResource } from "../api";
import { Empty, ErrorNotice, TableSkeleton, PageHeading, Pagination } from "../components";
import { Navigate } from "../router";
import { useOrganization } from "../state";
import { CompanyEditor } from "./CompanyEditor";
import { DeleteCompanyDialog } from "./DeleteCompanyDialog";
import { companyDateFields, companyMoneyFields, type Company, type CompanyDateField, type CompanyList } from "./model";
import "../pages/ListFilters.css";
import "./companies.css";

export function CompaniesPage() {
  const member = useOrganization();
  if (member.role !== "admin") return <Navigate to={`/o/${member.organization_id}`} replace />;
  return <CompaniesDirectory key={member.organization_id} organizationId={member.organization_id} />;
}

function CompaniesDirectory({ organizationId }: { organizationId: string }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [dateField, setDateField] = useState<CompanyDateField>("booking_date");
  const [start, setStart] = useState(""), [end, setEnd] = useState("");
  const [page, setPage] = useState(1), [size, setSize] = useState(25);
  const [editor, setEditor] = useState<{ company?: Company; currency: string; exponent: number } | null>(null);
  const [deleting, setDeleting] = useState<Company | null>(null);
  const [notice, setNotice] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timeout);
  }, [search]);
  const invalidDates = Boolean(start && end && start > end);
  const filtered = Boolean(search || start || end || dateField !== "booking_date");
  const params = new URLSearchParams({ page: String(page), page_size: String(size), date_field: dateField });
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
    setNotice(`${company.company_name} ${editor?.company ? "updated" : "added"}.`);
    setEditor(null);
    resource.refresh();
  }
  function deleted() {
    setNotice(`${deleting?.company_name || "Company"} deleted.`);
    setDeleting(null);
    if (data?.items.length === 1 && page > 1) setPage(page - 1);
    resource.refresh();
    requestAnimationFrame(() => addButton.current?.focus());
  }
  return <div className="companies-page">
    <PageHeading title="Companies" description="A company directory with hotel, voucher and payment details."
      actions={<button ref={addButton} type="button" className="button" disabled={!data} onClick={() => { if (data) setEditor({ currency: data.currency, exponent: data.currency_exponent }); }}><Plus size={17} />Add company</button>} />
    {notice && <div className="notice success companies-notice" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label="Dismiss company notification" onClick={() => setNotice("")}><X size={16} /></button></div>}
    <section className="panel companies-panel" aria-label="Companies directory">
      <div className="record-filters companies-filters" role="search" aria-label="Filter companies">
        <label className="record-filter-search">Search companies<input type="search" maxLength={200} placeholder="Company, hotel, customer, voucher or remarks" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label className="record-filter-select">Date field<select value={dateField} onChange={event => { setDateField(event.target.value as CompanyDateField); setPage(1); }}>{companyDateFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label>
        <label className="record-filter-date">From date<input type="date" value={start} min="1900-01-01" max={end || "9999-12-31"} aria-invalid={invalidDates || undefined} onChange={event => { setStart(event.target.value); setPage(1); }} /></label>
        <label className="record-filter-date">To date<input type="date" value={end} min={start || "1900-01-01"} max="9999-12-31" aria-invalid={invalidDates || undefined} onChange={event => { setEnd(event.target.value); setPage(1); }} /></label>
        <button type="button" className="icon-button" aria-label="Refresh companies" disabled={resource.loading || invalidDates} onClick={resource.refresh}><RefreshCw size={17} /></button>
      </div>
      <div className="record-filter-summary">
        <p role="status">{invalidDates ? "Check the date range" : resource.loading || search.trim() !== query ? "Searching…" : data ? `${data.total} ${data.total === 1 ? "company" : "companies"} · Amounts in ${data.currency}` : "Companies"}</p>
        {filtered && <button type="button" className="text-link" onClick={clearFilters}>Clear filters</button>}
      </div>
      {invalidDates ? <div className="companies-state"><ErrorNotice message="From date must be on or before To date." /></div> : resource.error ? <div className="companies-state"><ErrorNotice message={resource.error} /><button type="button" className="button secondary" onClick={resource.refresh}>Try again</button></div> : !data ? <TableSkeleton columns={["Company name", "Hotel name", "Customer name", "Check-in", "Check-out", "Room type"]} label="Loading companies" /> : <div aria-busy={resource.loading}>
        {data.items.length ? <><p className="companies-scroll-hint">Scroll horizontally to see all fields.</p><div className="table-scroll companies-table-scroll" tabIndex={0} role="region" aria-label="Companies table, scroll horizontally for all columns">
          <table className="compact-record-table companies-table">
            <caption className="sr-only">One row per company. Amounts in {data.currency}.</caption>
            <thead><tr>
              <th scope="col">Company name</th><th scope="col">Hotel name</th><th scope="col">Customer name</th>
              <th scope="col">Check-in</th><th scope="col">Check-out</th><th scope="col">Room type</th>
              <th scope="col">Booking date</th><th scope="col">Voucher number</th>
              {companyMoneyFields.map(field => <th scope="col" className="align-right" key={field.name}>{field.label}</th>)}
              <th scope="col">Remarks</th><th scope="col">Actions</th>
            </tr></thead>
            <tbody>{data.items.map(company => <tr key={company.id}>
              <th scope="row"><strong>{company.company_name}</strong></th>
              <td className="companies-text">{company.hotel_name || "—"}</td>
              <td className="companies-text">{company.customer_name || "—"}</td>
              <td className="companies-date">{company.check_in ? dateLabel(company.check_in) : "—"}</td>
              <td className="companies-date">{company.check_out ? dateLabel(company.check_out) : "—"}</td>
              <td className="companies-text">{company.room_type || "—"}</td>
              <td className="companies-date">{company.booking_date ? dateLabel(company.booking_date) : "—"}</td>
              <td className="companies-text">{company.voucher_number || "—"}</td>
              {companyMoneyFields.map(field => <td key={field.name} className="align-right amount">{company[field.minor] === null ? "—" : money(company[field.minor] ?? undefined, data.currency, data.currency_exponent)}</td>)}
              <td className="companies-remarks">{company.remarks || "—"}</td>
              <td><div className="companies-row-actions">
                <button type="button" className="icon-button" aria-label={`Edit ${company.company_name}`} onClick={() => setEditor({ company, currency: data.currency, exponent: data.currency_exponent })}><Pencil size={16} /></button>
                <button type="button" className="icon-button danger-text" aria-label={`Delete ${company.company_name}`} onClick={() => setDeleting(company)}><Trash2 size={16} /></button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div></> : <Empty title={filtered ? "No matching companies" : "No companies yet"} detail={filtered ? "Try another search or date range, or clear your filters." : "Add a company to keep its hotel, voucher and payment details in one place."} />}
        <div className="companies-table-footer">
          <label>Rows<select aria-label="Companies per page" value={size} onChange={event => { setSize(Number(event.target.value)); setPage(1); }}>{[10, 25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <Pagination page={data.page} total={data.total} size={data.page_size} onPage={setPage} />
        </div>
      </div>}
    </section>
    {editor && <CompanyEditor organizationId={organizationId} initial={editor.company} currency={editor.currency} exponent={editor.exponent} onClose={() => setEditor(null)} onSaved={saved} onRefresh={refreshFromDialog} />}
    {deleting && <DeleteCompanyDialog organizationId={organizationId} company={deleting} onClose={() => setDeleting(null)} onDeleted={deleted} onRefresh={refreshFromDialog} />}
  </div>;
}
