import { useEffect, useRef, useState, type ReactNode } from "react";
import { useClerk, useReverification, useUser } from "@clerk/react";
import { isReverificationCancelledError } from "@clerk/react/errors";
import type { EmailAddressResource, SessionWithActivitiesResource, UserResource } from "@clerk/react/types";
import { Check, KeyRound, Laptop, Mail, Save, ShieldCheck, Smartphone, UserRound } from "lucide-react";
import { ErrorNotice, Loading } from "../components";
import { errorMessage } from "../api";
import { PASSWORD_HINT, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../password-policy";
import { VerificationDialog, type VerificationRequest } from "./VerificationDialog";
import "./account-settings.css";

type Section = "profile" | "email" | "password" | "devices";
type Feedback = { section: Section; error?: string; notice?: string };

export function AccountSettings() {
  const { isLoaded, user } = useUser();
  if (!isLoaded) return <Loading />;
  if (!user) return null;
  return <AccountControls key={user.id} user={user} />;
}

function AccountControls({ user }: { user: UserResource }) {
  const clerk = useClerk();
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [savedName, setSavedName] = useState({ firstName: user.firstName ?? "", lastName: user.lastName ?? "" });
  const [addresses, setAddresses] = useState(user.emailAddresses);
  const [primaryId, setPrimaryId] = useState(user.primaryEmailAddressId);
  const [email, setEmail] = useState("");
  const [pendingEmail, setPendingEmail] = useState<EmailAddressResource>();
  const [code, setCode] = useState("");
  const [removingEmail, setRemovingEmail] = useState<string>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordEnabled, setPasswordEnabled] = useState(user.passwordEnabled);
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [sessions, setSessions] = useState<SessionWithActivitiesResource[]>();
  const [sessionError, setSessionError] = useState("");
  const [feedback, setFeedback] = useState<Feedback>();
  const [busy, setBusy] = useState<Section>();
  const working = useRef(false);
  const mounted = useRef(true);
  const [verification, setVerification] = useState<VerificationRequest>();
  const pendingVerification = useRef<VerificationRequest | undefined>(undefined);
  const protectedAction = useReverification((action: () => Promise<unknown>) => action(), {
    onNeedsReverification: request => {
      if (!mounted.current) { request.cancel(); return; }
      const finish = (callback: () => void) => {
        pendingVerification.current = undefined;
        if (mounted.current) setVerification(undefined);
        callback();
      };
      const pending = { level: request.level, complete: () => finish(request.complete), cancel: () => finish(request.cancel) };
      pendingVerification.current = pending; setVerification(pending);
    },
  });
  async function protect<T,>(action: () => Promise<T>): Promise<T> {
    const result = await protectedAction(action);
    if (result && typeof result === "object" && "clerk_error" in result) {
      throw new Error("Your identity could not be verified. Please try again.");
    }
    return result as T;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pendingVerification.current?.cancel(); };
  }, []);
  useEffect(() => {
    let active = true;
    void user.getSessions().then(result => { if (active) setSessions(result.filter(item => item.status === "active")); })
      .catch(cause => { if (active) setSessionError(errorMessage(cause)); });
    return () => { active = false; };
  }, [user]);

  async function run(section: Section, action: () => Promise<void>, notice?: string) {
    if (working.current) return;
    working.current = true; setBusy(section); setFeedback(undefined);
    try {
      await action();
      if (mounted.current && notice) setFeedback({ section, notice });
    } catch (cause) {
      if (mounted.current && !isReverificationCancelledError(cause)) setFeedback({ section, error: errorMessage(cause) });
    } finally {
      working.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }
  const disabled = Boolean(busy);
  const nameDirty = firstName.trim() !== savedName.firstName || lastName.trim() !== savedName.lastName;
  function messages(section: Section) {
    return feedback?.section === section && <>
      <ErrorNotice message={feedback.error ?? ""} />
      {feedback.notice && <p className="account-status" role="status"><Check size={15} aria-hidden="true" />{feedback.notice}</p>}
    </>;
  }
  async function sendEmailCode(address: EmailAddressResource) {
    setPendingEmail(address); setCode("");
    await address.prepareVerification({ strategy: "email_code" });
  }

  return <>
    <section className="panel profile-settings" aria-labelledby="profile-settings-title">
      <header className="appearance-settings-heading account-section-heading"><UserRound size={20} aria-hidden="true" /><div>
        <h2 id="profile-settings-title">Profile</h2><p>Manage your personal details.</p>
      </div></header>
      <form className="stack-form account-settings-body" aria-busy={busy === "profile"} onSubmit={event => {
        event.preventDefault();
        void run("profile", async () => {
          const updated = await protect(() => user.update({ firstName: firstName.trim(), lastName: lastName.trim() }));
          const name = { firstName: updated.firstName ?? "", lastName: updated.lastName ?? "" };
          setSavedName(name); setFirstName(name.firstName); setLastName(name.lastName);
        }, "Profile saved.");
      }}>
        <div className="account-identity"><span className="account-avatar" aria-hidden="true">{(savedName.firstName || user.primaryEmailAddress?.emailAddress || "U").slice(0, 1).toUpperCase()}{savedName.lastName.slice(0, 1).toUpperCase()}</span>
          <div><strong>{[savedName.firstName, savedName.lastName].filter(Boolean).join(" ") || "Your account"}</strong><span>{addresses.find(address => address.id === primaryId)?.emailAddress}</span></div></div>
        <div className="account-field-grid">
          <label>First name<input autoComplete="given-name" maxLength={100} value={firstName} onChange={event => setFirstName(event.target.value)} disabled={disabled} /></label>
          <label>Last name<input autoComplete="family-name" maxLength={100} value={lastName} onChange={event => setLastName(event.target.value)} disabled={disabled} /></label>
        </div>
        {messages("profile")}
        <div className="account-actions"><button className="button" disabled={disabled || !nameDirty}><Save size={16} aria-hidden="true" />{busy === "profile" ? "Saving…" : "Save profile"}</button></div>
      </form>
    </section>

    <section className="panel profile-settings" aria-labelledby="account-emails-title">
      <SectionHeading icon={<Mail size={20} />} id="account-emails-title" title="Email addresses" description="Manage the addresses you use to sign in." />
      <div className="account-settings-body">
        <ul className="account-detail-list">{addresses.map(address => <li key={address.id} className="account-detail-row">
          <div className="account-detail-copy"><strong>{address.emailAddress}</strong><div className="account-labels">
            {address.id === primaryId && <span className="badge badge-active">Primary</span>}
            <span className={`account-verification-label ${address.verification.status === "verified" ? "verified" : ""}`}>{address.verification.status === "verified" ? <><ShieldCheck size={13} />Verified</> : "Not verified"}</span>
          </div></div>
          <div className="account-row-actions">
            {address.verification.status !== "verified" && <button className="button secondary small" disabled={disabled} onClick={() => void run("email", () => sendEmailCode(address), "Verification code sent.")}>Verify email</button>}
            {address.id !== primaryId && <>
              {address.verification.status === "verified" && <button className="button secondary small" disabled={disabled} onClick={() => void run("email", async () => {
                const updated = await protect(() => user.update({ primaryEmailAddressId: address.id }));
                setPrimaryId(updated.primaryEmailAddressId);
              }, "Primary email updated.")}>Make primary</button>}
              {removingEmail === address.id ? <div className="account-remove-confirm"><span>Remove this email?</span>
                <button className="button danger-button small" disabled={disabled} onClick={() => void run("email", async () => {
                  await protect(() => address.destroy()); setAddresses(items => items.filter(item => item.id !== address.id));
                  if (pendingEmail?.id === address.id) setPendingEmail(undefined);
                  setRemovingEmail(undefined);
                }, "Email address removed.")}>Remove email</button>
                <button className="button secondary small" disabled={disabled} onClick={() => setRemovingEmail(undefined)}>Cancel</button></div>
                : <button className="text-link danger-text" disabled={disabled} onClick={() => setRemovingEmail(address.id)}>Remove</button>}
            </>}
          </div>
        </li>)}</ul>
        {messages("email")}
        {pendingEmail ? <form className="stack-form account-email-form" aria-busy={busy === "email"} onSubmit={event => {
          event.preventDefault(); void run("email", async () => {
            const verified = await pendingEmail.attemptVerification({ code: code.trim() });
            if (verified.verification.status !== "verified") throw new Error("The email address is not verified yet. Check the code and try again.");
            setAddresses(items => items.map(item => item.id === verified.id ? verified : item));
            setPendingEmail(undefined); setCode("");
          }, "Email verified. You can now make it your primary address.");
        }}>
          <p className="muted">Enter the verification code for <strong>{pendingEmail.emailAddress}</strong>.</p>
          <label>Email verification code<input autoComplete="one-time-code" inputMode="numeric" value={code} onChange={event => setCode(event.target.value)} required disabled={disabled} autoFocus /></label>
          <div className="account-actions"><button className="button" disabled={disabled}>{busy === "email" ? "Please wait…" : "Verify email address"}</button>
            <button type="button" className="button secondary" disabled={disabled} onClick={() => void run("email", () => sendEmailCode(pendingEmail), "A new verification code has been sent.")}>Resend code</button>
            <button type="button" className="text-link" disabled={disabled} onClick={() => { setPendingEmail(undefined); setCode(""); setFeedback(undefined); }}>Cancel</button></div>
        </form> : <form className="stack-form account-email-form" aria-busy={busy === "email"} onSubmit={event => {
          event.preventDefault(); void run("email", async () => {
            const normalized = email.trim();
            if (addresses.some(address => address.emailAddress.toLowerCase() === normalized.toLowerCase())) throw new Error("This email address is already on your account.");
            const created = await protect(() => user.createEmailAddress({ email: normalized }));
            setAddresses(items => [...items, created]); setEmail("");
            await sendEmailCode(created);
          }, "Verification code sent.");
        }}><label>Add an email address<input type="email" autoComplete="email" maxLength={320} value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" required disabled={disabled} /></label>
          <div className="account-actions"><button className="button secondary" disabled={disabled}>{busy === "email" ? "Please wait…" : "Add email address"}</button></div>
        </form>}
      </div>
    </section>

    <section className="panel profile-settings" aria-labelledby="account-password-title">
      <SectionHeading icon={<KeyRound size={20} />} id="account-password-title" title="Password" description={passwordEnabled ? "Change the password you use to sign in." : "Add a password to sign in with your email address."} />
      <form className="stack-form account-settings-body" aria-busy={busy === "password"} onSubmit={event => {
        event.preventDefault(); void run("password", async () => {
          if (newPassword !== confirmation) throw new Error("Your passwords do not match.");
          await protect(() => user.updatePassword({ newPassword, ...(passwordEnabled ? { currentPassword } : {}), signOutOfOtherSessions: signOutOthers }));
          setCurrentPassword(""); setNewPassword(""); setConfirmation(""); setPasswordEnabled(true);
          if (signOutOthers) setSessions(items => items?.filter(item => item.id === clerk.session?.id));
        }, signOutOthers ? "Password updated. Other devices have been signed out." : "Password updated.");
      }}>
        {passwordEnabled && <label className="account-field-half">Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required disabled={disabled} /></label>}
        <div className="account-field-grid"><div className="account-password-field"><label>New password<input type="password" autoComplete="new-password" aria-describedby="account-password-hint" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} value={newPassword} onChange={event => setNewPassword(event.target.value)} required disabled={disabled} /></label><small id="account-password-hint">{PASSWORD_HINT}</small></div>
          <label>Confirm new password<input type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={disabled} /></label></div>
        <label className="account-checkbox"><input type="checkbox" checked={signOutOthers} onChange={event => setSignOutOthers(event.target.checked)} disabled={disabled} />Sign out of other devices after changing my password</label>
        {messages("password")}
        <div className="account-actions"><button className="button" disabled={disabled}>{busy === "password" ? "Updating…" : passwordEnabled ? "Update password" : "Set password"}</button></div>
      </form>
    </section>

    <section className="panel profile-settings" aria-labelledby="account-devices-title">
      <SectionHeading icon={<Laptop size={20} />} id="account-devices-title" title="Signed-in devices" description="Review your active sessions and sign out of devices you no longer use." />
      <div className="account-settings-body">
        <ErrorNotice message={sessionError} />
        {sessionError && <button className="button secondary" disabled={disabled} onClick={() => void run("devices", async () => {
          const result = await user.getSessions(); setSessions(result.filter(item => item.status === "active")); setSessionError("");
        })}>Retry loading devices</button>}
        {!sessions && !sessionError && <Loading />}
        <ul className="account-detail-list">{sessions?.map(item => <li key={item.id} className="account-detail-row">
          <span className="account-device-icon" aria-hidden="true">{item.latestActivity.isMobile ? <Smartphone size={20} /> : <Laptop size={20} />}</span>
          <div className="account-detail-copy"><strong>{[item.latestActivity.browserName, item.latestActivity.deviceType].filter(Boolean).join(" · ") || "Web browser"}</strong>
            <span>{[item.latestActivity.city, item.latestActivity.country].filter(Boolean).join(", ") || "Location unavailable"} · Last active {item.lastActiveAt.toLocaleString()}</span>
            {item.id === clerk.session?.id && <span className="account-current-device"><span />This device</span>}</div>
          <button className="button secondary small" disabled={disabled} onClick={() => void run("devices", async () => {
            if (item.id === clerk.session?.id) await clerk.signOut({ redirectUrl: "/login" });
            else { await protect(() => item.revoke()); setSessions(items => items?.filter(session => session.id !== item.id)); }
          }, "Device signed out.")}>Sign out{item.id === clerk.session?.id ? "" : " device"}</button>
        </li>)}</ul>
        {sessions?.length === 0 && <p className="muted">No active devices to display.</p>}
        {messages("devices")}
      </div>
    </section>
    {verification && <VerificationDialog request={verification} />}
  </>;
}

function SectionHeading({ icon, id, title, description }: { icon: ReactNode; id: string; title: string; description: string }) {
  return <header className="appearance-settings-heading account-section-heading"><span aria-hidden="true">{icon}</span><div><h2 id={id}>{title}</h2><p>{description}</p></div></header>;
}
