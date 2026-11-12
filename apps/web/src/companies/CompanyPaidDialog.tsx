import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, errorMessage, mutate } from "../api";
import { ErrorNotice } from "../components";
import { CompanyDialog } from "./CompanyDialog";
import { companyDecimal, companyPaidPayload } from "./model";

export function CompanyPaidDialog({ organizationId, companyName, paidMinor, version, currency, exponent, onClose, onSaved, onRefresh }: {
  organizationId: string; companyName: string; paidMinor: string; version: number; currency: string; exponent: number;
  onClose: () => void; onSaved: () => void; onRefresh: () => void;
}) {
  const [paid, setPaid] = useState(() => companyDecimal(paidMinor, exponent));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true), submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || conflict) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      await mutate(`/organizations/${organizationId}/companies/paid`, {
        company_name: companyName, paid: companyPaidPayload(paid, exponent), expected_version: version,
      }, "PATCH");
      if (mounted.current) onSaved();
    } catch (cause) {
      if (mounted.current) { setError(errorMessage(cause)); setConflict(cause instanceof ApiError && cause.status === 409); }
    } finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  return <CompanyDialog title="Edit company paid" description={`Total paid for ${companyName}, across all vouchers.`} busy={busy} onClose={onClose} compact>
    <ErrorNotice message={error} />
    {conflict && <div className="notice company-conflict"><p>Refresh company totals to use the latest paid amount. Your unsaved amount will be discarded.</p><button type="button" className="button secondary small" onClick={onRefresh}>Refresh company totals</button></div>}
    <form className="stack-form" onSubmit={submit} aria-busy={busy}>
      <label>Paid<input autoFocus required type="text" inputMode="decimal" maxLength={32} value={paid} disabled={busy} onChange={event => setPaid(event.target.value)} aria-describedby="company-paid-help" /></label>
      <p id="company-paid-help" className="company-dialog-description">Amount in {currency}. Enter the total paid to date. Balance is calculated from all voucher totals minus this amount.</p>
      <div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button" disabled={busy || conflict}>{busy ? "Saving…" : "Save paid"}</button></div>
    </form>
  </CompanyDialog>;
}
