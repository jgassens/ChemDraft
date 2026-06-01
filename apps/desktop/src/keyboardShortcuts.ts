import {
  createShortcutRegistry,
  shortcutsFromCommands,
  type ShortcutPlatform,
  type ShortcutRegistry
} from "@chemdraft/shortcut-engine";
import type { CommandSpec } from "./commands";

export function createDesktopShortcutRegistry(
  commands: readonly CommandSpec[],
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): ShortcutRegistry {
  return createShortcutRegistry(shortcutsFromCommands(commands), { platform });
}

export function detectDesktopShortcutPlatform(): ShortcutPlatform {
  const platform = globalThis.navigator?.platform.toLowerCase() ?? "";
  if (platform.includes("mac")) {
    return "macos";
  }
  if (platform.includes("win")) {
    return "windows";
  }
  return "linux";
}
