/**
 * User setting for which keyboard-shortcut scheme the app uses.
 *
 *   chemdraft — the native ChemDraft bindings (default).
 *   chemdraw  — bindings that mirror ChemDraw's defaults, for users migrating
 *               from ChemDraw. Covers tool hotkeys, hovered atom/bond hotkeys,
 *               and the menu chords that differ between the two apps.
 */

export type KeybindingScheme = "chemdraft" | "chemdraw";

export interface KeybindingSettings {
  scheme: KeybindingScheme;
}

export const DEFAULT_KEYBINDING_SETTINGS: KeybindingSettings = {
  scheme: "chemdraft"
};

const STORAGE_KEY = "chemdraft.keybindings.v1";

export function isKeybindingScheme(value: unknown): value is KeybindingScheme {
  return value === "chemdraft" || value === "chemdraw";
}

export function isKeybindingSettings(value: unknown): value is KeybindingSettings {
  if (typeof value !== "object" || value === null) return false;
  return isKeybindingScheme((value as Partial<KeybindingSettings>).scheme);
}

export function loadKeybindingSettings(): KeybindingSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<KeybindingSettings> | null) : null;
    if (parsed && typeof parsed === "object") {
      return {
        scheme: isKeybindingScheme(parsed.scheme) ? parsed.scheme : DEFAULT_KEYBINDING_SETTINGS.scheme
      };
    }
  } catch {
    // Corrupt/blocked storage — fall back to the default.
  }
  return DEFAULT_KEYBINDING_SETTINGS;
}

export function saveKeybindingSettings(settings: KeybindingSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort (private mode / disabled storage).
  }
}
