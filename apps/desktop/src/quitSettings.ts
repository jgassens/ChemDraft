const STORAGE_KEY = "chemdraft.quit.ask-to-save.v1";

export function loadAskToSaveBeforeQuit(): boolean {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function saveAskToSaveBeforeQuit(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, String(enabled)); }
  catch { /* Persistence is best effort, as for other preferences. */ }
}
