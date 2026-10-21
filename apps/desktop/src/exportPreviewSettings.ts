export const EXPORT_PREVIEW_STORAGE_KEY = "chemdraft.export.preview-and-presets.v1";

export function loadExportPreviewEnabled(): boolean {
  try { return globalThis.localStorage?.getItem(EXPORT_PREVIEW_STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function saveExportPreviewEnabled(enabled: boolean): void {
  try { globalThis.localStorage?.setItem(EXPORT_PREVIEW_STORAGE_KEY, String(enabled)); }
  catch { /* Persistence is best effort, as for other preferences. */ }
}
