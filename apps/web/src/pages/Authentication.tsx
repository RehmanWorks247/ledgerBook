import {
  useContext,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { useClerk, useSignIn, useSignUp, useUser } from "@clerk/react";
import { Link, Navigate, useNavigate } from "../router";
import {
  ArrowRight,
  Mail,
} from "lucide-react";
import { errorMessage, hasErrorCode, mutate } from "../api";
import { AuthContext } from "../state";
import { invitationLink, invitationUrl, clearInvitation } from "../invitation";
import { ErrorNotice, Loading } from "../components";
import { AuthFrame } from "../branding/AuthFrame";
import { PASSWORD_HINT, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../password-policy";

function PasswordField({
  value,
  onChange,
  newPassword = false,
  confirm = false,
}: {
  value: string;
  onChange: (value: string) => void;
  newPassword?: boolean;
  confirm?: boolean;
}) {
  return (
    <label>
      {confirm ? "Confirm password" : newPassword ? "New password" : "Password"}
      <input
        type="password"
        name={confirm ? "confirmPassword" : "password"}
        autoComplete={newPassword ? "new-password" : "current-password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={newPassword ? PASSWORD_MIN_LENGTH : undefined}
        maxLength={PASSWORD_MAX_LENGTH}
        required
      />
      {newPassword && !confirm && (
        <small>
          {PASSWORD_HINT}
        </small>
      )}
    </label>
  );
}
function CodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      Verification code
      <input
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={(event) => onChange(event.target.value.trim())}
        required
        autoFocus
      />
    </label>
  );
}
async function checked(result: Promise<{ error: unknown }>) {
  const { error } = await result;
  if (error) throw error;
}
export function AuthPage({ mode }: { mode: "login" | "forgot" | "reset" }) {
  const { refresh } = useContext(AuthContext);
  const clerk = useClerk();
  const { isSignedIn } = useUser();
  const { signIn } = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [step, setStep] = useState<"email" | "code" | "password" | "mfa">(
    "email",
  );
  const [factor, setFactor] = useState<
    "email_code" | "phone_code" | "totp" | "backup_code"
  >("email_code");
  const destination = invitationLink.token ? invitationUrl() : "/";
  const reset = mode !== "login";
  useEffect(() => {
    setError("");
    setNotice("");
    setPassword("");
    setConfirmation("");
    setCode("");
    setStep("email");
    setRecoveryUnavailable(false);
  }, [mode]);
  if (isSignedIn) return <Navigate to={destination} replace />;

  async function finish() {
    let pendingTask = false;
    let redirect = destination;
    await checked(
      signIn.finalize({
        navigate: ({ session, decorateUrl }) => {
          pendingTask = Boolean(session?.currentTask);
          redirect = decorateUrl(destination);
        },
      }),
    );
    if (pendingTask) {
      await clerk.redirectToTasks({ redirectUrl: destination });
      return;
    }
    await refresh();
    if (
      redirect.startsWith("http") &&
      new URL(redirect).origin !== window.location.origin
    )
      window.location.assign(redirect);
    else navigate(redirect, { replace: true });
  }
  async function advance() {
    if (signIn.status === "complete") {
      await finish();
      return;
    }
    if (
      signIn.status === "needs_second_factor" ||
      signIn.status === "needs_client_trust"
    ) {
      const supported = signIn.supportedSecondFactors;
      const next =
        supported.find((item) => item.strategy === "email_code")?.strategy ||
        supported.find((item) => item.strategy === "totp")?.strategy ||
        supported.find((item) => item.strategy === "phone_code")?.strategy ||
        supported.find((item) => item.strategy === "backup_code")?.strategy;
      if (!next)
        throw new Error(
          "This account needs an additional verification method. Contact your administrator for help signing in.",
        );
      setFactor(next);
      setCode("");
      setStep("mfa");
      if (next === "email_code") await checked(signIn.mfa.sendEmailCode());
      if (next === "phone_code") await checked(signIn.mfa.sendPhoneCode());
      return;
    }
    if (signIn.status === "needs_new_password") {
      setStep("password");
      return;
    }
    throw new Error(
      "Sign in needs another verification step. Please start again or contact your administrator.",
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (step === "mfa") {
        if (factor === "email_code")
          await checked(signIn.mfa.verifyEmailCode({ code }));
        else if (factor === "phone_code")
          await checked(signIn.mfa.verifyPhoneCode({ code }));
        else if (factor === "totp")
          await checked(signIn.mfa.verifyTOTP({ code }));
        else await checked(signIn.mfa.verifyBackupCode({ code }));
        await advance();
      } else if (!reset && step === "email") {
        await checked(
          signIn.password({ emailAddress: email.trim(), password }),
        );
        await advance();
      } else if (step === "email") {
        setRecoveryUnavailable(false);
        await checked(signIn.create({ identifier: email.trim() }));
        await checked(signIn.resetPasswordEmailCode.sendCode());
        setStep("code");
      } else if (step === "code") {
        if (recoveryUnavailable)
          throw new Error(
            "This code is invalid or expired. Check your email address and request a new code.",
          );
        await checked(signIn.resetPasswordEmailCode.verifyCode({ code }));
        setPassword("");
        setConfirmation("");
        setStep("password");
      } else if (step === "password") {
        if (password !== confirmation)
          throw new Error("Your passwords do not match.");
        await checked(
          signIn.resetPasswordEmailCode.submitPassword({
            password,
            signOutOfOtherSessions: true,
          }),
        );
        setPassword("");
        setConfirmation("");
        await advance();
      }
    } catch (cause) {
      if (
        reset &&
        step === "email" &&
        hasErrorCode(cause, "form_identifier_not_found")
      ) {
        setRecoveryUnavailable(true);
        setStep("code");
      } else setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (step === "code") {
        if (!recoveryUnavailable)
          await checked(signIn.resetPasswordEmailCode.sendCode());
      } else if (factor === "phone_code")
        await checked(signIn.mfa.sendPhoneCode());
      else await checked(signIn.mfa.sendEmailCode());
      setNotice(
        "If an account exists for that email, a new verification code has been sent. Check your inbox and spam folder.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const title =
    step === "mfa"
      ? "Verify it’s you"
      : step === "code"
        ? "Check your inbox"
        : step === "password"
          ? "Choose a new password"
          : reset
            ? "Reset your password"
            : "Sign in";
  const description =
    step === "mfa"
      ? factor === "totp"
        ? "Enter the code from your authenticator app."
        : factor === "backup_code"
          ? "Enter one of your unused backup codes."
          : `Enter the verification code sent to your ${factor === "phone_code" ? "phone" : "email"}.`
      : step === "code"
        ? `If an account exists for ${email}, a password reset code has been sent. Enter it below, and check your spam folder too.`
        : step === "password"
          ? "Choose a new password. Your other sessions will be signed out."
          : reset
            ? "Enter your account email. We’ll send you a secure verification code to reset your password."
            : "Enter your email and password.";
  return (
    <AuthFrame>
      <h1>{title}</h1>
      <p className="muted">{description}</p>
      <ErrorNotice message={error} />
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <form onSubmit={submit} className="stack-form" aria-busy={busy}>
        {step === "email" && (
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              name="email"
              placeholder="you@business.com"
              value={email}
              maxLength={254}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
        )}
        {((!reset && step === "email") || step === "password") && (
          <PasswordField
            value={password}
            onChange={setPassword}
            newPassword={step === "password"}
          />
        )}
        {step === "password" && (
          <PasswordField
            value={confirmation}
            onChange={setConfirmation}
            newPassword
            confirm
          />
        )}
        {(step === "code" || step === "mfa") && (
          <CodeField value={code} onChange={setCode} />
        )}
        {!reset && step === "email" && (
          <Link className="form-link" to={invitationUrl("/forgot-password")}>
            Forgot password?
          </Link>
        )}
        <button className="button wide" disabled={busy}>
          {busy
            ? "Please wait…"
            : step === "password"
              ? "Save password & sign in"
              : step === "code" || step === "mfa"
                ? "Verify code"
                : reset
                  ? "Send reset code"
                  : "Sign in"}
          {!busy && <ArrowRight size={17} />}
        </button>
        {(step === "code" ||
          (step === "mfa" &&
            (factor === "email_code" || factor === "phone_code"))) && (
          <button
            type="button"
            className="text-link"
            onClick={() => void resend()}
            disabled={busy}
          >
            Resend code
          </button>
        )}
        {step !== "email" && (
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => {
              void signIn.reset();
              setStep("email");
              setCode("");
              setError("");
              setNotice("");
            }}
          >
            Start again
          </button>
        )}
        {reset && (
          <Link className="center-link" to={invitationUrl("/login")}>
            Back to sign in
          </Link>
        )}
      </form>
      {!reset && step === "email" && (
        <p className="auth-help">
          To create an account, use the invitation email from your business.
        </p>
      )}
    </AuthFrame>
  );
}

type InviteInfo = {
  status: string;
  email?: string;
  name?: string;
  organizationName?: string;
  existingUser?: boolean;
  provider?: string;
};
export function InvitationPage() {
  const { refresh } = useContext(AuthContext);
  const { isLoaded, user } = useUser();
  const clerk = useClerk();
  const { signUp } = useSignUp();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo>();
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!invitationLink.token) {
      setInfo({ status: "invalid" });
      return;
    }
    let active = true;
    const token = invitationLink.token;
    setError("");
    mutate<InviteInfo>("/auth/invitations/inspect", {
      token,
    })
      .then((value) => {
        if (active && invitationLink.token === token) setInfo(value);
      })
      .catch((cause) => {
        if (active && invitationLink.token === token) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const email = user?.primaryEmailAddress?.emailAddress;
  const mismatch = Boolean(
    user &&
    (user.primaryEmailAddress?.verification.status !== "verified" ||
      email?.toLowerCase() !== info?.email?.toLowerCase()),
  );
  async function accept(event: FormEvent) {
    event.preventDefault();
    const { token, ticket } = invitationLink;
    const stillCurrent = () => invitationLink.token === token && invitationLink.ticket === ticket;
    setBusy(true);
    setError("");
    try {
      if (!user) {
        if (!ticket)
          throw new Error(
            "This link is missing its secure invitation ticket. Open the original email, or ask the administrator to resend your invitation.",
          );
        if (password !== confirmation)
          throw new Error("Your passwords do not match.");
        // Send the password and Clerk ticket together. The invitation verifies the email.
        const [firstName, ...lastNames] = (info?.name || "")
          .trim()
          .split(/\s+/);
        await checked(
          signUp.create({
            strategy: "ticket",
            ticket,
            password,
            ...(firstName ? { firstName, lastName: lastNames.join(" ") } : {}),
          }),
        );
        if (!stillCurrent()) return;
        if (signUp.status !== "complete")
          throw new Error(
            "Your account needs additional information. Contact the administrator to check the account sign-up settings.",
          );
        let pendingTask = false;
        let redirect = invitationUrl();
        await checked(
          signUp.finalize({
            navigate: ({ session, decorateUrl }) => {
              pendingTask = Boolean(session?.currentTask);
              redirect = decorateUrl(invitationUrl());
            },
          }),
        );
        if (!stillCurrent()) return;
        setPassword("");
        setConfirmation("");
        if (pendingTask) {
          await clerk.redirectToTasks({ redirectUrl: invitationUrl() });
          return;
        }
        if (
          redirect.startsWith("http") &&
          new URL(redirect).origin !== window.location.origin
        ) {
          window.location.assign(redirect);
          return;
        }
      }
      if (!stillCurrent()) return;
      await mutate("/auth/invitations/accept", { token });
      if (!stillCurrent()) return;
      clearInvitation();
      await refresh();
      navigate("/", { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function switchAccount() {
    setBusy(true);
    setError("");
    try {
      await clerk.signOut({ redirectUrl: invitationUrl() });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  const invalid = info && info.status !== "valid";
  return (
    <AuthFrame>
      <h1>
        {invalid
          ? "Invitation unavailable"
          : info?.name
            ? `Welcome, ${info.name}`
            : "Accept invitation"}
      </h1>
      <ErrorNotice message={error} />
      {(!info || !isLoaded) && !error && <Loading />}
      {!info && error && (
        <button
          className="button secondary"
          onClick={() => setRevision((value) => value + 1)}
        >
          Try again
        </button>
      )}
      {invalid && (
        <>
          <p className="muted">
            {info.status === "accepted"
              ? "This invitation has already been accepted. Sign in to view your account."
              : info.status === "expired"
                ? "This invitation has expired. Ask the business to send a fresh invitation."
                : info.status === "revoked"
                  ? "This invitation has been revoked. Contact the business for access."
                  : "This invitation link is invalid or missing. Open the latest invitation email, or ask the business to resend it."}
          </p>
          <Link
            to="/login"
            className="button"
            onClick={() => clearInvitation()}
          >
            Go to sign in
          </Link>
        </>
      )}
      {info?.status === "valid" && isLoaded && (
        <>
          <p className="muted">
            You’ve been invited to <strong>{info.organizationName}</strong>.{" "}
            {user || info.existingUser
              ? "Accept to open your customer account."
              : "Set your password to join and view your balance and statements."}
          </p>
          <div className="invited-email">
            <Mail size={20} />
            <span>{info.email}</span>
          </div>
          {mismatch ? (
            <>
              <ErrorNotice
                message={`You’re signed in as ${email}. Sign in with the invited email as your primary email address to continue.`}
              />
              <button
                className="button"
                onClick={() => void switchAccount()}
                disabled={busy}
              >
                Switch account
              </button>
            </>
          ) : info.existingUser && !user ? (
            <>
              <p>
                Your email already has an account. Sign in with your
                existing password to accept this invitation.
              </p>
              <Link to={invitationUrl("/login")} className="button">
                Sign in to accept <ArrowRight size={17} />
              </Link>
              <Link
                to={invitationUrl("/forgot-password")}
                className="center-link"
              >
                Forgot password?
              </Link>
            </>
          ) : !user && !invitationLink.ticket ? (
            <ErrorNotice message="This link is missing its secure invitation ticket. Open the original invitation email or ask the business to resend it." />
          ) : (
            <form className="stack-form" onSubmit={accept} aria-busy={busy}>
              {!user && (
                <>
                  <PasswordField
                    value={password}
                    onChange={setPassword}
                    newPassword
                  />
                  <PasswordField
                    value={confirmation}
                    onChange={setConfirmation}
                    newPassword
                    confirm
                  />
                </>
              )}
              <p className="small muted">
                {user
                  ? "You’ll join with your current account."
                  : "Choose your own password. The business cannot see it."}
              </p>
              <div id="clerk-captcha" />
              <button className="button wide" disabled={busy}>
                {busy
                  ? "Activating account…"
                  : user
                    ? "Accept invitation"
                    : "Set password & join"}
                <ArrowRight size={17} />
              </button>
            </form>
          )}
        </>
      )}
    </AuthFrame>
  );
}
