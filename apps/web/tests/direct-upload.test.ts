import assert from "node:assert/strict";
import { test } from "node:test";
import { setTokenProvider } from "../src/api";
import { uploadDocument } from "../src/user-files/remote";

const file = new File(["%PDF-1.7\n%%EOF"], "Voucher.pdf", { type: "application/pdf" });
const path = "/organizations/org/customers/customer/bookings/booking/folders/folder/documents";
const uploadsPath = `/api${path.replace(/\/documents$/, "/uploads")}`;
const checksum = "a".repeat(64);
const ticket = {
  transport: "direct", uploadId: "upload-id", url: "https://bucket.storage.test/key?signature=private",
  headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" }, expiresAt: "2026-11-09T10:10:00Z",
};
const document = { id: "saved", kind: "file", name: file.name, size: file.size, parentId: "folder", modifiedAt: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("direct upload reports real bytes, isolates credentials, and waits for server verification before success", async () => {
  const originalFetch = globalThis.fetch, originalXHR = globalThis.XMLHttpRequest;
  const started = deferred<FakeRequest>(), verifying = deferred<void>(), complete = deferred<Response>();
  class FakeRequest {
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    onload?: () => void;
    onabort?: () => void;
    status = 200;
    withCredentials = true;
    headers = new Map<string, string>();
    open(method: string, url: string) { assert.equal(method, "PUT"); assert.equal(url, ticket.url); }
    setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
    send(body: unknown) { assert.equal(body, file); started.resolve(this); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeRequest as unknown as typeof XMLHttpRequest;
  setTokenProvider(async () => "private-app-session");
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(options.method, "POST");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("Authorization"), "Bearer private-app-session");
    assert.equal(headers.get("X-CSRF-Protection"), "1");
    if (String(input) === uploadsPath) {
      assert.deepEqual(JSON.parse(options.body as string), { name: file.name, size: file.size, sha256: checksum, idempotency_key: "stable-key" });
      return Response.json(ticket);
    }
    assert.equal(input, `${uploadsPath}/upload-id/complete`);
    verifying.resolve();
    return complete.promise;
  };
  try {
    const progress: number[] = [];
    let saved = false;
    const result = uploadDocument(path, file, file.name, "stable-key", new AbortController().signal, bytes => progress.push(bytes), checksum);
    void result.then(() => { saved = true; });
    const request = await started.promise;
    assert.equal(request.withCredentials, false);
    assert.deepEqual(Object.fromEntries(request.headers), ticket.headers);
    request.upload.onprogress?.({ loaded: 5 });
    request.upload.onprogress?.({ loaded: file.size });
    assert.deepEqual(progress, [5, file.size]);
    assert.equal(saved, false, "Sending all bytes is not a confirmed save");
    request.onload?.();
    await verifying.promise;
    assert.equal(saved, false, "Storage acceptance still requires verified booking metadata");
    complete.resolve(Response.json(document));
    assert.deepEqual(await result, document);
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXHR; setTokenProvider(async () => null); }
});

test("direct PUT errors remain actionable and never finalize an unsuccessful upload", async () => {
  const originalFetch = globalThis.fetch, originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = undefined as unknown as typeof XMLHttpRequest;
  for (const [status, message] of [[403, /expired or was rejected/], [429, /temporarily busy/], [503, /temporarily busy/]] as const) {
    let calls = 0;
    globalThis.fetch = async (input, options = {}) => {
      calls++;
      if (calls === 1) { assert.equal(input, uploadsPath); return Response.json(ticket); }
      assert.equal(input, ticket.url);
      assert.equal(options.method, "PUT");
      assert.equal(options.credentials, "omit");
      assert.equal(new Headers(options.headers).has("Authorization"), false);
      return new Response("provider detail must not leak", { status });
    };
    try {
      await assert.rejects(uploadDocument(path, file, file.name, "same-key", new AbortController().signal, () => {}, checksum), message);
      assert.equal(calls, 2);
    } finally { globalThis.fetch = originalFetch; }
  }
  globalThis.XMLHttpRequest = originalXHR;
});

test("retry of an immutable stored object still verifies it and committed uploads do not transmit twice", async () => {
  const originalFetch = globalThis.fetch, originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = undefined as unknown as typeof XMLHttpRequest;
  let committed = false, puts = 0, verified = 0;
  const keys: string[] = [];
  globalThis.fetch = async (input, options = {}) => {
    if (String(input) === uploadsPath) {
      keys.push(JSON.parse(options.body as string).idempotency_key);
      return Response.json(committed ? { transport: "complete", document } : ticket);
    }
    if (input === ticket.url) { puts++; return new Response(null, { status: 412 }); }
    assert.equal(input, `${uploadsPath}/upload-id/complete`);
    verified++;
    committed = true;
    return Response.json(document);
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      assert.deepEqual(await uploadDocument(path, file, file.name, "same-key", new AbortController().signal, () => {}, checksum), document);
    assert.deepEqual(keys, ["same-key", "same-key"]);
    assert.equal(puts, 1);
    assert.equal(verified, 1);
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXHR; }
});

test("stopping a direct transfer aborts the actual request and does not finalize it", async () => {
  const originalFetch = globalThis.fetch, originalXHR = globalThis.XMLHttpRequest;
  const started = deferred<void>();
  let aborted = false, calls = 0;
  class FakeRequest {
    upload = {};
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    send() { started.resolve(); }
    abort() { aborted = true; this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeRequest as unknown as typeof XMLHttpRequest;
  globalThis.fetch = async () => { calls++; return Response.json(ticket); };
  try {
    const controller = new AbortController();
    const result = uploadDocument(path, file, file.name, "key", controller.signal, () => {}, checksum);
    await started.promise;
    controller.abort();
    await assert.rejects(result, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.equal(aborted, true);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXHR; }
});
