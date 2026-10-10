import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";

export type ModifierHintInteraction =
  | "idle" | "rotate-drag" | "resize-drag" | "move-drag" | "bond-drag"
  | "marquee" | "lasso" | "measure-drag" | "arrowhead-drag" | "other-drag";

export interface ModifierHintContext {
  activeTool: string;
  interaction: ModifierHintInteraction;
  hoverTarget?: "molecule" | "arrow" | "object" | "empty";
  hasSelection: boolean;
  /** Group rotation is already visible; only its molecule tilt handles need Shift. */
  selectionHandles?: "rotate" | "tilt" | "none";
  inlineEditing?: boolean;
  dualShaftArrow?: boolean;
  twoArrowheads?: boolean;
  /** Lasso subtraction stays latched once Alt is used during the gesture. */
  lassoSubtracting?: boolean;
}

export interface HeldModifiers {
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/** Describe only canvas behaviors, never commands or hypothetical tool capabilities. */
export function modifierHint(
  context: ModifierHintContext,
  held: HeldModifiers,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): string {
  if (context.inlineEditing) return "";
  const shift = platform === "macos" ? "⇧" : "Shift";
  const alt = platform === "macos" ? "⌥" : "Alt";
  const primary = platform === "macos" ? "⌘" : "Ctrl";
  const selectionTool = ["tool.select", "tool.lasso", "tool.art.directEdit"].includes(context.activeTool);
  const shiftHint = (available: string, active: string, released: string) => held.shiftKey
    ? `${active} — release ${shift} ${released}`
    : `${shift}: ${available}`;
  const selectionHints = (region: boolean, subtract = true) => {
    const subtracting = held.altKey || (context.interaction === "lasso" && context.lassoSubtracting);
    const hints = [shiftHint(
      region ? "add to selection" : "click to toggle selection",
      region ? "Adding to selection" : "Click toggles selection",
      "to replace selection"
    )];
    if (subtract) hints.push(context.interaction === "lasso" && context.lassoSubtracting
      ? `Subtracting from selection (${alt} used during lasso)`
      : held.altKey ? `Subtracting from selection — release ${alt} ${held.shiftKey ? region ? "to add to selection" : "to toggle selection" : "to replace selection"}` : `${alt}: subtract from selection`);
    // Alt wins over Shift in the selection policy.
    return subtracting && subtract ? hints.slice(1).join(" · ") : hints.join(" · ");
  };

  switch (context.interaction) {
    case "rotate-drag":
      return shiftHint("snap to 15° steps", "Snapping to 15°", "for free rotation");
    case "resize-drag":
      return shiftHint("stretch width and height independently", "Stretching width and height independently", "for proportional resizing");
    case "measure-drag":
      return shiftHint("constrain to 45° angles", "Measuring at 45° angles", "for any angle");
    case "marquee":
    case "lasso":
      return context.activeTool === "tool.eraser" ? "" : selectionHints(true);
    case "arrowhead-drag":
      if (!context.twoArrowheads) return "";
      return context.dualShaftArrow
        ? shiftHint("resize both arrowheads", "Resizing both arrowheads", "to resize one arrowhead")
        : shiftHint("resize one arrowhead", "Resizing one arrowhead", "to resize both arrowheads");
    case "move-drag":
    case "bond-drag":
    case "other-drag":
      return "";
    case "idle":
      break;
  }

  if (context.activeTool === "tool.art.measure") {
    return shiftHint("constrain to 45° angles", "Measure at 45° angles", "for any angle");
  }
  if (context.activeTool === "tool.art.eyedropper") {
    return held.altKey ? `Copy full art appearance — release ${alt} to copy fill or stroke only` : `${alt}: copy full art appearance`;
  }
  const hints: string[] = [];
  if (context.hoverTarget === "arrow") {
    hints.push(shiftHint("show arrow rotate/resize handles", "Arrow rotate/resize handles shown", "to hide handles"));
  } else if (selectionTool && context.hasSelection && context.selectionHandles !== "none") {
    const handles = context.selectionHandles === "tilt" ? "3D tilt" : "rotate";
    hints.push(shiftHint(`show ${handles} handles`, `${handles === "rotate" ? "Rotate" : "3D tilt"} handles shown`, "to hide handles"));
  }
  if (selectionTool && context.hoverTarget !== undefined) {
    hints.push(selectionHints(context.hoverTarget === "empty", context.hoverTarget === "molecule" || context.hoverTarget === "empty"));
  }
  if (context.hoverTarget !== undefined) {
    const primaryHeld = platform === "macos" ? held.metaKey : held.ctrlKey;
    hints.push(`${primary}${primaryHeld ? " held" : ""} + wheel: zoom`);
  }
  return hints.join(" · ");
}
