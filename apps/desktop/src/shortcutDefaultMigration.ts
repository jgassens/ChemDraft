/**
 * One-time move to ChemDraft's single keyboard-shortcut set (owner decision, 2026-11-26).
 *
 * Older versions had two presets: "chemdraft" (the default before 1.2.3) and "chemdraw" (now the one
 * set, keybindingSettings.ts). On launch, before the document window mounts, this decides which
 * preset the install last used and records the single set:
 *
 *   - the native preferences file already names the single set: nothing to move. The custom keys are
 *     mirrored into the webview cache;
 *   - the set is named only in the webview cache (the browser build, or a native write that failed):
 *     it is copied to the native file;
 *   - the retired preset is named (native file, else cache), or nothing is named but the install
 *     existed before 1.2.3, when that preset was the unnamed default: the install moves. Its own
 *     custom keys for the retired preset (`overrides.chemdraft`) are carried into the set when no other
 *     command already uses the key (customKeyboardShortcuts.ts `mergeLegacyShortcutOverrides`); the
 *     others are dropped. A one-time status message tells the user (`peekShortcutSetNotice`). It is
 *     pending in the cache until the status line has shown it (`confirmShortcutSetNoticeShown`), so a
 *     launch that quits first still gets it;
 *   - a fresh install records the set and sees no message.
 *
 * On every branch the set's custom keys are taken from both stores entry by entry, never as one
 * store's whole map: the native file's entry wins for a command, the cache's other entries are kept
 * unless they collide with a key already in use, and an invalid entry in either store is dropped
 * alone. Where the native file lacks one of the combined keys it is written there too, so neither
 * store is ever overwritten with a map that lost a valid customization.
 *
 * The cache is written only after the native file has taken the combined keys. When that write fails,
 * neither store is touched and the failure is logged: on every branch that moves, the native file still
 * does not name the set, so the move is not recorded as done, and the next launch combines the same two
 * stores again and loses nothing. Meanwhile a window keeps the cache's keys rather than taking the
 * native file's (useShortcutPreference.ts), since only a native file that names the set is known to hold
 * every key the cache does. Nothing writes the native file in the background: a window's own reads
 * never write, so no stale map can land after an edit in Preferences.
 *
 * The set's id in the native file is the "done" marker (preferences.json has no room for a separate
 * flag: lib.rs parses it with deny_unknown_fields), so every later launch takes the first branch.
 * The retired preset's stored custom keys are left in place, unread.
 *
 * When the native preferences cannot be read, nothing is written and nothing moves this launch: the
 * app runs on the single set with whatever custom keys for it the cache holds, and the next launch
 * that can read the file moves the install. Nothing here throws to the caller, whatever is stored.
 *
 * Existing-install evidence, used only when no preset is named anywhere:
 *   1. toolbar-state.json (TOOLSET_LAYOUT_STATE_FILENAME in lib.rs) in the app data folder. Every
 *      desktop launch writes it at startup, on macOS and Windows alike, and has since before 1.1.1.
 *      A file that exists but cannot be read still counts.
 *   2. Any key in the native preferences file (tour seen, custom shortcuts; 1.2.2 and later).
 *   3. Any `chemdraft.` key in the webview's localStorage (the browser build's only store).
 * Behavior is the same on every platform; only the stores differ, and they come in through the host.
 */
import type { ShortcutOverrides, ShortcutPlatform, ShortcutScope } from "@chemdraft/shortcut-engine";
import type { DesktopPreferences } from "./desktopPreferences";
import {
  isStoredKeybindingScheme,
  KEYBINDING_SCHEME,
  KEYBINDING_STORAGE_KEY,
  LEGACY_KEYBINDING_SCHEME,
  type KeybindingSettings,
  type StoredKeybindingScheme,
  type StoredShortcutOverrides,
  validSchemeOverrides
} from "./keybindingSettings";

/**
 * Left in the webview cache by 1.2.3 release candidates whose launch could not read the native
 * preferences. Meaningless now; removed when found, and never counted as existing-install evidence.
 */
export const PENDING_FRESH_INSTALL_KEY = "chemdraft.shortcutDefault.pendingFresh";

