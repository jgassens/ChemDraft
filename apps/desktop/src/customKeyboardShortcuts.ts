import { createEmptyDocument } from "@chemdraft/chem-core";
import {
  hoverKeyFromEvent, keyFromCode, normalizeShortcut, parseShortcutDisplay, reservedShortcutReason,
  type ShortcutAction, type ShortcutOverrides, type ShortcutPlatform
} from "@chemdraft/shortcut-engine";
import { buildAppMenuModel, flattenAppMenuCommands } from "./appMenu";
import { allShellCommands, createLayerActions, createQuickActions } from "./commands";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import { defaultHoverShortcuts } from "./keybindingScheme";
import type { KeybindingScheme } from "./keybindingSettings";
import { commandPlatformAlternates, createMainWindowShortcutCommands, detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { getToolsetCommandSpecs } from "./toolsets";

function baseMenu(platform: ShortcutPlatform) {
  return flattenAppMenuCommands(buildAppMenuModel({
    rulersVisible: true, crosshairsVisible: true, canUndo: true, canRedo: true,
    hasSelection: true, hasSelectedMolecule: true, toolbars: [], platform
  }));
}

export function keyboardShortcutActions(
  scheme: KeybindingScheme,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): ShortcutAction[] {
  const document = createEmptyDocument();
  const state = {
    quickActions: createQuickActions(document, undefined),
    layerActions: createLayerActions(document),
    toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs())
  };
  const known = new Map(allShellCommands(document).map(command => [command.id, command]));
  const commands = createMainWindowShortcutCommands(state, scheme);
  const otherScheme = createMainWindowShortcutCommands(state, scheme === "chemdraft" ? "chemdraw" : "chemdraft");
  const commandIds = new Set(otherScheme.filter(command => command.shortcut || command.defaultShortcut).map(command => command.id));
  for (const command of commands) {
    if (command.shortcut || command.defaultShortcut) commandIds.add(command.id);
  }
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
    for (const [key, id] of Object.entries(defaultHoverShortcuts(scheme, scope))) {
      byCommand.set(id, [...(byCommand.get(id) ?? []), key]);
    }
    for (const [id, defaults] of byCommand) {
      rows.push({ id, scope, title: known.get(id)?.title ?? id, defaults });
    }
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title));
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
    const key = hoverKeyFromEvent(event);
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
