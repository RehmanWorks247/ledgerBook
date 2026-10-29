import { useCallback, useEffect, useRef, useState } from "react";

export type Membership = {
  id: string;
  organization_id: string;
  role: "admin" | "customer";
  customer_id: string | null;
  organization_name: string;
  currency: string;
  currency_exponent: number;
};
export type Session = {
  user: { id: string; email: string };
  memberships: Membership[];
};
export type Customer = {
  id: string;
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
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Protection": "1",
      ...options.headers,
    },
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
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";

export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const lastPath = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    if (lastPath.current !== path) {
      setData(undefined);
      lastPath.current = path;
    }
    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, refresh };
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
