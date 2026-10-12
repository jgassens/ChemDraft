import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";

export interface ModifierLabels {
  option: string;
  optionGlyph: string;
  command: string;
  control: string;
  shift: string;
}

/** Platform spelling for modifiers in user-facing canvas hints. */
export function modifierLabels(
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): ModifierLabels {
  return platform === "macos"
    ? { option: "Option", optionGlyph: "⌥", command: "⌘", control: "⌃", shift: "⇧" }
    : { option: "Alt", optionGlyph: "Alt", command: "Ctrl", control: "Ctrl", shift: "Shift" };
}

/** Replaces the Mac-only modifier spelling used by existing tool-hint definitions. */
export function localizeModifierHint(
  hint: string,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): string {
  const labels = modifierLabels(platform);
  return hint
    .replaceAll("Option", labels.option)
    .replaceAll("⌥", labels.optionGlyph);
}
