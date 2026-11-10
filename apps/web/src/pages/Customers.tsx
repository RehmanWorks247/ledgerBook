import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { Link, Navigate, useNavigate, useParams } from "../router";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  authenticatedFetch,
  dateLabel,
  errorMessage,
  mutate,
  requestCustomerInvitation,
  useResource,
  type Customer,
  type Entry,
  type Statement,
} from "../api";
import { useOrganization } from "../state";
import { useLedgerMoney as useMoney } from '../currency';
import { businessDate } from './booking-model';
import { useDirectoryFilters } from "./directory-filters";
import { amountTone } from "../money-tone";
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  TableSkeleton,
  PageHeading,
  Pagination,
} from "../components";
import { DeleteAccountDialog } from "../DeleteAccountDialog";
type CustomerListData = {
  items: Customer[];
  page: number;
  page_size: number;
  total: number;
  time_zone?: string;
};
export function CustomerList() {
  const money = useMoney();
  const member = useOrganization();
  const { search, setSearch, status, setStatus, dates, setDate, setPage, params, clear, invalidDates, filtered } = useDirectoryFilters();
  const { data, error, loading, refresh } = useResource<CustomerListData>(
    `/organizations/${member.organization_id}/customers?${params}`, { cache: true },
  );
  if (member.role !== "admin")
    return <Navigate to={`/o/${member.organization_id}`} replace />;
  return (
    <>
      <PageHeading
        title="Customer Data"
        actions={
          <Link
            to={`/o/${member.organization_id}/customers/new`}
            className="button"
          >
            <Plus size={18} />
            New customer
          </Link>
        }
      />
      <ErrorNotice message={error} />
      <section className="panel">
        <div className="record-filters" role="search" aria-label="Filter customers">
          <label className="record-filter-search">Search customers<input type="search" placeholder="ID, name, email, phone or date" value={search} maxLength={160} onChange={event => setSearch(event.target.value)} /></label>
          <label className="record-filter-select">Account status<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All accounts</option><option value="active">Active</option><option value="archived">Archived</option></select></label>
          <label className="record-filter-date">Added from<input type="date" value={dates.start} max={dates.end || undefined} onChange={event => setDate("start", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
          <label className="record-filter-date">Added to<input type="date" value={dates.end} min={dates.start || undefined} onChange={event => setDate("end", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
          <button
            type="button"
            className="icon-button"
            onClick={refresh}
            aria-label="Refresh customers"
            disabled={loading}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <div className="record-filter-summary"><p role="status">{loading ? "Searching…" : data ? `${data.total} customer${data.total === 1 ? "" : "s"}${data.time_zone ? ` · Dates in ${data.time_zone}` : ""}` : "Customers"}</p>{filtered && <button type="button" className="text-link" onClick={clear}>Clear filters</button>}</div>
        {invalidDates ? <div className="record-filter-error"><ErrorNotice message="Added from must be on or before added to." /></div> : error ? <div className="record-filter-summary"><button type="button" className="text-link" onClick={refresh}>Try again</button></div> : loading && !data ? (
          <TableSkeleton columns={["Customer", "Status", "Invitation", "Outstanding balance", "Actions"]} label="Loading customers" />
        ) : (
          data && (
            <>
              {data.items.length ? (
                <div className="table-scroll" aria-busy={loading}>
                  <table className="compact-record-table">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Status</th>
                        <th>Invitation</th>
                        <th className="align-right">Outstanding balance</th>
                        <th>
                          <span className="sr-only">View</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((customer) => (
                        <tr key={customer.id}>
                          <td>
                            <Link
                              className="customer-cell"
                              to={`/o/${member.organization_id}/customers/${customer.id}`}
                            >
                              <span className="customer-avatar">
                                {customer.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span>
                                <strong>{customer.name}</strong>
                                <small>{customer.email}</small>
                                <small className="customer-reference">{customer.customer_code}</small>
                              </span>
                            </Link>
                          </td>
                          <td>
                            <Badge value={customer.status} />
                          </td>
                          <td>
                            <Badge
                              value={
                                customer.invitation_status || "not_invited"
                              }
                            />
                            {customer.delivery_status === "failed" && (
                              <small className="text-error">
                                Invitation request failed
                              </small>
                            )}
                          </td>
                          <td
                            className="align-right amount money-charge"
                          >
                            {money(
                              customer.balance_minor,
                              member.currency,
                              member.currency_exponent,
                            )}
                          </td>
                          <td>
                            <Link
                              className="icon-button"
                              aria-label={`View ${customer.name}`}
                              to={`/o/${member.organization_id}/customers/${customer.id}`}
                            >
                              <ChevronRight size={18} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    filtered
                      ? "No matching customers"
                      : "Your first customer is a fresh start"
                  }
                  detail={
                    filtered
                      ? "Try another ID, name, contact detail, date or account status, or clear the filters."
                      : "Create a customer account to start recording transactions and invite them to view their statements."
                  }
                />
              )}
              <Pagination
                page={data.page}
                total={data.total}
                size={data.page_size}
                onPage={setPage}
              />
            </>
          )
        )}
      </section>
    </>
  );
}

export function CustomerEditor() {
  const member = useOrganization();
  const { customerId } = useParams();
  if (member.role !== "admin")
    return <Navigate to={`/o/${member.organization_id}`} replace />;
  return customerId ? (
    <ExistingCustomerEditor customerId={customerId} />
  ) : (
    <CustomerForm />
  );
}
function ExistingCustomerEditor({ customerId }: { customerId: string }) {
  const member = useOrganization();
  const { data, error, loading } = useResource<Customer>(
    `/organizations/${member.organization_id}/customers/${customerId}`,
  );
  return (
    <>
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : (
        data && <CustomerForm key={data.id} initial={data} />
      )}
    </>
  );
}
function CustomerForm({ initial }: { initial?: Customer }) {
  const member = useOrganization();
  const navigate = useNavigate();
  const root = `/o/${member.organization_id}/customers`;
  const [fields, setFields] = useState({
    name: initial?.name || "",
    email: initial?.email || "",
    phone: initial?.phone || "",
    notes: initial?.notes || "",
    status: initial?.status || "active",
  });
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = (name: keyof typeof fields) => ({
    value: fields[name],
    onChange: (
      event: ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => setFields({ ...fields, [name]: event.target.value }),
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const customer = await mutate<Customer>(
        `/organizations/${member.organization_id}/customers${initial ? `/${initial.id}` : ""}`,
        initial
          ? fields
          : {
              name: fields.name,
              email: fields.email,
              phone: fields.phone,
              notes: fields.notes,
              idempotency_key: idempotencyKey,
            },
        initial ? "PATCH" : "POST",
      );
      navigate(`${root}/${customer.id}`);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" to={initial ? `${root}/${initial.id}` : root}>
        <ChevronLeft size={16} />
        {initial ? "Back to account" : "Back to customers"}
      </Link>
      <PageHeading
        title={initial ? "Manage customer" : "Add Customer"}
      />
      <div className="editor-layout customer-editor-layout">
        <section className="panel form-panel">
          <h2>Customer details</h2>
          <ErrorNotice message={error} />
          <form className="stack-form" onSubmit={submit} aria-busy={busy}>
            <label>
              Full name or business name
              <input
                name="name"
                autoComplete="organization"
                maxLength={160}
                required
                {...field("name")}
              />
            </label>
            <div className="form-columns">
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  readOnly={Boolean(initial)}
                  required
                  {...field("email")}
                />
                <small>
                  {initial
                    ? "Email is fixed to protect account identity. To use a different address, archive this account and create a new one."
                    : "Use an address they can access. Ask them to check their inbox and Spam or Junk folder."}
                </small>
              </label>
              <label>
                Phone number <span className="optional">Optional</span>
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  maxLength={40}
                  {...field("phone")}
                />
              </label>
            </div>
            <label>
              Internal notes <span className="optional">Optional</span>
              <textarea
                name="notes"
                rows={4}
                maxLength={2000}
                {...field("notes")}
              />
              <small>Only administrators can view these notes.</small>
            </label>
            {initial && (
              <label>
                Account status
                <select {...field("status")}>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </select>
                <small>
                  Archived accounts keep their complete financial history. New
                  entries are blocked until reactivated.
                </small>
              </label>
            )}
            <div className="form-actions">
              <Link
                className="button secondary"
                to={initial ? `${root}/${initial.id}` : root}
              >
                Cancel
              </Link>
              <button className="button" disabled={busy}>
                {busy
                  ? "Saving…"
                  : initial
                    ? "Save changes"
                    : "Create & invite customer"}
                {!busy && <ArrowRight size={17} />}
              </button>
            </div>
          </form>
        </section>

      </div>
    </>
  );
}

export function CustomerDetail({ recordPayment = false }: { recordPayment?: boolean }) {
  const money = useMoney();
  const member = useOrganization();
  const navigate = useNavigate();
  const { customerId: routeCustomerId } = useParams();
  const customerId = routeCustomerId || member.customer_id;
  const admin = member.role === "admin";
  const base = `/organizations/${member.organization_id}/customers/${customerId}`;
  const [filters, setFilters] = useState({ start: "", end: "", search: "" });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ reversal?: Entry; kind?: string } | null>(recordPayment ? { kind: "payment" } : null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    page_size: "25",
    ...Object.fromEntries(Object.entries(applied).filter(([, value]) => value)),
  });
  const statement = useResource<Statement>(`${base}/statement?${query}`);
  const account = useResource<Customer>(base);
  const data = statement.data && {
    ...statement.data,
    customer: account.data || statement.data.customer,
  };
  const error = statement.error || account.error;
  const loading = statement.loading;
  const refresh = () => {
    statement.refresh();
    account.refresh();
  };
  useEffect(() => {
    setModal(recordPayment ? { kind: "payment" } : null);
    setPage(1);
    setFilters({ start: "", end: "", search: "" });
    setApplied({ start: "", end: "", search: "" });
    setNotice("");
    setActionError("");
    setDeleting(false);
  }, [customerId, recordPayment]);
  async function accessAction(
    action: "invite" | "revoke-invitation" | "revoke-access",
  ) {
    if (
      action !== "invite" &&
      !window.confirm(
        action === "revoke-access"
          ? "Revoke this customer’s access to this business? Their financial history will be preserved."
          : "Revoke the outstanding invitation? This does not revoke already accepted access.",
      )
    )
      return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      if (action === "invite") await requestCustomerInvitation(base);
      else
        await mutate(
          `${base}/${action === "revoke-access" ? "revoke-access" : "invitations"}`,
          undefined,
          action === "revoke-invitation" ? "DELETE" : "POST",
        );
      setNotice(
        action === "invite"
          ? "Clerk accepted the invitation email request. Ask the recipient to check their inbox and Spam or Junk folder."
          : action === "revoke-access"
            ? "Customer access revoked. Financial history is preserved."
            : "Invitation revoked.",
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      refresh();
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setActionError("");
    try {
      const exportQuery = new URLSearchParams(query);
      exportQuery.set("currency", "GBP");
      const response = await authenticatedFetch(`${base}/statement.csv?${exportQuery}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(
          body.message ||
            "Unable to export this statement. Try a smaller date range.",
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "ledgerbook-statement.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {admin && (
        <Link
          className="back-link"
          to={`/o/${member.organization_id}/customers`}
        >
          <ChevronLeft size={16} />
          All customers
        </Link>
      )}
      {!admin && <Link className="back-link" to={`/o/${member.organization_id}`}><ChevronLeft size={16} />My account</Link>}
      <PageHeading
        eyebrow={data?.customer.customer_code}
        title={
          data?.customer.name ||
          (admin ? "Customer account" : "Account overview")
        }
        actions={
          <>
            {data && (
              <Link
                className="button secondary"
                to={`/o/${member.organization_id}/users/${data.customer.id}`}
              >
                <FolderOpen size={16} />
                {admin ? "Profile, bookings & documents" : "My bookings"}
              </Link>
            )}
            {admin && data && (
              <Link
                className="button secondary"
                to={`/o/${member.organization_id}/customers/${customerId}/edit`}
              >
                Manage account
              </Link>
            )}
            {admin && data?.customer.status === "active" && (
              <button className="button" onClick={() => setModal({})}>
                <Plus size={18} />
                Record transaction
              </button>
            )}
          </>
        }
      />
      <ErrorNotice message={error || actionError} />
      {notice && (
        <div role="status" className="notice success">
          {notice}
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="account-summary">
              <div className="balance-card">
                <span className="eyebrow">Outstanding balance</span>
                <strong className="money-charge">
                  {money(
                    data.current_balance_minor,
                    data.currency,
                    data.currency_exponent,
                  )}
                </strong>
                <span>
                  {BigInt(data.current_balance_minor) > 0n
                    ? "Amount owed to the business"
                    : BigInt(data.current_balance_minor) < 0n
                      ? "Customer credit balance"
                      : "All settled up"}
                </span>
              </div>
              <section className="panel contact-card">
                <div className="contact-top">
                  <h2>Account details</h2>
                  <Badge value={data.customer.status} />
                </div>
                <dl>
                  <div>
                    <dt>Email</dt>
                    <dd>{data.customer.email}</dd>
                  </div>
                  <div>
                    <dt>Phone</dt>
                    <dd>{data.customer.phone || "Not provided"}</dd>
                  </div>
                  {admin && (
                    <div>
                      <dt>Invitation</dt>
                      <dd>
                        <Badge
                          value={
                            data.customer.invitation_status || "not_invited"
                          }
                        />
                        {data.customer.delivery_status && (
                          <span
                            className={
                              data.customer.delivery_status === "failed"
                                ? "text-error"
                                : "muted"
                            }
                          >
                            {" "}
                            ·{" "}
                            {data.customer.delivery_status === "sent"
                              ? "Email request accepted"
                              : data.customer.delivery_status === "failed"
                                ? "Email request failed"
                                : "Email request pending"}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
                {admin &&
                  data.customer.invitation_status === "pending" &&
                  data.customer.delivery_status === "sent" && (
                    <p className="small muted">
                      Ask the recipient to check their inbox and Spam or Junk
                      folder for the invitation.
                    </p>
                  )}
                {admin && data.customer.notes && (
                  <div className="internal-note">
                    <strong>Internal notes</strong>
                    <p>{data.customer.notes}</p>
                  </div>
                )}
              </section>
            </div>
            {admin && (
              <div className="access-bar">
                <span>
                  <Mail size={17} />
                  Customer access
                </span>
                <div>
                  <button
                    className="text-link"
                    disabled={
                      busy || !account.data || data.customer.status === "archived" ||
                      data.customer.invitation_status === "accepted"
                    }
                    onClick={() => void accessAction("invite")}
                  >
                    {data.customer.invitation_status === "not_invited"
                      ? "Send invitation"
                      : "Resend invitation"}
                  </button>
                  <button
                    className="text-link muted"
                    disabled={busy || data.customer.invitation_status !== "pending"}
                    onClick={() => void accessAction("revoke-invitation")}
                  >
                    Revoke invitation
                  </button>
                  <button
                    className="text-link danger-text"
                    disabled={busy || data.customer.invitation_status !== "accepted"}
                    onClick={() => void accessAction("revoke-access")}
                  >
                    Revoke access
                  </button>
                </div>
              </div>
            )}
            {data.customer.delivery_status === "failed" &&
              data.customer.invitation_status === "pending" &&
              admin &&
              !actionError && (
                <ErrorNotice message="The invitation request failed. The customer account is saved. Use Send / resend invitation to try again." />
              )}
            <section className="panel statement-panel">
              <div className="panel-heading">
                <div>

                  <h2>Account statement</h2>
                </div>
                <button
                  className="button secondary"
                  disabled={busy || loading}
                  onClick={() => void download()}
                >
                  <Download size={16} />
                  Export CSV
                </button>
              </div>
              <form
                className="record-filters"
                aria-label="Filter statement"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    filters.start &&
                    filters.end &&
                    filters.start > filters.end
                  ) {
                    setActionError(
                      "The start date must be on or before the end date.",
                    );
                    return;
                  }
                  setActionError("");
                  setApplied(filters);
                  setPage(1);
                }}
              >
                <label className="record-filter-date">
                  From
                  <input
                    type="date"
                    max={filters.end || undefined}
                    value={filters.start}
                    onChange={(event) =>
                      setFilters({ ...filters, start: event.target.value })
                    }
                  />
                </label>
                <label className="record-filter-date">
                  To
                  <input
                    type="date"
                    min={filters.start || undefined}
                    value={filters.end}
                    onChange={(event) =>
                      setFilters({ ...filters, end: event.target.value })
                    }
                  />
                </label>
                <label className="record-filter-search">
                  Search transactions
                  <input
                    type="search"
                    placeholder="Entry ID, date, description or reference"
                    maxLength={200}
                    value={filters.search}
                    onChange={(event) =>
                      setFilters({ ...filters, search: event.target.value })
                    }
                  />
                </label>
                <button className="button secondary" disabled={loading}>
                  Apply filters
                </button>
                {Object.values(filters).some(Boolean) && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      const empty = { start: "", end: "", search: "" };
                      setFilters(empty);
                      setApplied(empty);
                      setPage(1);
                      setActionError("");
                    }}
                  >
                    Clear
                  </button>
                )}
              </form>
              <div className="period-summary">
                <span>
                  Balance before period{" "}
                  <strong className={amountTone(data.opening_balance_minor)}>
                    {money(
                      data.opening_balance_minor,
                      data.currency,
                      data.currency_exponent,
                    )}
                  </strong>
                </span>
                <span>
                  Balance at period end{" "}
                  <strong className={amountTone(data.closing_balance_minor)}>
                    {money(
                      data.closing_balance_minor,
                      data.currency,
                      data.currency_exponent,
                    )}
                  </strong>
                </span>
              </div>
              {applied.search && (
                <p className="search-note">
                  Search filters the displayed rows. Running and period balances
                  include all transactions in their date range.
                </p>
              )}
              {data.entries.length ? (
                <div className="table-scroll" aria-busy={loading}>
                  <table className="statement-table">
                    <thead>
                      <tr>
                        <th>Date / entry</th>
                        <th>Description</th>
                        <th>Type</th>
                        <th className="align-right">Amount</th>
                        <th className="align-right">Running balance</th>
                        {admin && (
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.entries.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            <strong className="normal-weight">
                              {dateLabel(entry.effective_date)}
                            </strong>
                            <small>#{entry.id}</small>
                          </td>
                          <td>
                            <strong className="entry-description">
                              {entry.description}
                            </strong>
                            {entry.reference && (
                              <small>Ref: {entry.reference}</small>
                            )}
                            {entry.reversal_of && (
                              <small>Reversal of #{entry.reversal_of}</small>
                            )}
                          </td>
                          <td>
                            <Badge value={entry.kind} />
                          </td>
                          <td
                            className={`align-right amount ${amountTone(entry.amount_minor, entry.kind)}`}
                          >
                            {money(
                              entry.amount_minor,
                              data.currency,
                              data.currency_exponent,
                            )}
                          </td>
                          <td className={`align-right amount running-amount ${amountTone(entry.running_balance_minor)}`}>
                            {money(
                              entry.running_balance_minor,
                              data.currency,
                              data.currency_exponent,
                            )}
                          </td>
                          {admin && (
                            <td>
                              {entry.kind !== "reversal" &&
                                !entry.reversed_by &&
                                data.customer.status === "active" && (
                                  <button
                                    className="text-link"
                                    aria-label={`Reverse entry ${entry.id}`}
                                    onClick={() =>
                                      setModal({ reversal: entry })
                                    }
                                  >
                                    Reverse
                                  </button>
                                )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    Object.values(applied).some(Boolean)
                      ? "No transactions match these filters"
                      : "No transactions yet"
                  }
                  detail={
                    Object.values(applied).some(Boolean)
                      ? "Try another entry ID, date, description or reference, or clear the filters."
                      : admin
                      ? "Record an opening balance, a charge, or a payment to start this customer’s ledger."
                      : "Transactions recorded by the business will appear here."
                  }
                />
              )}
              <Pagination
                page={page}
                total={data.total}
                size={data.page_size}
                onPage={setPage}
              />
            </section>
            {admin && (
              <section className="panel deletion-panel">
                <div>
                  <h2>Permanently delete this account</h2>
                  <p>
                    Delete this customer’s profile, all financial records, bookings,
                    uploaded files, invitations, and access to this business. This cannot be undone.
                  </p>
                </div>
                <button
                  className="button danger-button"
                  disabled={busy}
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 size={16} />
                  Delete account
                </button>
              </section>
            )}
            {admin && deleting && (
              <DeleteAccountDialog
                name={data.customer.name}
                email={data.customer.email}
                kind="customer"
                organizationName={member.organization_name}
                path={base}
                onClose={() => setDeleting(false)}
                onDeleted={() => {
                  setDeleting(false);
                  navigate(`/o/${member.organization_id}/customers`);
                }}
              />
            )}
            {modal && (
              <EntryDialog
                customer={data.customer}
                reversal={modal.reversal}
                initialKind={modal.kind}
                onClose={() => setModal(null)}
                onSaved={() => {
                  setModal(null);
                  setNotice("Transaction recorded successfully.");
                  refresh();
                }}
              />
            )}
          </>
        )
      )}
    </>
  );
}

function EntryDialog({
  customer,
  reversal,
  initialKind,
  onClose,
  onSaved,
}: {
  customer: Customer;
  reversal?: Entry;
  initialKind?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const member = useOrganization();
  const dialog = useRef<HTMLDialogElement>(null);
  const money = useMoney();
  const [kind, setKind] = useState(reversal ? "reversal" : initialKind || "charge");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => businessDate(member.time_zone || 'UTC'));
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (member.currency !== 'GBP' && !reversal) {
      setError('New travel transactions require a GBP accounting workspace.');
      return;
    }
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/organizations/${member.organization_id}/customers/${customer.id}/entries`,
        {
          kind,
          ...(reversal ? { reversal_of: reversal.id } : { amount }),
          effective_date: date,
          description,
          reference,
          idempotency_key: idempotencyKey,
        },
      );
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="entry-dialog"
      aria-labelledby="entry-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">{customer.name}</span>
          <h2 id="entry-title">
            {reversal ? "Reverse a transaction" : "Record a transaction"}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close transaction form"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      <ErrorNotice message={error} />
      {member.currency !== 'GBP' && !reversal && <ErrorNotice message="New travel transactions require a GBP accounting workspace. Existing ledger history must be migrated with an agreed conversion rate before posting GBP amounts." />}
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        {reversal ? (
          <div className="notice neutral">
            <strong>Reversing entry #{reversal.id}</strong>
            <p>
              {reversal.description} ·{" "}
              <span className={amountTone(reversal.amount_minor, reversal.kind)}>{money(
                reversal.amount_minor,
                member.currency,
                member.currency_exponent,
              )}</span>
            </p>
            The original entry stays intact. An equal and opposite entry will be
            recorded. To replace it, record a new charge or payment afterward.
          </div>
        ) : (
          <>
            <label>
              Transaction type
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="charge">Charge — increases amount owed</option>
                <option value="payment">Payment — decreases amount owed</option>
                <option value="opening">
                  Opening balance — first entry only
                </option>
              </select>
            </label>
            <label>
              Amount (GBP)
              <input
                type="text"
                inputMode="decimal"
                placeholder={
                  member.currency_exponent
                    ? `0.${"0".repeat(member.currency_exponent)}`
                    : "0"
                }
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                maxLength={24}
                pattern={
                  kind === "opening"
                    ? "-?[0-9]+([.][0-9]+)?"
                    : "[0-9]+([.][0-9]+)?"
                }
                required
              />
              <small>
                {kind === "opening"
                  ? "Enter a positive amount owed, or a negative amount for customer credit. An opening balance must be the first entry."
                  : "Enter a positive amount. The transaction type determines its effect on the balance."}
              </small>
            </label>
          </>
        )}
        <label>
          Effective date
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            min={reversal?.effective_date.slice(0, 10)}
            required
          />
        </label>
        <label>
          {reversal ? "Reason for reversal" : "Description"}
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            required
            maxLength={1000}
            placeholder={
              reversal
                ? "Explain why this entry is being corrected…"
                : "What is this transaction for?"
            }
          />
        </label>
        <label>
          Reference <span className="optional">Optional</span>
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={160}
            placeholder="Receipt or internal reference"
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className={`button${!reversal && kind === "payment" ? " button-success" : !reversal && kind === "charge" ? " button-danger" : ""}`} disabled={busy || (member.currency !== 'GBP' && !reversal)}>
            {busy
              ? "Recording…"
              : reversal
                ? "Confirm reversal"
                : "Record transaction"}
          </button>
        </div>
        <p className="small muted">
          Individual entries cannot be edited or deleted. Use a reversal to correct them.
        </p>
      </form>
    </dialog>
  );
}
