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
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  dateLabel,
  errorMessage,
  money,
  mutate,
  today,
  useResource,
  type Customer,
  type Entry,
  type Statement,
} from "../api";
import { useOrganization } from "../state";
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
  Pagination,
} from "../components";
type CustomerListData = {
  items: Customer[];
  page: number;
  page_size: number;
  total: number;
};
export function CustomerList() {
  const member = useOrganization();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({
    search: query,
    page: String(page),
    page_size: "25",
    ...(status ? { status } : {}),
  });
  const { data, error, loading, refresh } = useResource<CustomerListData>(
    `/organizations/${member.organization_id}/customers?${params}`,
  );
  if (member.role !== "admin")
    return <Navigate to={`/o/${member.organization_id}`} replace />;
  return (
    <>
      <PageHeading
        eyebrow="CUSTOMER ACCOUNTS"
        title="Your customers"
        description="A clear account of every customer relationship."
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
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search);
            setPage(1);
          }}
        >
          <label className="search-field">
            <Search size={18} />
            <span className="sr-only">Search customers by name or email</span>
            <input
              placeholder="Search by name or email…"
              value={search}
              maxLength={160}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="filter-select">
            <span className="sr-only">Account status</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All accounts</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <button className="button secondary" disabled={loading}>
            Search
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={refresh}
            aria-label="Refresh customers"
            disabled={loading}
          >
            <RefreshCw size={17} />
          </button>
        </form>
        {loading && !data ? (
          <Loading />
        ) : (
          data && (
            <>
              {data.items.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Status</th>
                        <th>Invitation</th>
                        <th className="align-right">Balance</th>
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
                                Email delivery failed
                              </small>
                            )}
                          </td>
                          <td
                            className={`align-right amount ${BigInt(customer.balance_minor || "0") < 0n ? "credit-amount" : ""}`}
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
                    query || status
                      ? "No matching customers"
                      : "Your first customer is a fresh start"
                  }
                  detail={
                    query || status
                      ? "Try a different name, email address, or account status."
                      : "Create a customer account to start recording transactions and invite them to view their statements."
                  }
                />
              )}
              <Pagination
                page={page}
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
        eyebrow="CUSTOMER ACCOUNTS"
        title={initial ? "Manage customer" : "A new customer account"}
        description={
          initial
            ? "Keep contact details and account access up to date."
            : "Start their ledger today. They can accept their invitation later."
        }
      />
      <div className="editor-layout">
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
                    : "We’ll send their secure invitation to this address."}
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
        <aside className="helper-card">
          <span className="helper-icon">
            <ShieldCheck size={25} />
          </span>
          <h3>A secure start</h3>
          <p>
            Customers choose their own passwords. You never need to set or share
            one.
          </p>
          <ul>
            <li>The account is ready for transactions immediately.</li>
            <li>
              The invitation gives access only to this customer’s account.
            </li>
            <li>You can resend an invitation if email delivery fails.</li>
          </ul>
          <div className="helper-divider" />
          <h3>Opening balance</h3>
          <p>
            Add an opening balance as the first transaction after creating the
            account. It stays part of the account’s history.
          </p>
        </aside>
      </div>
    </>
  );
}