/** Set once the move's status message has been shown, so a repeated move never shows it again. */
export const SHORTCUT_SET_NOTICE_SHOWN_KEY = "chemdraft.keybindings.singleSetNoticeShown";

/**
 * Set when the move is recorded and cleared once the status line has shown its message, so a launch
 * that quits in between still shows it on the next one. Never shown while SHORTCUT_SET_NOTICE_SHOWN_KEY
 * is set.
 */
export const SHORTCUT_SET_NOTICE_PENDING_KEY = "chemdraft.keybindings.singleSetNoticePending";

export interface ShortcutDefaultMigrationHost {
  /** The webview's localStorage, or undefined where it is unavailable. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> | undefined;
  /** The desktop runtime's native stores; undefined in the browser build. */
  native?: {
    /** Reads preferences.json. Rejects when it cannot be read or parsed. */
    readPreferences(): Promise<DesktopPreferences>;
    /** Applies a patch to preferences.json the way lib.rs `apply_patch` does. */
    writePreferences(patch: DesktopPreferences): Promise<unknown>;
    /** Whether toolbar-state.json exists. Rejects when it exists but cannot be read. */
    hasToolbarLayout(): Promise<boolean>;
  };
  /** The platform whose key conflicts decide which carried-over keys survive. Defaults to detection. */
  platform?: ShortcutPlatform;
}

export type ShortcutDefaultMigrationOutcome =
  | { kind: "current" | "fresh-install" | "preferences-unreadable" }
  /** Moved from the retired preset: `kept` custom keys carried over, `dropped` ones that conflicted. */
  | { kind: "migrated"; kept: number; dropped: number };

/** This launch's pending message, for a webview whose cache cannot record it. */
let noticePending = false;
/** Set once this process has shown the message, so it is never shown again even if the cache cannot record it. */
let noticeShown = false;

export async function migrateShortcutDefault(host: ShortcutDefaultMigrationHost): Promise<ShortcutDefaultMigrationOutcome> {
  let outcome: ShortcutDefaultMigrationOutcome;
  try {
    outcome = await resolveShortcutSet(host);
  } catch (error) {
    // Whatever was stored, the app still starts on the single set.
    console.error("Could not move to the single shortcut set", error);
    return { kind: "preferences-unreadable" };
  }
  if (outcome.kind === "migrated" && !noticeAlreadyShown(host.storage)) {
    noticePending = true;
    try {
      host.storage?.setItem(SHORTCUT_SET_NOTICE_PENDING_KEY, "1");
    } catch {
      // This launch still shows it from memory.
    }
  }
  return outcome;
}

/** The status message announcing the move: the owner's wording, the same on every platform. */
export const SHORTCUT_SET_NOTICE =
  "Keyboard shortcuts now use one standard set. You can change any key in Preferences ▸ Keyboard.";

/**
 * The move's status message, if the status line still has to show it: after a move, on the launch that
 * moved the install or on a later one if that launch quit before showing it. Records nothing, so a
 * launch that quits before showing it shows it next time; call `confirmShortcutSetNoticeShown` from the
 * same callback that puts it in the status line. Undefined once that has been called.
 */
export function peekShortcutSetNotice(
  storage: ShortcutDefaultMigrationHost["storage"] = defaultStorage()
): string | undefined {
  if (noticeShown) return undefined;
  const pending = noticePending || readFlag(storage, SHORTCUT_SET_NOTICE_PENDING_KEY);
  return pending && !noticeAlreadyShown(storage) ? SHORTCUT_SET_NOTICE : undefined;
}

/**
 * Record that the status line has shown the message `peekShortcutSetNotice` returned, so no later call,
 * on this launch or any other, returns it again.
 */
