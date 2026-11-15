/** Pure model for four two-slot custom color swatches. */
export const CUSTOM_SWATCH_COUNT = 4;
export const CMYK_APPROXIMATION_NOTE = "Approximate: CMYK is converted to screen RGB without a color profile.";
export const CUSTOM_SWATCH_STORAGE_KEY = "chemdraft.customColorSwatches.v1";
const STORAGE_KEY = CUSTOM_SWATCH_STORAGE_KEY;

export type CustomSwatchNumber = 1 | 2 | 3 | 4;
export type CustomSwatchSlot = 1 | 2;
export type CustomSwatchAction = "apply" | "edit" | "clear";
export type CustomSwatchState = Record<CustomSwatchNumber, { slot1?: string; slot2?: string }>;
export type ColorInputResult = { ok: true; hex: string; approximate: boolean } | { ok: false; message: string };
export type SwatchStorage = Pick<Storage, "getItem" | "setItem">;

/** IDs are ordered by swatch, slot, then apply/edit/clear. */
export function customSwatchCommandId(swatch: CustomSwatchNumber, slot: CustomSwatchSlot, action: CustomSwatchAction): string {
  return `color.customSwatch.${swatch}.slot${slot}.${action}`;
}
export function parseCustomSwatchCommandId(id: string): { swatch: CustomSwatchNumber; slot: CustomSwatchSlot; action: CustomSwatchAction } | undefined {
  const match = /^color\.customSwatch\.([1-4])\.slot([12])\.(apply|edit|clear)$(?![\s\S])/.exec(id);
  return match ? { swatch: Number(match[1]) as CustomSwatchNumber, slot: Number(match[2]) as CustomSwatchSlot, action: match[3] as CustomSwatchAction } : undefined;
}
export function allCustomSwatchCommandIds(): string[] {
  return ([1, 2, 3, 4] as const).flatMap((swatch) => ([1, 2] as const).flatMap((slot) =>
    (["apply", "edit", "clear"] as const).map((action) => customSwatchCommandId(swatch, slot, action))));
}

/** Matches normalizeHexColor's shorthand expansion and lowercase normalization. */
export function parseHexColorInput(text: string): ColorInputResult {
  const digits = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{8}$/.test(digits) || /^[0-9a-f]{4}$/.test(digits)) {
    return { ok: false, message: `Hex color alpha is not supported, got ${JSON.stringify(text)}` };
  }
  if (/^[0-9a-f]{3}$/.test(digits)) return { ok: true, hex: `#${[...digits].map((digit) => digit + digit).join("")}`, approximate: false };
  if (/^[0-9a-f]{6}$/.test(digits)) return { ok: true, hex: `#${digits}`, approximate: false };
  return { ok: false, message: `Hex color must be 3 or 6 hex digits, got ${JSON.stringify(text)}` };
}

function channel(value: string | number, name: string, whole: boolean): number | string {
  const raw = String(value);
  const trimmed = raw.trim();
  const validSyntax = whole ? /^\d+$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/;
  const number = Number(trimmed);
  if (!validSyntax.test(trimmed) || !Number.isFinite(number) || number < 0 || number > (whole ? 255 : 100)) {
    return `${name} must be ${whole ? "a whole number from 0 to 255" : "a percentage from 0 to 100"}, got ${raw}`;
  }
  return number;
}
function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
export function parseRgbColorInput(r: string | number, g: string | number, b: string | number): ColorInputResult {
  const values = [channel(r, "Red", true), channel(g, "Green", true), channel(b, "Blue", true)];
  const error = values.find((value): value is string => typeof value === "string");
  if (error !== undefined) return { ok: false, message: error };
  return { ok: true, hex: rgbHex(values[0] as number, values[1] as number, values[2] as number), approximate: false };
}
export function parseCmykColorInput(c: string | number, m: string | number, y: string | number, k: string | number): ColorInputResult {
  const values = [channel(c, "Cyan", false), channel(m, "Magenta", false), channel(y, "Yellow", false), channel(k, "Black", false)];
  const error = values.find((value): value is string => typeof value === "string");
  if (error !== undefined) return { ok: false, message: error };
  const [cyan, magenta, yellow, black] = values as number[];
  const component = (ink: number) => Math.round(255 * (1 - ink / 100) * (1 - black / 100));
  return { ok: true, hex: rgbHex(component(cyan), component(magenta), component(yellow)), approximate: true };
}
/** Returns undefined for invalid hex input. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const result = parseHexColorInput(hex);
  if (!result.ok) return undefined;
  return { r: parseInt(result.hex.slice(1, 3), 16), g: parseInt(result.hex.slice(3, 5), 16), b: parseInt(result.hex.slice(5, 7), 16) };
}
/** Naive device RGB-to-CMYK inverse, in percentages rounded to one decimal. */
export function rgbToCmyk(r: number, g: number, b: number): { c: number; m: number; y: number; k: number } {
  const black = 1 - Math.max(r, g, b) / 255;
  const round = (n: number) => Math.round(n * 1000) / 10;
  const ink = (n: number) => black === 1 ? 0 : round((1 - n / 255 - black) / (1 - black));
  return { c: ink(r), m: ink(g), y: ink(b), k: round(black) };
}

function emptyState(): CustomSwatchState { return { 1: {}, 2: {}, 3: {}, 4: {} }; }
/** Reads each slot independently; invalid stored entries are ignored. */
export function loadCustomSwatches(storage?: SwatchStorage): CustomSwatchState {
  const state = emptyState();
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
    if (!raw) return state;
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return state;
    for (const swatch of [1, 2, 3, 4] as const) {
      const entry = (data as Record<string, unknown>)[swatch];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const slot of ["slot1", "slot2"] as const) {
        const value = (entry as Record<string, unknown>)[slot];
        if (typeof value !== "string") continue;
        const parsed = parseHexColorInput(value);
        if (parsed.ok) state[swatch][slot] = parsed.hex;
      }
    }
  } catch { /* Storage and malformed JSON are best effort. */ }
  return state;
}
/** Reject invalid input rather than storing a color that cannot be displayed. */
export function setCustomSwatchSlot(state: CustomSwatchState, swatch: CustomSwatchNumber, slot: CustomSwatchSlot, hex: string): CustomSwatchState {
  const parsed = parseHexColorInput(hex);
  if (!parsed.ok) throw new Error(parsed.message);
  return { ...state, [swatch]: { ...state[swatch], [`slot${slot}`]: parsed.hex } };
}
export function clearCustomSwatchSlot(state: CustomSwatchState, swatch: CustomSwatchNumber, slot: CustomSwatchSlot): CustomSwatchState {
  const entry = { ...state[swatch] };
  delete entry[`slot${slot}`];
  return { ...state, [swatch]: entry };
}
export function saveCustomSwatches(state: CustomSwatchState, storage?: SwatchStorage): void {
  try { (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* Persistence is best effort. */ }
}
