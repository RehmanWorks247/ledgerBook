import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { ApiError, errorMessage } from "../api";
import { ErrorNotice } from "../components";
import { useNavigate } from "../router";
import { AuthContext } from "../state";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { deleteWorkspace, type Workspace } from "./model";

export function DeleteWorkspaceDialog({ workspace, onClose, onReload }: { workspace: Workspace; onClose: () => void; onReload: () => void }) {
  const { refresh } = useContext(AuthContext);
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [filesPending, setFilesPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      if (!deleted) {
        const result = await deleteWorkspace(workspace, confirmation);
        if (!mounted.current) return;
        setDeleted(true);
        setFilesPending((result.files_pending ?? 0) > 0);
      }
      try {
        await refresh({ preserveSession: true });
        if (mounted.current) navigate("/workspaces?deleted=1", { replace: true });
      } catch {
        if (mounted.current) setError("The workspace was permanently deleted. Your workspace list could not refresh; retry below to continue.");
      }
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
  return (
    <WorkspaceDialog title={deleted ? "Workspace deleted" : "Permanently delete workspace?"}
      description={deleted ? `${workspace.name} has been permanently deleted.` : `This will permanently delete ${workspace.name} and all of its business data.`}
      locked={busy || deleted} onClose={onClose}>
      <ErrorNotice message={error} />
      {conflict && <p className="notice">This workspace changed in another session. Reload the saved details before deleting. Unsaved edits will be replaced.
        <button type="button" className="button secondary small" disabled={busy} onClick={onReload}>Reload saved details</button>
      </p>}
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        {deleted ? <p className="notice" role="status">Workspace deletion is complete. This workspace can no longer be accessed.{filesPending && " Stored files will be removed automatically after upload links expire."}</p> : <>
          <div className="deletion-scope">
            <ul>
              <li>Customer accounts, bookings, payments, and ledger history will be permanently removed.</li>
              <li>Documents and uploaded files become inaccessible immediately. Stored files are permanently removed automatically after upload links expire.</li>
              <li>Team access, invitations, and reminders for this workspace will be removed.</li>
            </ul>
            <p>Your other workspaces and sign-in account are unaffected.</p>
            <p className="danger-text"><strong>This cannot be undone.</strong></p>
          </div>
          <label>Type {workspace.name} to confirm permanent deletion
            <input required autoComplete="off" spellCheck={false} value={confirmation}
              onChange={event => setConfirmation(event.target.value)} disabled={busy} />
          </label>
        </>}
        <div className="form-actions">
          {!deleted && <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>}
          <button className={`button ${deleted ? "primary" : "danger-button"}`} disabled={busy || conflict || (!deleted && confirmation !== workspace.name)}>
            {!deleted && <Trash2 size={16} />}
            {busy ? (deleted ? "Refreshing…" : "Deleting permanently…") : (deleted ? "Refresh workspace list" : "Delete workspace permanently")}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
