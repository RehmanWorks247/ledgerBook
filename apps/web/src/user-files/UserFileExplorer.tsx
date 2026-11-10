import { usePrivateAsset } from "../private-assets";
import { FilePreviewModal } from "../file-preview/FilePreviewModal";
import { ErrorNotice } from "../components";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Download,
  File,
  FileText,
  FolderClosed,
  FolderInput,
  FolderPlus,
  HardDrive,
  History,
  Image,
  Info,
  LockKeyhole,
  LoaderCircle,
  Monitor,
  Pencil,
  RotateCcw,
  Sheet,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  entriesFromFiles,
  getUserFileStore,
  readDroppedEntries,
  type DocumentHistory,
  type FileNode,
  type FileStore,
  type UploadItem,
  type UploadResult,
} from "./model";
import { BookingFileStore } from "./remote";

type ExplorerProps = {
  viewerId: string;
  organizationId: string;
  userId: string;
  canManage: boolean;
  bookingId?: string;
  onFilesChanged?: () => void;
};
type DialogState =
  | { kind: "create" }
  | { kind: "move" | "details" | "preview" | "rename" | "delete" | "versions"; node: FileNode };
type Toast = { message: string; tone: "success" | "error" | "info"; id: number };
const root = "root";
const dragType = "application/x-ledgerbook-record-item";
const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const emptyUploads: readonly UploadItem[] = [];
const noUploads = () => emptyUploads;
const noUploadSubscription = () => () => {};

export function UploadNotification({ message, tone, dismiss }: { message: string; tone: Toast["tone"]; dismiss: () => void }) {
  return <div className="ufe-toast" data-tone={tone} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true"><span>{tone === "success" ? <Check size={16} /> : <AlertCircle size={16} />}</span><div>{message}</div><button type="button" aria-label="Dismiss notification" onClick={dismiss}><X size={14} /></button></div>;
}

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  const level = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length,
  );
  return `${Number((bytes / 1024 ** level).toFixed(1))} ${units[level - 1]}`;
}

function ancestors(byId: Map<string, FileNode>, id: string | null) {
  const result: FileNode[] = [];
  let current = id ? byId.get(id) : undefined;
  while (current) {
    result.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result.reverse();
}

function folderPath(chain: FileNode[]) {
  return ["All files", ...chain.map((folder) => folder.name)].join(" / ");
}

function moveDestinations(byId: Map<string, FileNode>, item: FileNode) {
  const choices = [];
  if (item.parentId !== null) choices.push({ id: root, path: "All files" });
  for (const folder of byId.values()) {
    if (folder.kind !== "folder" || folder.id === item.parentId) continue;
    const chain = ancestors(byId, folder.id);
    if (!chain.some((ancestor) => ancestor.id === item.id)) {
      choices.push({ id: folder.id, path: folderPath(chain) });
    }
  }
  return choices.sort((a, b) => names.compare(a.path, b.path));
}

function FolderArt() {
  const fillId = useId();
  return (
    <svg className="ufe-folder-art" viewBox="0 0 64 52" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={fillId} x1="32" y1="21" x2="32" y2="46" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--folder-front-light)" />
          <stop offset="1" stopColor="var(--folder-front-dark)" />
        </linearGradient>
      </defs>
      <path
        d="M8 12a5 5 0 0 1 5-5h12a5 5 0 0 1 3.5 1.5L32 12h19a5 5 0 0 1 5 5v25H8Z"
        fill="var(--folder-back)"
      />
      <g className="ufe-folder-paper">
        <rect x="13" y="16" width="37" height="24" rx="3" transform="rotate(-5 13 16)" fill="var(--folder-paper-back)" />
        <rect x="13" y="17" width="39" height="25" rx="3" fill="var(--folder-paper)" />
        <path d="M19 21h17" stroke="var(--folder-paper-line)" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <path
        d="M7.5 26a4 4 0 0 1 4-4.5h41a4 4 0 0 1 4 4.5l-2.2 15a5 5 0 0 1-5 4.3H14.7a5 5 0 0 1-5-4.3Z"
        fill={`url(#${fillId})`}
      />
      <path d="M12 23h40" stroke="var(--folder-highlight)" strokeLinecap="round" />
      <path d="M15 43h34" stroke="var(--folder-back)" strokeLinecap="round" opacity=".3" />
    </svg>
  );
}

