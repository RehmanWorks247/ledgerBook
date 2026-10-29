import { useCallback, useContext, useEffect, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes } from "./router";
import { api, type Session } from "./api";
import { AuthContext } from "./state";
import { Empty, Loading } from "./components";
import { AuthPage, InvitationPage } from "./pages/Authentication";
import { OrganizationPicker, Overview, Shell } from "./pages/Workspace";
import {
  CustomerDetail,
  CustomerEditor,
  CustomerList,
} from "./pages/Customers";
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setSession(await api<Session>("/auth/session"));
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <AuthContext.Provider value={{ session, loading, refresh }}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
        <Route path="/reset-password" element={<AuthPage mode="reset" />} />
        <Route path="/invite" element={<InvitationPage />} />
        <Route element={<Protected />}>
          <Route path="/" element={<OrganizationPicker />} />
          <Route path="/o/:orgId" element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="customers" element={<CustomerList />} />
            <Route path="customers/new" element={<CustomerEditor />} />
            <Route path="customers/:customerId" element={<CustomerDetail />} />
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
