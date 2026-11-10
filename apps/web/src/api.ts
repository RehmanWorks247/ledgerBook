import { useCallback, useEffect, useState } from "react";
import { clearResourceCache, forgetResourceCache, readResourceCache, resourceCacheGeneration, resourceCacheScope, writeResourceCache } from "./resource-cache";

export type Membership = {
  id: string;
  organization_id: string;
  role: "admin" | "customer";
  customer_id: string | null;
  organization_name: string;
  organization_description?: string;
  organization_color?: string;
  organization_version?: number;
  currency: string;
  currency_exponent: number;
  time_zone?: string;
};
export type Session = {
  user: { id: string; email: string; name?: string | null };
  memberships: Membership[];
  can_create_workspaces?: boolean;
};
export type Customer = {
  id: string;
  customer_code?: string;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  status: "active" | "archived";
  balance_minor: string;
  invitation_status?: string;
  delivery_status?: string;
  access_status?: string;
  created_at?: string;
  updated_at?: string;
};
export type Entry = {
  id: string;
  kind: "opening" | "charge" | "payment" | "reversal";
  amount_minor: string;
  running_balance_minor?: string;
  currency: string;
  effective_date: string;
  description: string;
  reference: string | null;
  created_at: string;
  reversal_of: string | null;
  customer_name?: string;
  customer_id?: string;
  reversed_by?: string | null;
};
export type Statement = {
  customer: Customer;
  entries: Entry[];
  page: number;
  page_size: number;
  total: number;
  opening_balance_minor: string;
  closing_balance_minor: string;
  current_balance_minor: string;
  total_amount_minor: string;
  total_paid_minor: string;
  currency: string;
  currency_exponent: number;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;
export function setTokenProvider(provider: TokenProvider) {
  tokenProvider = provider;
}
export async function authenticatedHeaders(initial?: HeadersInit) {
  const token = await tokenProvider();
  const headers = new Headers(initial);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-CSRF-Protection", "1");
  return headers;
}
export async function authenticatedFetch(
  path: string,
  options: RequestInit = {},
) {
  const headers = await authenticatedHeaders(options.headers);
  const response = await fetch(`/api${path}`, { ...options, credentials: "include", headers });
  if ((response.ok && !["GET", "HEAD"].includes((options.method || "GET").toUpperCase())) ||
      response.status === 401 || response.status === 403) clearResourceCache();
  return response;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await authenticatedFetch(path, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string | string[];
    };
    throw new ApiError(
      Array.isArray(data.message)
        ? data.message.join(" ")
        : data.message ||
            "The request could not be completed. Please try again.",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const mutate = <T>(path: string, body?: unknown, method = "POST") =>
  api<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function requestCustomerInvitation(customerPath: string) {
  const invitation = await mutate<{
    id: string;
    expires_at: string;
    delivery_status: "queued" | "sent" | "failed";
  }>(`${customerPath}/invitations`);
  // A saved invitation can return HTTP 201 even when Clerk could not send it.
  if (invitation?.delivery_status === "failed")
    throw new Error(
      "The invitation request failed. The customer account is saved. Use Send / resend invitation to try again.",
    );
  if (invitation?.delivery_status !== "sent")
    throw new Error(
      "The invitation email request has not been confirmed. Refresh the invitation status before trying again.",
    );
  return invitation;
}
export async function permanentlyDeleteAccount(
  accountPath: string,
  accountEmail: string,
  confirmation: string,
) {
  const confirmationEmail = confirmation.trim().toLowerCase();
  if (!confirmationEmail || confirmationEmail !== accountEmail.toLowerCase())
    throw new Error(
      "Enter the account’s email address exactly to confirm permanent deletion.",
    );
  return mutate<{ message: string }>(
    accountPath,
    { confirmation_email: confirmationEmail },
    "DELETE",
  );
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const details = error as {
      errors?: { longMessage?: string; message?: string }[];
      longMessage?: string;
      message?: string;
    };
    return (
      details.errors?.[0]?.longMessage ||
      details.errors?.[0]?.message ||
      details.longMessage ||
      details.message ||
      "Something went wrong. Please try again."
    );
  }
  return "Something went wrong. Please try again.";
}
export function hasErrorCode(error: unknown, code: string) {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: string; errors?: { code?: string }[] };
  return (
    details.code === code ||
    Boolean(details.errors?.some((item) => item.code === code))
  );
}

export function useResource<T>(path: string | null, { cache = false }: { cache?: boolean } = {}) {
  const scope = resourceCacheScope();
  const cached = path && cache ? readResourceCache<T>(path) : undefined;
  const [result, setResult] = useState<{
    path: string | null; scope: string | null; data?: T; error: string; loading: boolean;
  }>(() => ({ path, scope, data: cached, error: "", loading: Boolean(path) }));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const generation = resourceCacheGeneration();
    setResult(previous => ({ path, scope, error: "", loading: true,
      data: previous.path === path && previous.scope === scope ? previous.data : cache ? readResourceCache<T>(path) : undefined,
    }));
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (cache) writeResourceCache(path, data, generation);
        setResult({ path, scope, data, error: "", loading: false });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        forgetResourceCache(path);
        setResult(previous => ({ path, scope,
          data: error instanceof ApiError && [401, 403, 404].includes(error.status) ? undefined : previous.data,
          error: errorMessage(error), loading: false,
        }));
      });
    return () => controller.abort();
  }, [path, scope, cache, revision]);
  // Never expose the previous customer's/query's data for even one render.
  const current = result.path === path && result.scope === scope;
  return {
    data: path ? current ? result.data : cached : undefined,
    error: path && current ? result.error : "",
    loading: Boolean(path) && (!current || result.loading),
    refresh,
  };
}

export function money(
  value: string | undefined,
  currency: string,
  exponent: number,
) {
  const units = BigInt(value || "0");
  const scale = 10n ** BigInt(exponent);
  const absolute = units < 0n ? -units : units;
  const whole = (absolute / scale).toLocaleString("en-US");
  const fraction = exponent
    ? `.${(absolute % scale).toString().padStart(exponent, "0")}`
    : "";
  return `${units < 0n ? "−" : ""}${currency} ${whole}${fraction}`;
}
export function dateLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}
export const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