function FileArt({ node }: { node: FileNode }) {
  const type = node.mimeType || node.file?.type || "";
  let Icon = File;
  if (type.startsWith("image/")) Icon = Image;
  else if (/spreadsheet|excel|csv/.test(type)) Icon = Sheet;
  else if (/text|document|pdf/.test(type)) Icon = FileText;
  return (
    <span className="ufe-file-art" data-tone={Icon === Image ? "violet" : Icon === Sheet ? "success" : /pdf/.test(type) ? "danger" : "info"} aria-hidden="true">
      <Icon />
    </span>
  );
}

function ExplorerDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="entry-dialog ufe-dialog"
      aria-labelledby={titleId}
      onCancel={close}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function FileDetails({
  node,
  path,
  close,
  preview,
}: {
  node: FileNode;
  path: string;
  close: () => void;
  preview: () => void;
}) {
  const { url, error } = usePrivateAsset(node.url, node.file);
  return (
    <ExplorerDialog title="File details" close={close}>
      <div className="ufe-detail-name">
        <FileArt node={node} />
        <strong>{node.name}</strong>
      </div>
      <ErrorNotice message={error} />
      {!url && !error && (node.url || node.file) && <p role="status">Loading attachment…</p>}
      <dl className="ufe-detail-list">
        <dt>Location</dt>
        <dd>{path}</dd>
        <dt>File type</dt>
        <dd>{node.mimeType || node.file?.type || "File"}</dd>
        <dt>Size</dt>
        <dd>{sizeLabel(node.size)}</dd>
        <dt>Modified</dt>
        <dd>{dates.format(node.modifiedAt)}</dd>
      </dl>
      <div className="form-actions">
        <button className="button secondary" onClick={close}>
          Close
        </button>
        <button type="button" className="button secondary" onClick={preview} aria-haspopup="dialog">
          Preview file
        </button>
        {url && (
          <a className="button" href={url} download={node.name}>
            <Download size={16} />
            Download copy
          </a>
        )}
      </div>
    </ExplorerDialog>
  );
}

export function canEditText(node: FileNode) {
  return node.kind === "file" && node.size <= 256 * 1024 && /\.(txt|csv|json|md|markdown)$/i.test(node.name);
}

export function validateTextEdit(name: string, text: string) {
  const size = new TextEncoder().encode(text).length;
  if (!size || size > 256 * 1024) throw new Error("Enter non-empty UTF-8 text up to 256 KB.");
  if (Array.from(text).some(char => { const code=char.charCodeAt(0); return code===127 || code<32 && ![9,10,13].includes(code); })) throw new Error("Remove binary control characters before saving.");
  if (/\.json$/i.test(name)) {
    try { JSON.parse(text); } catch { throw new Error("Enter valid JSON before saving."); }
  }
}

