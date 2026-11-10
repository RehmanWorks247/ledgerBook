// Only opted-in read views use this cache. It never persists to disk and every
// mount still revalidates against the API. Editors continue to fetch fresh data.
const maxEntries = 60;
const maxAge = 5 * 60_000;
const entries = new Map<string, { data: unknown; expires: number }>();
let scope: string | null = null;
let generation = 0;

export function resourceCacheScope() { return scope; }
export function resourceCacheGeneration() { return generation; }

export function clearResourceCache() {
  entries.clear();
  generation++;
}

export function setResourceCacheScope(next: string | null) {
  if (scope === next) return;
  scope = next;
  clearResourceCache();
}

export function readResourceCache<T>(path: string): T | undefined {
  const entry = entries.get(path);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    entries.delete(path);
    return undefined;
  }
  return entry.data as T;
}

export function writeResourceCache(path: string, data: unknown, requestedGeneration: number) {
  // A request started before a write/sign-out must not repopulate invalid data.
  if (scope === null || requestedGeneration !== generation) return;
  entries.delete(path);
  entries.set(path, { data, expires: Date.now() + maxAge });
  if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
}

export function forgetResourceCache(path: string) { entries.delete(path); }
