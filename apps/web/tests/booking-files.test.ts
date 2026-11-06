import assert from "node:assert/strict";
import { test } from "node:test";
import { BookingFileStore, bookingFilesPath, uploadDocument } from "../src/user-files/remote";
import { entriesFromFiles, readDroppedEntries, type FileNode } from "../src/user-files/model";
import { businessDate, departureInstant } from "../src/pages/booking-model";

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  bookingId: "33333333-3333-4333-8333-333333333333",
};
const folder: FileNode = {
  id: "44444444-4444-4444-8444-444444444444", name: "Makkah Hotel", kind: "folder",
  parentId: null, size: 0, modifiedAt: 0, serviceKey: "makkah", defaultFolder: true,
};

test("selected files and dropped PDFs use the booking destination and retry a lost response without duplicates", async () => {
  const originalFetch = globalThis.fetch;
  const nodes: FileNode[] = [folder];
  const uploads = new Map<string, string>();
  const requests: { url: string; options: RequestInit }[] = [];
  let loseResponse = true;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, options });
    if (options.method === "POST") {
      assert.equal(url, `/api${bookingFilesPath(context)}/folders/${folder.id}/documents`);
      const headers = new Headers(options.headers);
      assert.equal(headers.get("Content-Type"), "application/pdf");
      assert.equal(headers.get("X-CSRF-Protection"), "1");
      assert.equal(options.credentials, "include");
      const key = headers.get("Idempotency-Key")!;
      assert.match(key, /^[0-9a-f-]{36}$/);
      const bytes = await (options.body as File).text();
      if (!uploads.has(key)) {
        uploads.set(key, bytes);
        nodes.push({ id: key, parentId: folder.id, kind: "file", name: decodeURIComponent(headers.get("X-File-Name")!), size: bytes.length, modifiedAt: 0, mimeType: "application/pdf", url: `/api${bookingFilesPath(context)}/documents/${key}` });
      }
      if (loseResponse) { loseResponse = false; throw new Error("Connection interrupted"); }
      return Response.json(nodes.at(-1));
    }
    assert.equal(url, `/api${bookingFilesPath(context)}/files`);
    return Response.json({ items: nodes });
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    const picked = new File(["%PDF-1.7\nhotel A\n%%EOF"], "Voucher.pdf", { type: "application/pdf" });
    assert.deepEqual(await store.importEntries(folder.id, entriesFromFiles([picked])), { succeeded: 0, failed: 1, cancelled: 0 });
    assert.match(store.getUploads()[0].error!, /Connection interrupted/);
    assert.equal(store.getSnapshot().filter((node) => node.kind === "file").length, 0, "An unconfirmed response must not be shown as saved");
    assert.equal((await store.retryUploads()).succeeded, 1);
    assert.equal(uploads.size, 1);
    const dropped = new File(["%PDF-1.7\nhotel B\n%%EOF"], "Second voucher.pdf", { type: "application/pdf" });
    await store.importEntries(folder.id, await readDroppedEntries({ files: [dropped] } as unknown as DataTransfer));
    assert.equal(uploads.size, 2);
    assert.equal(store.getSnapshot().filter((node) => node.kind === "file").length, 2);
    assert.equal(requests.filter(({ options }) => options.method === "POST").length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing customer/booking or a foreign service folder is rejected before any upload", async () => {
  assert.throws(() => bookingFilesPath({ ...context, customerId: "" }), /Select a customer/);
  assert.throws(() => bookingFilesPath({ ...context, bookingId: "" }), /Select a customer/);
  const store = new BookingFileStore(context);
  const entries = entriesFromFiles([new File(["%PDF-1.7\n"], "Voucher.pdf")]);
  await assert.rejects(store.importEntries(null, entries), /Open a service folder/);
  await assert.rejects(store.importEntries("another-booking-folder", entries), /selected booking/);
});

