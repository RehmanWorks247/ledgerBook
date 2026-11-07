import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  errorMessage,
  requestCustomerInvitation,
  setTokenProvider,
} from "../src/api";
import { ErrorNotice } from "../src/components";

test("a saved invitation whose email request failed renders an actionable error despite HTTP 201", async () => {
  const originalFetch = globalThis.fetch;
  const customerPath = "/organizations/business/customers/customer";
  setTokenProvider(async () => "admin-session");
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), `/api${customerPath}/invitations`);
    assert.equal(options?.method, "POST");
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer admin-session",
    );
    return Response.json(
      { id: "saved-invitation", delivery_status: "failed" },
      { status: 201 },
    );
  };
  try {
    let failure: unknown;
    await assert.rejects(
      requestCustomerInvitation(customerPath),
      (error: unknown) => {
        failure = error;
        return true;
      },
    );
    const rendered = renderToStaticMarkup(
      createElement(ErrorNotice, { message: errorMessage(failure) }),
    );
    assert.match(rendered, /role="alert"/);
    assert.match(rendered, /invitation request failed/i);
    assert.match(rendered, /customer account is saved/i);
    assert.match(rendered, /Send \/ resend invitation/);
    assert.doesNotMatch(rendered, /invitation sent|request accepted/i);
  } finally {
    globalThis.fetch = originalFetch;
    setTokenProvider(async () => null);
  }
});

test("invitation requests require explicit provider acceptance and preserve transport failures", async () => {
  const originalFetch = globalThis.fetch;
  const customerPath = "/organizations/business/customers/customer";
  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          id: "accepted-invitation",
          delivery_status: "sent",
          expires_at: "2026-11-10T00:00:00Z",
        },
        { status: 201 },
      );
    assert.equal(
      (await requestCustomerInvitation(customerPath)).id,
      "accepted-invitation",
    );

    for (const delivery_status of ["queued", undefined]) {
      globalThis.fetch = async () =>
        Response.json({ id: "unconfirmed", delivery_status }, { status: 201 });
      await assert.rejects(
        requestCustomerInvitation(customerPath),
        /has not been confirmed/,
      );
    }

    globalThis.fetch = async () =>
      Response.json(
        { message: "Invitation service is unavailable." },
        { status: 503 },
      );
    await assert.rejects(
      requestCustomerInvitation(customerPath),
      /Invitation service is unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
