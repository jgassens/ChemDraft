import {
  createShortcutRegistry,
  detectShortcutPlatform,
  shortcutsFromCommands,
  type ShortcutPlatform,
  type ShortcutRegistry
} from "@chemdraft/shortcut-engine";
import type { CommandSpec } from "./commands";

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

  return createShortcutRegistry(shortcutsFromCommands(shortcutCommands), {
    platform: options.platform ?? detectDesktopShortcutPlatform()
  });
}

export function detectDesktopShortcutPlatform(): ShortcutPlatform {
  return detectShortcutPlatform();
}
