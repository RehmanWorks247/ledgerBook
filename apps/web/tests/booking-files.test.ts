import { setTokenProvider } from "../src/api";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BookingFileStore, bookingFilesPath, uploadDocument } from "../src/user-files/remote";
import { entriesFromFiles, readDroppedEntries, type FileNode } from "../src/user-files/model";
import { businessDate, departureInstant } from "../src/pages/booking-model";

// Keep database-fallback coverage while exercising the new upload handshake.
function proxyUploads(handler: typeof fetch): typeof fetch {
  return async (input, options = {}) => {
    if (String(input).endsWith("/uploads")) {
      assert.equal(options.method, "POST");
      assert.equal(new Headers(options.headers).get("X-CSRF-Protection"), "1");
      const body = JSON.parse(options.body as string);
      assert.match(body.sha256, /^[a-f0-9]{64}$/);
      return Response.json({ transport: "proxy" });
    }
    return handler(input, options);
  };
}

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
  globalThis.fetch = proxyUploads(async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, options });
    if (options.method === "POST") {
      assert.equal(url, `/api${bookingFilesPath(context)}/folders/${folder.id}/documents`);
      const headers = new Headers(options.headers);
      assert.equal(headers.get("Content-Type"), "application/octet-stream");
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
  });
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
  globalThis.fetch = proxyUploads(async (_input, options = {}) => {
    assert.equal(options.method, undefined, "No invalid file may be posted");
    return allowed ? Response.json({ items: [folder] }) : Response.json({ message: "Document access is unavailable." }, { status: 404 });
  });
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

test("mixed file selections and folder drops accept all types up to 10 MiB and reject larger or empty files before posting", async () => {
  const originalFetch = globalThis.fetch;
  const uploaded: string[] = [];
  globalThis.fetch = proxyUploads(async (_input, options = {}) => {
    if (!options.method) return Response.json({ items: [folder] });
    const headers = new Headers(options.headers);
    assert.equal(headers.get("Content-Type"), "application/octet-stream");
    const name = decodeURIComponent(headers.get("X-File-Name")!);
    uploaded.push(name);
    return Response.json({ id: crypto.randomUUID(), parentId: folder.id, kind: "file", name, size: (options.body as File).size, modifiedAt: 0 });
  });
  try {
    const store = new BookingFileStore(context);
    await store.load();
    const files = ["letter.doc", "letter.docx", "photo.jpg", "photo.png", "data.csv", "archive.zip", "custom.anything", "README"]
      .map(name => new File([new Uint8Array([0, 255, 128])], name));
    files.push(new File([new Uint8Array(10 * 1024 * 1024)], "limit.bin"));
    assert.equal((await store.importEntries(folder.id, entriesFromFiles(files))).succeeded, files.length);
    assert.deepEqual(uploaded.sort(), files.map(file => file.name).sort());
    const before = uploaded.length;
    for (const size of [0, 10 * 1024 * 1024 + 1]) {
      await assert.rejects(store.importEntries(folder.id, [{ kind: "folder", name: "Dropped folder", children: entriesFromFiles([
        new File(["valid"], "valid.txt"), new File([new Uint8Array(size)], "invalid.bin"),
      ]) }]), /non-empty file up to 10 MB/);
    }
    assert.equal(uploaded.length, before);
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
  globalThis.fetch = proxyUploads(async (_input, options = {}) => {
    if (options.method === "POST") return saveSucceeds ? Response.json({ id: "saved", parentId: folder.id, kind: "file", name: "Voucher.pdf", size: 14, modifiedAt: 0 }) : Response.json({ message: "Upload was rejected." }, { status: 400 });
    if (initialLoad) { initialLoad = false; return Response.json({ items: [folder] }); }
    return Response.json({ message: "File list is unavailable." }, { status: 503 });
  });
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
    await new Promise(resolve => setImmediate(resolve));
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
  globalThis.fetch = proxyUploads(async (_input, options = {}) => {
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
  });
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
  globalThis.fetch = proxyUploads(async (_input, options = {}) => {
    if (!options.method) return Response.json({ items: [folder] });
    const headers = new Headers(options.headers);
    ++started;
    if (allow) return Response.json({ id: headers.get("Idempotency-Key"), parentId: folder.id, kind: "file", name: decodeURIComponent(headers.get("X-File-Name")!), size: 14, modifiedAt: 0 });
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
      if (started === 3) ready();
    });
  });
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = proxyUploads(async () => { throw new Error("Unexpected request"); });
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
  setTokenProvider(async () => "document-session");
  try {
    const progress: number[] = [];
    let settled = false;
    const promise = uploadDocument("/documents", new File(["%PDF-1.7\n%%EOF"], "Test.pdf"), "Test.pdf", "stable-key", new AbortController().signal, (loaded) => progress.push(loaded), "a".repeat(64));
    await new Promise(resolve => setImmediate(resolve));
    const request = FakeRequest.latest;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.deepEqual(progress, [14]);
    assert.equal(settled, false, "Sending every byte is not confirmation of a successful save");
    assert.equal(request.withCredentials, true);
    assert.equal(request.headers.get("authorization"), "Bearer document-session");
    assert.equal(request.headers.get("x-csrf-protection"), "1");
    assert.equal(request.headers.get("idempotency-key"), "stable-key");
    request.onload?.();
    assert.equal((await promise).id, "saved");
  } finally { globalThis.XMLHttpRequest = original; globalThis.fetch = originalFetch; setTokenProvider(async () => null); }
});

