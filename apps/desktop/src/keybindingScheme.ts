/**
 * ChemDraw-compatible keybinding scheme.
 *
 * The mapping is behavioral: each entry pairs a ChemDraft command with the key
 * ChemDraw users expect for the equivalent action, so muscle memory transfers.
 * ChemDraw actions with no ChemDraft equivalent (nickname labels such as OMe,
 * ring-sprout hotkeys, dialog hotkeys) are simply absent — the keys do nothing
 * rather than doing something surprising.
 *
 * Three surfaces are remapped:
 *   1. Registry shortcuts (tool switching + menu chords) via
 *      `applyKeybindingSchemeToCommands`, applied wherever a shortcut registry
 *      or command list is built.
 *   2. Hovered atom/bond hotkeys via `chemDrawHoveredTargetHotkeyCommand`,
 *      consulted by the MainWindow keydown ladder ahead of the registry.
 *   3. Native macOS menu accelerators, rebuilt by the Rust side when the
 *      scheme changes (`set_keybinding_scheme`).
 */

import { numericAtomDrawingHotkeys, numericBondDrawingHotkeys, type CommandSpec } from "./commands";
import type { KeybindingScheme } from "./keybindingSettings";
import { compactMacShortcutLabel } from "./toolsets";

/**
 * Registry-level overrides for the ChemDraw scheme. `null` unbinds a default
 * ChemDraft shortcut whose key means something else (or nothing) in ChemDraw.
 * The table is a full replacement per command — the shortcut engine treats two
 * commands on one chord as a conflict and disables both, so every ChemDraft
 * default that would collide with a ChemDraw binding must be cleared here.
 */
export const CHEMDRAW_COMMAND_SHORTCUT_OVERRIDES: Readonly<Record<string, string | null>> = {
  // --- Tool switching (ChemDraw generic hotkeys) ---
  "tool.select": "Space", // marquee selection
  "tool.lasso": null, // ChemDraw has no lasso hotkey (Alt toggles marquee/lasso)
  "tool.bond": "X",
  "tool.chain": "Shift+X",
  "tool.benzene": "J",
  "tool.bracket": "Shift+T",
  "tool.reactionArrow": "E",
  // ChemDraft's E-for-eraser must not shadow ChemDraw's E (the arrow tool above; and over an
  // atom, ChemDraw's e/E place ethyl/ester labels — neither means erase).
  "tool.eraser": null,
  "tool.cyclopentane": null, // frees R; ChemDraw has no cyclopentane hotkey
  "tool.plus": null, // +/- act on the hovered atom only, never switch tools
  "tool.minus": null,

  // --- Hovered-target keys that differ ---
  // Carbonyl is "2" over an atom in ChemDraw (handled by the hover ladder);
  // a bare "K" there means t-Bu, which ChemDraft doesn't support.
  "atom.addCarbonylToHoveredAtom": null,

  // --- Menu chords that differ from ChemDraft defaults ---
  "export.open": "Ctrl+Cmd+E",
  "view.zoomIn": "Shift+Cmd+>", // Magnify
  "view.zoomOut": "Shift+Cmd+<", // Reduce
  "view.toggleRulers": "Cmd+;",
  "view.toggleCrosshairs": "Alt+Cmd+X",
  // ChemDraw's Object menu has only front/back on Cmd+[ / Cmd+] (yes, that
  // orientation), with no bindings for the one-step variants.
  "layout.bringToFront": "Cmd+[",
  "layout.sendToBack": "Cmd+]",
  "layout.bringForward": null,
  "layout.sendBackward": null,
  // "Rotate 180° horizontal/vertical" in ChemDraw terms.
  "layout.flipHorizontal": "Shift+Cmd+H",
  "layout.flipVertical": "Shift+Cmd+V"
};

/**
 * Rewrite command shortcuts for the active scheme. Hand-written
 * `shortcutLabel`s are dropped on overridden commands so tooltips fall back to
 * formatting the replacement chord instead of showing the stale key.
 */
export function applyKeybindingSchemeToCommands(
  commands: readonly CommandSpec[],
  scheme: KeybindingScheme
): CommandSpec[] {
  if (scheme !== "chemdraw") {
    return [...commands];
  }
  return commands.map((command) => {
    if (!(command.id in CHEMDRAW_COMMAND_SHORTCUT_OVERRIDES)) {
      return command;
    }
    const override = CHEMDRAW_COMMAND_SHORTCUT_OVERRIDES[command.id];
    return {
      ...command,
      // Empty string — NOT undefined — is the "unbound" sentinel. Transformed specs are later
      // merged over manifest-derived bases with `override.field ?? base.field` semantics
      // (toolsets.ts), where undefined resurrects the stale ChemDraft key in tooltips; "" survives
      // those merges, reads as "no shortcut" everywhere downstream (registry, tooltips, flyouts),
      // and clears both fields the shortcut engine falls back through.
      shortcut: override ?? "",
      defaultShortcut: override ?? "",
      shortcutLabel: override ? compactMacShortcutLabel(override) ?? override : ""
    };
  });
}

function atomElementCommand(element: string): string {
  return `atom.setHoveredElement.${element}`;
}

/**
 * ChemDraw hotkeys pressed while hovering an atom. Case-sensitive: ChemDraw
 * distinguishes e.g. `b` (Br) from `B` (boron) and `c` (C) from `C` (Cl).
 * Only the subset with a ChemDraft equivalent appears here.
 */
const CHEMDRAW_ATOM_HOTKEYS: Readonly<Record<string, string>> = {
  ...numericAtomDrawingHotkeys,
  // "3/a" on the cheat sheet: both attach a benzene ring at the atom.
  a: numericAtomDrawingHotkeys["3"],
  "+": "atom.addPositiveChargeToHoveredAtom",
  "-": "atom.addNegativeChargeToHoveredAtom",
  h: atomElementCommand("H"),
  c: atomElementCommand("C"),
  n: atomElementCommand("N"),
  w: atomElementCommand("N"),
  o: atomElementCommand("O"),
  q: atomElementCommand("O"),
  f: atomElementCommand("F"),
  p: atomElementCommand("P"),
  s: atomElementCommand("S"),
  i: atomElementCommand("I"),
  B: atomElementCommand("B"),
  b: atomElementCommand("Br"),
  C: atomElementCommand("Cl"),
  l: atomElementCommand("Cl"),
  L: atomElementCommand("Li"),
  S: atomElementCommand("Si")
};

/**
 * ChemDraw hotkeys pressed while hovering a bond. ChemDraw's tapered-hash and
 * even-hash styles both map onto ChemDraft's single hashed style.
 */
const CHEMDRAW_BOND_HOTKEYS: Readonly<Record<string, string>> = {
  ...numericBondDrawingHotkeys,
  // ChemDraw fuses benzene onto a bond with "a".
  a: "bond.fuseRingAtHoveredBond.benzene",
  w: "bond.setHoveredBondDisplay.wedge",
  h: "bond.setHoveredBondDisplay.hashed",
  H: "bond.setHoveredBondDisplay.hashed",
  W: "bond.setHoveredBondDisplay.hashed",
  b: "bond.setHoveredBondDisplay.bold",
  d: "bond.setHoveredBondDisplay.dashed"
};

/** Resolve a ChemDraw-scheme hover hotkey to a command id, or undefined. */
export function chemDrawHoveredTargetHotkeyCommand(
  targetKind: "atom" | "bond",
  key: string
): string | undefined {
  const table = targetKind === "atom" ? CHEMDRAW_ATOM_HOTKEYS : CHEMDRAW_BOND_HOTKEYS;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
