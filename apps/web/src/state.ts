import { createContext, useContext } from "react";
import type { Membership, Session } from "./api";
export const AuthContext = createContext<{
  session: Session | null;
  loading: boolean;
  refresh: () => Promise<void>;
}>({ session: null, loading: true, refresh: async () => undefined });
export const OrganizationContext = createContext<Membership>(null!);
export const useOrganization = () => useContext(OrganizationContext);
// Email link tokens exist only in memory, never in queries, storage, or analytics.
export const emailLink = {
  token: window.location.hash.slice(1),
  purpose: window.location.pathname === "/invite" ? "invite" : "reset",
};
if (emailLink.token)
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
export const pendingInvitation = () =>
  Boolean(emailLink.token && emailLink.purpose === "invite");
