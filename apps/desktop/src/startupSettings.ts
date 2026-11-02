/** Launch-only preference; synchronous storage matches the other boolean preferences. */
const STORAGE_KEY = "chemdraft.startup.start-fresh.v1";

export function loadStartWithFreshDocument(): boolean {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function saveStartWithFreshDocument(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, String(enabled)); }
  catch { /* Persistence is best effort, as for other preferences. */ }
}
