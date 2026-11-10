import { Suspense, useContext, useEffect, useMemo, useState } from "react";
import { useClerk } from "@clerk/react";
import { Link, NavLink, Navigate, Outlet, useParams, useSearch } from "../router";
import {
  ArrowRight,
  Building2,
  BookOpen,
  ReceiptText,
  CalendarDays,
  ChevronRight,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings2,
  Users,
  UserRound,
  X,
  Plus,
  Search,
} from "lucide-react";
import {
  errorMessage,
} from "../api";
import { AuthContext, OrganizationContext, useOrganization } from "../state";
import {
  Brand,
  Empty,
  ErrorNotice,
  PageSkeleton,
} from "../components";
import { preloadSidebarPage, preloadSidebarPages } from "../route-loaders";
import { Dashboard } from "./Dashboard";
import { CustomerAccount } from "./CustomerAccount";
import { ThemeToggle } from "../theme";
import { CurrencyProvider, LedgerCurrencyNotice } from '../currency';
import { CreateWorkspaceDialog } from "../workspaces/CreateWorkspaceDialog";
import { workspaceBadgeStyle } from "../workspaces/model";
import "../workspaces/workspaces.css";

export function OrganizationPicker({ managed = false }: { managed?: boolean }) {
  const { session } = useContext(AuthContext);
  const clerk = useClerk();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(24);
  const [creating, setCreating] = useState(false);
  const search = useSearch();
  const memberships = session?.memberships ?? [];
  const canCreate = session?.can_create_workspaces ?? memberships.some(member => member.role === "admin");
  const canManageWorkspaces = canCreate || memberships.some(member => member.role === "admin");
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? memberships.filter(member => `${member.organization_name} ${member.organization_description ?? ""}`.toLocaleLowerCase().includes(search)) : memberships;
  }, [memberships, query]);
  if (memberships.length > 0 && (!canManageWorkspaces || (!managed && memberships.length === 1)))
    return (
      <Navigate to={`/o/${session!.memberships[0].organization_id}`} replace />
    );
  return (
    <main className="workspace-picker">
      <div className="workspace-picker-header">
        <Brand />
        <ThemeToggle />
      </div>
      <div className="workspace-picker-title">
        <div>
          <h1>{canManageWorkspaces ? "Workspaces" : "My account"}</h1>
          {canManageWorkspaces && <p className="muted">Choose a workspace to continue.</p>}
        </div>
        {canCreate && <button className="button primary" onClick={event => { event.currentTarget.focus(); setCreating(true); }}><Plus size={17} />Create workspace</button>}
      </div>
      <ErrorNotice message={error} />
      {canManageWorkspaces && managed && new URLSearchParams(search).get("deleted") === "1" && <p className="notice" role="status">Workspace permanently deleted. Any stored files will be removed automatically after upload links expire.</p>}
      {memberships.length > 0 && <>
        <label className="workspace-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Search workspaces</span>
          <input type="search" value={query} placeholder="Search workspaces…" onChange={event => { setQuery(event.target.value); setVisibleCount(24); }} />
        </label>
        <p className="workspace-result-count muted small" role="status">{filtered.length} {filtered.length === 1 ? "workspace" : "workspaces"}{query.trim() ? " found" : " available"}</p>
        <div className="workspace-list workspace-management-list">
          {filtered.slice(0, visibleCount).map((member) => (
            <article className="workspace-management-card" key={member.id}>
              <Link className="workspace-card" to={`/o/${member.organization_id}`}>
                <span className="workspace-icon" style={workspaceBadgeStyle(member.organization_color)} aria-hidden="true">{member.organization_name.slice(0, 1).toUpperCase()}</span>
                <div className="workspace-card-copy">
                  <h2>{member.organization_name}</h2>
                  {member.organization_description && <p className="workspace-description">{member.organization_description}</p>}
                  <p>{member.role === "admin" ? "Administrator" : "Customer account"} · {member.currency}</p>
                </div>
                <ArrowRight size={20} aria-hidden="true" />
              </Link>
              {member.role === "admin" && <div className="workspace-card-footer"><Link to={`/o/${member.organization_id}/settings`} className="workspace-manage-link" aria-label={`Manage ${member.organization_name}`}><Settings2 size={15} />Manage workspace</Link></div>}
            </article>
          ))}
        </div>
        {filtered.length > visibleCount && <button className="button secondary workspace-load-more" onClick={() => setVisibleCount(count => count + 24)}>Show more workspaces</button>}
        {!filtered.length && <Empty title="No matching workspaces" detail="Try a different name or description." />}
      </>}
      {!memberships.length && (
        <Empty
          title={canManageWorkspaces ? "No active workspace" : "No active account"}
          detail={canCreate ? "Create a workspace for your business." : "Accept an invitation or contact your business administrator for access."}
        />
      )}
      <div className="workspace-picker-footer">
      <Link to="/settings" className="button secondary">
        Settings
      </Link>
      <button
        className="button secondary"
        onClick={() => {
          void clerk
            .signOut({ redirectUrl: "/login" })
            .catch((error) => setError(errorMessage(error)));
        }}
      >
        Sign out
      </button>
      </div>
      {creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
    </main>
  );
}
export function Shell() {
  const { orgId } = useParams();
  const { session } = useContext(AuthContext);
  const clerk = useClerk();
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const member = session!.memberships.find(
    (item) => item.organization_id === orgId,
  );
  const role = member?.role;
  useEffect(() => {
    if (!role) return;
    const preload = () => preloadSidebarPages(role === "admin");
    if ("requestIdleCallback" in window) {
      const idle = window.requestIdleCallback(preload, { timeout: 1500 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = setTimeout(preload, 150);
    return () => clearTimeout(timer);
  }, [role]);
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
          {member.role === "admin" && <div className="organization-label">
            <span className="organization-monogram" style={workspaceBadgeStyle(member.organization_color)}>
              {member.organization_name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{member.organization_name}</strong>
              <small>Business workspace</small>
            </span>
          </div>}
          {member.role === "admin" && <span className="nav-heading">Workspace</span>}
          <nav className={member.role === "customer" ? "customer-navigation" : undefined} aria-label="Main navigation" onClick={() => setMenuOpen(false)}
            onPointerOver={event => {
              const link = (event.target as Element).closest<HTMLAnchorElement>("a");
              if (link) preloadSidebarPage(link.pathname);
            }}
            onFocus={event => {
              const link = event.target.closest<HTMLAnchorElement>("a");
              if (link) preloadSidebarPage(link.pathname);
            }}>
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
                <CalendarDays size={19} className="icon-warning" />
                My bookings
              </NavLink>
            )}
            {member.role === "admin" && (
              <NavLink to={`${root}/access`}>
                <UserRound size={19} />
                Users & access
              </NavLink>
            )}
            {member.role === "admin" && (
              <NavLink to={`${root}/companies`}>
                <Building2 size={19} className="icon-info" />
                Companies
              </NavLink>
            )}
            <NavLink to={`${root}/settings`}>
              <Settings2 size={19} />
              Settings
            </NavLink>
          </nav>
          <div className="sidebar-bottom">
              {member.role === "admin" && <Link to="/workspaces" className="switch-workspace">
                <Building2 size={17} />
                Workspaces
              </Link>}
            <button
              onClick={() => {
                void clerk
                  .signOut({ redirectUrl: "/login" })
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
            <Link to={root} className="topbar-brand">
              <Brand />
            </Link>
            {member.role === "admin" && <span className="breadcrumb">
              <span>Workspace</span> <ChevronRight size={14} />
              <strong>{member.organization_name}</strong>
            </span>}
            <div className="topbar-actions">
              <span className="small muted">GBP</span>
              <ThemeToggle />
              <div className="topbar-user">
                <span className="user-avatar">
                  {(session!.user.name || session!.user.email).slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{session!.user.name || session!.user.email}</strong>
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

            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </main>
          <footer className="app-footer">
            <span>Umrah Packages UK</span>
            <span>
              {member.role === "admin" ? "Positive balance = amount owed · Negative balance = customer credit" : "For help, contact your travel company."}
            </span>
            <span>{member.role === "admin" ? "GBP ledger" : "GBP"}</span>
          </footer>
        </div>
      </div>
      </CurrencyProvider>
    </OrganizationContext.Provider>
  );
}
export function Overview() {
  const member = useOrganization();
  return member.role === "customer" ? <CustomerAccount /> : <Dashboard />;
}
