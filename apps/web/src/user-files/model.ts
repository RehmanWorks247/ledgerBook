type ParentId = string | null;

export type FileNode = {
  id: string;
  parentId: ParentId;
  name: string;
  kind: "file" | "folder";
  size: number;
  modifiedAt: number;
  file?: File;
  mimeType?: string;
  url?: string;
  serviceKey?: string | null;
  defaultFolder?: boolean;
  issuedAt?: string | null;
  version?: number;
};

export type DocumentVersion = {version:number;name:string;mimeType:string;size:number;createdAt:string;current:boolean};
export type DocumentHistory = {version:number;items:DocumentVersion[]};

export interface FileStore {
  getSnapshot: () => readonly FileNode[];
  subscribe: (listener: () => void) => () => void;
  createFolder: (parentId: ParentId, name: string) => void | Promise<void>;
  importEntries: (parentId: ParentId, entries: ImportEntry[]) => void | Promise<void | UploadResult>;
  move: (id: string, parentId: ParentId) => void | Promise<void>;
  rename?: (id: string, name: string) => void | Promise<void>;
  remove?: (id: string) => void | Promise<void>;
  load?: () => Promise<void>;
  getUploads?: () => readonly UploadItem[];
  subscribeUploads?: (listener: () => void) => () => void;
  retryUploads?: () => Promise<UploadResult>;
  cancelUploads?: () => void;
  clearUploads?: () => void;
  history?: (id:string) => Promise<DocumentHistory>;
  readText?: (id:string) => Promise<{name:string;version:number;text:string}>;
  replace?: (node:FileNode,file:File,onProgress?:(message:string)=>void) => Promise<void>;
  restore?: (id:string,version:number,expectedVersion:number) => Promise<void>;
  downloadVersion?: (id:string,version:number,name:string) => Promise<void>;
}

export type UploadItem = {
  id: string;
  name: string;
  status: "queued" | "preparing" | "uploading" | "saving" | "complete" | "failed" | "cancelled";
  loaded: number;
  total: number;
  error?: string;
};
export type UploadResult = { succeeded: number; failed: number; cancelled: number };

export type ImportEntry =
  | { kind: "file"; name: string; file: File }
  | { kind: "folder"; name: string; children: ImportEntry[] };

let nextId = 0;

function newFolder(parentId: ParentId, name: string): FileNode {
  return {
    id: String(++nextId),
    parentId,
    name,
    kind: "folder",
    size: 0,
    modifiedAt: Date.now(),
  };
}

const nameKey = (name: string) => name.normalize().toLowerCase();

function availableName(entry: ImportEntry, taken: Set<string>) {
  let name = entry.name;
  const dot = entry.kind === "file" ? name.lastIndexOf(".") : -1;
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let copy = 2; taken.has(nameKey(name)); copy++) {
    name = `${base} (${copy})${extension}`;
  }
  taken.add(nameKey(name));
  return name;
}

class UserFileStore {
  private nodes: FileNode[] = ["Documents", "Statements", "Receipts"].map(
    (name) => newFolder(null, name),
  );
  private listeners = new Set<() => void>();

  getSnapshot = (): readonly FileNode[] => this.nodes;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private commit(nodes: FileNode[]) {
    this.nodes = nodes;
    this.listeners.forEach((listener) => listener());
  }

  private destination(parentId: ParentId) {
    if (parentId === null) return;
    const folder = this.nodes.find((node) => node.id === parentId);
    if (folder?.kind !== "folder")
      throw new Error("Choose a folder in this record.");
    return folder;
  }

  private namesIn(parentId: ParentId) {
    const siblings = this.nodes.filter((node) => node.parentId === parentId);
    return new Set(siblings.map((node) => nameKey(node.name)));
  }

