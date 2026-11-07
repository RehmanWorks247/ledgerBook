import { createContext, useContext } from "react";
import type { Membership, Session } from "./api";
export const AuthContext = createContext<{
  session: Session | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}>({ session: null, loading: true, error: "", refresh: async () => undefined });
export const OrganizationContext = createContext<Membership>(null!);
export const useOrganization = () => useContext(OrganizationContext);
