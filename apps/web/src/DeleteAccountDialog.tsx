import { useEffect, useRef, useState, type FormEvent } from "react";
import { Trash2, X } from "lucide-react";
import { errorMessage, permanentlyDeleteAccount } from "./api";
import { ErrorNotice } from "./components";

export function DeleteAccountDialog({
  name,
  email,
  kind,
  organizationName,
  path,
  onClose,
  onDeleted,
}: {
  name: string;
  email: string;
  kind: "customer" | "administrator";
  organizationName: string;
  path: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await permanentlyDeleteAccount(path, email, confirmation);
      onDeleted();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="entry-dialog"
      aria-labelledby="delete-account-title"
      aria-describedby="delete-account-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h2 id="delete-account-title">Permanently delete {kind}?</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close deletion confirmation"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      <ErrorNotice message={error} />
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        <div id="delete-account-description" className="deletion-scope">
          <p>
            <strong>{name}</strong>
            <br />
            <span className="invited-email">{email}</span>
          </p>
          {kind === "customer" ? (
            <>
              <p>
                This permanently deletes this customer’s data in {organizationName}:
              </p>
              <ul>
                <li>Profile, contact details, and internal notes</li>
                <li>
                  All ledger transactions, payments, balances, and statement history
                </li>
                <li>Travel bookings, service folders, uploaded documents, and payment receipts</li>
                <li>Invitations and access to this business</li>
              </ul>
              <p>
                You can invite the same email again to start a new, empty customer account.
              </p>
            </>
          ) : (
            <>
              <p>
                This permanently removes this administrator’s access to {organizationName}.
              </p>
              <p>
                Customer accounts and business transactions created by this administrator are kept.
              </p>
            </>
          )}
          <p>
            The sign-in account is deleted only when no other business or pending invitation
            needs it. Data in other businesses is unaffected.
          </p>
          <p className="danger-text">
            <strong>This cannot be undone.</strong>
          </p>
        </div>
        <label>
          Type {email} to confirm permanent deletion
          <input
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            required
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button danger-button"
            disabled={
              busy || confirmation.trim().toLowerCase() !== email.toLowerCase()
            }
          >
            <Trash2 size={16} />
            {busy ? "Deleting permanently…" : "Delete permanently"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
