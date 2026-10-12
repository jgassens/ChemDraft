import { describe, expect, it, vi } from "vitest";

vi.mock("./keyboardShortcuts", () => ({
  detectDesktopShortcutPlatform: () => "macos"
}));

import { localizeModifierHint, modifierLabels } from "./modifierLabels";

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

  it("formats the Lasso tool hint", () => {
    expect(localizeModifierHint("Lasso Selection: drag around objects; Option subtracts; Esc exits", platform))
      .toBe(`Lasso Selection: drag around objects; ${expected.option} subtracts; Esc exits`);
  });

  it("formats the Eyedropper tool hint", () => {
    expect(localizeModifierHint("Eyedropper: click source art; ⌥ copies full appearance; Esc exits", platform))
      .toBe(`Eyedropper: click source art; ${expected.optionGlyph} copies full appearance; Esc exits`);
  });

  it("formats the selected Eyedropper target hint", () => {
    expect(localizeModifierHint("Eyedropper: Fill target selected; click source art; switch Fill/Stroke, ⌥ click copies all; Esc exits", platform))
      .toBe(`Eyedropper: Fill target selected; click source art; switch Fill/Stroke, ${expected.optionGlyph} click copies all; Esc exits`);
  });

  it("formats the repeated Eyedropper target hint", () => {
    expect(localizeModifierHint("Eyedropper: Stroke target selected; click different source art; switch Fill/Stroke, ⌥ click copies all; Esc exits", platform))
      .toBe(`Eyedropper: Stroke target selected; click different source art; switch Fill/Stroke, ${expected.optionGlyph} click copies all; Esc exits`);
  });
});
