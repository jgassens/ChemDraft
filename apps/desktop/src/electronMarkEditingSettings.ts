export const ELECTRON_MARK_EDITING_STORAGE_KEY = "chemdraft.direct-electron-mark-editing.v1";

export function loadDirectElectronMarkEditing(): boolean {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(ELECTRON_MARK_EDITING_STORAGE_KEY) ?? "false") === true;
  } catch { return false; }
}

export function saveDirectElectronMarkEditing(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(ELECTRON_MARK_EDITING_STORAGE_KEY, JSON.stringify(enabled)); }
  catch { /* Best-effort, matching other boolean preferences. */ }
}
