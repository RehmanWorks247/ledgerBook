import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticatedFetch, setTokenProvider } from "../src/api";
import { clearResourceCache, readResourceCache, resourceCacheGeneration, setResourceCacheScope, writeResourceCache } from "../src/resource-cache";

test("navigation cache isolates queries, workspaces and signed-in access", () => {
  setResourceCacheScope("session-one/admin");
  const generation = resourceCacheGeneration();
  writeResourceCache("/organizations/one/customers?page=1", { name: "First" }, generation);
  assert.deepEqual(readResourceCache("/organizations/one/customers?page=1"), { name: "First" });
  assert.equal(readResourceCache("/organizations/two/customers?page=1"), undefined);
  assert.equal(readResourceCache("/organizations/one/customers?page=2"), undefined);
  setResourceCacheScope("session-two/customer");
  writeResourceCache("/organizations/one/customers?page=1", { name: "Late response" }, generation);
  assert.equal(readResourceCache("/organizations/one/customers?page=1"), undefined);
  setResourceCacheScope(null);
});

test("a successful save invalidates previous views and responses that started before the save", async () => {
  const originalFetch = globalThis.fetch;
  setTokenProvider(async () => null);
  setResourceCacheScope("admin");
  const generation = resourceCacheGeneration();
  writeResourceCache("/customers", { name: "Old name" }, generation);
  globalThis.fetch = async () => Response.json({ name: "New name" });
  try {
    await authenticatedFetch("/customers/one", { method: "PATCH" });
    writeResourceCache("/customers", { name: "Old name" }, generation);
    assert.equal(readResourceCache("/customers"), undefined);
    writeResourceCache("/customers", { name: "New name" }, resourceCacheGeneration());
    assert.deepEqual(readResourceCache("/customers"), { name: "New name" });
  } finally { globalThis.fetch = originalFetch; setResourceCacheScope(null); }
});

test("rejected writes retain the cache, but revoked API access discards it", async () => {
  const originalFetch = globalThis.fetch;
  setResourceCacheScope("admin");
  let status = 409;
  globalThis.fetch = async () => Response.json({}, { status });
  try {
    writeResourceCache("/customers", { name: "Current" }, resourceCacheGeneration());
    await authenticatedFetch("/customers/one", { method: "PATCH" });
    assert.deepEqual(readResourceCache("/customers"), { name: "Current" });
    status = 403;
    await authenticatedFetch("/customers");
    assert.equal(readResourceCache("/customers"), undefined);
  } finally { globalThis.fetch = originalFetch; clearResourceCache(); setResourceCacheScope(null); }
});