export function CustomerDetail() {
  const member = useOrganization();
  const { customerId: routeCustomerId } = useParams();
  const customerId = routeCustomerId || member.customer_id;
  const admin = member.role === "admin";
  const base = `/organizations/${member.organization_id}/customers/${customerId}`;
  const [filters, setFilters] = useState({ start: "", end: "", search: "" });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ reversal?: Entry } | null>(null);
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
    setPage(1);
    setFilters({ start: "", end: "", search: "" });
    setApplied({ start: "", end: "", search: "" });
    setNotice("");
    setActionError("");
  }, [customerId]);
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
      await mutate(
        `${base}/${action === "revoke-access" ? "revoke-access" : "invitations"}`,
        undefined,
        action === "revoke-invitation" ? "DELETE" : "POST",
      );
      setNotice(
        action === "invite"
          ? "Invitation requested. Check the delivery status below."
          : action === "revoke-access"
            ? "Customer access revoked. Financial history is preserved."
            : "Invitation revoked.",
      );
      refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setActionError("");
    try {
      const response = await fetch(`/api${base}/statement.csv?${query}`, {
        credentials: "include",
      });
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
      <PageHeading
        eyebrow={admin ? "CUSTOMER ACCOUNT" : "YOUR ACCOUNT"}
        title={
          data?.customer.name ||
          (admin ? "Customer account" : "Account overview")
        }
        description={
          admin
            ? "Every transaction. One complete picture."
            : `Your balance and transaction history with ${member.organization_name}.`
        }
        actions={
          <>
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
                <span className="eyebrow">CURRENT BALANCE</span>
                <strong>
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
                            · Email {data.customer.delivery_status}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
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
                    disabled={busy || data.customer.status === "archived"}
                    onClick={() => void accessAction("invite")}
                  >
                    Send / resend invitation
                  </button>
                  <button
                    className="text-link muted"
                    disabled={busy}
                    onClick={() => void accessAction("revoke-invitation")}
                  >
                    Revoke invitation
                  </button>
                  <button
                    className="text-link danger-text"
                    disabled={busy}
                    onClick={() => void accessAction("revoke-access")}
                  >
                    Revoke access
                  </button>
                </div>
              </div>
            )}
            {data.customer.delivery_status === "failed" && admin && (
              <ErrorNotice message="The customer account was saved, but its invitation email could not be delivered. Use Send / resend invitation to try again." />
            )}
            <section className="panel statement-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">A COMPLETE RECORD</span>
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
                className="statement-filters"
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
                <label>
                  From
                  <input
                    type="date"
                    value={filters.start}
                    onChange={(event) =>
                      setFilters({ ...filters, start: event.target.value })
                    }
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={filters.end}
                    onChange={(event) =>
                      setFilters({ ...filters, end: event.target.value })
                    }
                  />
                </label>
                <label className="statement-search">
                  Description or reference
                  <input
                    type="search"
                    placeholder="Search transactions…"
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
                {Object.values(applied).some(Boolean) && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      const empty = { start: "", end: "", search: "" };
                      setFilters(empty);
                      setApplied(empty);
                      setPage(1);
                    }}
                  >
                    Clear
                  </button>
                )}
              </form>
              <div className="period-summary">
                <span>
                  Balance before period{" "}
                  <strong>
                    {money(
                      data.opening_balance_minor,
                      data.currency,
                      data.currency_exponent,
                    )}
                  </strong>
                </span>
                <span>
                  Balance at period end{" "}
                  <strong>
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
                            className={`align-right amount ${BigInt(entry.amount_minor) < 0n ? "credit-amount" : ""}`}
                          >
                            {money(
                              entry.amount_minor,
                              data.currency,
                              data.currency_exponent,
                            )}
                          </td>
                          <td className="align-right amount running-amount">
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
                    admin
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
            <p className="ledger-footnote">
              <ShieldCheck size={16} />
              Posted entries are preserved. Corrections appear as linked
              reversals.
            </p>
            {modal && (
              <EntryDialog
                customer={data.customer}
                reversal={modal.reversal}
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
  onClose,
  onSaved,
}: {
  customer: Customer;
  reversal?: Entry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const member = useOrganization();
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState(reversal ? "reversal" : "charge");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
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
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        {reversal ? (
          <div className="notice neutral">
            <strong>Reversing entry #{reversal.id}</strong>
            <p>
              {reversal.description} ·{" "}
              {money(
                reversal.amount_minor,
                member.currency,
                member.currency_exponent,
              )}
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
              Amount ({member.currency})
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
          <button className="button" disabled={busy}>
            {busy
              ? "Recording…"
              : reversal
                ? "Confirm reversal"
                : "Record transaction"}
          </button>
        </div>
        <p className="small muted">
          Once recorded, entries cannot be edited or deleted.
        </p>
      </form>
    </dialog>
  );
}
