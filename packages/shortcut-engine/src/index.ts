export type ShortcutPlatform = "macos" | "windows" | "linux";

export interface CommandShortcut {
  commandId: string;
  keys: readonly string[];
  platform?: ShortcutPlatform;
  when?: string;
}

export function describeShortcut(shortcut: CommandShortcut): string {
  return shortcut.keys.join("+");
}