export function FileVersionDialog({node,store,canManage,close,saved}:{node:FileNode;store:FileStore;canManage:boolean;close:()=>void;saved:(message:string)=>void}) {
  const [history,setHistory] = useState<DocumentHistory>();
  const [error,setError] = useState("");
  const [status,setStatus] = useState("Loading versions…");
  const [working,setWorking] = useState(false);
  const [editing,setEditing] = useState(false);
  const [text,setText] = useState("");
  const [original,setOriginal] = useState("");
  const [editVersion,setEditVersion] = useState(node.version);
  const [replacement,setReplacement] = useState<File>();
  const [confirmRestore,setConfirmRestore] = useState<number>();
  const dirty = editing && text !== original || Boolean(replacement);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    void store.history?.(node.id).then(value => {if(active) {setHistory(value);setStatus("");}}).catch(reason => {if(active) {setError(reason instanceof Error?reason.message:"Versions could not be loaded.");setStatus("");}});
    return () => {active=false;};
  },[store,node.id]);
  useEffect(() => {
    if (!dirty && !working) return;
    const warn = (event:BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload",warn);
    return () => window.removeEventListener("beforeunload",warn);
  },[dirty,working]);
  function dismiss() {
    if (working) return;
    if (dirty && !window.confirm("Discard the unsaved changes to this file?")) return;
    close();
  }
  async function run(action:()=>Promise<void>) {
    if (pending.current) return;
    pending.current=true;setWorking(true);setError("");
    try {await action();} catch(reason) {setError(reason instanceof Error?reason.message:"The file could not be saved.");setStatus("");}
    finally {pending.current=false;setWorking(false);}
  }
  return <ExplorerDialog title={canManage?"Edit file & version history":"File version history"} close={dismiss}>
    <p className="ufe-dialog-context"><FileText size={16}/>{node.name}</p>
    <ErrorNotice message={error}/>
    {status && <p role="status">{status}</p>}
    {canManage && history && <div className="stack-form">
      <p>Saved changes create a new version. The customer sees the latest file; earlier versions remain available below.</p>
      {canEditText(node) && store.readText && !editing && <button type="button" className="button secondary" disabled={working} onClick={() => void run(async()=>{
        setStatus("Opening text…");const result=await store.readText!(node.id);setText(result.text);setOriginal(result.text);setEditVersion(result.version);setEditing(true);setReplacement(undefined);setStatus("");
      })}>Edit text</button>}
      {editing && <label>File content<textarea className="ufe-text-editor" aria-label="File content" spellCheck={false} value={text} disabled={working} onChange={event=>setText(event.target.value)}/><small>UTF-8 · TXT, CSV, JSON and Markdown · Up to 256 KB</small></label>}
      {!editing && <label>Replace file<input aria-label="Replacement file" type="file" disabled={working} onChange={event=>{setReplacement(event.target.files?.[0]);setError("");}}/><small>Choose a file with the same extension, up to 10 MB. The current name stays the same.</small></label>}
      <div className="form-actions"><button type="button" className="button" disabled={working || !dirty} onClick={()=>void run(async()=>{
        let file=replacement;
        if(editing) {validateTextEdit(node.name,text);file=new globalThis.File([text],node.name,{type:node.mimeType});}
        if(!file) return;
        await store.replace!({...node,version:editing?editVersion:history.version},file,setStatus);
        saved("New file version saved successfully.");close();
      })}>{working?"Saving…":editing?"Save text":"Save replacement"}</button></div>
    </div>}
    <h3>Version history</h3>
    {history && <ol className="ufe-version-list">{history.items.map(version=><li key={version.version}>
      <div><strong>Version {version.version}{version.current?" · Current":""}</strong><small>{dates.format(new Date(version.createdAt))} · {sizeLabel(version.size)}</small></div>
      <button type="button" className="button secondary" disabled={working} aria-label={`Download version ${version.version}`} onClick={()=>void run(async()=>{await store.downloadVersion!(node.id,version.version,version.name);})}><Download size={14}/>Download</button>
      {canManage && !version.current && <button type="button" className="button secondary" disabled={working || dirty} aria-label={`Restore version ${version.version}`} onClick={()=>setConfirmRestore(version.version)}>Restore</button>}
    </li>)}</ol>}
    {confirmRestore && <div className="ufe-restore-confirm"><p>Restore version {confirmRestore} as the latest file? The current content will remain in version history.</p><div className="form-actions"><button type="button" className="button secondary" disabled={working} onClick={()=>setConfirmRestore(undefined)}>Keep current version</button><button type="button" className="button" disabled={working} onClick={()=>void run(async()=>{setStatus("Restoring…");await store.restore!(node.id,confirmRestore,history!.version);saved("Earlier file version restored successfully.");close();})}>Confirm restore</button></div></div>}
    <div className="form-actions"><button type="button" className="button secondary" disabled={working} onClick={dismiss}>Close</button></div>
  </ExplorerDialog>;
}

