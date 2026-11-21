import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";

/**
 * User setting for which keyboard-shortcut scheme the app uses.
 *
 *   chemdraft — the native ChemDraft bindings (default).
 *   chemdraw  — bindings that mirror ChemDraw's defaults, for users migrating
 *               from ChemDraw. Covers tool hotkeys, hovered atom/bond hotkeys,
 *               and the menu chords that differ between the two apps.
 */

export type KeybindingScheme = "chemdraft" | "chemdraw";

export const KEYBINDING_SCHEME_LABELS: Record<KeybindingScheme, string> = {
  chemdraft: "ChemDraft",
  chemdraw: "Classic desktop-compatible"
};

export interface KeybindingSettings {
  scheme: KeybindingScheme;
  overrides?: Partial<Record<KeybindingScheme, ShortcutOverrides>>;
}

export const DEFAULT_KEYBINDING_SETTINGS: KeybindingSettings = {
  scheme: "chemdraft"
};

export const KEYBINDING_STORAGE_KEY = "chemdraft.keybindings.v1";

export function isKeybindingScheme(value: unknown): value is KeybindingScheme {
  return value === "chemdraft" || value === "chemdraw";
}

export function isKeybindingSettings(value: unknown): value is KeybindingSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Partial<KeybindingSettings>;
  return isKeybindingScheme(settings.scheme) && (settings.overrides === undefined || isSchemeOverrides(settings.overrides));
}

export function loadKeybindingSettings(): KeybindingSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEYBINDING_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<KeybindingSettings> | null) : null;
    if (parsed && typeof parsed === "object") {
      return {
        scheme: isKeybindingScheme(parsed.scheme) ? parsed.scheme : DEFAULT_KEYBINDING_SETTINGS.scheme,
        ...(isSchemeOverrides(parsed.overrides) ? { overrides: parsed.overrides } : {})
      };
    }
  } catch {
    // Corrupt/blocked storage — fall back to the default.
  }
  return DEFAULT_KEYBINDING_SETTINGS;
}

export function saveKeybindingSettings(settings: KeybindingSettings): void {
  try {
    globalThis.localStorage?.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort (private mode / disabled storage).
  }
}

export function isSchemeOverrides(value: unknown): value is KeybindingSettings["overrides"] {
  const entries = (object: unknown): [string, unknown][] | undefined =>
    object && typeof object === "object" && !Array.isArray(object) ? Object.entries(object) : undefined;
  return entries(value)?.every(([scheme, scopes]) => isKeybindingScheme(scheme) &&
    entries(scopes)?.every(([scope, rows]) => ["commands", "atom", "bond"].includes(scope) &&
      entries(rows)?.every(([id, keys]) => /^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(id) && Array.isArray(keys) &&
        keys.length <= 8 && keys.every(key => typeof key === "string" && key.length > 0 && key.length <= 80)))) === true;
}
