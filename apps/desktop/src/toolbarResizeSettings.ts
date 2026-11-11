export const TOOLBAR_RESIZE_STORAGE_KEY = "chemdraft.resizable-floating-toolbars.v1";
export type ResizableToolbarsChange = boolean;

export function loadResizableFloatingToolbars(): boolean {
  try { return JSON.parse(globalThis.localStorage?.getItem(TOOLBAR_RESIZE_STORAGE_KEY) ?? "false") === true; }
  catch { return false; }
}

export function saveResizableFloatingToolbars(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(TOOLBAR_RESIZE_STORAGE_KEY, JSON.stringify(enabled)); }
  catch { /* Persistence is best effort. */ }
}