test("bad PDFs are rejected before writing a selection and a revoked list clears previously loaded files", async () => {
  const originalFetch = globalThis.fetch;
  let allowed = true;
  globalThis.fetch = async (_input, options = {}) => {
    assert.equal(options.method, undefined, "No invalid file may be posted");
    return allowed ? Response.json({ items: [folder] }) : Response.json({ message: "Document access is unavailable." }, { status: 404 });
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    await assert.rejects(store.importEntries(folder.id, entriesFromFiles([
      new File(["%PDF-1.7\n%%EOF"], "Good.pdf"), new File(["not a pdf"], "Bad.pdf"),
    ])), /not a valid PDF/);
    allowed = false;
    await assert.rejects(store.load(), /Document access is unavailable/);
    assert.deepEqual(store.getSnapshot(), []);
  } finally { globalThis.fetch = originalFetch; }
});

test("booking departure entry and calendar dates use the business zone independently of the device", () => {
  assert.equal(departureInstant("2026-11-06T12:00", "UTC"), "2026-11-06T12:00:00.000Z");
  assert.equal(departureInstant("2026-06-06T12:00", "Europe/London"), "2026-06-06T11:00:00.000Z");
  assert.equal(businessDate("Asia/Karachi", new Date("2026-11-05T20:00:00Z")), "2026-11-06");
  assert.throws(() => departureInstant("2026-03-29T01:30", "Europe/London"), /does not exist/);
  assert.throws(() => departureInstant("2026-02-31T12:00", "UTC"), /valid departure/);
});