test("admin file mutations keep confirmed responses without a follow-up list request and retain rejected deletions", async () => {
  const originalFetch = globalThis.fetch;
  const node: FileNode = { id: "saved", parentId: folder.id, name: "Voucher.pdf", kind: "file", size: 14, modifiedAt: 0 };
  let rejectDelete = true, reads = 0;
  globalThis.fetch = async (input, options = {}) => {
    if (!options.method) { reads++; return Response.json({ items: [folder, node] }); }
    assert.equal(input, `/api${bookingFilesPath(context)}/files/saved`);
    assert.equal(new Headers(options.headers).get("X-CSRF-Protection"), "1");
    if (options.method === "PATCH") return Response.json({ ...node, ...JSON.parse(options.body as string) });
    assert.equal(options.method, "DELETE");
    return rejectDelete ? Response.json({ message: "Only administrators can change documents." }, { status: 403 }) : Response.json({ deleted: true });
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    await store.rename(node.id, "Hotel voucher.pdf");
    assert.equal(store.getSnapshot().find(item => item.id === node.id)?.name, "Hotel voucher.pdf");
    assert.equal(reads, 1, "A transient list failure cannot misreport a confirmed rename as failed");
    await assert.rejects(store.remove(node.id), /Only administrators/);
    assert.ok(store.getSnapshot().some(item => item.id === node.id));
    rejectDelete = false;
    await store.remove(node.id);
    assert.equal(store.getSnapshot().some(item => item.id === node.id), false);
    assert.ok(store.getSnapshot().some(item => item.id === folder.id));
  } finally { globalThis.fetch = originalFetch; }
});

test("moving a folder updates the service of its whole subtree from the confirmed response", async () => {
  const originalFetch = globalThis.fetch;
  const custom: FileNode = { ...folder, id: "custom", parentId: folder.id, defaultFolder: false };
  const nested: FileNode = { ...custom, id: "nested", parentId: custom.id };
  const document: FileNode = { ...nested, id: "document", parentId: nested.id, kind: "file", name: "Voucher.pdf", size: 14 };
  let reads = 0;
  globalThis.fetch = async (_input, options = {}) => {
    if (!options.method) { reads++; return Response.json({ items: [folder, custom, nested, document] }); }
    assert.deepEqual(JSON.parse(options.body as string), { parent_id: "new-service" });
    return Response.json({ ...custom, parentId: "new-service", serviceKey: "transport", modifiedAt: 123 });
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    await store.move(custom.id, "new-service");
    assert.equal(reads, 1);
    for (const id of [custom.id, nested.id, document.id]) assert.equal(store.getSnapshot().find(node => node.id === id)?.serviceKey, "transport");
    assert.equal(store.getSnapshot().find(node => node.id === folder.id)?.serviceKey, folder.serviceKey);
    assert.equal(store.getSnapshot().find(node => node.id === document.id)?.parentId, nested.id);
  } finally { globalThis.fetch = originalFetch; }
});

