import { useEffect, useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { ApiError, errorMessage, mutate } from "../api";
import { ErrorNotice } from "../components";
import { CompanyDialog } from "./CompanyDialog";
import type { Company } from "./model";

export function DeleteCompanyDialog({ company, organizationId, onClose, onDeleted, onRefresh }: {
  company: Company;
  organizationId: string;
  onClose: () => void;
  onDeleted: () => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true), submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || conflict) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      await mutate(`/organizations/${organizationId}/companies/${company.id}`, { expected_version: company.version }, "DELETE");
      if (mounted.current) onDeleted();
    } catch (cause) {
      if (mounted.current) {
        setConflict(cause instanceof ApiError && cause.status === 409);
        setError(errorMessage(cause));
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <CompanyDialog title="Delete record?" description={`Delete ${company.customer_name || "this customer record"} from ${company.company_name}? This cannot be undone.`}
    busy={busy} onClose={onClose} compact>
    <ErrorNotice message={error} />
    {conflict && <div className="notice company-conflict"><p>This record changed in another session. Refresh the table and review its latest details before deleting.</p><button type="button" className="button secondary small" onClick={onRefresh}>Refresh records</button></div>}
    <form onSubmit={remove} aria-busy={busy}>
      <div className="form-actions">
        <button type="button" className="button secondary" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button danger-button" disabled={busy || conflict}><Trash2 size={16} />{busy ? "Deleting…" : "Delete record"}</button>
      </div>
    </form>
  </CompanyDialog>;
}
