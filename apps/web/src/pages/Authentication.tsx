import {
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, Navigate, useNavigate } from "../router";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  FileText,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { errorMessage, mutate } from "../api";
import { AuthContext, emailLink, pendingInvitation } from "../state";
import { Brand, ErrorNotice, Loading } from "../components";
import { ThemeToggle } from "../theme";
function PasswordField({
  value,
  onChange,
  newPassword = false,
}: {
  value: string;
  onChange: (value: string) => void;
  newPassword?: boolean;
}) {
  return (
    <label>
      Password
      <input
        type="password"
        name="password"
        autoComplete={newPassword ? "new-password" : "current-password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={newPassword ? 12 : undefined}
        maxLength={128}
        required
      />
      {newPassword && (
        <small>
          Use at least 12 characters. A long, unique passphrase works well.
        </small>
      )}
    </label>
  );
}
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-layout">
      <aside className="auth-story">
        <Brand light />
        <div>
          <span className="eyebrow">BUSINESS, IN BALANCE</span>
          <h1>
            A clear view.
            <br />A confident next step.
          </h1>
          <p>
            Your customer accounts, payments, and statements. Together in one
            dependable place.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="illustration-header">
              <BookOpen />
              <span>A better way to keep track</span>
              <Check size={18} />
            </div>
            <div className="illustration-line long" />
            <div className="illustration-line" />
            <div className="illustration-grid">
              <div>
                <ArrowUpRight />
                <span>Charges</span>
              </div>
              <div>
                <ArrowDownLeft />
                <span>Payments</span>
              </div>
              <div>
                <FileText />
                <span>Statements</span>
              </div>
            </div>
          </div>
        </div>
        <span className="auth-foot">
          <ShieldCheck size={16} /> Private accounts. Clear records.
        </span>
      </aside>
      <section className="auth-main">
        <div className="auth-theme">
          <ThemeToggle />
        </div>
        <div className="mobile-brand">
          <Brand />
        </div>
        <div className="auth-card">{children}</div>
        <p className="auth-bottom">LedgerBook · Built for everyday business</p>
      </section>
    </main>
  );
}
export function AuthPage({ mode }: { mode: "login" | "forgot" | "reset" }) {
  const { session, refresh } = useContext(AuthContext);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setError("");
    setDone(false);
    setPassword("");
  }, [mode]);
  if (mode === "login" && session)
    return <Navigate to={pendingInvitation() ? "/invite" : "/"} replace />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        await mutate("/auth/login", { email, password });
        await refresh();
        navigate(pendingInvitation() ? "/invite" : "/");
      }
      if (mode === "forgot") {
        await mutate("/auth/forgot-password", { email });
        setDone(true);
      }
      if (mode === "reset") {
        const token = emailLink.token;
        await mutate("/auth/reset-password", {
          token,
          password,
        });
        if (emailLink.token === token) emailLink.token = "";
        setPassword("");
        await refresh();
        setDone(true);
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const title =
    mode === "login"
      ? "Welcome back"
      : mode === "forgot"
        ? "Reset your password"
        : "Choose a new password";
  return (
    <AuthFrame>
      <span className="eyebrow">YOUR LEDGERBOOK ACCOUNT</span>
      <h1>{title}</h1>
      <p className="muted">
        {mode === "login"
          ? "Sign in to pick up where you left off."
          : mode === "forgot"
            ? "Enter your email and we’ll send you a secure reset link if an account exists."
            : "A fresh password keeps your account secure."}
      </p>
      <ErrorNotice message={error} />
      {done ? (
        <div className="auth-success">
          <span className="success-icon">
            <Check />
          </span>
          <h2>{mode === "forgot" ? "Check your inbox" : "Password updated"}</h2>
          <p>
            {mode === "forgot"
              ? "If an account exists for that email, a password reset link will be sent. Check your spam folder too."
              : "Your previous sessions have been signed out. Sign in with your new password."}
          </p>
          <Link className="button" to="/login">
            Back to sign in
          </Link>
        </div>
      ) : mode === "reset" &&
        (!emailLink.token || emailLink.purpose !== "reset") ? (
        <>
          <ErrorNotice message="This reset link is missing or invalid. Request a new password reset email." />
          <Link to="/forgot-password">Request a new link</Link>
        </>
      ) : (
        <form onSubmit={submit} className="stack-form" aria-busy={busy}>
          {mode !== "reset" && (
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
          {mode !== "forgot" && (
            <PasswordField
              value={password}
              onChange={setPassword}
              newPassword={mode === "reset"}
            />
          )}
          {mode === "login" && (
            <Link className="form-link" to="/forgot-password">
              Forgot password?
            </Link>
          )}
          <button className="button wide" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "login"
                ? "Sign in"
                : mode === "forgot"
                  ? "Send reset link"
                  : "Save new password"}
            {!busy && <ArrowRight size={17} />}
          </button>
          {mode === "forgot" && (
            <Link className="center-link" to="/login">
              Back to sign in
            </Link>
          )}
          {mode === "reset" && error && (
            <Link className="center-link" to="/forgot-password">
              Request a new reset link
            </Link>
          )}
        </form>
      )}
      {mode === "login" && (
        <p className="auth-help">
          New here? Open the invitation email from your business to set up your
          account.
        </p>
      )}
    </AuthFrame>
  );
}
type InviteInfo = {
  status: string;
  email?: string;
  organizationName?: string;
  existingUser?: boolean;
};
export function InvitationPage() {
  const { session, loading, refresh } = useContext(AuthContext);
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo>();
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!emailLink.token || emailLink.purpose !== "invite") {
      setInfo({ status: "invalid" });
      return;
    }
    let active = true;
    const token = emailLink.token;
    mutate<InviteInfo>("/auth/invitations/inspect", { token })
      .then((value) => {
        if (!active || emailLink.token !== token) return;
        if (value.status !== "valid") emailLink.token = "";
        setInfo(value);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);
  async function accept(event: FormEvent) {
    event.preventDefault();
    const token = emailLink.token;
    setBusy(true);
    setError("");
    try {
      await mutate("/auth/invitations/accept", {
        token,
        ...(info?.existingUser ? {} : { password }),
      });
      if (emailLink.token !== token) return;
      emailLink.token = "";
      await refresh();
      navigate("/");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError("");
    const token = emailLink.token;
    try {
      await mutate("/auth/logout");
      await refresh();
      if (info?.existingUser && emailLink.token === token) navigate("/login");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const invalid = info && info.status !== "valid";
  const mismatch =
    session && info?.email?.toLowerCase() !== session.user.email.toLowerCase();
  return (
    <AuthFrame>
      <span className="eyebrow">YOU’RE INVITED</span>
      <h1>{invalid ? "Invitation unavailable" : "Your account starts here"}</h1>
      <ErrorNotice message={error} />
      {(!info || loading) && !error && <Loading />}
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
          <Link to={session ? "/" : "/login"} className="button">
            {session ? "Back to LedgerBook" : "Go to sign in"}
          </Link>
        </>
      )}
      {info?.status === "valid" && !loading && (
        <>
          <p className="muted">
            Join <strong>{info.organizationName}</strong> to view your balance
            and statements.
          </p>
          <div className="invited-email">
            <Mail size={20} />
            <span>{info.email}</span>
          </div>
          {mismatch ? (
            <>
              <ErrorNotice
                message={`You’re signed in as ${session.user.email}. Switch accounts to continue as ${info.email}.`}
              />
              <button
                className="button"
                onClick={() => void signOut()}
                disabled={busy}
              >
                Switch account
              </button>
            </>
          ) : info.existingUser && !session ? (
            <>
              <p>
                Your email already has a LedgerBook account. Sign in with your
                existing password to accept this invitation.
              </p>
              <Link to="/login" className="button">
                Sign in to accept <ArrowRight size={17} />
              </Link>
              <Link to="/forgot-password" className="form-link">
                Forgot password?
              </Link>
            </>
          ) : (
            <form className="stack-form" onSubmit={accept} aria-busy={busy}>
              {!info.existingUser && (
                <PasswordField
                  value={password}
                  onChange={setPassword}
                  newPassword
                />
              )}
              <p className="small muted">
                {info.existingUser
                  ? "Your existing password will stay the same."
                  : "Choose your own password. The business cannot see it."}
              </p>
              <button className="button wide" disabled={busy}>
                {busy ? "Activating account…" : "Accept invitation"}
                <ArrowRight size={17} />
              </button>
            </form>
          )}
        </>
      )}
    </AuthFrame>
  );
}