test("confirmed folder creations release their retry key so a renamed or moved folder does not reserve its old name", async () => {
  const originalFetch = globalThis.fetch;
  const secondService: FileNode = { ...folder, id: crypto.randomUUID(), name: "Flight Tickets", serviceKey: "flight" };
  const nodes: FileNode[] = [folder, secondService];
  const attempts = new Map<string, FileNode>();
  const keys: string[] = [];
  globalThis.fetch = async (input, options = {}) => {
    if (!options.method) return Response.json({ items: nodes });
    const body = JSON.parse(options.body as string);
    if (options.method === "POST") {
      keys.push(body.idempotency_key);
      let node = attempts.get(body.idempotency_key);
      if (!node) {
        node = { id: crypto.randomUUID(), parentId: body.parent_id, name: body.name, kind: "folder", size: 0, modifiedAt: 0, serviceKey: "makkah" };
        attempts.set(body.idempotency_key, node);
        nodes.push(node);
      }
      return Response.json(node);
    }
    const node = nodes.find(item => String(input).endsWith(`/files/${item.id}`))!;
    assert.ok(node);
    if ("name" in body) node.name = body.name;
    if ("parent_id" in body) { node.parentId = body.parent_id; node.serviceKey = "flight"; }
    return Response.json(node);
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    await store.createFolder(folder.id, "Original");
    const first = store.getSnapshot().find(node => node.name === "Original")!;
    await store.rename(first.id, "Renamed");
    await store.createFolder(folder.id, "Original");
    const second = store.getSnapshot().find(node => node.name === "Original")!;
    assert.ok(second, "Creating the old name after rename must create a new folder.");
    assert.notEqual(second.id, first.id);
    await store.move(second.id, secondService.id);
    await store.createFolder(folder.id, "Original");
    const third = store.getSnapshot().find(node => node.name === "Original" && node.parentId === folder.id)!;
    assert.ok(third, "Moving a folder away must leave its former name available.");
    assert.notEqual(third.id, second.id);
    assert.equal(new Set(keys).size, 3);
    assert.equal(store.getSnapshot().filter(node => !node.defaultFolder).length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("lost folder creation responses retry the same attempt and repeated tree imports reuse confirmed folders", async () => {
  const originalFetch = globalThis.fetch;
  const nodes: FileNode[] = [folder];
  const attempts = new Map<string, FileNode>();
  const keys: string[] = [];
  let loseResponse = true;
  globalThis.fetch = async (_input, options = {}) => {
    if (!options.method) return Response.json({ items: nodes });
    const body = JSON.parse(options.body as string);
    keys.push(body.idempotency_key);
    let node = attempts.get(body.idempotency_key);
    if (!node) {
      node = { id: crypto.randomUUID(), parentId: body.parent_id, name: body.name, kind: "folder", size: 0, modifiedAt: 0, serviceKey: "makkah" };
      attempts.set(body.idempotency_key, node);
      nodes.push(node);
    }
    if (loseResponse) { loseResponse = false; throw new Error("Connection interrupted after commit"); }
    return Response.json(node);
  };
  try {
    const store = new BookingFileStore(context);
    await store.load();
    await assert.rejects(store.createFolder(folder.id, "Retry folder"), /Connection interrupted/);
    await store.createFolder(folder.id, "Retry folder");
    assert.equal(keys[0], keys[1], "An uncertain creation must safely retry without duplicates.");
    assert.equal(attempts.size, 1);
    const entries = [{ kind: "folder" as const, name: "Imported", children: [{ kind: "folder" as const, name: "Nested", children: [] }] }];
    await store.importEntries(folder.id, entries);
    const created = keys.length;
    await store.importEntries(folder.id, entries);
    assert.equal(keys.length, created, "Re-importing a confirmed tree must reuse its actual folders.");
    assert.equal(store.getSnapshot().filter(node => !node.defaultFolder).length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("document replacements use create-only direct uploads, preserve auth isolation and commit only after verification", async () => {
  const originalFetch=globalThis.fetch;
  const old:FileNode={id:'55555555-5555-4555-8555-555555555555',parentId:folder.id,name:'notes.txt',kind:'file',size:3,modifiedAt:0,version:1};
  const store=new BookingFileStore(context);const requests:string[]=[];let attempts=0;let key='';
  setTokenProvider(async()=> 'private-session-token');
  globalThis.fetch=async(input,options={})=>{
    const url=String(input);requests.push(url);
    if(url.endsWith('/files'))return Response.json({items:[folder,old]});
    if(url.endsWith('/uploads')){
      const body=JSON.parse(options.body as string);assert.equal(body.expected_version,1);assert.equal(body.name,'notes.txt');
      assert.equal(new Headers(options.headers).get('Authorization'),'Bearer private-session-token');
      if(key)assert.equal(body.idempotency_key,key);else key=body.idempotency_key;
      return Response.json({transport:'direct',uploadId:'new-object',url:'https://storage.example.test/object',headers:{'Content-Type':'text/plain','If-None-Match':'*'}});
    }
    if(url.startsWith('https://storage.')) {
      assert.equal(options.credentials,'omit');assert.equal(new Headers(options.headers).has('Authorization'),false);assert.equal(new Headers(options.headers).has('X-CSRF-Protection'),false);
      assert.equal(new Headers(options.headers).get('If-None-Match'),'*');return new Response(null,{status:++attempts===1?200:412});
    }
    assert.ok(url.endsWith('/uploads/new-object/complete'));assert.equal(store.getSnapshot().find(node=>node.id===old.id)?.version,1);
    if(attempts===1)throw Error('Final response interrupted');
    return Response.json({...old,size:7,version:2});
  };
  try {
    await store.load();const file=new File(['changed'],'notes.txt');const messages:string[]=[];
    await assert.rejects(store.replace(old,file,message=>messages.push(message)),/interrupted/);assert.equal(store.getSnapshot().find(node=>node.id===old.id)?.version,1);
    await store.replace(old,file,message=>messages.push(message));assert.equal(store.getSnapshot().find(node=>node.id===old.id)?.version,2);
    assert.ok(messages.includes('Verifying & saving…'));assert.equal(requests.filter(url=>url.startsWith('https://storage.')).length,2);
  }finally{globalThis.fetch=originalFetch;setTokenProvider(async()=>null);}
});

test("document proxy edits carry optimistic version guards and rejected saves preserve the local snapshot",async()=>{
  const originalFetch=globalThis.fetch;const old:FileNode={id:'text',parentId:folder.id,name:'guide.md',kind:'file',size:3,modifiedAt:0,version:4};const store=new BookingFileStore(context);let fail=true;
  globalThis.fetch=async(input,options={})=>{
    const url=String(input);if(url.endsWith('/files'))return Response.json({items:[folder,old]});
    if(url.endsWith('/uploads')){assert.equal(JSON.parse(options.body as string).expected_version,4);return Response.json({transport:'proxy'});}
    assert.ok(url.endsWith('/content'));assert.equal(new Headers(options.headers).get('X-Document-Version'),'4');assert.equal(options.credentials,'include');
    return fail?Response.json({message:'This file has a newer version.'},{status:409}):Response.json({...old,version:5,size:7});
  };
  try{await store.load();const file=new File(['changed'],'guide.md');await assert.rejects(store.replace(old,file),/newer version/);assert.equal(store.getSnapshot().at(-1)?.version,4);fail=false;await store.replace(old,file);assert.equal(store.getSnapshot().at(-1)?.version,5);}finally{globalThis.fetch=originalFetch;}
});

test("version restoration submits the selected history and current version before publishing",async()=>{
  const originalFetch=globalThis.fetch;const old:FileNode={id:'file',parentId:folder.id,name:'guide.md',kind:'file',size:3,modifiedAt:0,version:4};const store=new BookingFileStore(context);
  globalThis.fetch=async(input,options={})=>{
    if(String(input).endsWith('/files'))return Response.json({items:[folder,old]});
    assert.ok(String(input).endsWith('/documents/file/versions/2/restore'));assert.deepEqual(JSON.parse(options.body as string),{expected_version:4});return Response.json({...old,version:5});
  };
  try{await store.load();await store.restore('file',2,4);assert.equal(store.getSnapshot().at(-1)?.version,5);}finally{globalThis.fetch=originalFetch;}
});