test("refresh failures do not mask upload errors or misreport a committed document as unsaved", async () => {
  const originalFetch = globalThis.fetch;
  let initialLoad = true;
  let saveSucceeds = false;
  globalThis.fetch = async (_input, options = {}) => {
    if (options.method === "POST") return saveSucceeds ? Response.json({ id: "saved", parentId: folder.id, kind: "file", name: "Voucher.pdf", size: 14, modifiedAt: 0 }) : Response.json({ message: "Upload was rejected." }, { status: 400 });
    if (initialLoad) { initialLoad = false; return Response.json({ items: [folder] }); }
    return Response.json({ message: "File list is unavailable." }, { status: 503 });
  };
  try {
    const entries = entriesFromFiles([new File(["%PDF-1.7\n%%EOF"], "Voucher.pdf")]);
    const store = new BookingFileStore(context);
    await store.load();
    assert.equal((await store.importEntries(folder.id, entries)).failed, 1);
    assert.equal(store.getUploads()[0].error, "Upload was rejected.");
    saveSucceeds = true;
    assert.equal((await store.retryUploads()).succeeded, 1);
    assert.equal(store.getUploads()[0].status, "complete");
    await assert.rejects(store.load(), /File list is unavailable/);
    assert.equal(store.getSnapshot().some((node) => node.id === "saved"), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("a slower previous file refresh cannot replace the newest booking contents", async () => {
  const originalFetch = globalThis.fetch;
  let firstResolve!: (value: Response) => void;
  let secondResolve!: (value: Response) => void;
  let request = 0;
  globalThis.fetch = () => new Promise<Response>((resolve) => {
    if (++request === 1) firstResolve = resolve;
    else secondResolve = resolve;
  });
  try {
    const store = new BookingFileStore(context);
    const previous = store.load();
    const current = store.load();
    secondResolve(Response.json({ items: [{ ...folder, name: "Newest folder" }] }));
    await current;
    firstResolve(Response.json({ items: [folder] }));
    await previous;
    assert.equal(store.getSnapshot()[0].name, "Newest folder");
  } finally { globalThis.fetch = originalFetch; }
});

test("a partial batch stays bounded and retries only failed files with their original keys", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0, peak = 0, rejectOne = true;
  const requests: { name: string; key: string }[] = [];
  globalThis.fetch = async (_input, options = {}) => {
    if (!options.method) return Response.json({ items: [folder] });
    const headers = new Headers(options.headers);
    const name = decodeURIComponent(headers.get("X-File-Name")!);
    const key = headers.get("Idempotency-Key")!;
    requests.push({ name, key });
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    --active;
    if (name === "2.pdf" && rejectOne) return Response.json({ message: "Storage temporarily unavailable." }, { status: 503 });
    return Response.json({ id: key, parentId: folder.id, kind: "file", name, size: 14, modifiedAt: 0 });
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    const entries = entriesFromFiles(Array.from({ length: 7 }, (_, i) => new File(["%PDF-1.7\n%%EOF"], `${i}.pdf`)));
    assert.deepEqual(await store.importEntries(folder.id, entries), { succeeded: 6, failed: 1, cancelled: 0 });
    assert.equal(peak, 3, "The browser should run three transfers, without sending the whole selection at once");
    assert.equal(store.getSnapshot().filter((node) => node.kind === "file").length, 6);
    assert.equal(store.getUploads().filter((item) => item.status === "failed")[0].error, "Storage temporarily unavailable.");
    rejectOne = false;
    assert.deepEqual(await store.retryUploads(), { succeeded: 1, failed: 0, cancelled: 0 });
    assert.equal(requests.length, 8, "Previously committed files must not be sent again");
    assert.equal(requests.at(-1)?.key, requests.find((request) => request.name === "2.pdf")?.key);
    assert.equal(store.getSnapshot().filter((node) => node.kind === "file").length, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("stopping a batch aborts active requests and preserves queued files for safe retry", async () => {
  const originalFetch = globalThis.fetch;
  let allow = false, started = 0;
  let ready!: () => void;
  const firstWave = new Promise<void>((resolve) => { ready = resolve; });
  globalThis.fetch = async (_input, options = {}) => {
    if (!options.method) return Response.json({ items: [folder] });
    const headers = new Headers(options.headers);
    ++started;
    if (allow) return Response.json({ id: headers.get("Idempotency-Key"), parentId: folder.id, kind: "file", name: decodeURIComponent(headers.get("X-File-Name")!), size: 14, modifiedAt: 0 });
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
      if (started === 3) ready();
    });
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    const batch = store.importEntries(folder.id, entriesFromFiles(Array.from({ length: 5 }, (_, i) => new File(["%PDF-1.7\n%%EOF"], `${i}.pdf`))));
    await firstWave;
    store.cancelUploads();
    assert.deepEqual(await batch, { succeeded: 0, failed: 0, cancelled: 5 });
    assert.equal(started, 3, "Queued transfers must not begin after cancellation");
    allow = true;
    assert.deepEqual(await store.retryUploads(), { succeeded: 5, failed: 0, cancelled: 0 });
  } finally { globalThis.fetch = originalFetch; }
});

test("browser upload progress waits for the committed response and preserves the request security headers", async () => {
  const original = globalThis.XMLHttpRequest;
  class FakeRequest {
    static latest: FakeRequest;
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    onload?: () => void;
    onabort?: () => void;
    responseText = JSON.stringify({ id: "saved" });
    status = 201;
    withCredentials = false;
    headers = new Map<string, string>();
    constructor() { FakeRequest.latest = this; }
    open(method: string, path: string) { assert.equal(method, "POST"); assert.equal(path, "/api/documents"); }
    setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
    send() { this.upload.onprogress?.({ loaded: 14 }); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeRequest as unknown as typeof XMLHttpRequest;
  try {
    const progress: number[] = [];
    let settled = false;
    const promise = uploadDocument("/documents", new File(["%PDF-1.7\n%%EOF"], "Test.pdf"), "Test.pdf", "stable-key", new AbortController().signal, (loaded) => progress.push(loaded));
    const request = FakeRequest.latest;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.deepEqual(progress, [14]);
    assert.equal(settled, false, "Sending every byte is not confirmation of a successful save");
    assert.equal(request.withCredentials, true);
    assert.equal(request.headers.get("X-CSRF-Protection"), "1");
    assert.equal(request.headers.get("Idempotency-Key"), "stable-key");
    request.onload?.();
    assert.equal((await promise).id, "saved");
  } finally { globalThis.XMLHttpRequest = original; }
});
