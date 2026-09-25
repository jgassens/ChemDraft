import {
  createShortcutRegistry,
  detectShortcutPlatform,
  shortcutsFromCommands,
  type CommandShortcut,
  type ShortcutPlatform,
  type ShortcutRegistry
} from "@chemdraft/shortcut-engine";
import type { CommandSpec } from "./commands";

/**
 * Platform-convention chords bound in addition to a command's own `shortcut`. Windows and Linux
 * redo with Ctrl+Y as well as Ctrl+Shift+Z — and the native Edit ▸ Redo item there is a predefined
 * muda item that works by SENDING Ctrl+Y to the focused window, so without this binding the menu
 * item it labels "Ctrl+Y" silently does nothing.
 */
const PLATFORM_ALTERNATE_SHORTCUTS: readonly CommandShortcut[] = [
  { commandId: "edit.redo", keys: ["Ctrl", "Y"], platform: "windows" },
  { commandId: "edit.redo", keys: ["Ctrl", "Y"], platform: "linux" }
];

export interface DesktopShortcutRegistryOptions {
  platform?: ShortcutPlatform;
  includeDisabled?: boolean;
}

export function createDesktopShortcutRegistry(
  commands: readonly CommandSpec[],
  platformOrOptions: ShortcutPlatform | DesktopShortcutRegistryOptions = detectDesktopShortcutPlatform()
): ShortcutRegistry {
  const options = typeof platformOrOptions === "string"
    ? { platform: platformOrOptions }
    : platformOrOptions;
  const shortcutCommands = options.includeDisabled
    ? commands.map((command) => ({ ...command, enabled: true }))
    : commands;

  const commandShortcuts = shortcutsFromCommands(shortcutCommands);
  const boundCommandIds = new Set(commandShortcuts.map((shortcut) => shortcut.commandId));
  // An alternate follows its command: a disabled or absent command gets no extra chord either.
  const alternates = PLATFORM_ALTERNATE_SHORTCUTS.filter((shortcut) => boundCommandIds.has(shortcut.commandId));

  return createShortcutRegistry([...commandShortcuts, ...alternates], {
    platform: options.platform ?? detectDesktopShortcutPlatform()
  });
}

export function detectDesktopShortcutPlatform(): ShortcutPlatform {
  return detectShortcutPlatform();
}

/**
 * WebView2's built-in browser shortcuts stay enabled (wry turns them on and Tauri exposes no switch),
 * so off macOS F5 / Ctrl+F5 / Ctrl+R / Ctrl+Shift+R reload the document webview — discarding undo
 * history, selection and anything newer than the last session autosave. The document window
 * suppresses these chords unless a ChemDraft command claims them (Ctrl+R is Show Rulers in the
 * ChemDraft scheme). macOS's WKWebView has no reload shortcut.
 */
export function isBrowserReloadChord(
  event: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): boolean {
  if (platform === "macos" || event.altKey || event.metaKey) {
    return false;
  }
  if (event.key === "F5" || event.key === "BrowserRefresh") {
    return true;
  }
  return Boolean(event.ctrlKey) && event.key.toLowerCase() === "r";
}