export function confirmShortcutSetNoticeShown(
  storage: ShortcutDefaultMigrationHost["storage"] = defaultStorage()
): void {
  noticeShown = true;
  noticePending = false;
  // Shown is recorded before pending is cleared, so a marker left behind can never show it twice.
  try {
    if (!noticeAlreadyShown(storage)) storage?.setItem(SHORTCUT_SET_NOTICE_SHOWN_KEY, "1");
  } catch {
    // Best-effort: the pending marker is cleared below, and this process remembers it was shown.
  }
  try {
    if (readFlag(storage, SHORTCUT_SET_NOTICE_PENDING_KEY)) storage?.removeItem(SHORTCUT_SET_NOTICE_PENDING_KEY);
  } catch {
    // The shown marker, when it could be written, keeps a leftover pending marker silent.
  }
}

/** Tests only: forget a pending notice and the once-per-process run. */
export function resetShortcutDefaultMigrationForTests(): void {
  noticePending = false;
  noticeShown = false;
  started = undefined;
}

async function resolveShortcutSet(host: ShortcutDefaultMigrationHost): Promise<ShortcutDefaultMigrationOutcome> {
  clearPendingFreshInstall(host.storage);
  let preferences: DesktopPreferences = {};
  if (host.native) {
    try {
      const read: unknown = await host.native.readPreferences();
      // Only a plain object holds preferences: a string's characters or an array's items are not stored
      // keys, and must not count as an existing install.
      preferences = read && typeof read === "object" && !Array.isArray(read) ? read as DesktopPreferences : {};
    } catch (error) {
      console.error("Could not read preferences to move to the single shortcut set", error);
      return { kind: "preferences-unreadable" };
    }
  }
  const nativeScheme = isStoredKeybindingScheme(preferences.shortcutScheme) ? preferences.shortcutScheme : undefined;
  const nativeOverrides = validSchemeOverrides(preferences.shortcutOverrides);
  const cached = readCache(host.storage);
  // Custom keys are combined entry by entry, never by taking one store's whole map: the native file's
  // entries win, the cache's fill the gaps unless they collide, and an invalid entry in either is
  // dropped alone. So a valid customization kept in only one store survives every branch below.
  const setKeys = await combineSetKeys(nativeOverrides?.[KEYBINDING_SCHEME], cached.overrides?.[KEYBINDING_SCHEME], host.platform);
  const legacy = combineEntries(nativeOverrides?.[LEGACY_KEYBINDING_SCHEME], cached.overrides?.[LEGACY_KEYBINDING_SCHEME]);
  const stored = (keys: ShortcutOverrides | undefined): StoredShortcutOverrides => ({
    ...(legacy ? { [LEGACY_KEYBINDING_SCHEME]: legacy } : {}),
    ...(keys ? { [KEYBINDING_SCHEME]: keys } : {})
  });
  // The native file gets the set's custom keys whenever its own copy lacks one of them.
  const setKeysPatch = (keys: ShortcutOverrides | undefined): DesktopPreferences =>
    sameKeys(keys, rawSetEntry(preferences)) ? {} : { shortcutOverrides: { [KEYBINDING_SCHEME]: keys ?? {} } };

  if (nativeScheme === KEYBINDING_SCHEME) {
    await recordSet(host, setKeysPatch(setKeys), stored(setKeys));
    return { kind: "current" };
  }

  const previous: StoredKeybindingScheme | undefined = nativeScheme ?? cached.scheme;
  if (previous === KEYBINDING_SCHEME) {
    // Named in the cache only: the set is copied to the native file with the combined custom keys.
    await recordSet(host, { shortcutScheme: KEYBINDING_SCHEME, ...setKeysPatch(setKeys) }, stored(setKeys));
    return { kind: "current" };
  }

  const movesFromRetiredPreset = previous === LEGACY_KEYBINDING_SCHEME || cached.present ||
    hasChemDraftStorage(host.storage) || Object.keys(preferences).length > 0 || await hasToolbarLayout(host);
  if (!movesFromRetiredPreset) {
    await recordSet(host, { shortcutScheme: KEYBINDING_SCHEME, ...setKeysPatch(setKeys) }, stored(setKeys));
    return { kind: "fresh-install" };
  }

  const merged = legacy
    ? (await import("./customKeyboardShortcuts")).mergeLegacyShortcutOverrides(legacy, setKeys, host.platform)
    : { overrides: setKeys, kept: 0, dropped: 0 };
  const movedKeys = withoutEmptyScopes(merged.overrides);
  await recordSet(host, { shortcutScheme: KEYBINDING_SCHEME, ...setKeysPatch(movedKeys) }, stored(movedKeys));
  return { kind: "migrated", kept: merged.kept, dropped: merged.dropped };
}

