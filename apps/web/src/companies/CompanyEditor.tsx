import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ApiError, errorMessage, mutate } from "../api";
import { ErrorNotice } from "../components";
import { CompanyDialog } from "./CompanyDialog";
import { companyFields, companyPayload, type Company, type CompanyFields } from "./model";

export function CompanyEditor({ organizationId, companyName, initial, currency, exponent, onClose, onSaved, onRefresh }: {
  organizationId: string;
  companyName: string;
  initial?: Company;
  currency: string;
  exponent: number;
  onClose: () => void;
  onSaved: (company: Company) => void;
  onRefresh: () => void;
}) {
  const [fields, setFields] = useState(() => ({ ...companyFields(initial, exponent), company_name: companyName }));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true), submitting = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (error) errorBox.current?.focus(); }, [error]);
  const field = (name: keyof CompanyFields) => ({
    name,
    value: fields[name],
    disabled: busy,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields(current => ({ ...current, [name]: event.target.value })),
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || conflict) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      const payload = companyPayload(fields, exponent);
      const fingerprint = JSON.stringify(payload);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      const saved = await mutate<Company>(`/organizations/${organizationId}/companies${initial ? `/${initial.id}` : ""}`,
        initial ? { ...payload, expected_version: initial.version } : { ...payload, idempotency_key: attempt.current.key },
        initial ? "PATCH" : "POST");
      if (mounted.current) onSaved(saved);
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
  return (
    <CompanyDialog title={initial ? "Edit Voucher" : "Add Voucher"} busy={busy} onClose={onClose}
      description={`Voucher for ${companyName}. Enter the customer, room and voucher details below.`}>
      {error && <div tabIndex={-1} ref={errorBox}><ErrorNotice message={error} /></div>}
      {conflict && <div className="notice company-conflict"><p>This record changed in another session. Refresh the table and reopen the record to use its latest details. Your unsaved edits will be discarded.</p><button type="button" className="button secondary small" onClick={onRefresh}>Refresh records</button></div>}
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        <label>Company name<input value={companyName} readOnly /></label>
        <div className="company-form-grid">
          <label>Customer name<input autoFocus maxLength={200} {...field("customer_name")} /></label>
          <label>Hotel name<input maxLength={200} {...field("hotel_name")} /></label>
          <label>Check-in<input type="date" min="1900-01-01" max={fields.check_out || "9999-12-31"} {...field("check_in")} /></label>
          <label>Check-out<input type="date" min={fields.check_in || "1900-01-01"} max="9999-12-31" {...field("check_out")} /></label>
          <label>Quantity<input type="number" required min={1} max={1000000} step={1} inputMode="numeric" {...field("quantity")} /></label>
          <label>Room type<input maxLength={200} placeholder="e.g. Quad with BB" {...field("room_type")} /></label>
          <label>Booking date<input type="date" min="1900-01-01" max="9999-12-31" {...field("booking_date")} /></label>
          <label>Voucher number<input maxLength={100} {...field("voucher_number")} /></label>
        </div>
        <fieldset className="company-money-fields">
          <legend>Amounts · {currency}</legend>
          <p id="company-money-help">Enter the full voucher total{exponent ? ` with up to ${exponent} decimal places` : " in whole units"}. Quantity is informational and does not multiply the total. Update paid separately in the company totals.</p>
          <label>Voucher total<input type="text" inputMode="decimal" maxLength={24} placeholder={exponent ? `0.${"0".repeat(exponent)}` : "0"} aria-describedby="company-money-help" {...field("voucher_price")} /></label>
        </fieldset>
        <label>Remarks<textarea rows={3} maxLength={2000} {...field("remarks")} /></label>
        <div className="form-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button" disabled={busy || conflict}>{busy ? "Saving…" : initial ? "Save changes" : "Add Voucher"}</button>
        </div>
      </form>
    </CompanyDialog>
  );
}
