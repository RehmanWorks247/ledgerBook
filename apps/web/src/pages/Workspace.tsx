import { useContext, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useParams } from "../router";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChevronRight,
  CircleHelp,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  dateLabel,
  errorMessage,
  money,
  mutate,
  useResource,
  type Entry,
} from "../api";
import { AuthContext, OrganizationContext, useOrganization } from "../state";
import {
  Badge,
  Brand,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
  Stat,
} from "../components";
import { CustomerDetail } from "./Customers";
export function OrganizationPicker() {
  const { session, refresh } = useContext(AuthContext);
  const [error, setError] = useState("");
  if (session!.memberships.length === 1)
    return (
      <Navigate to={`/o/${session!.memberships[0].organization_id}`} replace />
    );
  return (
    <main className="workspace-picker">
      <Brand />
      <span className="eyebrow">YOUR WORKSPACES</span>
      <h1>Where would you like to go?</h1>
      <p className="muted">
        Each business has its own accounts and statements.
      </p>
      <ErrorNotice message={error} />
      <div className="workspace-list">
        {session!.memberships.map((member) => (
          <Link
            className="workspace-card"
            key={member.id}
            to={`/o/${member.organization_id}`}
          >
            <span className="workspace-icon">
              <Building2 />
            </span>
            <div>
              <h2>{member.organization_name}</h2>
              <p>
                {member.role === "admin"
                  ? "Organization administrator"
                  : "Customer account"}{" "}
                · {member.currency}
              </p>
            </div>
            <ArrowRight size={20} />
          </Link>
        ))}
      </div>
      {!session!.memberships.length && (
        <Empty
          title="No active workspace"
          detail="Accept an invitation to get started, or contact your business if your access has been revoked."
        />
      )}
      <button
        className="button secondary"
        onClick={() => {
          void mutate("/auth/logout")
            .then(refresh)
            .catch((error) => setError(errorMessage(error)));
        }}
      >
        Sign out
      </button>
    </main>
  );
}
export function Shell() {
  const { orgId } = useParams();
  const { session, refresh } = useContext(AuthContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const member = session!.memberships.find(
    (item) => item.organization_id === orgId,
  );
  if (!member) return <Navigate to="/" replace />;
  const root = `/o/${orgId}`;
  return (
    <OrganizationContext.Provider value={member}>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
          <Link to={root} className="brand-link">
            <Brand light />
          </Link>
          <button
            className="mobile-close icon-button"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <X />
          </button>
          <div className="organization-label">
            <span className="organization-monogram">
              {member.organization_name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{member.organization_name}</strong>
              <small>
                {member.role === "admin"
                  ? "Business workspace"
                  : "Customer workspace"}
              </small>
            </span>
          </div>
          <span className="nav-heading">WORKSPACE</span>
          <nav aria-label="Main navigation" onClick={() => setMenuOpen(false)}>
            <NavLink to={root} end>
              <LayoutDashboard size={19} />
              {member.role === "admin" ? "Overview" : "My account"}
            </NavLink>
            {member.role === "admin" && (
              <NavLink to={`${root}/customers`}>
                <Users size={19} />
                Customers
              </NavLink>
            )}
          </nav>
          <div className="sidebar-note">
            <ShieldCheck size={20} />
            <p>
              Every entry tells a story.
              <span>Keep your records complete with linked corrections.</span>
            </p>
          </div>
          <div className="sidebar-bottom">
            {session!.memberships.length > 1 && (
              <Link to="/" className="switch-workspace">
                <Building2 size={17} />
                Switch workspace
              </Link>
            )}
            <button
              onClick={() => {
                void mutate("/auth/logout")
                  .then(refresh)
                  .catch((error) => setError(errorMessage(error)));
              }}
            >
              <LogOut size={17} />
              Sign out
            </button>
          </div>
        </aside>
        {menuOpen && (
          <button
            aria-label="Close navigation"
            className="nav-scrim"
            onClick={() => setMenuOpen(false)}
          />
        )}
        <div className="app-body">
          <header className="topbar">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMenuOpen(true)}
            >
              <Menu />
            </button>
            <span className="breadcrumb">
              Workspace <ChevronRight size={14} />
              <strong>{member.organization_name}</strong>
            </span>
            <div className="topbar-user">
              <span className="user-avatar">
                {session!.user.email.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{session!.user.email}</strong>
                <small>
                  {member.role === "admin" ? "Administrator" : "Customer"}
                </small>
              </span>
            </div>
          </header>
          <main id="main" className="main-content">
            <ErrorNotice message={error} />
            <Outlet />
          </main>
          <footer className="app-footer">
            <span>LedgerBook</span>
            <span>
              Positive balance = amount owed · Negative balance = customer
              credit
            </span>
            <span>{member.currency} workspace</span>
          </footer>
        </div>
      </div>
    </OrganizationContext.Provider>
  );
}
export function Overview() {
  const member = useOrganization();
  return member.role === "customer" ? <CustomerDetail /> : <Dashboard />;
}
type DashboardData = {
  total_debt_minor: string;
  total_credit_minor: string;
  customer_count: number;
  recent_entries: Entry[];
};
function Dashboard() {
  const member = useOrganization();
  const { data, error, loading, refresh } = useResource<DashboardData>(
    `/organizations/${member.organization_id}/dashboard`,
  );
  return (
    <>
      <PageHeading
        eyebrow="THE BIG PICTURE"
        title="Business overview"
        description="Know where things stand. Keep your business moving."
        actions={
          <Link
            className="button"
            to={`/o/${member.organization_id}/customers/new`}
          >
            <Plus size={18} />
            New customer
          </Link>
        }
      />
      <ErrorNotice message={error} />
      {error && (
        <button className="button secondary" onClick={refresh}>
          Try again
        </button>
      )}
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="stats-grid">
            <Stat
              label="Outstanding customer debt"
              value={money(
                data.total_debt_minor,
                member.currency,
                member.currency_exponent,
              )}
              detail="Total positive customer balances"
              icon={<ArrowUpRight size={21} />}
              primary
            />
            <Stat
              label="Customer credits"
              value={money(
                data.total_credit_minor,
                member.currency,
                member.currency_exponent,
              )}
              detail="Credit balances, shown separately"
              icon={<ArrowDownLeft size={21} />}
            />
            <Stat
              label="Customer accounts"
              value={data.customer_count.toLocaleString()}
              detail="Your organization’s customer ledger"
              icon={<Users size={21} />}
            />
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">YOUR LEDGER AT A GLANCE</span>
                <h2>Recent activity</h2>
              </div>
              <Link
                className="text-link"
                to={`/o/${member.organization_id}/customers`}
              >
                View customers <ArrowRight size={16} />
              </Link>
            </div>
            {data.recent_entries.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Customer / description</th>
                      <th>Date</th>
                      <th>Type</th>
                      <th className="align-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          {entry.customer_id ? (
                            <Link
                              className="table-link"
                              to={`/o/${member.organization_id}/customers/${entry.customer_id}`}
                            >
                              {entry.customer_name || "Customer account"}
                            </Link>
                          ) : (
                            <strong>
                              {entry.customer_name || "Ledger entry"}
                            </strong>
                          )}
                          <small>{entry.description}</small>
                        </td>
                        <td>{dateLabel(entry.effective_date)}</td>
                        <td>
                          <Badge value={entry.kind} />
                        </td>
                        <td className="align-right amount">
                          {money(
                            entry.amount_minor,
                            member.currency,
                            member.currency_exponent,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="Your ledger is ready"
                detail="Create your first customer account, then record an opening balance, charge, or payment."
              />
            )}
          </section>
          <div className="info-strip">
            <CircleHelp size={19} />
            <p>
              <strong>Balances with context.</strong> Debt and credit stay
              separate so you can see what customers owe and what you owe them.
            </p>
          </div>
        </>
      )}
    </>
  );
}
