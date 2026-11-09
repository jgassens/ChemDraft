export interface CompoundLayoutSettings {
  enabled: boolean;
  formattedReactionConditions?: boolean;
}
export const compoundLayoutFeatures = [
  { key: "formattedReactionConditions", title: "Formatted Reaction Conditions", description: "Add and edit conditions with subscript and superscript formatting." }
] as const;
export const COMPOUND_LAYOUT_STORAGE_KEY = "chemdraft.compound-layout-tools.v1";
export function isCompoundLayoutSettings(value: unknown): value is CompoundLayoutSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as CompoundLayoutSettings;
  return typeof settings.enabled === "boolean" && compoundLayoutFeatures.every(({ key }) =>
    settings[key] === undefined || typeof settings[key] === "boolean");
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

/** Gate authoring commands only; rendering and existing document attachments always stay active. */
export function compoundLayoutCommandDisabledReason(id: string, settings: CompoundLayoutSettings): string | undefined {
  const feature = id === "arrow.conditions" ? "formattedReactionConditions" : undefined;
  if (!feature && !isCompoundLayoutCommand(id)) return undefined;
  if (!settings.enabled) return "Enable Compound layout tools in Settings";
  if (feature && !settings[feature]) return `Enable ${compoundLayoutFeatures.find(item => item.key === feature)!.title} in Settings`;
  return undefined;
}

export function isCompoundLayoutCommandHidden(id: string, settings: CompoundLayoutSettings): boolean {
  return !!compoundLayoutCommandDisabledReason(id, settings);
}
