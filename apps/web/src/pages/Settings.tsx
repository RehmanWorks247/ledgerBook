import { AccountSettings } from "../account/AccountSettings";
import { useContext } from "react";
import { ArrowLeft, Check, Monitor, Moon, Sun } from "lucide-react";
import { NotificationSettings } from "../NotificationSettings";
import { Brand, PageHeading } from "../components";
import { Link } from "../router";
import { AuthContext } from "../state";
import { useTheme, type AccentTheme, type ThemePreference } from "../theme";
import { WorkspaceSettings } from "../workspaces/WorkspaceSettings";

const modes = [
  { id: "light", label: "Light", description: "A bright, clear view", Icon: Sun },
  { id: "dark", label: "Dark", description: "A quieter view after hours", Icon: Moon },
  { id: "system", label: "System", description: "Follow your device settings", Icon: Monitor },
] satisfies { id: ThemePreference; label: string; description: string; Icon: typeof Sun }[];

const palettes = [
  { id: "gold", label: "Gold" },
  { id: "green", label: "Emerald" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "amber", label: "Amber" },
  { id: "rose", label: "Rose" },
  { id: "neutral", label: "Graphite" },
] satisfies { id: AccentTheme; label: string }[];

function PalettePreview() {
  return (
    <span className="theme-preview" aria-hidden="true">
      <span className="theme-preview-sidebar">
        <span className="theme-preview-mark" />
        <span className="theme-preview-nav active" />
        <span className="theme-preview-nav" />
        <span className="theme-preview-nav" />
      </span>
      <span className="theme-preview-content">
        <span className="theme-preview-heading">
          <span />
          <span className="theme-preview-button" />
        </span>
        <span className="theme-preview-stats"><span /><span /><span /></span>
        <span className="theme-preview-table"><span /><span /><span /></span>
      </span>
    </span>
  );
}

export function Settings({ standalone = false }: { standalone?: boolean }) {
  const { session } = useContext(AuthContext);
  const canManageWorkspaces = session?.can_create_workspaces || session?.memberships.some(member => member.role === "admin");
  const accountPath = session?.memberships[0] ? `/o/${session.memberships[0].organization_id}` : "/";
  const { theme, preference, accent, setPreference, setAccent } = useTheme();
  const paletteName = palettes.find((palette) => palette.id === accent)!.label;

  const content = (
    <>
      <PageHeading
        title="Settings"
      />
      <AccountSettings />
      {!standalone && <WorkspaceSettings />}
      <section className="panel appearance-settings" aria-labelledby="appearance-title">
        <header className="appearance-settings-heading">
          <h2 id="appearance-title">Appearance</h2>
        </header>

        <fieldset className="appearance-fieldset">
          <legend>Display mode</legend>
          <div className="appearance-modes">
            {modes.map(({ id, label, Icon }) => (
              <label className="appearance-mode" key={id}>
                <input
                  className="sr-only"
                  type="radio"
                  name="display-mode"
                  value={id}
                  checked={preference === id}
                  onChange={() => setPreference(id)}
                />
                <Icon size={20} aria-hidden="true" />
                <span className="appearance-mode-copy">
                  <strong>{label}</strong>
                </span>
                <span className="appearance-check" aria-hidden="true">
                  {preference === id && <Check size={13} strokeWidth={2.5} />}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="appearance-fieldset">
          <legend>Color theme</legend>
          <div className="appearance-palettes">
            {palettes.map(({ id, label }) => (
              <label className="theme-option" data-accent={id} key={id}>
                <input
                  className="sr-only"
                  type="radio"
                  name="accent-theme"
                  value={id}
                  checked={accent === id}
                  onChange={() => setAccent(id)}
                  aria-label={label}
                />
                <PalettePreview />
                <span className="theme-option-label">
                  <span className="theme-option-swatch" aria-hidden="true" />
                  <strong>{label}</strong>
                  {id === "gold" && <small>Default</small>}
                  <span className="appearance-check" aria-hidden="true">
                    {accent === id && <Check size={13} strokeWidth={2.5} />}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <footer className="appearance-settings-footer">
          <span role="status" aria-live="polite" aria-atomic="true">
            <Check size={15} aria-hidden="true" />
            {paletteName} · {theme === "dark" ? "Dark" : "Light"} mode
            {preference === "system" ? " (system)" : ""}
          </span>
        </footer>
      </section>
      {!standalone && <NotificationSettings />}
    </>
  );
  return standalone ? (
    <main className="standalone account-standalone">
      <Link to="/" className="brand-link account-brand">
        <Brand />
      </Link>
      <Link to={canManageWorkspaces ? "/workspaces" : accountPath} className="back-link">
        <ArrowLeft size={16} />
        {canManageWorkspaces ? "Back to your workspaces" : "Back to my account"}
      </Link>
      {content}
    </main>
  ) : content;
}
