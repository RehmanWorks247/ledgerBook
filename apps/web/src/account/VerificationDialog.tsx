import { useEffect, useRef, useState, type FormEvent } from "react";
import { useClerk } from "@clerk/react";
import type { SessionVerificationLevel, SessionVerificationResource, SessionVerificationFirstFactor, SessionVerificationSecondFactor } from "@clerk/react/types";
import { ShieldCheck, X } from "lucide-react";
import { ErrorNotice, Loading } from "../components";
import { errorMessage } from "../api";

export type VerificationRequest = {
  level: SessionVerificationLevel | undefined;
  complete: () => void;
  cancel: () => void;
};
type Factor = SessionVerificationFirstFactor | SessionVerificationSecondFactor;
const supported = (factor: Factor) => factor.strategy !== "enterprise_sso";
function factorLabel(factor: Factor) {
  switch (factor.strategy) {
    case "password": return "Password";
    case "email_code": return `Email code · ${factor.safeIdentifier}`;
    case "phone_code": return `Text message · ${factor.safeIdentifier}`;
    case "totp": return "Authenticator app";
    case "backup_code": return "Backup code";
    case "passkey": return "Passkey";
    default: return "Single sign-on";
  }
}

export function VerificationDialog({ request }: { request: VerificationRequest }) {
  const clerk = useClerk();
  const dialog = useRef<HTMLDialogElement>(null);
  const startup = useRef<Promise<SessionVerificationResource> | null>(null);
  const [verification, setVerification] = useState<SessionVerificationResource>();
  const [factorIndex, setFactorIndex] = useState(0);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sent, setSent] = useState(false);
  const inFlight = useRef(false);
  const session = clerk.session;
  const second = verification?.status === "needs_second_factor";
  const factors = (second ? verification?.supportedSecondFactors : verification?.supportedFirstFactors)?.filter(supported) ?? [];
  const factor = factors[factorIndex];
  const needsCode = factor?.strategy === "email_code" || factor?.strategy === "phone_code";

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    if (!session) { setError("Your session has ended. Sign in again to continue."); setBusy(false); return; }
    // Clerk's sensitive account actions require the strongest available factor.
    // Requesting second_factor falls back to first_factor for users without MFA.
    startup.current ??= session.startVerification({ level: request.level ?? "second_factor" });
    void startup.current.then(result => {
      if (!active) return;
      if (result.status === "complete") request.complete();
      else setVerification(result);
    }).catch(cause => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [session, request]);

  async function sendCode() {
    if (!session || !factor || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (factor.strategy === "email_code") await session.prepareFirstFactorVerification({ strategy: "email_code", emailAddressId: factor.emailAddressId });
      else if (factor.strategy === "phone_code") {
        const params = { strategy: "phone_code" as const, phoneNumberId: factor.phoneNumberId };
        if (second) await session.prepareSecondFactorVerification(params);
        else await session.prepareFirstFactorVerification(params);
      }
      setSent(true); setNotice("Verification code sent.");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !factor || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      let result: SessionVerificationResource;
      if (factor.strategy === "passkey") result = await session.verifyWithPasskey({ level: second ? "second_factor" : "first_factor" });
      else if (second && (factor.strategy === "totp" || factor.strategy === "backup_code" || factor.strategy === "phone_code")) {
        result = await session.attemptSecondFactorVerification({ strategy: factor.strategy, code: value.trim() });
      } else if (!second && factor.strategy === "password") {
        result = await session.attemptFirstFactorVerification({ strategy: "password", password: value });
      } else if (!second && (factor.strategy === "email_code" || factor.strategy === "phone_code")) {
        result = await session.attemptFirstFactorVerification({ strategy: factor.strategy, code: value.trim() });
      } else throw new Error("This verification method is unavailable. Choose another method.");
      if (result.status === "complete") request.complete();
      else {
        setVerification(result); setFactorIndex(0); setValue(""); setSent(false);
        setNotice("One more verification step is required.");
      }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="entry-dialog account-verification" aria-labelledby="account-verify-title"
    onCancel={event => { event.preventDefault(); if (!busy) request.cancel(); }}>
    <div className="dialog-heading"><div><ShieldCheck size={22} aria-hidden="true" /><h2 id="account-verify-title">Verify it’s you</h2></div>
      <button className="icon-button" aria-label="Cancel verification" disabled={busy} onClick={request.cancel}><X size={20} /></button></div>
    <p className="muted">Confirm your identity to continue with this account change.</p>
    <ErrorNotice message={error} />
    {busy && !verification ? <Loading /> : !factor ? <>
      <p>No supported verification method is available. Sign in again, then retry this change.</p>
      <button className="button secondary" onClick={request.cancel}>Cancel</button>
    </> : <form className="stack-form" onSubmit={submit} aria-busy={busy}>
      {factors.length > 1 && <label>Verification method<select disabled={busy} value={factorIndex} onChange={event => {
        setFactorIndex(Number(event.target.value)); setValue(""); setSent(false); setError(""); setNotice("");
      }}>{factors.map((item, index) => <option key={index} value={index}>{factorLabel(item)}</option>)}</select></label>}
      {needsCode && <div className="account-code-delivery"><p>{factorLabel(factor)}</p>
        <button type="button" className="button secondary small" disabled={busy} onClick={() => void sendCode()}>{sent ? "Resend code" : "Send code"}</button></div>}
      {factor.strategy !== "passkey" && <label>{factor.strategy === "password" ? "Password" : factor.strategy === "backup_code" ? "Backup code" : "Verification code"}
        <input key={`${second}/${factorIndex}`} type={factor.strategy === "password" ? "password" : "text"}
          autoComplete={factor.strategy === "password" ? "current-password" : "one-time-code"}
          inputMode={factor.strategy === "password" || factor.strategy === "backup_code" ? undefined : "numeric"}
          value={value} onChange={event => setValue(event.target.value)} required disabled={busy} autoFocus />
      </label>}
      {notice && <p className="account-status" role="status">{notice}</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={request.cancel} disabled={busy}>Cancel</button>
        <button className="button" disabled={busy || (needsCode && !sent)}>{busy ? "Verifying…" : factor.strategy === "passkey" ? "Use passkey" : "Verify & continue"}</button></div>
    </form>}
  </dialog>;
}
