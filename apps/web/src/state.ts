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
export const emailLink = { token: "", purpose: "" };
export function captureEmailLink(): boolean {
  const { pathname, search, hash } = window.location;
  if (!hash || (pathname !== "/invite" && pathname !== "/reset-password"))
    return false;
  const token = hash.slice(1);
  emailLink.purpose = pathname === "/invite" ? "invite" : "reset";
  emailLink.token = /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
  window.history.replaceState(window.history.state, "", pathname + search);
  return true;
}
captureEmailLink();
export const pendingInvitation = () =>
  Boolean(emailLink.token && emailLink.purpose === "invite");