export function UserFileExplorer({
  viewerId,
  organizationId,
  userId,
  canManage,
  bookingId,
  onFilesChanged,
}: ExplorerProps) {
  const recordKey = JSON.stringify(bookingId ? [viewerId, organizationId, userId, bookingId] : [viewerId, organizationId, userId]);
  const store = useMemo<FileStore>(() => bookingId
    ? new BookingFileStore({ organizationId, customerId: userId, bookingId })
    : getUserFileStore(recordKey), [recordKey, organizationId, userId, bookingId]);
  useEffect(() => {
    if (!onFilesChanged) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(onFilesChanged, 200);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [store, onFilesChanged]);
  return (
    <FileExplorer
      key={`${recordKey}/${canManage}`}
      store={store}
      canManage={canManage}
    />
  );
}

export function FileExplorer({
  store,
  canManage,
}: {
  store: FileStore;
  canManage: boolean;
}) {
  const nodes = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const uploads = useSyncExternalStore(store.subscribeUploads ?? noUploadSubscription, store.getUploads ?? noUploads, noUploads);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [field, setField] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState({ message: "", error: false });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const dragging = useRef<string | null>(null);
  const mounted = useRef(true);
  const statusVersion = useRef(0);
  const mutationPending = useRef(false);
  const titleId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      store.cancelUploads?.();
    };
  }, [store]);
  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!uploads.some((item) => ["queued", "preparing", "uploading", "saving"].includes(item.status))) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [uploads]);
  useEffect(() => {
    if (!store.load) return;
    let active = true;
    setBusy(true);
    setNotice({ message: "Loading files…", error: false });
    const refresh = () => {
      if (mutationPending.current) return;
      const version = ++statusVersion.current;
      void store.load!().then(() => {
        if (active && version === statusVersion.current) setNotice({ message: "", error: false });
      }).catch((error: unknown) => {
        if (active && version === statusVersion.current) setNotice({ message: error instanceof Error ? error.message : "Files could not be loaded.", error: true });
      }).finally(() => { if (active && version === statusVersion.current) setBusy(false); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [store]);
  const byId = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const counts = useMemo(() => {
    const totals = new Map<string | null, number>();
    for (const node of nodes)
      totals.set(node.parentId, (totals.get(node.parentId) || 0) + 1);
    return totals;
  }, [nodes]);
  const path = ancestors(byId, folderId);
  const children = nodes
    .filter((node) => node.parentId === folderId)
    .sort((a, b) => names.compare(a.name, b.name));
  const folders = children.filter((node) => node.kind === "folder");
  const files = children.filter((node) => node.kind === "file");
  const location = (id: string | null) =>
    id ? byId.get(id)?.name || "this folder" : "All files";
  const uploaded = uploads.filter((item) => item.status === "complete").length;
  const retryable = uploads.filter((item) => ["failed", "cancelled"].includes(item.status)).length;
  const uploading = uploads.some((item) => ["queued", "preparing", "uploading", "saving"].includes(item.status));
  const uploadDestination = !store.load || path.some((folder) => folder.serviceKey);

  function notify(message: string, tone: Toast["tone"] = "success") {
    setToast({ message, tone, id: Date.now() });
  }

  function reportUpload(result: void | UploadResult, target?: string | null) {
    if (!mounted.current) return;
    if (!result) {
      setNotice({ message: `Added to ${location(target ?? null)}.`, error: false });
      notify(`Added to ${location(target ?? null)}.`);
      return;
    }
    const incomplete = result.failed + result.cancelled;
    if (incomplete) {
      const failure = store.getUploads?.().find((item) => item.status === "failed");
      const saved = result.succeeded ? `${result.succeeded} ${result.succeeded === 1 ? "file" : "files"} saved. ` : "";
      notify(`${saved}${result.failed ? `${result.failed} ${result.failed === 1 ? "file could" : "files could"} not be uploaded. ${failure ? `${failure.name}: ${failure.error}` : "Retry below."}` : "Uploads stopped. Retry below to finish saving your files."}`, result.failed ? "error" : "info");
    } else {
      notify(result.succeeded ? `${result.succeeded === 1 ? "File" : `${result.succeeded} files`} uploaded successfully.` : "Folders added successfully.");
    }
    setNotice({
      message: incomplete ? `${incomplete} ${incomplete === 1 ? "file needs" : "files need"} attention. Retry below.`
        : result.succeeded ? target === undefined ? "Files saved." : `Saved to ${location(target)}.` : "Folders added.",
      error: incomplete > 0,
    });
  }

  function openFolder(id: string | null) {
    setFolderId(id);
    setNotice({ message: "", error: false });
    setDropTarget(null);
  }
  function openDialog(next: DialogState) {
    setDialog(next);
    setField(next.kind === "rename" ? next.node.name : "");
    setFormError("");
  }
  function reportError(error: unknown) {
    const message = error instanceof Error ? error.message : "The change could not be made. Please retry.";
    setNotice({
      message,
      error: true,
    });
    notify(message, "error");
  }
  async function addFromPicker(event: ChangeEvent<HTMLInputElement>) {
    if (!canManage || busy || mutationPending.current || !event.target.files?.length) return;
    const entries = entriesFromFiles(event.target.files);
    event.target.value = "";
    setBusy(true);
    mutationPending.current = true;
    ++statusVersion.current;
    setNotice({ message: "Adding files…", error: false });
    try {
      reportUpload(await store.importEntries(folderId, entries), folderId);
    } catch (error) {
      if (mounted.current) reportError(error);
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function drop(event: DragEvent, target: string | null) {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (!canManage || dialog || busy || mutationPending.current) return;
    setBusy(true);
    mutationPending.current = true;
    ++statusVersion.current;
    try {
      if (event.dataTransfer.types.includes(dragType)) {
        const id = event.dataTransfer.getData(dragType);
        if (id !== dragging.current) return;
        await store.move(id, target);
        setNotice({ message: `Moved to ${location(target)}.`, error: false });
      } else if (event.dataTransfer.types.includes("Files")) {
        setNotice({ message: "Reading dropped items…", error: false });
        const entries = await readDroppedEntries(event.dataTransfer);
        if (!mounted.current) return;
        if (!entries.length)
          throw new Error(
            "No files were found. Try choosing files from your device.",
          );
        reportUpload(await store.importEntries(target, entries), target);
      }
    } catch (error) {
      if (mounted.current) reportError(error);
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function retry() {
    if (!canManage || busy || mutationPending.current || !store.retryUploads) return;
    setBusy(true);
    mutationPending.current = true;
    ++statusVersion.current;
    setNotice({ message: "Retrying files…", error: false });
    try { reportUpload(await store.retryUploads()); }
    catch (error) { if (mounted.current) reportError(error); }
    finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function dropProps(target: string | null) {
    return {
      onDragOver(event: DragEvent) {
        const internal = event.dataTransfer.types.includes(dragType);
        if (!internal && !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!canManage || dialog || busy || (internal && !dragging.current)) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        event.dataTransfer.dropEffect = internal ? "move" : "copy";
        setDropTarget(target ?? root);
      },
      onDrop(event: DragEvent) {
        void drop(event, target);
      },
    };
  }
  function dragProps(node: FileNode) {
    return {
      draggable: canManage && !busy && !node.defaultFolder,
      onDragStart(event: DragEvent) {
        if (!canManage || busy || node.defaultFolder) return event.preventDefault();
        dragging.current = node.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(dragType, node.id);
      },
      onDragEnd() {
        dragging.current = null;
        setDropTarget(null);
      },
    };
  }
  function managementButtons(node: FileNode) {
    return (
      !node.defaultFolder && (
        <div className="ufe-item-actions">
        {node.kind === "file" && <button type="button" className="ufe-move" aria-label={`Details for ${node.name}`} title="File details" aria-haspopup="dialog" onClick={() => openDialog({ kind: "details", node })}><Info size={15} /></button>}
        {node.kind === "file" && store.history && <button type="button" className="ufe-move" disabled={busy} aria-label={`${canManage ? "Edit file and versions" : "Version history"} ${node.name}`} title={canManage ? "Edit file and version history" : "Version history"} onClick={() => openDialog({kind:"versions",node})}><History size={15}/></button>}
        {canManage && <>
        <button
          type="button"
          className="ufe-move"
          disabled={busy}
          aria-label={`Move ${node.name}`}
          title={`Move ${node.name}`}
          onClick={() => openDialog({ kind: "move", node })}
        >
          <FolderInput size={16} />
        </button>
        {store.rename && <button type="button" className="ufe-move" disabled={busy} aria-label={`Rename ${node.name}`} title={`Rename ${node.name}`} onClick={() => openDialog({ kind: "rename", node })}><Pencil size={15} /></button>}
        {store.remove && <button type="button" className="ufe-move" disabled={busy || (node.kind === "folder" && Boolean(counts.get(node.id)))} aria-label={`Delete ${node.name}`} title={node.kind === "folder" && counts.get(node.id) ? "Move or delete this folder’s contents first" : `Delete ${node.name}`} onClick={() => openDialog({ kind: "delete", node })}><Trash2 size={15} /></button>}
        </>}
        </div>
      )
    );
  }
  const destinations =
    dialog?.kind === "move" ? moveDestinations(byId, dialog.node) : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canManage || busy || mutationPending.current || !dialog || dialog.kind === "details" || dialog.kind === "preview" || dialog.kind === "versions") return;
    setBusy(true);
    mutationPending.current = true;
    ++statusVersion.current;
    try {
      if (dialog.kind === "create") {
        await store.createFolder(folderId, field);
        setNotice({ message: `Created ${field.trim()}.`, error: false });
        notify(`Created ${field.trim()}.`);
      } else if (dialog.kind === "rename") {
        const originalExtension = dialog.node.kind === "file" ? /\.[^.]+$/.exec(dialog.node.name)?.[0] ?? "" : "";
        const nextExtension = /\.[^.]+$/.exec(field.trim())?.[0] ?? "";
        if (dialog.node.kind === "file" && nextExtension.toLowerCase() !== originalExtension.toLowerCase())
          throw new Error(originalExtension ? `Keep the original ${originalExtension} extension when renaming this file.` : "Keep this file without an extension when renaming it.");
        await store.rename?.(dialog.node.id, field.trim());
        notify(`Renamed to ${field.trim()}.`);
      } else if (dialog.kind === "delete") {
        await store.remove?.(dialog.node.id);
        notify(`Deleted ${dialog.node.name}.`);
      } else {
        if (!field) return;
        const target = field === root ? null : field;
        await store.move(dialog.node.id, target);
        setNotice({ message: `Moved to ${location(target)}.`, error: false });
        notify(`Moved to ${location(target)}.`);
      }
      setDialog(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The change could not be made.";
      setFormError(message);
      notify(message, "error");
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby={titleId}
      className="panel ufe"
      {...dropProps(folderId)}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDropTarget(null);
      }}
    >
      <header className="ufe-header">
        <div>
          <span className="eyebrow">User files</span>
          <h2 id={titleId}>File explorer</h2>
        </div>
        {canManage ? (
          <div className="ufe-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => openDialog({ kind: "create" })}
            >
              <FolderPlus size={16} />
              New folder
            </button>
            <button
              className="button"
              disabled={busy || !uploadDestination}
              onClick={() => fileInput.current?.click()}
              title={uploadDestination ? "Add files" : "Open a service folder or drop files onto one below"}
            >
              <Upload size={16} />
              Add files
            </button>
            <input
              hidden
              type="file"
              multiple
              ref={fileInput}
              aria-label="Choose files"
              onChange={addFromPicker}
            />
            <input
              hidden
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              ref={folderInput}
              aria-label="Choose a folder"
              onChange={addFromPicker}
            />
          </div>
        ) : (
          <span className="ufe-readonly">
            <LockKeyhole size={13} />
            View only
          </span>
        )}
      </header>
      <div className="ufe-bar">
        <nav className="ufe-path" aria-label="File location">
          <HardDrive size={16} />
          {[{ id: null, name: "All files" }, ...path].map((folder, i) => (
            <Fragment key={folder.id ?? root}>
              {i > 0 && <ChevronRight size={13} />}
              <button
                type="button"
                {...dropProps(folder.id)}
                onClick={() => openFolder(folder.id)}
                aria-current={folder.id === folderId ? "location" : undefined}
                className={
                  dropTarget === (folder.id ?? root) ? "ufe-target" : undefined
                }
              >
                {folder.name}
              </button>
            </Fragment>
          ))}
        </nav>
        <span className="ufe-total">
          {children.length} {children.length === 1 ? "item" : "items"}
        </span>
      </div>
      <div className="ufe-body" aria-busy={busy}>
        {folders.length > 0 && (
          <>
            <h3 className="ufe-label">
              Folders <span>{folders.length}</span>
            </h3>
            <ul className="ufe-folders">
              {folders.map((node) => {
                const count = counts.get(node.id) || 0;
                return (
                  <li
                    key={node.id}
                    className={
                      dropTarget === node.id ? "ufe-target" : undefined
                    }
                    {...dragProps(node)}
                    {...dropProps(node.id)}
                  >
                    <button
                      className="ufe-folder"
                      title={node.name}
                      onClick={() => openFolder(node.id)}
                      aria-label={`Open ${node.name} folder`}
                    >
                      <FolderArt />
                      <span>
                        <strong>{node.name}</strong>
                        <small>
                          {count} {count === 1 ? "item" : "items"}
                        </small>
                      </span>
                    </button>
                    {managementButtons(node)}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {files.length > 0 && (
          <>
            <h3 className="ufe-label">
              Files <span>{files.length}</span>
            </h3>
            <ul className="ufe-files">
              {files.map((node) => (
                <li key={node.id} {...dragProps(node)}>
                  <button
                    className="ufe-file"
                    title={`Preview ${node.name}`}
                    aria-haspopup="dialog"
                    onClick={() => openDialog({ kind: "preview", node })}
                  >
                    <FileArt node={node} />
                    <span>{node.name}</span>
                  </button>
                  <small>{sizeLabel(node.size)}</small>
                  <small className="ufe-date">
                    {dates.format(node.modifiedAt)}
                  </small>
                  {managementButtons(node)}
                </li>
              ))}
            </ul>
          </>
        )}
        {canManage ? (
          <div
            className={`ufe-drop${dropTarget === (folderId ?? root) ? " ufe-target" : ""}`}
          >
            <span className="ufe-drop-icon">
              <Upload size={20} />
            </span>
            <div>
              <strong>{uploadDestination ? "Drop files or folders here" : "Drop files onto a service folder above"}</strong>
              <p>
                <button disabled={busy || !uploadDestination} onClick={() => fileInput.current?.click()}>
                  Choose files
                </button>{" "}
                or{" "}
                <button disabled={busy || !uploadDestination} onClick={() => folderInput.current?.click()}>
                  choose a folder
                </button>{" "}
                from your device.
              </p>
              {store.load && <p>All file types · Up to 10 MB each · 100 MB per selection</p>}
            </div>
          </div>
        ) : (
          !children.length && !busy && !notice.error && (
            <div className="ufe-empty">
              <FolderArt />
              <strong>This folder is empty</strong>
              <p>Files added by an administrator appear here.</p>
            </div>
          )
        )}
      </div>
      {canManage && uploads.length > 0 && (
        <div className="ufe-uploads" aria-label="File uploads">
          <div className="ufe-upload-heading">
            <span role="status">{uploading ? "Uploading" : "Uploads"} <span>{uploaded} of {uploads.length} saved</span></span>
            <div>
              {uploading && <button type="button" className="ufe-upload-action" onClick={() => store.cancelUploads?.()}>Stop uploads</button>}
              {!busy && retryable > 0 && <button type="button" className="ufe-upload-action" onClick={() => void retry()}><RotateCcw size={13} />Retry {retryable === 1 ? "file" : `${retryable} files`}</button>}
              {!busy && <button type="button" className="ufe-move" aria-label="Dismiss upload list" onClick={() => store.clearUploads?.()}><X size={15} /></button>}
            </div>
          </div>
          <ul className="ufe-upload-list">
            {uploads.map((item) => {
              const active = ["preparing", "uploading", "saving"].includes(item.status);
              const percent = Math.min(100, Math.round(item.loaded / Math.max(1, item.total) * 100));
              return (
                <li key={item.id} data-state={item.status}>
                  <span className="ufe-upload-icon">{item.status === "complete" ? <Check size={16} /> : active ? <LoaderCircle size={16} className="ufe-spinning" /> : item.error ? <AlertCircle size={16} /> : <FileText size={16} />}</span>
                  <div className="ufe-upload-file">
                    <div><strong title={item.name}>{item.name}</strong><small>{item.status === "complete" ? "Saved" : item.status === "saving" ? "Verifying & saving…" : item.status === "preparing" ? "Preparing…" : item.status === "uploading" ? `${percent}%` : item.status === "cancelled" ? "Stopped" : item.status === "failed" ? "Failed" : "Queued"}</small></div>
                    {active && <progress max={100} value={item.status === "preparing" ? undefined : percent} aria-label={`${item.status === "preparing" ? "Preparing" : item.status === "saving" ? "Saving" : "Uploading"} ${item.name}`} />}
                    {item.error && <p>{item.error}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <footer className="ufe-footer">
        <span>
          <Monitor size={14} />
          {store.load ? "Booking documents · Saved securely." : "Local preview · Changes clear on refresh."}
        </span>
        <span
          role="status"
          className={notice.error ? "ufe-error" : "ufe-status"}
        >
          {notice.message && (
            <>
              {notice.error ? <AlertCircle size={14} /> : <Check size={14} />}
              {notice.message}
            </>
          )}
        </span>
      </footer>
      {toast && <UploadNotification key={toast.id} message={toast.message} tone={toast.tone} dismiss={() => setToast(null)} />}
      {dialog?.kind === "details" && (
        <FileDetails
          node={dialog.node}
          path={folderPath(path)}
          close={() => setDialog(null)}
          preview={() => openDialog({ kind: "preview", node: dialog.node })}
        />
      )}
      {dialog?.kind === "preview" && (
        <FilePreviewModal
          file={{ name: dialog.node.name, mimeType: dialog.node.mimeType || dialog.node.file?.type, size: dialog.node.size, url: dialog.node.url, blob: dialog.node.file }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "versions" && <FileVersionDialog node={dialog.node} store={store} canManage={canManage} close={() => setDialog(null)} saved={message => notify(message)} />}
      {dialog && dialog.kind !== "details" && dialog.kind !== "preview" && dialog.kind !== "versions" && canManage && (
        <ExplorerDialog
          title={dialog.kind === "create" ? "New folder" : dialog.kind === "rename" ? "Rename item" : dialog.kind === "delete" ? "Delete item" : "Move item"}
          close={() => setDialog(null)}
        >
          <form className="stack-form" onSubmit={submit}>
            <p className="ufe-dialog-context">
              <FolderClosed size={16} />
              {dialog.kind === "create" ? folderPath(path) : dialog.node.name}
            </p>
            {dialog.kind === "delete" ? <p>This permanently deletes this {dialog.node.kind} from the booking. {dialog.node.kind === "file" && "The customer will no longer be able to open it."}</p> : dialog.kind === "create" || dialog.kind === "rename" ? (
              <label>
                {dialog.kind === "create" ? "Folder name" : "Name"}
                <input
                  required
                  maxLength={240}
                  autoFocus
                  autoComplete="off"
                  placeholder="e.g. Signed agreements"
                  value={field}
                  onChange={(event) => {
                    setField(event.target.value);
                    setFormError("");
                  }}
                />
              </label>
            ) : (
              <label>
                Destination folder
                <select
                  required
                  autoFocus
                  value={field}
                  onChange={(event) => {
                    setField(event.target.value);
                    setFormError("");
                  }}
                >
                  <option value="" disabled>
                    Choose a folder
                  </option>
                  {destinations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.path}
                    </option>
                  ))}
                </select>
                {!destinations.length && (
                  <small>Create another folder to move this item.</small>
                )}
              </label>
            )}
            {formError && (
              <p role="alert" className="ufe-error">
                {formError}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className={`button${dialog.kind === "delete" ? " danger" : ""}`} disabled={busy || (dialog.kind !== "delete" && !field.trim())}>
                {busy ? "Saving…" : dialog.kind === "create" ? "Create folder" : dialog.kind === "rename" ? "Save name" : dialog.kind === "delete" ? "Delete permanently" : "Move item"}
              </button>
            </div>
          </form>
        </ExplorerDialog>
      )}
    </section>
  );
}
