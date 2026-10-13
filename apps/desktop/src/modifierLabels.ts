import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";

export interface ModifierLabels {
  option: string;
  optionGlyph: string;
  command: string;
  control: string;
  shift: string;
}

/** Platform spelling for modifiers in user-facing canvas hints. */
export function modifierLabels(
  platform: ShortcutPlatform = detectShortcutPlatform()
): ModifierLabels {
  return platform === "macos"
    ? { option: "Option", optionGlyph: "⌥", command: "⌘", control: "⌃", shift: "⇧" }
    : { option: "Alt", optionGlyph: "Alt", command: "Ctrl", control: "Ctrl", shift: "Shift" };
}
