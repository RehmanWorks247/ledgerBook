import { useContext, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useParams } from "../router";
import {
  ArrowRight,
  Building2,
  BookOpen,
  ReceiptText,
  ChevronRight,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings2,
  Users,
  X,
} from "lucide-react";
import {
  errorMessage,
  mutate,
} from "../api";
import { AuthContext, OrganizationContext, useOrganization } from "../state";
import {
  Brand,
  Empty,
  ErrorNotice,
} from "../components";
import { Dashboard } from "./Dashboard";
import { CustomerDetail } from "./Customers";
import { ThemeToggle } from "../theme";
import { CurrencyProvider, LedgerCurrencyNotice } from '../currency';
export function OrganizationPicker() {
  const { session, refresh } = useContext(AuthContext);
  const [error, setError] = useState("");
  if (session!.memberships.length === 1)
    return (
      <Navigate to={`/o/${session!.memberships[0].organization_id}`} replace />
    );
  return (
    <main className="workspace-picker">
      <div className="workspace-picker-header">
        <Brand />
        <ThemeToggle />
      </div>
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
      <CurrencyProvider key={member.id}>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
          <Link to={root} className="brand-link">
            <Brand />
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
              <NavLink to={`${root}/customer-ledger`}>
                <BookOpen size={19} className="icon-violet" />
                Customer Ledger
              </NavLink>
            )}
            {member.role === "admin" && (
              <NavLink to={`${root}/customers`}>
                <Users size={19} className="icon-info" />
                Customer Data
              </NavLink>
            )}
            {member.role === "admin" && (
              <NavLink to={`${root}/payment-reviews`}>
                <ReceiptText size={19} className="icon-success" />
                Payment reviews
              </NavLink>
            )}
            {member.role === "admin" ? (
              <NavLink to={`${root}/users`}>
                <FolderOpen size={19} className="icon-warning" />
                Customer records
              </NavLink>
            ) : member.customer_id && (
              <NavLink to={`${root}/users/${member.customer_id}`}>
                <FolderOpen size={19} className="icon-warning" />
                My files
              </NavLink>
            )}
            <NavLink to={`${root}/settings`}>
              <Settings2 size={19} />
              Settings
            </NavLink>
          </nav>
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
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Menu />
            </button>
            <span className="breadcrumb">
              <span>Workspace</span> <ChevronRight size={14} />
              <strong>{member.organization_name}</strong>
            </span>
            <div className="topbar-actions">
              <span className="small muted">GBP</span>
              <ThemeToggle />
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
            </div>
          </header>
          <main id="main" className="main-content">
            <ErrorNotice message={error} />
            <LedgerCurrencyNotice />

            <Outlet />
          </main>
          <footer className="app-footer">
            <span>LedgerBook</span>
            <span>
              Positive balance = amount owed · Negative balance = customer
              credit
            </span>
            <span>GBP ledger</span>
          </footer>
        </div>
      </div>
      </CurrencyProvider>
    </OrganizationContext.Provider>
  );
}
export function Overview() {
  const member = useOrganization();
  return member.role === "customer" ? <CustomerDetail /> : <Dashboard />;
}
