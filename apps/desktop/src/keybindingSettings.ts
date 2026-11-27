import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";

/**
 * ChemDraft has one built-in keyboard-shortcut set (owner decision, 2026-11-26). The user can change
 * any key in Preferences > Keyboard; those custom keys are the only per-user shortcut state.
 *
 * The set's id, "chemdraw", is a storage id only and is never shown. The native preferences file
 * (lib.rs `StoredShortcutSetId`), the native menu's `set_keybinding_scheme` (lib.rs
 * `KeybindingScheme`), and the tour's dialog protocol carry it, and custom keys are stored under it
 * (`overrides.chemdraw`).
 *
 * "chemdraft" names a second preset that existed before. It is read only by the one-time move
 * to the single set (shortcutDefaultMigration.ts); nothing else resolves keys from it.
 */
export type KeybindingScheme = "chemdraw";

/** The one built-in shortcut set. */
export const KEYBINDING_SCHEME: KeybindingScheme = "chemdraw";

/** The retired preset's id, as older versions stored it. */
export const LEGACY_KEYBINDING_SCHEME = "chemdraft";

/** A set id as older versions may have stored it. */
export type StoredKeybindingScheme = KeybindingScheme | typeof LEGACY_KEYBINDING_SCHEME;

/** Custom keys by set id, as stored. Only `chemdraw` is applied. */
export type StoredShortcutOverrides = Partial<Record<StoredKeybindingScheme, ShortcutOverrides>>;

export interface KeybindingSettings {
  scheme: KeybindingScheme;
  overrides?: StoredShortcutOverrides;
}

export const DEFAULT_KEYBINDING_SETTINGS: KeybindingSettings = {
  scheme: KEYBINDING_SCHEME
};

export const KEYBINDING_STORAGE_KEY = "chemdraft.keybindings.v1";

export function isKeybindingScheme(value: unknown): value is KeybindingScheme {
  return value === KEYBINDING_SCHEME;
}

export function isStoredKeybindingScheme(value: unknown): value is StoredKeybindingScheme {
  return value === KEYBINDING_SCHEME || value === LEGACY_KEYBINDING_SCHEME;
}

export function isKeybindingSettings(value: unknown): value is KeybindingSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Partial<KeybindingSettings>;
  return isKeybindingScheme(settings.scheme) && (settings.overrides === undefined || isSchemeOverrides(settings.overrides));
}

/**
 * The settings this webview uses. Whatever set id the cache holds (the retired preset's before the
 * move to one set, an unknown value, or none), the result is the one set; valid custom keys are kept.
 * Never throws: corrupt or blocked storage reads as the defaults.
 */
export function loadKeybindingSettings(): KeybindingSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEYBINDING_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<KeybindingSettings> | null) : null;
    if (parsed && typeof parsed === "object" && isSchemeOverrides(parsed.overrides)) {
      return { scheme: KEYBINDING_SCHEME, overrides: parsed.overrides };
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

/**
 * Set while the webview cache holds custom keys for the set that the native preferences file has not
 * saved: the move to the single set (shortcutDefaultMigration.ts) sets it when it combined the two
 * stores but could not write the result to the native file. While it is set the cache's keys are the
 * user's, so a window saves them to the native file rather than replacing them with the file's
 * (useShortcutPreference.ts); a saved edit in Preferences, or a launch whose stores agree, clears it.
 */
export const UNSAVED_SHORTCUTS_STORAGE_KEY = "chemdraft.keybindings.unsavedInPreferencesFile";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Whether the cache holds custom keys the native file has not saved. False when storage is unreadable. */
export function hasUnsavedShortcuts(storage?: FlagStorage): boolean {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

/** Record whether the cache holds custom keys the native file has not saved. Best-effort. */
export function setUnsavedShortcuts(unsaved: boolean, storage?: FlagStorage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    if (unsaved) target?.setItem(UNSAVED_SHORTCUTS_STORAGE_KEY, "1");
    else if (target?.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY) != null) target.removeItem(UNSAVED_SHORTCUTS_STORAGE_KEY);
  } catch {
    // Persistence is best-effort, as for the settings themselves.
  }
}

const SHORTCUT_SCOPES = ["commands", "atom", "bond"] as const;

function objectEntries(object: unknown): [string, unknown][] | undefined {
  return object && typeof object === "object" && !Array.isArray(object) ? Object.entries(object) : undefined;
}

function isShortcutOverrideRow(id: string, keys: unknown): keys is string[] {
  return /^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(id) && Array.isArray(keys) && keys.length <= 8 &&
    keys.every(key => typeof key === "string" && key.length > 0 && key.length <= 80);
}

export function isSchemeOverrides(value: unknown): value is StoredShortcutOverrides {
  return objectEntries(value)?.every(([scheme, scopes]) => isStoredKeybindingScheme(scheme) &&
    objectEntries(scopes)?.every(([scope, rows]) => (SHORTCUT_SCOPES as readonly string[]).includes(scope) &&
      objectEntries(rows)?.every(([id, keys]) => isShortcutOverrideRow(id, keys)))) === true;
}

/**
 * The valid part of stored custom keys, entry by entry: what `isSchemeOverrides` accepts is returned
 * as it is; anything else (an unknown set id or scope, a malformed command id, keys of the wrong
 * shape) drops only that entry, never its valid neighbours. Scopes left with no entries are omitted.
 * Undefined when the value is not an object at all. Never throws.
 */
export function validSchemeOverrides(value: unknown): StoredShortcutOverrides | undefined {
  try {
    const schemes = objectEntries(value);
    if (!schemes) return undefined;
    const valid: StoredShortcutOverrides = {};
    for (const [scheme, scopes] of schemes) {
      if (!isStoredKeybindingScheme(scheme)) continue;
      const set: Record<string, Record<string, string[]>> = {};
      for (const [scope, rows] of objectEntries(scopes) ?? []) {
        if (!(SHORTCUT_SCOPES as readonly string[]).includes(scope)) continue;
        const kept = (objectEntries(rows) ?? []).filter(([id, keys]) => isShortcutOverrideRow(id, keys));
        if (kept.length) set[scope] = Object.fromEntries(kept) as Record<string, string[]>;
      }
      valid[scheme] = set as ShortcutOverrides;
    }
    return valid;
  } catch {
    return undefined;
  }
}
