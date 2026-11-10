import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { createThemeStore, type AccentTheme, type ThemePreference, type ThemeSnapshot } from "./theme-store";
export type { AccentTheme, Theme, ThemePreference } from "./theme-store";

type ThemeContextValue = ThemeSnapshot & {
  setPreference: (value: ThemePreference) => void;
  setAccent: (value: AccentTheme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  preference: "system",
  accent: "gold",
  setPreference: () => {},
  setAccent: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createThemeStore(typeof window === "undefined" ? null : window));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return (
    <ThemeContext.Provider value={{ ...snapshot, setPreference: store.setPreference, setAccent: store.setAccent, toggle: store.toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
      title={`Switch to ${dark ? "light" : "dark"} mode`}
      onClick={toggle}
    >
      {dark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
      <span>{dark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}
