import { api, ApiError, authenticatedFetch, authenticatedHeaders, errorMessage, mutate } from "../api";
import type { DocumentHistory, FileNode, FileStore, ImportEntry, UploadItem, UploadResult } from "./model";

export type BookingFileContext = {
  organizationId: string;
  customerId: string;
  bookingId: string;
};

export const MAX_UPLOAD_FILES = 100;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;

export function bookingFilesPath(context: BookingFileContext) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![context.organizationId, context.customerId, context.bookingId].every((id) => uuid.test(id)))
    throw new Error("Select a customer and one of their bookings before uploading documents.");
  return `/organizations/${context.organizationId}/customers/${context.customerId}/bookings/${context.bookingId}`;
}

// Context, destination, filename and content form a stable retry key, including
// when a response was lost after the server committed the document.
async function submissionKey(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function fileDigest(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortError() { return new DOMException("Upload stopped. Retry to confirm whether the file was saved.", "AbortError"); }

type UploadTicket =
  | { transport: "proxy" }
  | { transport: "complete"; document: FileNode }
  | { transport: "direct"; uploadId: string; url: string; headers: Record<string, string>; expiresAt: string };

function storageError(status: number) {
  if (status === 403) return "The storage upload link expired or was rejected. Retry to get a fresh link.";
  if (status === 413) return "The file exceeds the storage upload limit. Choose a file up to 10 MB.";
  if (status === 429 || status >= 500) return "Storage is temporarily busy. Wait a moment and retry this file.";
  return "Storage could not accept this file. Retry; if it continues, contact your administrator.";
}

// Never attach application cookies or session headers to a signed storage URL.
// Only the short-lived capability and headers returned by the API go to R2.
async function putDirectUpload(ticket: Extract<UploadTicket, { transport: "direct" }>, file: File,
  signal: AbortSignal, onProgress: (loaded: number) => void) {
  if (signal.aborted) throw abortError();
  if (new URL(ticket.url).protocol !== "https:") throw new Error("The storage upload address is invalid. Contact your administrator.");
  if (typeof XMLHttpRequest === "undefined") {
    const response = await fetch(ticket.url, { method: "PUT", body: file, headers: ticket.headers, signal, credentials: "omit" });
    // A retry may find the immutable object from a previously interrupted save.
    // Finalization still verifies the size and digest before trusting it.
    if (!response.ok && response.status !== 412) throw new Error(storageError(response.status));
    onProgress(file.size);
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    request.open("PUT", ticket.url);
    request.withCredentials = false;
    request.timeout = 180_000;
    for (const [header, value] of Object.entries(ticket.headers)) request.setRequestHeader(header, value);
    request.upload.onprogress = (event) => onProgress(Math.min(event.loaded, file.size));
    request.onload = () => {
      if ((request.status >= 200 && request.status < 300) || request.status === 412) { onProgress(file.size); finish(); }
      else finish(new Error(storageError(request.status)));
    };
    request.onerror = () => finish(new Error("Could not reach file storage. Check your connection and retry. If it continues, ask your administrator to check storage access."));
    request.ontimeout = () => finish(new Error("The storage upload timed out. Check your connection and retry this file."));
    request.onabort = () => finish(abortError());
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

// Completion is reported only after the API verifies the uploaded object and
// commits booking metadata. A stable key safely recovers a lost final response.
export async function uploadDocument(path: string, file: File, name: string, key: string, signal: AbortSignal,
  onProgress: (loaded: number) => void, sha256?: string): Promise<FileNode> {
  if (signal.aborted) throw abortError();
  const uploadsPath = path.replace(/\/documents$/, "/uploads");
  const ticket = await api<UploadTicket>(uploadsPath, {
    method: "POST", signal,
    body: JSON.stringify({ name, size: file.size, sha256: sha256 ?? await fileDigest(file), idempotency_key: key }),
  });
  if (ticket.transport === "complete") return ticket.document;
  if (ticket.transport === "proxy") return uploadProxyDocument(path, file, name, key, signal, onProgress);
  if (ticket.transport !== "direct") throw new Error("The upload could not be prepared. Refresh the page and retry.");
  await putDirectUpload(ticket, file, signal, onProgress);
  return api<FileNode>(`${uploadsPath}/${encodeURIComponent(ticket.uploadId)}/complete`, { method: "POST", signal, body: "{}" });
}

// The database-backed local environment retains its existing upload route.
async function uploadProxyDocument(path: string, file: File, name: string, key: string, signal: AbortSignal,
  onProgress: (loaded: number) => void, extraHeaders: Record<string,string> = {}): Promise<FileNode> {
  const headers = { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "Idempotency-Key": key, ...extraHeaders };
  if (signal.aborted) return Promise.reject(abortError());
  if (typeof XMLHttpRequest === "undefined") return api<FileNode>(path, { method: "POST", headers, body: file, signal });
  const authorizedHeaders = await authenticatedHeaders(headers);
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error, node?: FileNode) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(node!);
    };
    request.open("POST", `/api${path}`);
    request.withCredentials = true;
    request.timeout = 180_000;
    for (const [header, value] of authorizedHeaders) request.setRequestHeader(header, value);
    request.upload.onprogress = (event) => onProgress(Math.min(event.loaded, file.size));
    request.onload = () => {
      let data: FileNode & { message?: string | string[] };
      try { data = JSON.parse(request.responseText); }
      catch { finish(new Error("The upload response was interrupted. Retry this file safely.")); return; }
      if (request.status >= 200 && request.status < 300) finish(undefined, data);
      else finish(new ApiError(Array.isArray(data.message) ? data.message.join(" ") : data.message || "The file could not be uploaded. Please retry.", request.status));
    };
    request.onerror = () => finish(new Error("Connection interrupted. Retry this file safely."));
    request.ontimeout = () => finish(new Error("The upload timed out. Retry this file safely."));
    request.onabort = () => finish(abortError());
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

type UploadJob = { item: UploadItem; entry: Extract<ImportEntry, { kind: "file" }>; destination: string; key?: string; digest?: string };

export class BookingFileStore implements FileStore {
  private nodes: FileNode[] = [];
  private listeners = new Set<() => void>();
  private uploadListeners = new Set<() => void>();
  private uploads: UploadItem[] = [];
  private jobs: UploadJob[] = [];
  private controller: AbortController | undefined;
  private loadVersion = 0;
  private folderAttempts = new Map<string, string>();
  readonly path: string;

  constructor(context: BookingFileContext) { this.path = bookingFilesPath(context); }

  getSnapshot = (): readonly FileNode[] => this.nodes;
  getUploads = (): readonly UploadItem[] => this.uploads;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribeUploads = (listener: () => void) => {
    this.uploadListeners.add(listener);
    return () => { this.uploadListeners.delete(listener); };
  };
  private commit(nodes: FileNode[]) {
    this.nodes = nodes;
    this.listeners.forEach((listener) => listener());
  }
  private upsert(node: FileNode) {
    // Ignore older list requests that started before this mutation committed.
    ++this.loadVersion;
    this.commit([...this.nodes.filter((existing) => existing.id !== node.id), node]);
  }
  private publishUploads() {
    this.uploads = this.jobs.map(({ item }) => ({ ...item }));
    this.uploadListeners.forEach((listener) => listener());
  }
  clearUploads = () => {
    if (this.controller) return;
    this.jobs = [];
    this.publishUploads();
  };
  cancelUploads = () => { this.controller?.abort(); };
  load = async () => {
    const version = ++this.loadVersion;
    try {
      const data = await api<{ items: FileNode[] }>(`${this.path}/files`);
      if (version === this.loadVersion) this.commit(data.items);
    } catch (error) {
      // A temporary outage must not erase successfully saved documents. Access
      // denial does clear them, so revoked records do not remain visible.
      if (version === this.loadVersion && error instanceof ApiError && [401, 403, 404].includes(error.status)) this.commit([]);
      throw error;
    }
  };

  private serviceDestination(parentId: string | null) {
    if (!parentId) throw new Error("Open a service folder in this booking before adding files.");
    let folder = this.nodes.find((node) => node.id === parentId && node.kind === "folder");
    const visited = new Set<string>();
    while (folder) {
      if (folder.serviceKey) return;
      if (visited.has(folder.id)) break;
      visited.add(folder.id);
      folder = this.nodes.find((node) => node.id === folder?.parentId && node.kind === "folder");
    }
    throw new Error("Choose a service folder belonging to the selected booking.");
  }

  private async folder(parentId: string | null, name: string, signal?: AbortSignal) {
    const attempt = JSON.stringify([parentId, name.trim()]);
    const key = this.folderAttempts.get(attempt) ?? crypto.randomUUID();
    this.folderAttempts.set(attempt, key);
    const result = await api<FileNode>(`${this.path}/folders`, {
      method: "POST", signal,
      body: JSON.stringify({ parent_id: parentId, name, idempotency_key: key }),
    });
    // Keep an interrupted attempt retryable, but a confirmed creation must not
    // reserve this name forever after its folder is renamed, moved or deleted.
    if (this.folderAttempts.get(attempt) === key) this.folderAttempts.delete(attempt);
    this.upsert(result);
    return result;
  }

  async createFolder(parentId: string | null, name: string) {
    const key = name.trim().normalize().toLowerCase();
    if (this.nodes.some((node) => node.parentId === parentId && node.name.normalize().toLowerCase() === key))
      throw new Error("An item with this name already exists here.");
    await this.folder(parentId, name);
  }

  async importEntries(parentId: string | null, entries: ImportEntry[]): Promise<UploadResult> {
    if (this.controller) throw new Error("Wait for the current upload to finish.");
    this.serviceDestination(parentId);
    const controller = new AbortController();
    this.controller = controller;
    let files = 0, bytes = 0, folders = 0;
    const validate = async (list: ImportEntry[], depth = 0): Promise<void> => {
      if (depth > 12) throw new Error("Choose folders no more than 12 levels deep.");
      for (const entry of list) {
        if (controller.signal.aborted) throw abortError();
        if (!entry.name.trim() || entry.name.length > 240 || /[/\\]/.test(entry.name)
          || Array.from(entry.name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
          || [".", ".."].includes(entry.name.trim()))
          throw new Error("Use file and folder names up to 240 characters without slashes or control characters.");
        if (entry.kind === "folder") {
          if (++folders > 100) throw new Error("Choose at most 100 folders at a time.");
          await validate(entry.children, depth + 1);
        } else {
          if (++files > MAX_UPLOAD_FILES || (bytes += entry.file.size) > MAX_BATCH_BYTES)
            throw new Error("Choose at most 100 files totalling 100 MB at a time.");
          if (entry.file.size === 0 || entry.file.size > MAX_DOCUMENT_BYTES)
            throw new Error(`${entry.name}: choose a non-empty file up to 10 MB.`);
          if (entry.name.trim().toLowerCase().endsWith(".pdf") && (entry.file.size < 12 || !(await entry.file.slice(0, 5).text()).startsWith("%PDF-") || !(await entry.file.slice(-1024).text()).includes("%%EOF")))
            throw new Error(`${entry.name} is not a valid PDF document.`);
        }
      }
    };
    try {
      // Validate the complete selection before creating folders or uploading.
      await validate(entries);
      this.jobs = [];
      this.publishUploads();
      const planned: UploadJob[] = [];
      const append = async (list: ImportEntry[], destination: string): Promise<void> => {
        for (const entry of list) {
          if (controller.signal.aborted) throw abortError();
          if (entry.kind === "folder") {
            // Re-selecting an interrupted folder import should reuse its
            // confirmed tree while individual failed creations retain keys.
            const folder = this.nodes.find(node => node.kind === "folder" && node.parentId === destination
              && node.name.normalize().toLowerCase() === entry.name.trim().normalize().toLowerCase())
              ?? await this.folder(destination, entry.name, controller.signal);
            await append(entry.children, folder.id);
          } else planned.push({ entry, destination, item: { id: crypto.randomUUID(), name: entry.name, status: "queued", loaded: 0, total: entry.file.size } });
        }
      };
      await append(entries, parentId!);
      this.jobs = planned;
      this.publishUploads();
      return await this.runUploads(this.jobs, controller.signal);
    } finally { this.controller = undefined; }
  }

  retryUploads = async (): Promise<UploadResult> => {
    if (this.controller) throw new Error("Wait for the current upload to finish.");
    const pending = this.jobs.filter(({ item }) => ["failed", "cancelled"].includes(item.status));
    const controller = new AbortController();
    this.controller = controller;
    try {
      for (const job of pending) job.item = { ...job.item, status: "queued", loaded: 0, error: undefined };
      this.publishUploads();
      return await this.runUploads(pending, controller.signal);
    } finally { this.controller = undefined; }
  };

  private async runUploads(jobs: UploadJob[], signal: AbortSignal): Promise<UploadResult> {
    let index = 0;
    const work = async () => {
      while (index < jobs.length) {
        const job = jobs[index++];
        try {
          if (signal.aborted) throw abortError();
          job.item.status = "preparing";
          this.publishUploads();
          // Hash only the bounded number of active files, not the entire batch.
          job.digest ??= await fileDigest(job.entry.file);
          job.key ??= await submissionKey(`${this.path}/${job.destination}/${job.entry.name}/${job.digest}`);
          if (signal.aborted) throw abortError();
          const node = await uploadDocument(`${this.path}/folders/${job.destination}/documents`, job.entry.file, job.entry.name, job.key, signal, (loaded) => {
            job.item.loaded = loaded;
            job.item.status = loaded >= job.item.total ? "saving" : "uploading";
            this.publishUploads();
          }, job.digest);
          this.upsert(node);
          job.item.status = "complete";
          job.item.loaded = job.item.total;
        } catch (error) {
          job.item.status = signal.aborted ? "cancelled" : "failed";
          job.item.error = signal.aborted ? abortError().message : errorMessage(error);
        }
        this.publishUploads();
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, jobs.length) }, work));
    return {
      succeeded: jobs.filter(({ item }) => item.status === "complete").length,
      failed: jobs.filter(({ item }) => item.status === "failed").length,
      cancelled: jobs.filter(({ item }) => item.status === "cancelled").length,
    };
  }

  async move(id: string, parentId: string | null) {
    const moved = await mutate<FileNode>(`${this.path}/files/${encodeURIComponent(id)}`, { parent_id: parentId }, "PATCH");
    const children = new Map<string, string[]>();
    for (const node of this.nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
    const descendants = new Set([id]);
    for (const descendant of descendants) {
      for (const child of children.get(descendant) ?? []) descendants.add(child);
    }
    // The server moves the whole subtree to the destination service. Reflect
    // that confirmed change without relying on a second request succeeding.
    ++this.loadVersion;
    this.commit(this.nodes.map(node => node.id === id ? moved : descendants.has(node.id)
      ? { ...node, serviceKey: moved.serviceKey, modifiedAt: moved.modifiedAt } : node));
  }

  async rename(id: string, name: string) {
    this.upsert(await mutate<FileNode>(`${this.path}/files/${encodeURIComponent(id)}`, { name }, "PATCH"));
  }

  async history(id: string) {
    return api<DocumentHistory>(`${this.path}/documents/${encodeURIComponent(id)}/versions`);
  }
  async readText(id: string) {
    return api<{name:string;version:number;text:string}>(`${this.path}/documents/${encodeURIComponent(id)}/text`);
  }
  async restore(id: string, version: number, expectedVersion: number) {
    this.upsert(await mutate<FileNode>(`${this.path}/documents/${encodeURIComponent(id)}/versions/${version}/restore`, { expected_version: expectedVersion }));
  }
  async downloadVersion(id: string, version: number, name: string) {
    const response = await authenticatedFetch(`${this.path}/documents/${encodeURIComponent(id)}/versions/${version}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as {message?:string};
      throw new Error(data.message || "This version could not be downloaded.");
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async replace(node: FileNode, file: File, onProgress: (message: string) => void = () => {}) {
    if (!node.parentId || !node.version) throw new Error("Refresh the booking before editing this file.");
    if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error("Choose a non-empty replacement up to 10 MB.");
    const base = `${this.path}/folders/${encodeURIComponent(node.parentId)}/documents/${encodeURIComponent(node.id)}`;
    const sha256 = await fileDigest(file);
    const key = await submissionKey(`${base}/${node.version}/${file.name}/${sha256}`);
    const signal = new AbortController().signal;
    onProgress("Preparing replacement…");
    const ticket = await api<UploadTicket>(`${base}/uploads`, {method:"POST",body:JSON.stringify({name:file.name,size:file.size,sha256,idempotency_key:key,expected_version:node.version})});
    let saved: FileNode;
    const progress = (loaded:number) => onProgress(loaded >= file.size ? "Verifying & saving…" : `Uploading ${Math.round(loaded / file.size * 100)}%…`);
    if (ticket.transport === "complete") saved = ticket.document;
    else if (ticket.transport === "proxy") saved = await uploadProxyDocument(`${base}/content`,file,file.name,key,signal,progress,{"X-Document-Version":String(node.version)});
    else {
      await putDirectUpload(ticket,file,signal,progress);
      saved = await api<FileNode>(`${base}/uploads/${encodeURIComponent(ticket.uploadId)}/complete`,{method:"POST",body:"{}"});
    }
    this.upsert(saved);
  }

  async remove(id: string) {
    await mutate(`${this.path}/files/${encodeURIComponent(id)}`, undefined, "DELETE");
    ++this.loadVersion;
    this.commit(this.nodes.filter((node) => node.id !== id));
  }
}

