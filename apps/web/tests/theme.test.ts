import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ACCENT_STORAGE_KEY, createThemeStore, THEME_STORAGE_KEY, type AccentTheme } from "../src/theme-store";

function fixture({ saved = null, savedAccent = null, dark = false, blocked = false }: {
  saved?: string | null;
  savedAccent?: string | null;
  dark?: boolean;
  blocked?: boolean;
} = {}) {
  const stored = new Map<string, string>();
  if (saved !== null) stored.set(THEME_STORAGE_KEY, saved);
  if (savedAccent !== null) stored.set(ACCENT_STORAGE_KEY, savedAccent);
  const mediaTarget = new EventTarget();
  const media = Object.assign(mediaTarget, { matches: dark });
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const meta = { content: "", setAttribute(_name: string, value: string) { this.content = value; } };
  const localStorage = {
    getItem(key: string) {
      if (blocked) throw new Error("Storage unavailable");
      return stored.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (blocked) throw new Error("Storage unavailable");
      stored.set(key, value);
    },
    removeItem(key: string) {
      if (blocked) throw new Error("Storage unavailable");
      stored.delete(key);
    },
  };
  const browser = Object.assign(new EventTarget(), {
    localStorage,
    matchMedia: () => media,
    document: { documentElement: root, querySelector: () => meta },
  });
  return {
    browser: browser as unknown as Window,
    root,
    meta,
    get stored() { return stored.get(THEME_STORAGE_KEY) ?? null; },
    get storedAccent() { return stored.get(ACCENT_STORAGE_KEY) ?? null; },
    systemDark(value: boolean) {
      media.matches = value;
      media.dispatchEvent(new Event("change"));
    },
    storage(value: string | null, key: string | null = THEME_STORAGE_KEY) {
      if (key === null) stored.clear();
      else if (value === null) stored.delete(key);
      else stored.set(key, value);
      browser.dispatchEvent(Object.assign(new Event("storage"), {
        key, newValue: value, storageArea: localStorage,
      }));
    },
  };
}

test("theme follows the system until a user chooses, then persists across reloads", () => {
  const env = fixture({ dark: true });
  const store = createThemeStore(env.browser);
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "system", accent: "gold" });
  assert.equal(env.root.dataset.theme, "dark");
  assert.equal(env.root.dataset.accent, "gold");
  assert.equal(env.root.style.colorScheme, "dark");
  assert.equal(env.meta.content, "#0a0a0a");

  env.systemDark(false);
  assert.equal(store.getSnapshot().theme, "light");
  assert.equal(updates, 1);
  store.toggle();
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "dark", accent: "gold" });
  assert.equal(env.stored, "dark");
  env.systemDark(true);
  env.systemDark(false);
  assert.equal(store.getSnapshot().theme, "dark", "an explicit choice takes precedence over the OS");
  assert.deepEqual(createThemeStore(env.browser).getSnapshot(), store.getSnapshot(), "reload restores the choice");
  store.setPreference("system");
  assert.equal(env.stored, null, "system mode removes the explicit mode preference");
  assert.deepEqual(store.getSnapshot(), { theme: "light", preference: "system", accent: "gold" });
  env.systemDark(true);
  assert.equal(store.getSnapshot().theme, "dark");
  stop();
});

test("accent and mode are independently persisted and unset preferences receive the gold default", () => {
  const env = fixture({ saved: "dark" });
  const store = createThemeStore(env.browser);
  const stop = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "dark", accent: "gold" });
  const accents: AccentTheme[] = ["gold", "green", "blue", "violet", "amber", "rose", "neutral"];
  for (const accent of accents) {
    store.setAccent(accent);
    assert.equal(env.storedAccent, accent);
    assert.equal(env.root.dataset.accent, accent);
    assert.equal(env.stored, "dark", "accent selection preserves the mode preference");
    assert.deepEqual(createThemeStore(env.browser).getSnapshot(), { theme: "dark", preference: "dark", accent });
  }
  store.setPreference("light");
  assert.deepEqual(store.getSnapshot(), { theme: "light", preference: "light", accent: "neutral" });
  store.toggle();
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "dark", accent: "neutral" });
  assert.equal(env.storedAccent, "neutral", "mode controls preserve the accent preference");
  stop();
});