/**
 * Write the patch (if any) to the native file, then the combined custom keys to the cache. The cache is
 * written only once the native file has taken the patch: when that write fails, both stores are left
 * exactly as they were, so the cache never holds keys the native file lacks because of this move, and
 * the next launch combines the same stores again.
 */
async function recordSet(host: ShortcutDefaultMigrationHost, patch: DesktopPreferences, overrides: StoredShortcutOverrides): Promise<void> {
  if (Object.keys(patch).length > 0 && !await writeNative(host, patch)) return;
  mirrorCache(host.storage, overrides);
}

/**
 * The set's custom keys from both stores: `native` wins per command, and the cache's other entries are
 * added unless they collide (customKeyboardShortcuts.ts `mergeStoredShortcutOverrides`). The command
 * table is loaded only when the cache has an entry the native file lacks.
 */
async function combineSetKeys(
  native: ShortcutOverrides | undefined,
  cached: ShortcutOverrides | undefined,
  platform: ShortcutPlatform | undefined
): Promise<ShortcutOverrides | undefined> {
  const missing = SCOPES.some(scope => Object.keys(cached?.[scope] ?? {}).some(id => !Object.hasOwn(native?.[scope] ?? {}, id)));
  if (!missing) return withoutEmptyScopes(native);
  const { mergeStoredShortcutOverrides } = await import("./customKeyboardShortcuts");
  return withoutEmptyScopes(mergeStoredShortcutOverrides(native, cached, platform).overrides);
}

/** The retired preset's custom keys from both stores, `primary` winning per command. Never applied as they are. */
function combineEntries(primary: ShortcutOverrides | undefined, secondary: ShortcutOverrides | undefined): ShortcutOverrides | undefined {
  const combined: ShortcutOverrides = {};
  for (const scope of SCOPES) {
    const rows = { ...secondary?.[scope], ...primary?.[scope] };
    if (Object.keys(rows).length) combined[scope] = rows;
  }
  return withoutEmptyScopes(combined);
}

const SCOPES = ["commands", "atom", "bond"] as const satisfies readonly ShortcutScope[];

function withoutEmptyScopes(overrides: ShortcutOverrides | undefined): ShortcutOverrides | undefined {
  const kept = SCOPES.filter(scope => Object.keys(overrides?.[scope] ?? {}).length > 0);
  return kept.length ? Object.fromEntries(kept.map(scope => [scope, overrides?.[scope]])) as ShortcutOverrides : undefined;
}

/** The set's entry exactly as the native file holds it, valid or not. */
function rawSetEntry(preferences: DesktopPreferences): unknown {
  const overrides: unknown = preferences.shortcutOverrides;
  return overrides && typeof overrides === "object" && !Array.isArray(overrides)
    ? (overrides as Record<string, unknown>)[KEYBINDING_SCHEME]
    : undefined;
}

/** Whether the native file's raw set entry already holds exactly these custom keys (empty scopes ignored). */
function sameKeys(keys: ShortcutOverrides | undefined, raw: unknown): boolean {
  const scopes = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw).filter(([, rows]) => !(rows && typeof rows === "object" && !Array.isArray(rows) && Object.keys(rows).length === 0))
    : undefined;
  if (raw !== undefined && raw !== null && !scopes) return false;
  return stableJson(keys ?? {}) === stableJson(Object.fromEntries(scopes ?? []));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

let started: Promise<void> | undefined;

/**
 * Run the move once per process against the real stores. Never rejects: the document window
 * waits on it before mounting.
 */
