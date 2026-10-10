import { describe, expect, it } from "vitest";
import { modifierHint, type ModifierHintContext } from "./modifierHints";

const idle: ModifierHintContext = { activeTool: "tool.select", interaction: "idle", hasSelection: false };

describe.each(["macos", "windows"] as const)("modifier hints on %s", (platform) => {
  const shift = platform === "macos" ? "⇧" : "Shift";
  const alt = platform === "macos" ? "⌥" : "Alt";
  const primary = platform === "macos" ? "⌘" : "Ctrl";
  const hint = (context: Partial<ModifierHintContext>, held = {}) => modifierHint({ ...idle, ...context }, held, platform);

  it("shows selection handles and their held state, without inventing group rotate reveal", () => {
    expect(hint({ hasSelection: true })).toBe(`${shift}: show rotate handles`);
    expect(hint({ hasSelection: true }, { shiftKey: true })).toBe(`Rotate handles shown — release ${shift} to hide handles`);
    expect(hint({ hasSelection: true, selectionHandles: "none" })).toBe("");
    expect(hint({ hasSelection: true, selectionHandles: "tilt" })).toBe(`${shift}: show 3D tilt handles`);
    expect(hint({ hasSelection: true, activeTool: "tool.lasso" })).toContain("show rotate handles");
  });

  it("describes exact 15° rotation when Shift is pressed and released", () => {
    expect(hint({ interaction: "rotate-drag" })).toBe(`${shift}: snap to 15° steps`);
    expect(hint({ interaction: "rotate-drag" }, { shiftKey: true })).toBe(`Snapping to 15° — release ${shift} for free rotation`);
  });

  it("describes independent stretching and proportional resizing", () => {
    expect(hint({ interaction: "resize-drag" })).toBe(`${shift}: stretch width and height independently`);
    expect(hint({ interaction: "resize-drag" }, { shiftKey: true })).toContain(`release ${shift} for proportional resizing`);
  });

  it.each(["marquee", "lasso"] as const)("describes %s selection and Alt precedence", (interaction) => {
    expect(hint({ interaction })).toBe(`${shift}: add to selection · ${alt}: subtract from selection`);
    expect(hint({ interaction }, { shiftKey: true })).toContain("Adding to selection");
    expect(hint({ interaction }, { altKey: true })).toContain("Subtracting from selection");
    expect(hint({ interaction }, { shiftKey: true, altKey: true })).not.toContain("Adding to selection");
    expect(hint({ interaction }, { shiftKey: true, altKey: true })).toContain("to add to selection");
    expect(hint({ interaction, activeTool: "tool.eraser" }, { shiftKey: true, altKey: true })).toBe("");
  });

  it("keeps a latched subtracting lasso accurate after Alt release", () => {
    expect(hint({ interaction: "lasso", lassoSubtracting: true })).toBe(`Subtracting from selection (${alt} used during lasso)`);
  });

  it("describes click toggling, region addition and molecule subtraction", () => {
    expect(hint({ hoverTarget: "molecule" })).toContain(`${shift}: click to toggle selection · ${alt}: subtract from selection`);
    expect(hint({ hoverTarget: "object" })).not.toContain("subtract");
    expect(hint({ hoverTarget: "empty" })).toContain(`${shift}: add to selection`);
  });

  it("reveals the arrow size box across tools", () => {
    expect(hint({ activeTool: "tool.art.arrow", hoverTarget: "arrow" })).toContain(`${shift}: show arrow rotate/resize handles`);
    expect(hint({ hoverTarget: "arrow" }, { shiftKey: true })).toContain("Arrow rotate/resize handles shown");
  });

  it("describes opposite Shift sizing policies for resonance and equilibrium arrowheads", () => {
    const context = { interaction: "arrowhead-drag", twoArrowheads: true } as const;
    expect(hint(context)).toBe(`${shift}: resize one arrowhead`);
    expect(hint(context, { shiftKey: true })).toContain(`release ${shift} to resize both arrowheads`);
    expect(hint({ ...context, dualShaftArrow: true })).toBe(`${shift}: resize both arrowheads`);
    expect(hint({ ...context, dualShaftArrow: true }, { shiftKey: true })).toContain(`release ${shift} to resize one arrowhead`);
    expect(hint({ interaction: "arrowhead-drag" })).toBe("");
  });

  it("describes tape-measure angles before and during a drag", () => {
    expect(hint({ activeTool: "tool.art.measure" })).toBe(`${shift}: constrain to 45° angles`);
    expect(hint({ interaction: "measure-drag" }, { shiftKey: true })).toContain(`release ${shift} for any angle`);
  });

  it("describes full eyedropper appearance sampling", () => {
    expect(hint({ activeTool: "tool.art.eyedropper" })).toBe(`${alt}: copy full art appearance`);
    expect(hint({ activeTool: "tool.art.eyedropper" }, { altKey: true })).toContain(`release ${alt} to copy fill or stroke only`);
  });

  it("uses the platform primary modifier for wheel zoom", () => {
    expect(hint({ activeTool: "tool.bond", hoverTarget: "empty" })).toBe(`${primary} + wheel: zoom`);
    expect(hint({ activeTool: "tool.bond", hoverTarget: "empty" }, platform === "macos" ? { metaKey: true } : { ctrlKey: true }))
      .toBe(`${primary} held + wheel: zoom`);
  });

  it.each(["move-drag", "bond-drag", "other-drag"] as const)("does not invent modifiers during %s", (interaction) => {
    expect(hint({ interaction, hasSelection: true, hoverTarget: "molecule" }, { shiftKey: true, altKey: true })).toBe("");
  });

  it("is empty when nothing applies or an inline editor owns focus", () => {
    expect(hint({})).toBe("");
    expect(hint({ activeTool: "tool.bond" })).toBe("");
    expect(hint({ interaction: "rotate-drag", inlineEditing: true }, { shiftKey: true })).toBe("");
  });

  it("never puts Mac glyphs in Windows hints", () => {
    const text = hint({ hasSelection: true, hoverTarget: "molecule" });
    if (platform === "windows") expect(text).not.toMatch(/[⇧⌥⌘]/);
    else expect(text).toContain("⌘");
  });
});
