import { describe, expect, it, vi } from "vitest";

vi.mock("@chemdraft/shortcut-engine", async (importOriginal) => ({
  ...await importOriginal<typeof import("@chemdraft/shortcut-engine")>(),
  detectShortcutPlatform: () => "macos"
}));

import { modifierLabels } from "./modifierLabels";

it("defaults to desktop platform detection", () => {
  expect(modifierLabels()).toEqual({ option: "Option", optionGlyph: "⌥", command: "⌘", control: "⌃", shift: "⇧" });
});

describe.each([
  ["macos", { option: "Option", optionGlyph: "⌥", command: "⌘", control: "⌃", shift: "⇧" }],
  ["windows", { option: "Alt", optionGlyph: "Alt", command: "Ctrl", control: "Ctrl", shift: "Shift" }]
] as const)("modifier labels on %s", (platform, expected) => {
  it("uses the platform's modifier names and glyphs", () => {
    expect(modifierLabels(platform)).toEqual(expected);
  });

});
