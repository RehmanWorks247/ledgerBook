import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Save, Trash2 } from "lucide-react";
import { api, ApiError, errorMessage, mutate, useResource } from "../api";
import { ErrorNotice, FormSkeleton } from "../components";
import { Link } from "../router";
import { AuthContext, useOrganization } from "../state";
import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { WorkspaceFields } from "./WorkspaceFields";
import { validateWorkspaceFields, workspaceFields, type Workspace } from "./model";
import "./workspaces.css";

function WorkspaceEditor({ initial }: { initial: Workspace }) {
  const { refresh } = useContext(AuthContext);
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(() => workspaceFields(initial));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [conflict, setConflict] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false), [showDelete, setShowDelete] = useState(false);
  const submitting = useRef(false), mounted = useRef(true);
  const path = `/organizations/${encodeURIComponent(initial.id)}`;
  const dirty = JSON.stringify(value) !== JSON.stringify(workspaceFields(saved));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function refreshNavigation() {
    try {
      await refresh({ preserveSession: true });
      if (mounted.current) setRefreshFailed(false);
    } catch {
      if (mounted.current) setRefreshFailed(true);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(""); setNotice(""); setConflict(false);
    try {
      const fields = validateWorkspaceFields(value);
      const updated = await mutate<Workspace>(path, { ...fields, expected_version: saved.version }, "PATCH");
      if (!mounted.current) return;
      setSaved(updated); setValue(workspaceFields(updated)); setNotice("Workspace details saved.");
      await refreshNavigation();
    } catch (cause) {
      if (mounted.current) {
        setError(errorMessage(cause));
        setConflict(cause instanceof ApiError && cause.status === 409);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function reload() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const updated = await api<Workspace>(path);
      if (!mounted.current) return;
      setSaved(updated); setValue(workspaceFields(updated)); setConflict(false); setNotice("Latest workspace details loaded.");
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <>
    <form className="stack-form workspace-settings-form" onSubmit={save} aria-busy={busy}>
      <ErrorNotice message={error} />
      {conflict && <div className="notice">This workspace changed in another session. Reload the saved details before making further changes. Unsaved edits will be replaced.
        <button type="button" className="button secondary small" disabled={busy} onClick={() => void reload()}>Reload saved details</button>
      </div>}
      <WorkspaceFields value={value} onChange={setValue} disabled={busy} />
      <div className="workspace-settings-actions">
        <button className="button primary" disabled={busy || !dirty || conflict}><Save size={16} />{busy ? "Saving…" : "Save workspace"}</button>
        {notice && <p role="status" className="workspace-save-status">{notice}</p>}
      </div>
      {refreshFailed && <div className="notice" role="status">Workspace details are saved. Navigation could not refresh.
        <button type="button" className="button secondary small" disabled={busy} onClick={() => void refreshNavigation()}>Refresh navigation</button>
      </div>}
    </form>
    <div className="workspace-danger-zone">
      <div><h3>Delete this workspace</h3><p>Permanently delete this workspace and its customers, bookings, payments, documents, and accounting history. This cannot be undone.</p></div>
      <button type="button" className="button danger-button" disabled={busy || conflict} onClick={event => { event.currentTarget.focus(); setShowDelete(true); }}><Trash2 size={16} />Delete workspace</button>
    </div>
    {showDelete && <DeleteWorkspaceDialog workspace={saved} onClose={() => setShowDelete(false)} onReload={() => { setShowDelete(false); void reload(); }} />}
  </>;
}

function AdminWorkspaceSettings() {
  const member = useOrganization();
  const workspace = useResource<Workspace>(`/organizations/${encodeURIComponent(member.organization_id)}`);
  return (
    <section className="panel workspace-settings" aria-labelledby="workspace-settings-title">
      <header className="workspace-settings-header"><div><h2 id="workspace-settings-title">Workspace details</h2>
        <p>Customize the name, description, and color shown to everyone in this workspace.</p></div>
        <Link className="button secondary small" to="/workspaces">All workspaces</Link>
      </header>
      <ErrorNotice message={workspace.error} />
      {workspace.error && !workspace.data && <button className="button secondary" onClick={workspace.refresh}>Retry loading workspace</button>}
      {workspace.loading && !workspace.data ? <FormSkeleton /> : workspace.data && <WorkspaceEditor key={workspace.data.id} initial={workspace.data} />}
    </section>
  );
}

export function WorkspaceSettings() {
  const member = useOrganization();
  if (member.role !== "admin") return null;
  return <AdminWorkspaceSettings key={member.organization_id} />;
}
