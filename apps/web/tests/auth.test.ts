import assert from "node:assert/strict";
import { test } from "node:test";
import {
  api,
  ApiError,
  authenticatedFetch,
  errorMessage,
  hasErrorCode,
  setTokenProvider,
} from "../src/api";
import { readInvitationLink } from "../src/invitation";

test("API requests and CSV downloads obtain the current Clerk bearer token for every request", async () => {
  const originalFetch = globalThis.fetch;
  let token = "session-one";
  const calls: {
    path: string;
    headers: Headers;
    credentials: RequestCredentials | undefined;
  }[] = [];
  setTokenProvider(async () => token);
  globalThis.fetch = async (input, options) => {
    calls.push({
      path: String(input),
      headers: new Headers(options?.headers),
      credentials: options?.credentials,
    });
    return Response.json({ ok: true });
  };
  try {
    await api("/auth/session", {
      headers: new Headers({ "X-Request-ID": "test" }),
    });
    token = "session-two";
    await authenticatedFetch("/organizations/a/customers/b/statement.csv");
    assert.equal(calls[0].path, "/api/auth/session");
    assert.equal(calls[0].headers.get("Authorization"), "Bearer session-one");
    assert.equal(calls[0].headers.get("X-Request-ID"), "test");
    assert.equal(calls[0].headers.get("X-CSRF-Protection"), "1");
    assert.equal(calls[1].headers.get("Authorization"), "Bearer session-two");
    assert.equal(calls[1].credentials, "include");
  } finally {
    globalThis.fetch = originalFetch;
    setTokenProvider(async () => null);
  }
});

test("a failed Clerk token refresh never falls back to an unauthenticated API request", async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return Response.json({});
  };
  setTokenProvider(async () => {
    throw new Error("Session refresh failed");
  });
  try {
    await assert.rejects(api("/auth/session"), /Session refresh failed/);
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
    setTokenProvider(async () => null);
  }
});

test("API access errors preserve their status and useful server message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ message: "Your account is disabled." }, { status: 403 });
  try {
    await assert.rejects(
      api("/auth/session"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 403 &&
        error.message === "Your account is disabled.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invitation context survives sign-in/reset routes without mistaking profile hashes for invitation tickets", () => {
  const token = "x".repeat(43);
  const ticket = "ticket+with/symbols=";
  const query = new URLSearchParams({ token, __clerk_ticket: ticket });
  for (const origin of ["https://ledger.test", "http://localhost:3001", "http://localhost:5173"]) {
    for (const path of ["invite", "login", "forgot-password", "reset-password"]) {
      assert.deepEqual(
        readInvitationLink(new URL(`${origin}/${path}?${query}`)),
        { token, ticket },
      );
    }
  }
  assert.deepEqual(
    readInvitationLink(new URL("https://ledger.test/account#security")),
    { token: "", ticket: "" },
  );
  assert.deepEqual(
    readInvitationLink(new URL("https://ledger.test/invite#legacy-token")),
    { token: "legacy-token", ticket: "" },
  );
});

test("Clerk errors show the actionable message and identify unknown-email recovery without exposing internal errors", () => {
  const clerkError = {
    errors: [
      {
        code: "form_identifier_not_found",
        message: "Unknown account",
        longMessage: "Account could not be found.",
      },
    ],
  };
  assert.equal(errorMessage(clerkError), "Account could not be found.");
  assert.equal(hasErrorCode(clerkError, "form_identifier_not_found"), true);
  assert.equal(hasErrorCode(clerkError, "form_password_incorrect"), false);
  assert.equal(errorMessage(null), "Something went wrong. Please try again.");
});
