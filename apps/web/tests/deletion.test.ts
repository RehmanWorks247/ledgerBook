import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { permanentlyDeleteAccount, setTokenProvider } from "../src/api";
import { DeleteAccountDialog } from "../src/DeleteAccountDialog";

test("permanent deletion requires the selected account email and sends confirmation to the scoped authenticated endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const path = "/organizations/business/customers/customer";
  let requests = 0;
  setTokenProvider(async () => "admin-session");
  globalThis.fetch = async (input, options) => {
    requests++;
    assert.equal(String(input), `/api${path}`);
    assert.equal(options?.method, "DELETE");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer admin-session");
    assert.deepEqual(JSON.parse(String(options?.body)), {
      confirmation_email: "customer@example.com",
    });
    return Response.json({ message: "Customer account and associated data permanently deleted." });
  };
  try {
    for (const confirmation of ["", "another@example.com", "customer"]) {
      await assert.rejects(
        permanentlyDeleteAccount(path, "customer@example.com", confirmation),
        /email address exactly/i,
      );
    }
    assert.equal(requests, 0, "an incorrect confirmation must not issue a deletion request");
    await permanentlyDeleteAccount(path, "customer@example.com", " CUSTOMER@EXAMPLE.COM ");
    assert.equal(requests, 1);

    globalThis.fetch = async () => Response.json(
      { message: "The account email has changed. Refresh before deleting." },
      { status: 409 },
    );
    await assert.rejects(
      permanentlyDeleteAccount(path, "customer@example.com", "customer@example.com"),
      /account email has changed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    setTokenProvider(async () => null);
  }
});

test("deletion confirmation clearly distinguishes complete customer data removal from administrator access removal", () => {
  const props = {
    name: "A Customer",
    email: "customer@example.com",
    organizationName: "Example Business",
    path: "/organizations/business/customers/customer",
    onClose() {},
    onDeleted() {},
  };
  const customer = renderToStaticMarkup(createElement(DeleteAccountDialog, { ...props, kind: "customer" }));
  assert.match(customer, /Permanently delete customer/);
  assert.match(customer, /ledger transactions, payments, balances, and statement history/);
  assert.match(customer, /Travel bookings, service folders, uploaded documents, and payment receipts/);
  assert.match(customer, /Invitations and access to this business/);
  assert.match(customer, /same email again/);
  assert.match(customer, /This cannot be undone/);
  assert.match(customer, /Type customer@example.com to confirm permanent deletion/);
  assert.match(customer, /class="button danger-button" disabled=""/);
  assert.doesNotMatch(customer, /financial history will be kept/);

  const admin = renderToStaticMarkup(createElement(DeleteAccountDialog, { ...props, kind: "administrator" }));
  assert.match(admin, /Permanently delete administrator/);
  assert.match(admin, /Customer accounts and business transactions created by this administrator are kept/);
  assert.doesNotMatch(admin, /new, empty customer account/);
});