test("mode and accent sync across tabs, and clearing preferences restores the defaults", () => {
  const env = fixture({ saved: "light", savedAccent: "blue", dark: true });
  const store = createThemeStore(env.browser);
  const stop = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { theme: "light", preference: "light", accent: "blue" });
  env.storage("dark", "unrelated-setting");
  assert.equal(store.getSnapshot().theme, "light");
  env.storage("dark");
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "dark", accent: "blue" });
  env.storage("rose", ACCENT_STORAGE_KEY);
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "dark", accent: "rose" });
  env.storage(null);
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "system", accent: "rose" });
  env.storage(null, ACCENT_STORAGE_KEY);
  assert.equal(store.getSnapshot().accent, "gold");
  env.storage("amber", ACCENT_STORAGE_KEY);
  env.storage(null, null);
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "system", accent: "gold" });
  env.systemDark(false);
  assert.equal(store.getSnapshot().theme, "light");
  stop();
  env.systemDark(true);
  assert.equal(store.getSnapshot().theme, "light", "unmount removes external listeners");
  const stopAgain = store.subscribe(() => {});
  assert.equal(store.getSnapshot().theme, "dark", "remount reads the current system preference");
  stopAgain();
});

test("invalid preferences and blocked storage do not prevent changing mode or accent", () => {
  const invalid = fixture({ saved: "unexpected", savedAccent: "invalid", dark: true });
  assert.deepEqual(createThemeStore(invalid.browser).getSnapshot(), { theme: "dark", preference: "system", accent: "gold" });
  const env = fixture({ blocked: true });
  const store = createThemeStore(env.browser);
  const stop = store.subscribe(() => {});
  assert.doesNotThrow(() => store.toggle());
  assert.doesNotThrow(() => store.setAccent("violet"));
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "dark", accent: "violet" });
  env.systemDark(true);
  env.systemDark(false);
  assert.equal(store.getSnapshot().theme, "dark", "session choice survives unavailable persistence");
  assert.doesNotThrow(() => store.toggle());
  assert.equal(store.getSnapshot().theme, "light");
  assert.doesNotThrow(() => store.setPreference("system"));
  env.systemDark(true);
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "system", accent: "violet" });
  stop();
});

test("snapshot identity changes only when mode, preference, or accent changes", () => {
  const env = fixture();
  const store = createThemeStore(env.browser);
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  const initial = store.getSnapshot();
  assert.strictEqual(store.getSnapshot(), initial);
  assert.strictEqual(store.getServerSnapshot(), store.getServerSnapshot());
  store.setAccent("gold");
  store.setPreference("system");
  env.systemDark(false);
  assert.strictEqual(store.getSnapshot(), initial);
  assert.equal(updates, 0);
  store.setPreference("light");
  assert.notStrictEqual(store.getSnapshot(), initial, "settings update when the preference changes but resolved mode does not");
  assert.equal(updates, 1);
  const explicit = store.getSnapshot();
  env.systemDark(true);
  assert.strictEqual(store.getSnapshot(), explicit, "OS changes do not rerender an explicit mode");
  env.storage("violet", ACCENT_STORAGE_KEY);
  assert.equal(updates, 2);
  env.storage("invalid", ACCENT_STORAGE_KEY);
  assert.equal(store.getSnapshot().accent, "gold");
  env.storage("invalid");
  assert.deepEqual(store.getSnapshot(), { theme: "dark", preference: "system", accent: "gold" });
  stop();
});

test("pre-paint bootstrap and the React store agree on mode and accent", () => {
  const script = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");
  for (const options of [
    { saved: "dark", dark: false },
    { saved: "light", dark: true },
    { saved: "invalid", dark: true },
    { dark: false },
    { dark: true, blocked: true },
    ...["gold", "green", "blue", "violet", "amber", "rose", "neutral", "invalid"].flatMap((savedAccent) => [
      { saved: "light", savedAccent, dark: true },
      { saved: "dark", savedAccent, dark: false },
      { saved: "system", savedAccent, dark: true },
    ]),
  ]) {
    const env = fixture(options);
    runInNewContext(script, {
      localStorage: env.browser.localStorage,
      window: env.browser,
      document: env.browser.document,
    });
    const beforeMount = { theme: env.root.dataset.theme, accent: env.root.dataset.accent, scheme: env.root.style.colorScheme, color: env.meta.content };
    const store = createThemeStore(env.browser);
    const stop = store.subscribe(() => {});
    assert.deepEqual({ theme: env.root.dataset.theme, accent: env.root.dataset.accent, scheme: env.root.style.colorScheme, color: env.meta.content }, beforeMount);
    assert.equal(store.getSnapshot().theme, beforeMount.theme);
    assert.equal(store.getSnapshot().accent, beforeMount.accent);
    stop();
  }
});
