import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPrivateAsset } from "../src/private-assets";
import { ApiError, setTokenProvider } from "../src/api";

const path = "/api/organizations/business/customers/customer/bookings/booking/documents/document";

test("private PDF and receipt reads authenticate every download and preserve content type and cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let token = "first-session";
  const controller = new AbortController();
  let reads = 0;
  setTokenProvider(async () => token);
  globalThis.fetch = async (input, options) => {
    reads++;
    assert.equal(input, path);
    assert.equal(options?.signal, controller.signal);
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
    return new Response("private document", { headers: { "Content-Type": reads === 1 ? "application/pdf" : "image/png" } });
  };
  try {
    const pdf = await loadPrivateAsset(path, controller.signal);
    assert.equal(pdf.type, "application/pdf");
    assert.equal(await pdf.text(), "private document");
    token = "second-session";
    assert.equal((await loadPrivateAsset(path, controller.signal)).type, "image/png");
    assert.equal(reads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    setTokenProvider(async () => null);
  }
});

test("private attachment errors remain actionable and foreign addresses never receive a session token", async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return Response.json({ message: "Your access to this booking was revoked." }, { status: 403 });
  };
  try {
    for (const address of ["https://outside.test/private", "//outside.test/private", "/api/organizations/\\outside.test/private"])
      await assert.rejects(loadPrivateAsset(address), /address is invalid/);
    assert.equal(reads, 0);
    await assert.rejects(loadPrivateAsset(path), (error: unknown) => error instanceof ApiError && error.status === 403 && /revoked/.test(error.message));
    assert.equal(reads, 1);
  } finally { globalThis.fetch = originalFetch; }
});
