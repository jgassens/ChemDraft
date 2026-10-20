const STORAGE_KEY = "chemdraft.export.preview-and-presets.v1";

export function loadExportPreviewEnabled(): boolean {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function saveExportPreviewEnabled(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, String(enabled)); }
  catch { /* Persistence is best effort, as for other preferences. */ }
}