  createFolder(parentId: ParentId, value: string) {
    this.destination(parentId);
    const name = value.trim();
    if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
      throw new Error("Enter a folder name without a slash or backslash.");
    }
    if (this.namesIn(parentId).has(nameKey(name))) {
      throw new Error("An item with this name already exists here.");
    }
    this.commit([...this.nodes, newFolder(parentId, name)]);
  }

  importEntries(parentId: ParentId, entries: ImportEntry[]) {
    this.destination(parentId);
    if (!entries.length) return;
    const added: FileNode[] = [];

    function append(list: ImportEntry[], parent: ParentId, taken: Set<string>) {
      for (const entry of list) {
        const name = availableName(entry, taken);
        if (entry.kind === "folder") {
          const folder = newFolder(parent, name);
          added.push(folder);
          append(entry.children, folder.id, new Set());
        } else {
          const file = entry.file;
          added.push({
            id: String(++nextId),
            parentId: parent,
            kind: "file",
            name,
            size: file.size,
            modifiedAt: file.lastModified,
            file,
          });
        }
      }
    }

    append(entries, parentId, this.namesIn(parentId));
    this.commit([...this.nodes, ...added]);
  }

  move(id: string, parentId: ParentId) {
    let ancestor = this.destination(parentId);
    const item = this.nodes.find((node) => node.id === id);
    if (!item) throw new Error("Choose an item in this record.");
    if (item.parentId === parentId) return;
    while (ancestor) {
      if (ancestor.id === id) {
        throw new Error(
          "A folder cannot be moved into itself or its subfolders.",
        );
      }
      ancestor = this.destination(ancestor.parentId);
    }
    if (this.namesIn(parentId).has(nameKey(item.name))) {
      throw new Error(
        "An item with this name already exists in the destination.",
      );
    }
    this.commit(
      this.nodes.map((node) => (node.id === id ? { ...node, parentId } : node)),
    );
  }
}

// Scoped by signed-in account, organization and record. All data lives only in this tab.
const stores = new Map<string, UserFileStore>();

export function getUserFileStore(recordKey: string) {
  let store = stores.get(recordKey);
  if (!store) {
    store = new UserFileStore();
    stores.set(recordKey, store);
  }
  return store;
}

export function clearUserFileStores() {
  stores.clear();
}

export function entriesFromFiles(files: ArrayLike<File>): ImportEntry[] {
  const roots: ImportEntry[] = [];
  const childrenByPath = new Map<string, ImportEntry[]>();
  for (const file of Array.from(files)) {
    let siblings = roots;
    let path = "";
    const directories = (file.webkitRelativePath || "").split("/").slice(0, -1);
    for (const name of directories) {
      path += "/" + name;
      let children = childrenByPath.get(path);
      if (!children) {
        children = [];
        childrenByPath.set(path, children);
        siblings.push({ kind: "folder", name, children });
      }
      siblings = children;
    }
    siblings.push({ kind: "file", name: file.name, file });
  }
  return roots;
}

async function readEntry(entry: FileSystemEntry, budget: { count: number }, depth = 0): Promise<ImportEntry> {
  if (++budget.count > 200) throw new Error("Choose at most 100 files and 100 folders at a time.");
  if (depth > 12) throw new Error("Choose folders no more than 12 levels deep.");
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return { kind: "file", name: entry.name, file };
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: ImportEntry[] = [];
  // Chromium returns large directories in batches. An empty batch signals completion.
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    for (const child of batch) children.push(await readEntry(child, budget, depth + 1));
  }
  return { kind: "folder", name: entry.name, children };
}

export async function readDroppedEntries(
  transfer: DataTransfer,
): Promise<ImportEntry[]> {
  // Drag data becomes protected after the drop handler returns. Capture handles synchronously.
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) looseFiles.push(file);
    }
  }
  if (!entries.length && !looseFiles.length)
    return entriesFromFiles(transfer.files);
  const budget = { count: looseFiles.length };
  const dropped: ImportEntry[] = [];
  for (const entry of entries) dropped.push(await readEntry(entry, budget));
  return dropped.concat(entriesFromFiles(looseFiles));
}
