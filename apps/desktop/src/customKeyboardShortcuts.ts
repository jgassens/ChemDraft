import { createEmptyDocument } from "@chemdraft/chem-core";
import {
  editShortcut, keyFromCode, normalizeShortcut, parseShortcutDisplay, recordedHoverKeyFromEvent, reservedShortcutReason,
  type ShortcutAction, type ShortcutOverrides, type ShortcutPlatform, type ShortcutScope
} from "@chemdraft/shortcut-engine";
import { buildAppMenuModel, flattenAppMenuCommands } from "./appMenu";
import { allShellCommands, createLayerActions, createQuickActions } from "./commands";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import { DEFAULT_COMMAND_SHORTCUT_OVERRIDES, defaultHoverShortcuts } from "./keybindingScheme";
import { commandPlatformAlternates, createMainWindowShortcutCommands, detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { getToolsetCommandSpecs } from "./toolsets";

function baseMenu(platform: ShortcutPlatform) {
  return flattenAppMenuCommands(buildAppMenuModel({
    rulersVisible: true, crosshairsVisible: true, canUndo: true, canRedo: true,
    hasSelection: true, hasSelectedMolecule: true, toolbars: [], platform
  }));
}

/**
 * Every row Preferences > Keyboard lists: each command with a key in the built-in set, each command
 * the set leaves without a key (`null` in DEFAULT_COMMAND_SHORTCUT_OVERRIDES: eraser, lasso and
 * others, so the user can still give them one), the platform-owned menu actions, and the hover keys.
 */
export function keyboardShortcutActions(
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): ShortcutAction[] {
  const document = createEmptyDocument();
  const state = {
    quickActions: createQuickActions(document, undefined),
    layerActions: createLayerActions(document),
    toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs())
  };
  const known = new Map(allShellCommands(document).map(command => [command.id, command]));
  const commands = createMainWindowShortcutCommands(state);
  const unbound = new Set(Object.entries(DEFAULT_COMMAND_SHORTCUT_OVERRIDES).filter(([, key]) => key === null).map(([id]) => id));
  const commandIds = new Set(commands.filter(command => command.shortcut || command.defaultShortcut || unbound.has(command.id))
    .map(command => command.id));
  const menu = new Map(baseMenu(platform).map(item => [item.commandId, item]));
  const rows: ShortcutAction[] = [...commandIds].flatMap(id => {
    const matching = commands.filter(command => command.id === id);
    if (!matching.length) return [];
    const defaults = [...new Set(matching.map(command => command.shortcut ?? command.defaultShortcut).filter((key): key is string => !!key))];
    if (defaults.length) defaults.push(...commandPlatformAlternates(id, platform));
    return [{
      id, scope: "commands", title: menu.get(id)?.label ?? matching[0].title, defaults,
      lockedReason: id === "document.closeTab" ? "Reserved for Close Window." : undefined
    }];
  });
  // The native Window and application menus also expose platform-owned actions.
  const systemActions = platform === "macos" ? [
    ["app.quit", "Quit ChemDraft", "Mod+Q"],
    ["app.hide", "Hide ChemDraft", "Mod+H"],
    ["app.hideOthers", "Hide Others", "Alt+Mod+H"],
    ["app.fullScreen", "Toggle Full Screen", "Ctrl+Mod+F"]
  ] : [["app.closeWindow", "Close Window", "Alt+F4"]];
  if (platform !== "linux") systemActions.push(["app.minimize", "Minimize Window", "Mod+M"]);
  for (const [id, title, key] of systemActions) {
    rows.push({ id, title, scope: "commands", defaults: [key], lockedReason: "Reserved by the system menu." });
  }
  for (const scope of ["atom", "bond"] as const) {
    const byCommand = new Map<string, string[]>();
    for (const [key, id] of Object.entries(defaultHoverShortcuts(scope))) {
      byCommand.set(id, [...(byCommand.get(id) ?? []), key]);
    }
    for (const [id, defaults] of byCommand) {
      rows.push({ id, scope, title: known.get(id)?.title ?? id, defaults });
    }
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Carry custom keys from the retired preset (`overrides.chemdraft`) into the one built-in set, for
 * the one-time move in shortcutDefaultMigration.ts. Conflicts follow the rule Preferences > Keyboard
 * applies to an assignment (`editShortcut`): a key is kept only when no other command in the set
 * already uses it, counting the set's own keys, the user's existing custom keys for the set, and keys
 * carried over before it. Dropped, never forced:
 *   - a key another command already uses, or a reserved one (F5 and Cmd/Ctrl+R included);
 *   - a key for a command the set does not list (a hover action it has no table entry for), or a
 *     locked system action;
 *   - a cleared entry (no keys): it removed one of the old preset's keys, which the set does not have.
 * A command the user already customized in the set keeps that customization. Never throws.
 */
export function mergeLegacyShortcutOverrides(
  legacy: ShortcutOverrides | undefined,
  current: ShortcutOverrides | undefined,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): { overrides: ShortcutOverrides; kept: number; dropped: number } {
  let overrides: ShortcutOverrides = { ...current };
  let kept = 0;
  let dropped = 0;
  const actions = keyboardShortcutActions(platform);
  for (const scope of ["commands", "atom", "bond"] as const satisfies readonly ShortcutScope[]) {
    for (const [id, keys] of Object.entries(legacy?.[scope] ?? {})) {
      if (!Array.isArray(keys) || !keys.length || Object.hasOwn(current?.[scope] ?? {}, id)) continue;
      const action = actions.find(row => row.id === id && row.scope === scope);
      const accepted: string[] = [];
      for (const key of keys) {
        let accept = false;
        try {
          accept = !!action && typeof key === "string" && !accepted.includes(key) &&
            editShortcut(actions, overrides, action, { kind: "assign", key }, platform).kind === "updated";
        } catch {
          // A key the engine cannot parse is dropped like a conflicting one.
        }
        if (accept) accepted.push(key); else dropped += 1;
      }
      kept += accepted.length;
      const isDefault = !!action && accepted.length === action.defaults.length &&
        accepted.every((key, index) => key === action.defaults[index]);
      if (accepted.length && !isDefault) overrides = { ...overrides, [scope]: { ...overrides[scope], [id]: accepted } };
    }
  }
  return { overrides, kept, dropped };
}

/**
 * Combine two stored copies of the user's custom keys for the set, entry by entry, for
 * shortcutDefaultMigration.ts: `primary` (the native preferences file's) and `secondary` (the webview
 * cache's). Every `primary` entry is kept as it is. An entry only `secondary` has is added unless it
 * would collide, by the rule Preferences > Keyboard applies (`editShortcut`): one of its keys that the
 * command does not have by default is used by another command (counting the set's keys, `primary`'s
 * and every other entry added), is reserved, or the command is a locked system action. A colliding
 * entry is dropped whole, so the command keeps its keys from `primary` or the set. Cleared entries
 * (no keys) never collide, and entries for commands this platform does not list are kept as stored.
 * Never throws.
 */
export function mergeStoredShortcutOverrides(
  primary: ShortcutOverrides | undefined,
  secondary: ShortcutOverrides | undefined,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): { overrides: ShortcutOverrides; dropped: number } {
  const scopes = ["commands", "atom", "bond"] as const satisfies readonly ShortcutScope[];
  const overrides: Record<ShortcutScope, Record<string, readonly string[]>> = {
    commands: { ...primary?.commands }, atom: { ...primary?.atom }, bond: { ...primary?.bond }
  };
  const added: { scope: ShortcutScope; id: string }[] = [];
  for (const scope of scopes) {
    for (const [id, keys] of Object.entries(secondary?.[scope] ?? {})) {
      if (Object.hasOwn(overrides[scope], id) || !Array.isArray(keys)) continue;
      overrides[scope][id] = keys;
      added.push({ scope, id });
    }
  }
  let dropped = 0;
  if (added.length) {
    let actions: ShortcutAction[] = [];
    try {
      actions = keyboardShortcutActions(platform);
    } catch {
      // Without the set's table nothing can be checked; the entries stay as stored.
    }
    // Dropping an entry gives the command its own keys back, which can collide with an entry kept
    // earlier in the pass, so repeat until a pass drops nothing.
    for (let changed = true; changed;) {
      changed = false;
      for (const { scope, id } of added) {
        if (!Object.hasOwn(overrides[scope], id)) continue;
        const action = actions.find(row => row.id === id && row.scope === scope);
        if (!action) continue;
        const keys = overrides[scope][id];
        const collides = !!action.lockedReason || keys.some(key => {
          if (action.defaults.includes(key)) return false;
          try {
            return editShortcut(actions, overrides, action, { kind: "assign", key }, platform).kind !== "updated";
          } catch {
            return true;
          }
        });
        if (collides) {
          delete overrides[scope][id];
          dropped += 1;
          changed = true;
        }
      }
    }
  }
  const result: ShortcutOverrides = {};
  for (const scope of scopes) {
    if (Object.keys(overrides[scope]).length) result[scope] = overrides[scope];
  }
  return { overrides: result, dropped };
}

/** Use TanStack's default chord for commands. Capture the exact hover character from the same press. */
export function capturedShortcut(
  hotkey: string,
  event: KeyboardEvent,
  scope: ShortcutAction["scope"],
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): { key: string } | { reason: string } {
  const tokens = parseShortcutDisplay(hotkey);
  const physical = /^\[(\w+)\]$/.exec(tokens.at(-1) ?? "")?.[1];
  if (physical) tokens[tokens.length - 1] = keyFromCode(physical) ?? event.key;
  if (tokens.at(-1) === " ") tokens[tokens.length - 1] = "Space";
  const reason = reservedShortcutReason(tokens, platform);
  if (reason) return { reason };
  if (scope !== "commands") {
    if (event.metaKey || event.ctrlKey || event.altKey) return { reason: "Use a single key, with Shift if needed, for hover actions." };
    // Shift+= is the + key, even when the event reports the unshifted legend "=".
    const key = recordedHoverKeyFromEvent(event);
    return key.length === 1 ? { key } : { reason: "Use a letter, number, or symbol for hover actions." };
  }
  const key = tokens.at(-1) ?? "";
  if (!/^(?:[ -~]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Arrow(?:Down|Left|Right|Up)|Enter|Tab|Backspace|Delete|Home|End|Insert|Page(?:Down|Up))$/i.test(key)) {
    return { reason: "This key is unavailable for shortcuts." };
  }
  return { key: tokens.join("+") };
}

export function nativeMenuShortcutOverrides(
  overrides: ShortcutOverrides | undefined,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): Record<string, string | null> {
  return Object.fromEntries(baseMenu(platform).flatMap<[string, string | null]>(({ commandId, accelerator }) => {
    const keys = overrides?.commands?.[commandId];
    if (!accelerator || !keys) return [];
    if (!keys.length) return [[commandId, null]];
    const shortcut = normalizeShortcut({ commandId, keys: parseShortcutDisplay(keys[0]) }, platform);
    const modifiers = shortcut.modifiers.map(modifier => modifier === "Meta" ? "Cmd" : modifier);
    const key = shortcut.key === " " ? "Space" : shortcut.key;
    return [[commandId, [...modifiers, key].join("+")]];
  }));
}
