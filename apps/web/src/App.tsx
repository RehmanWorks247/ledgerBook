import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes } from "./router";
import { api, type Session } from "./api";
import { AuthContext, captureEmailLink } from "./state";
import { Empty, Loading } from "./components";
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
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [emailFormVersion, setEmailFormVersion] = useState(0);
  const viewerId = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Opening a second email on the same route can be a fragment-only navigation.
    const receiveLink = () => {
      if (captureEmailLink()) setEmailFormVersion((version) => version + 1);
    };
    window.addEventListener("hashchange", receiveLink);
    receiveLink();
    return () => window.removeEventListener("hashchange", receiveLink);
  }, []);
  const refresh = useCallback(async () => {
    let nextSession: Session | null;
    try {
      nextSession = await api<Session>("/auth/session");
    } catch {
      nextSession = null;
    }
    if (viewerId.current !== nextSession?.user.id) clearUserFileStores();
    viewerId.current = nextSession?.user.id;
    setSession(nextSession);
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <AuthContext.Provider value={{ session, loading, refresh }}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
        <Route path="/reset-password" element={<AuthPage key={emailFormVersion} mode="reset" />} />
        <Route path="/invite" element={<InvitationPage key={emailFormVersion} />} />
        <Route element={<Protected />}>
          <Route path="/" element={<OrganizationPicker />} />
          <Route path="/o/:orgId" element={<Shell />}>
            <Route index element={<Overview />} />
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
  const { session, loading } = useContext(AuthContext);
  return loading ? (
    <Loading full />
  ) : session ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace />
  );
}
