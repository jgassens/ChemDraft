/** User defaults for drawing; never applied while opening, importing or pasting documents. */
export type DefaultDoubleBond = "offset" | "centred";
export interface DrawingSettings { defaultDoubleBond: DefaultDoubleBond }

export const DRAWING_SETTINGS_STORAGE_KEY = "chemdraft.drawing-settings.v1";

export function isDrawingSettings(value: unknown): value is DrawingSettings {
  if (!value || typeof value !== "object") return false;
  const position = (value as Partial<DrawingSettings>).defaultDoubleBond;
  return position === "offset" || position === "centred";
}

export function loadDrawingSettings(): DrawingSettings {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(DRAWING_SETTINGS_STORAGE_KEY) ?? "null");
    if (isDrawingSettings(value)) return value;
  } catch { /* Missing/corrupt/blocked storage retains the existing drawing behavior. */ }
  return { defaultDoubleBond: "offset" };
}

export function saveDrawingSettings(settings: DrawingSettings): void {
  try { globalThis.localStorage?.setItem(DRAWING_SETTINGS_STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* Best-effort, matching the other user preferences. */ }
}
