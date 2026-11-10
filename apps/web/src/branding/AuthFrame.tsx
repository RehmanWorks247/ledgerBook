import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Monitor, Moon, Palette, Sun, X } from "lucide-react";
import { Brand } from "../components";
import { ThemeToggle, useTheme, type AccentTheme, type ThemePreference } from "../theme";
import "./auth-theme.css";

const appearances: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const palettes: { value: AccentTheme; label: string }[] = [
  { value: "gold", label: "Gold" },
  { value: "green", label: "Emerald" },
  { value: "blue", label: "Blue" },
  { value: "violet", label: "Violet" },
  { value: "amber", label: "Amber" },
  { value: "rose", label: "Rose" },
  { value: "neutral", label: "Graphite" },
];

function AppearanceControl() {
  const { preference, accent, setPreference, setAccent } = useTheme();
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="umrah-appearance" ref={container}>
      <button
        type="button"
        className="umrah-appearance-trigger"
        aria-label="Customize appearance"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        ref={trigger}
      >
        <Palette size={16} aria-hidden="true" />
        <span>Customize</span>
      </button>
      {open && (
        <section className="umrah-appearance-panel" id={id} aria-label="Customize appearance">
          <div className="umrah-appearance-heading">
            <h2>Appearance</h2>
            <button
              type="button"
              className="umrah-appearance-close"
              aria-label="Close appearance settings"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <fieldset>
            <legend>Appearance</legend>
            <div className="umrah-appearance-modes">
              {appearances.map(({ value, label, icon: Icon }) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    value={value}
                    checked={preference === value}
                    onChange={() => setPreference(value)}
                  />
                  <span><Icon size={15} aria-hidden="true" />{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Accent color</legend>
            <div className="umrah-appearance-swatches">
              {palettes.map(({ value, label }) => (
                <label key={value} className="theme-option" data-accent={value} title={label}>
                  <input
                    type="radio"
                    name={`${id}-accent`}
                    value={value}
                    aria-label={label}
                    checked={accent === value}
                    onChange={() => setAccent(value)}
                  />
                  <span>{accent === value && <Check size={15} aria-hidden="true" />}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p>Saved on this device.</p>
        </section>
      )}
    </div>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="umrah-auth">
      <header className="umrah-auth-header">
        <div className="umrah-auth-controls">
          <ThemeToggle />
          <AppearanceControl />
        </div>
      </header>
      <section className="umrah-auth-main" aria-label="Account access">
        <Brand />
        <div className="auth-card umrah-auth-card">{children}</div>
      </section>
    </main>
  );
}
