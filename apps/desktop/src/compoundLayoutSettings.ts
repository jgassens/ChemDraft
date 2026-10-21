export interface CompoundLayoutSettings { enabled: boolean }
export const COMPOUND_LAYOUT_STORAGE_KEY = "chemdraft.compound-layout-tools.v1";
export function isCompoundLayoutSettings(value: unknown): value is CompoundLayoutSettings {
  return !!value && typeof value === "object" && typeof (value as CompoundLayoutSettings).enabled === "boolean";
}
export function loadCompoundLayoutSettings(): CompoundLayoutSettings {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(COMPOUND_LAYOUT_STORAGE_KEY) ?? "null");
    if (isCompoundLayoutSettings(value)) return value;
  } catch { /* Missing/corrupt/blocked storage keeps this opt-in feature off. */ }
  return { enabled: false };
}
export function saveCompoundLayoutSettings(settings: CompoundLayoutSettings): void {
  try { globalThis.localStorage?.setItem(COMPOUND_LAYOUT_STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* Best-effort, matching the existing Preferences storage policy. */ }
}
export function isCompoundLayoutCommand(id: string): boolean {
  return id.startsWith("layout.arrange.") || id === "layout.adjustArrangementSpacing";
}
