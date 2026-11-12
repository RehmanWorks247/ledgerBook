import { setResourceCacheScope } from "./resource-cache";
import { loadWorkspace, loadDashboard, loadCustomers, loadUsers, loadUserRecord, loadAccess, loadCompanies, loadSettings, loadPaymentReviews } from "./route-loaders";
import { captureInvitationLink } from "./invitation";
import { subscribeToNavigation } from "./history";
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes, useParams } from "./router";
import {
  api,
  ApiError,
  errorMessage,
  setTokenProvider,
  type Session,
} from "./api";
import { AuthContext } from "./state";
import { Brand, Empty, ErrorNotice, Loading } from "./components";
import { ThemeToggle } from "./theme";
const PaymentReviewPage = lazy(() => loadPaymentReviews().then(module => ({ default: module.PaymentReviewPage })));
import { clearUserFileStores } from "./user-files/model";
import { useAuth, useClerk, useUser } from "@clerk/react";
const AuthPage = lazy(() => import("./pages/Authentication").then(module => ({ default: module.AuthPage })));
const InvitationPage = lazy(() => import("./pages/Authentication").then(module => ({ default: module.InvitationPage })));
const OrganizationPicker = lazy(() => loadWorkspace().then(module => ({ default: module.OrganizationPicker })));
const Overview = lazy(() => loadWorkspace().then(module => ({ default: module.Overview })));
const Shell = lazy(() => loadWorkspace().then(module => ({ default: module.Shell })));
const UserDirectory = lazy(() => loadUsers().then(module => ({ default: module.UserDirectory })));
const UserRecord = lazy(() => loadUserRecord().then(module => ({ default: module.UserRecord })));
const Settings = lazy(() => loadSettings().then(module => ({ default: module.Settings })));
const CustomerLedger = lazy(() => loadDashboard().then(module => ({ default: module.CustomerLedger })));
const PaymentPicker = lazy(() => loadDashboard().then(module => ({ default: module.PaymentPicker })));
const BookingEditor = lazy(() => import("./pages/Bookings").then(module => ({ default: module.BookingEditor })));
const BookingPage = lazy(() => import("./pages/Bookings").then(module => ({ default: module.BookingPage })));
const BookingInvoicePage = lazy(() => import("./pages/Bookings").then(module => ({ default: module.BookingInvoicePage })));
const UsersPage = lazy(() => loadAccess().then(module => ({ default: module.UsersPage })));
const CustomerDetail = lazy(() => loadCustomers().then(module => ({ default: module.CustomerDetail })));
const CustomerEditor = lazy(() => loadCustomers().then(module => ({ default: module.CustomerEditor })));
const CustomerList = lazy(() => loadCustomers().then(module => ({ default: module.CustomerList })));
const CompaniesPage = lazy(() => loadCompanies().then(module => ({ default: module.CompaniesPage })));
export function App() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { user } = useUser();
  const primaryEmail = user?.primaryEmailAddress?.emailAddress;
  const emailVerification = user?.primaryEmailAddress?.verification.status;
  const displayName = user?.fullName;
  setTokenProvider(async () =>
    clerk.session ? clerk.session.getToken() : null,
  );
  const [session, setSession] = useState<Session | null>(null);
  const [sessionForId, setSessionForId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [invitationVersion, setInvitationVersion] = useState(0);
  useEffect(() => {
    const receiveLink = () => {
      if (captureInvitationLink()) setInvitationVersion(version => version + 1);
    };
    const unsubscribe = subscribeToNavigation(receiveLink);
    window.addEventListener("hashchange", receiveLink);
    receiveLink();
    return () => {
      unsubscribe();
      window.removeEventListener("hashchange", receiveLink);
    };
  }, []);
  const generation = useRef(0);
  const viewerId = useRef<string | undefined>(undefined);
  const refresh = useCallback(async (options?: { preserveSession?: boolean }) => {
    const current = ++generation.current;
    const requestedSessionId = clerk.session?.id || null;
    const stillCurrent = () =>
      current === generation.current &&
      requestedSessionId === (clerk.session?.id || null);
    const interruptedRefresh = () => new Error("Account access refresh was interrupted. Refresh to continue.");
    setError("");
    try {
      const result = await api<Session>("/auth/session");
      if (!stillCurrent() && options?.preserveSession) throw interruptedRefresh();
      if (stillCurrent()) {
        if (viewerId.current !== result.user.id) clearUserFileStores();
        setResourceCacheScope(JSON.stringify([requestedSessionId, result.user.id,
          result.memberships.map(member => [member.id, member.organization_id, member.role, member.customer_id]).sort(),
        ]));
        viewerId.current = result.user.id;
        setSession(result);
        setSessionForId(requestedSessionId);
      }
    } catch (cause) {
      if (!stillCurrent()) {
        // Mutation callers navigate only after their refreshed membership has
        // actually been installed. A focus refresh can supersede this request;
        // keep the completed mutation's explicit refresh/retry state instead.
        if (options?.preserveSession) throw interruptedRefresh();
        return;
      }
      // A successful workspace mutation must not disappear behind a sign-in
      // screen merely because its subsequent session refresh lost connectivity.
      if (options?.preserveSession && viewerId.current &&
          !(cause instanceof ApiError && (cause.status === 401 || cause.status === 403))) throw cause;
      clearUserFileStores();
      setResourceCacheScope(null);
      viewerId.current = undefined;
      setSession(null);
      setSessionForId(requestedSessionId);
      if (!(
        cause instanceof ApiError &&
        cause.status === 401 &&
        !clerk.session
      ))
        setError(errorMessage(cause));
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  }, [clerk]);
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      generation.current++;
      clearUserFileStores();
      setResourceCacheScope(null);
      viewerId.current = undefined;
      setSession(null);
      setSessionForId(null);
      setLoading(false);
      setError("");
      return;
    }
    // A changed Clerk session is gated by sessionForId below. Profile edits
    // refresh in the background so the account form stays mounted.
    void refresh();
  }, [
    isLoaded,
    isSignedIn,
    sessionId,
    primaryEmail,
    emailVerification,
    displayName,
    refresh,
  ]);
  useEffect(() => {
    if (!isSignedIn) return;
    const reload = () => {
      if (document.visibilityState === "visible") void refresh({ preserveSession: true }).catch(() => undefined);
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [isSignedIn, refresh]);
  if (!isLoaded) return <Loading full />;
  return (
    <AuthContext.Provider
      value={{
        session: isSignedIn && sessionForId === sessionId ? session : null,
        loading:
          loading ||
          Boolean(
            isSignedIn && (sessionForId !== sessionId || (!session && !error)),
          ),
        error,
        refresh,
      }}
    >
      <Suspense fallback={<Loading full />}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
        <Route path="/reset-password" element={<AuthPage mode="reset" />} />
        <Route path="/invite" element={<InvitationPage key={invitationVersion} />} />
        <Route element={<Protected />}>
          <Route path="/" element={<OrganizationPicker />} />
          <Route path="/workspaces" element={<OrganizationPicker managed />} />
          <Route path="/account" element={<AccountRedirect />} />
          <Route path="/settings" element={<Settings standalone />} />
          <Route path="/o/:orgId" element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="access" element={<UsersPage />} />
            <Route path="account" element={<AccountRedirect />} />
            <Route path="settings" element={<Settings />} />
            <Route path="companies" element={<CompaniesPage />} />
            <Route path="companies/:companySlug" element={<CompaniesPage />} />
            <Route path="users" element={<UserDirectory />} />
            <Route path="users/:customerId" element={<UserRecord />} />
            <Route path="users/:customerId/bookings/:bookingId" element={<BookingPage />} />
            <Route path="users/:customerId/bookings/:bookingId/invoices" element={<BookingInvoicePage />} />
            <Route path="bookings/new" element={<BookingEditor />} />
            <Route path="customers/:customerId/bookings/new" element={<BookingEditor />} />
            <Route path="customer-ledger" element={<CustomerLedger />} />
            <Route path="payments/new" element={<PaymentPicker />} />
            <Route path="payment-reviews" element={<PaymentReviewPage />} />
            <Route path="customers" element={<CustomerList />} />
            <Route path="customers/new" element={<CustomerEditor />} />
            <Route path="customers/:customerId" element={<CustomerDetail />} />
            <Route path="customers/:customerId/payments/new" element={<CustomerDetail recordPayment />} />
            <Route
              path="customers/:customerId/edit"
              element={<CustomerEditor />}
            />
          </Route>
        </Route>
        <Route
          path="*"
          element={
            <main className="standalone">
              <div className="standalone-brand"><Brand /><ThemeToggle /></div>
              <Empty
                title="Page not found"
                detail="This page may have moved or the address may be incorrect."
              />
              <Link className="button" to="/">
                Back to Umrah Packages UK
              </Link>
            </main>
          }
        />
      </Routes>
      </Suspense>
    </AuthContext.Provider>
  );
}

function AccountRedirect() {
  const { orgId } = useParams();
  const settingsPath = orgId ? `/o/${encodeURIComponent(orgId)}/settings` : "/settings";
  return <Navigate to={`${settingsPath}${window.location.search}${window.location.hash}`} replace />;
}

function Protected() {
  const { session, loading, error, refresh } = useContext(AuthContext);
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  return loading ? (
    <Loading full />
  ) : error && isSignedIn ? (
    <main className="standalone">
      <Brand />
      <h1>Unable to open your account</h1>
      <ErrorNotice message={error} />
      <p>Contact your business if your account has been disabled.</p>
      <div className="form-actions">
        <button className="button" onClick={() => void refresh()}>
          Try again
        </button>
        <button
          className="button secondary"
          onClick={() => void clerk.signOut({ redirectUrl: "/login" })}
        >
          Sign out
        </button>
      </div>
    </main>
  ) : session ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace />
  );
}
