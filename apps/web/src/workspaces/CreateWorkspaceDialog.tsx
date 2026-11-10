import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { errorMessage, mutate } from "../api";
import { ErrorNotice } from "../components";
import { useNavigate } from "../router";
import { AuthContext } from "../state";
import { WorkspaceFields } from "./WorkspaceFields";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { validateWorkspaceFields, workspaceFields, type Workspace } from "./model";

export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { refresh } = useContext(AuthContext);
  const navigate = useNavigate();
  const [value, setValue] = useState(workspaceFields);
  const [created, setCreated] = useState<Workspace>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false);
  const mounted = useRef(true);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function openWorkspace(workspace: Workspace) {
    try {
      await refresh({ preserveSession: true });
      if (mounted.current) navigate(`/o/${workspace.id}`);
    } catch {
      if (mounted.current) setError("Your workspace was created, but the workspace list could not refresh. Refresh access below to open it.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      if (created) { await openWorkspace(created); return; }
      const fields = validateWorkspaceFields(value);
      const fingerprint = JSON.stringify(fields);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      const saved = await mutate<Workspace>("/organizations", { ...fields, idempotency_key: attempt.current.key });
      if (!mounted.current) return;
      setCreated(saved);
      await openWorkspace(saved);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <WorkspaceDialog title={created ? "Workspace created" : "Create a workspace"} locked={busy} onClose={onClose}
      description="Give this business its own workspace, accounts, documents, and team access.">
      <ErrorNotice message={error} />
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        {created ? <p className="notice" role="status"><strong>{created.name}</strong> was created successfully.</p> : <>
          <WorkspaceFields value={value} onChange={setValue} disabled={busy} />
          <p className="small muted">You will be an administrator. New workspaces use GBP for their ledger.</p>
        </>}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>{created ? "Close" : "Cancel"}</button>
          <button className="button primary" disabled={busy}>
            {!created && <Plus size={16} />}
            {busy ? (created ? "Opening workspace…" : "Creating…") : (created ? "Refresh access & open" : "Create workspace")}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
