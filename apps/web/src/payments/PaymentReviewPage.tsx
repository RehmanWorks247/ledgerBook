import { useEffect, useState } from "react";
import { RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useResource } from "../api";
import { Empty, ErrorNotice, TableSkeleton, PageHeading, Pagination } from "../components";
import { Navigate } from "../router";
import { useOrganization } from "../state";
import { PaymentDetailsDialog, PaymentTable } from "./PaymentTable";
import type { Payment, PaymentReviewResponse, PaymentReviewStatus } from "./model";

const statuses = [{ value: "pending", label: "Pending review" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }, { value: "all", label: "All payments" }] as const;
const sorts = [{ value: "oldest", label: "Oldest first" }, { value: "newest", label: "Newest first" }, { value: "amount_desc", label: "Amount: high to low" }, { value: "amount_asc", label: "Amount: low to high" }];
function initialDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

export function PaymentReviewPage() {
  const member = useOrganization();
  if (member.role !== "admin") return <Navigate to={`/o/${member.organization_id}`} replace />;
  return <PaymentReviewContents key={member.id} />;
}

function PaymentReviewContents() {
  const member = useOrganization();
  const [initial] = useState(() => new URLSearchParams(window.location.search));
  const [status, setStatus] = useState<PaymentReviewStatus>(() => statuses.find(item => item.value === initial.get("status"))?.value || "pending");
  const [search, setSearch] = useState(() => (initial.get("q") || "").slice(0, 200));
  const [query, setQuery] = useState(search);
  const [from, setFrom] = useState(() => initialDate(initial.get("from")));
  const [to, setTo] = useState(() => initialDate(initial.get("to")));
  const [sort, setSort] = useState(() => sorts.find(item => item.value === initial.get("sort"))?.value || "oldest");
  const [page, setPage] = useState(() => Math.floor(Math.max(1, Math.min(1000000, Number(initial.get("page")) || 1))));
  const [size, setSize] = useState(() => [10, 25, 50, 100].includes(Number(initial.get("page_size"))) ? Number(initial.get("page_size")) : 25);
  const [selected, setSelected] = useState<{ payment: Payment; timeZone: string } | null>(null);
  const [notice, setNotice] = useState("");
  const invalidDates = Boolean(from && to && from > to);
  const filtered = Boolean(search || from || to);
  useEffect(() => {
    if (query === search.trim()) return;
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  const queryParams = new URLSearchParams({ status, sort, page: String(page), page_size: String(size) });
  if (query) queryParams.set("q", query);
  if (from && !invalidDates) queryParams.set("from", from);
  if (to && !invalidDates) queryParams.set("to", to);
  const params = queryParams.toString();
  useEffect(() => { window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`); }, [params]);
  const resource = useResource<PaymentReviewResponse>(`/organizations/${member.organization_id}/payment-submissions?${params}`, { cache: true });
  const emailStatus = useResource<{ retrying: number }>(`/organizations/${member.organization_id}/payment-email-status`, { cache: true });
  useEffect(() => { if (resource.data) setPage(resource.data.page); }, [resource.data]);
  function refresh() { resource.refresh(); emailStatus.refresh(); }
  function clearFilters() { setSearch(""); setQuery(""); setFrom(""); setTo(""); setPage(1); }
  function reviewed(payment: Payment) {
    setSelected(null);
    setNotice(payment.status === "approved" ? `Payment for ${payment.booking_reference} approved and recorded. The customer’s confirmation email is queued.` : `Payment for ${payment.booking_reference} rejected. The review note is visible to the customer.`);
    refresh();
  }
  return <div className="payment-review-page">
    <PageHeading title="Payment reviews" description="Find a payment, check its receipts and record your decision." actions={<button type="button" className="button secondary" aria-label="Refresh payment submissions" disabled={resource.loading} onClick={refresh}><RefreshCw size={15} />Refresh</button>} />
    {notice && <div className="notice success payment-result-notice" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label="Dismiss payment notification" onClick={() => setNotice("")}><X size={16} /></button></div>}
    {!!emailStatus.data?.retrying && <div className="notice" role="status">{emailStatus.data.retrying} notification email{emailStatus.data.retrying === 1 ? " is" : "s are"} waiting to retry. Payment records are saved.</div>}
    <section className="panel payment-review-panel" aria-label="Payment review queue">
      <div className="payment-status-tabs" role="group" aria-label="Payment status">{statuses.map(item => <button type="button" key={item.value} aria-pressed={status === item.value} onClick={() => { setStatus(item.value); setPage(1); }}><span>{item.label}</span>{resource.data?.counts && <span className="payment-tab-count">{resource.data.counts[item.value]}</span>}</button>)}</div>
      <div className="payment-query-toolbar" role="search" aria-label="Find payment submissions">
        <label className="payment-query-search"><span>Search payments</span><div><Search size={16} aria-hidden="true" /><input type="search" value={search} maxLength={200} placeholder="ID, name, booking, date, amount…" onChange={event => setSearch(event.target.value)} aria-describedby="payment-search-help" /></div></label>
        <label>Payment from<input type="date" value={from} max={to || undefined} aria-invalid={invalidDates || undefined} onChange={event => { setFrom(event.target.value); setPage(1); }} /></label>
        <label>Payment to<input type="date" value={to} min={from || undefined} aria-invalid={invalidDates || undefined} onChange={event => { setTo(event.target.value); setPage(1); }} /></label>
        <label>Sort by<select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>{sorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>
      <div className="payment-query-summary"><p id="payment-search-help"><SlidersHorizontal size={13} aria-hidden="true" /><span>Search IDs, names, email, dates, amounts, notes and receipt names.</span></p>{filtered && <button type="button" className="text-link" onClick={clearFilters}><X size={13} />Clear filters</button>}</div>
      {invalidDates ? <div className="payment-state"><ErrorNotice message="Payment from must be on or before payment to." /></div> : resource.error ? <div className="payment-state"><ErrorNotice message={resource.error} /><button type="button" className="button secondary" onClick={resource.refresh}>Try again</button></div> : !resource.data ? <TableSkeleton columns={["Customer", "Booking", "Payment date", "Amount", "Status", "Actions"]} label="Loading payment reviews" /> : <div aria-busy={resource.loading}>
        {!resource.data.items.length ? <div className="payment-empty"><Empty title={filtered ? "No matching payments" : status === "pending" ? "You’re all caught up" : "No payments here yet"} detail={filtered ? "Try another ID, name or date range, or clear your filters." : status === "pending" ? "New payment submissions will appear here for review." : "Payments will appear here as customers submit receipts and decisions are recorded."} />{filtered && <button type="button" className="button secondary" onClick={clearFilters}>Clear filters</button>}{status !== "all" && <button type="button" className="text-link" onClick={() => { setStatus("all"); setPage(1); }}>Search all statuses</button>}</div> : <PaymentTable payments={resource.data.items} organizationId={member.organization_id} timeZone={resource.data.time_zone} canReview showCustomer onOpen={payment => setSelected({ payment, timeZone: resource.data!.time_zone })} />}
        <div className="payment-table-footer"><label>Rows<select aria-label="Payments per page" value={size} onChange={event => { setSize(Number(event.target.value)); setPage(1); }}>{[10, 25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</select></label><Pagination page={resource.data.page} total={resource.data.total} size={resource.data.page_size} onPage={setPage} /></div>
        <p className="payment-timezone">Dates shown in {resource.data.time_zone}. Payment dates use the date supplied by the customer.</p>
      </div>}
    </section>
    {selected && <PaymentDetailsDialog payment={selected.payment} organizationId={member.organization_id} timeZone={selected.timeZone} canReview onClose={() => setSelected(null)} onReviewed={reviewed} />}
  </div>;
}