export function runShortcutDefaultMigration(): Promise<void> {
  started ??= defaultHost()
    .then(migrateShortcutDefault)
    .then(() => undefined, error => {
      console.error("Could not move to the single shortcut set", error);
    });
  return started;
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

async function defaultHost(): Promise<ShortcutDefaultMigrationHost> {
  const [{ desktopPreferences }, { isDesktopRuntime, loadToolsetLayoutState }] = await Promise.all([
    import("./desktopPreferences"),
    import("./window-manager")
  ]);
  return {
    storage: defaultStorage(),
    native: isDesktopRuntime() ? {
      readPreferences: () => desktopPreferences(),
      writePreferences: patch => desktopPreferences(patch),
      hasToolbarLayout: async () => (await loadToolsetLayoutState()) !== undefined
    } : undefined
  };
}

/** Whether the native file took the patch (true where there is no native file). Never rejects. */
async function writeNative(host: ShortcutDefaultMigrationHost, patch: DesktopPreferences): Promise<boolean> {
  if (!host.native) return true;
  try {
    await host.native.writePreferences(patch);
    return true;
  } catch (error) {
    // Neither store records the move, so the next launch makes it again from the same stores.
    console.error("Could not save the shortcut set; it will be saved on the next launch", error);
    return false;
  }
}

async function hasToolbarLayout(host: ShortcutDefaultMigrationHost): Promise<boolean> {
  return host.native ? host.native.hasToolbarLayout().catch(() => true) : false;
}

function readCache(storage: ShortcutDefaultMigrationHost["storage"]): {
  present: boolean;
  scheme?: StoredKeybindingScheme;
  overrides?: StoredShortcutOverrides;
} {
  try {
    const raw = storage?.getItem(KEYBINDING_STORAGE_KEY);
    if (raw === null || raw === undefined) return { present: false };
    try {
      const parsed = JSON.parse(raw) as Partial<Record<keyof KeybindingSettings, unknown>> | null;
      const scheme = parsed?.scheme;
      const overrides = parsed?.overrides;
      return {
        present: true,
        scheme: isStoredKeybindingScheme(scheme) ? scheme : undefined,
        overrides: validSchemeOverrides(overrides)
      };
    } catch {
      return { present: true };
    }
  } catch {
    return { present: false };
  }
}

/** Write the single set and its custom keys into the webview cache. Leaves an identical cache untouched. */
function mirrorCache(storage: ShortcutDefaultMigrationHost["storage"], overrides: StoredShortcutOverrides | undefined): void {
  const settings: KeybindingSettings = { scheme: KEYBINDING_SCHEME, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) };
  try {
    const value = JSON.stringify(settings);
    if (storage?.getItem(KEYBINDING_STORAGE_KEY) !== value) storage?.setItem(KEYBINDING_STORAGE_KEY, value);
  } catch {
    // Best-effort, as in saveKeybindingSettings: every reader resolves the single set anyway.
  }
}

function noticeAlreadyShown(storage: ShortcutDefaultMigrationHost["storage"]): boolean {
  return readFlag(storage, SHORTCUT_SET_NOTICE_SHOWN_KEY);
}

function readFlag(storage: ShortcutDefaultMigrationHost["storage"], key: string): boolean {
  try {
    return storage?.getItem(key) != null;
  } catch {
    return false;
  }
}

function clearPendingFreshInstall(storage: ShortcutDefaultMigrationHost["storage"]): void {
  try {
    if (storage?.getItem(PENDING_FRESH_INSTALL_KEY) != null) storage?.removeItem(PENDING_FRESH_INSTALL_KEY);
  } catch {
    // A leftover marker means nothing now.
  }
}

/** The move's own markers: written by the move, so never evidence that an install existed before it. */
const NOT_INSTALL_EVIDENCE = new Set([PENDING_FRESH_INSTALL_KEY, SHORTCUT_SET_NOTICE_SHOWN_KEY, SHORTCUT_SET_NOTICE_PENDING_KEY]);

function hasChemDraftStorage(storage: ShortcutDefaultMigrationHost["storage"]): boolean {
  try {
    for (let index = 0; index < (storage?.length ?? 0); index += 1) {
      const key = storage?.key(index);
      if (key?.startsWith("chemdraft.") && !NOT_INSTALL_EVIDENCE.has(key)) return true;
    }
  } catch {
    // Unreadable storage is no evidence either way.
  }
  return false;
}
