import { captureInvitationLink } from "./invitation";
import { subscribeToNavigation } from "./history";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes } from "./router";
import {
  api,
  ApiError,
  errorMessage,
  setTokenProvider,
  type Session,
} from "./api";
import { AuthContext } from "./state";
import { Empty, ErrorNotice, Loading } from "./components";
import { ThemeToggle } from "./theme";
import { AuthPage, InvitationPage } from "./pages/Authentication";
import { OrganizationPicker, Overview, Shell } from "./pages/Workspace";
import { UserDirectory } from "./pages/Users";
import { UserRecord } from "./pages/UserRecord";
import { Settings } from "./pages/Settings";
import { CustomerLedger, PaymentPicker } from "./pages/Dashboard";
import { BookingEditor, BookingPage } from "./pages/Bookings";
import { PaymentReviewPage } from "./payments/BookingPayments";
import { clearUserFileStores } from "./user-files/model";
import {
  CustomerDetail,
  CustomerEditor,
  CustomerList,
} from "./pages/Customers";
import { useAuth, useClerk, useUser } from "@clerk/react";
import { AccountPage, UsersPage } from "./pages/Access";
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
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const requestedSessionId = clerk.session?.id || null;
    const stillCurrent = () =>
      current === generation.current &&
      requestedSessionId === (clerk.session?.id || null);
    setError("");
    try {
      const result = await api<Session>("/auth/session");
      if (stillCurrent()) {
        if (viewerId.current !== result.user.id) clearUserFileStores();
        viewerId.current = result.user.id;
        setSession(result);
        setSessionForId(requestedSessionId);
      }
    } catch (cause) {
      if (!stillCurrent()) return;
      clearUserFileStores();
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
      if (document.visibilityState === "visible") void refresh();
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
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
        <Route path="/reset-password" element={<AuthPage mode="reset" />} />
        <Route path="/invite" element={<InvitationPage key={invitationVersion} />} />
        <Route element={<Protected />}>
          <Route path="/" element={<OrganizationPicker />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/o/:orgId" element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="access" element={<UsersPage />} />
            <Route path="account" element={<AccountPage embedded />} />
            <Route path="settings" element={<Settings />} />
            <Route path="users" element={<UserDirectory />} />
            <Route path="users/:customerId" element={<UserRecord />} />
            <Route path="users/:customerId/bookings/:bookingId" element={<BookingPage />} />
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
              <ThemeToggle />
              <Empty
                title="Page not found"
                detail="This page may have moved or the address may be incorrect."
              />
              <Link className="button" to="/">
                Back to LedgerBook
              </Link>
            </main>
          }
        />
      </Routes>
    </AuthContext.Provider>
  );
}

function Protected() {
  const { session, loading, error, refresh } = useContext(AuthContext);
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  return loading ? (
    <Loading full />
  ) : error && isSignedIn ? (
    <main className="standalone">
      <h1>Unable to open your workspace</h1>
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
