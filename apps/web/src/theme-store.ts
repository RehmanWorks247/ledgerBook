export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export type AccentTheme = "green" | "blue" | "violet" | "amber" | "rose" | "neutral";

export type ThemeSnapshot = Readonly<{
  theme: Theme;
  preference: ThemePreference;
  accent: AccentTheme;
}>;

export const THEME_STORAGE_KEY = "ledgerbook-theme";
export const ACCENT_STORAGE_KEY = "ledgerbook-accent";

function asPreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function asAccent(value: string | null): AccentTheme {
  return value === "blue" || value === "violet" || value === "amber" ||
    value === "rose" || value === "neutral" ? value : "green";
}

const serverSnapshot: ThemeSnapshot = { theme: "light", preference: "system", accent: "green" };

/** Keep choices for this session even when browser storage is blocked. */
export function createThemeStore(browser: Window | null) {
  const media = browser?.matchMedia("(prefers-color-scheme: dark)");
  const readStorage = (key: string) => {
    try {
      return browser?.localStorage.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  let preference = asPreference(readStorage(THEME_STORAGE_KEY));
  let accent = asAccent(readStorage(ACCENT_STORAGE_KEY));
  const resolvedTheme = (): Theme => preference === "system"
    ? media?.matches ? "dark" : "light"
    : preference;
  let snapshot: ThemeSnapshot = { theme: resolvedTheme(), preference, accent };
  const listeners = new Set<() => void>();

  const apply = () => {
    if (!browser) return;
    const document = browser.document;
    document.documentElement.dataset.theme = snapshot.theme;
    document.documentElement.dataset.accent = snapshot.accent;
    document.documentElement.style.colorScheme = snapshot.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      snapshot.theme === "dark" ? "#0a0a0a" : "#fafafa",
    );
  };

  const update = () => {
    const theme = resolvedTheme();
    const changed = snapshot.theme !== theme || snapshot.preference !== preference || snapshot.accent !== accent;
    if (changed) snapshot = { theme, preference, accent };
    apply();
    if (changed) listeners.forEach((listener) => listener());
  };

  const receiveStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== ACCENT_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== browser?.localStorage) return;
    } catch {
      return;
    }
    if (event.key === null || event.key === THEME_STORAGE_KEY) preference = asPreference(event.newValue);
    if (event.key === null || event.key === ACCENT_STORAGE_KEY) accent = asAccent(event.newValue);
    update();
  };

  const setPreference = (value: ThemePreference) => {
    preference = asPreference(value);
    try {
      if (preference === "system") browser?.localStorage.removeItem(THEME_STORAGE_KEY);
      else browser?.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // The in-memory choice still applies for this session.
    }
    update();
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        media?.addEventListener("change", update);
        browser?.addEventListener("storage", receiveStorage);
        update();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          media?.removeEventListener("change", update);
          browser?.removeEventListener("storage", receiveStorage);
        }
      };
    },
    setPreference,
    setAccent(value: AccentTheme) {
      accent = asAccent(value);
      try {
        browser?.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
      } catch {
        // The in-memory choice still applies for this session.
      }
      update();
    },
    toggle() {
      setPreference(snapshot.theme === "dark" ? "light" : "dark");
    },
  };
}
