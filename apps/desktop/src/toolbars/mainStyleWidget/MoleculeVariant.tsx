import {
  moleculeAtomLabelFontFamilyCommandId,
  moleculeAtomLabelFontSizeCommandId,
  moleculeAtomLabelHideImplicitHydrogensCommandId,
  moleculeAtomLabelShowTerminalCarbonsCommandId,
  moleculeStructureBondSpacingPercentCommandId,
  moleculeStructureBondStrokeWidthCommandId,
  normalizeHexColor,
  textColorCommands,
  textFontCommands
} from "../../commands";
import { fontLabel } from "../toolbarCells";
import type { ToolbarWidgetState } from "../toolbarWidgets";
import {
  mainToolbarSwatchCommands,
  numericSelectOptions,
  numericSelectValue,
  type MainStyleRows
} from "./cells";

/** Bond line widths a compact select can offer; the full range lives in the Molecule Inspector. */
const BOND_WIDTH_PRESETS = [1, 1.5, 2, 3, 4, 6] as const;
/** Double-bond spacing as % of bond length (ChemDraft's default preset is 18%). */
const BOND_SPACING_PRESETS = [10, 14, 18, 22, 26, 30] as const;
/** Atom label sizes; the preset default is 15px. */
const ATOM_LABEL_SIZE_PRESETS = [10, 12, 15, 18, 21, 24] as const;

/**
 * Molecule layout: the properties a chemist reaches for without opening the inspector.
 * Row 1: bond/atom color swatches (the text-color commands — their selection-color path already
 * routes to molecule parts), bond line width, hide-implicit-H and show-terminal-C toggles.
 * Row 2: atom-label font + size, double-bond spacing, More… (opens the Molecule Inspector).
 */
export function moleculeVariantRows(state: ToolbarWidgetState): MainStyleRows {
  const inspector = state.currentMoleculeInspector;
  const structure = inspector?.structure;
  const atomLabels = inspector?.atomLabels;
  const structureDisabled = structure ? !structure.enabled : true;
  const atomLabelsDisabled = atomLabels ? !atomLabels.enabled : true;
  const currentColor = normalizeHexColor(state.currentTextStyle?.color) ?? textColorCommands[0].color;
  // Both label toggles are show/hide on the SAME polarity: lit means those labels are visible on
  // the canvas. The underlying style field for hydrogens is inverted
  // (atomLabelHideImplicitHydrogens), so it is negated here — surfacing it raw would light the H
  // toggle for "hidden" while the C toggle lights for "shown", and a lit pair would mean opposite
  // things. A mixed (or absent) value reads as not-shown, so clicking unifies the selection.
  const showImplicitHydrogens = atomLabels?.values.hideImplicitHydrogens.value === false;
  const showTerminalCarbons = atomLabels?.values.showTerminalCarbons.value === true;

  return {
    primary: [
      {
        kind: "swatches",
        ariaLabel: "Bond and atom color",
        commands: mainToolbarSwatchCommands,
        activeColor: currentColor
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Bond line width",
        disabled: structureDisabled,
        value: numericSelectValue(
          structure?.values.bondStrokeWidthPx.value ?? null,
          structure?.values.bondStrokeWidthPx.mixed ?? false,
          2,
          BOND_WIDTH_PRESETS,
          moleculeStructureBondStrokeWidthCommandId
        ),
        options: numericSelectOptions(
          BOND_WIDTH_PRESETS,
          moleculeStructureBondStrokeWidthCommandId,
          (value) => `${value} px`
        )
      },
      {
        kind: "toggle",
        toggle: {
          // Lit → clicking hides (sets the inverted field true); dim → clicking shows.
          commandId: moleculeAtomLabelHideImplicitHydrogensCommandId(showImplicitHydrogens),
          label: "Show Implicit Hydrogens",
          active: showImplicitHydrogens,
          disabled: atomLabelsDisabled,
          content: "H"
        }
      },
      {
        kind: "toggle",
        toggle: {
          commandId: moleculeAtomLabelShowTerminalCarbonsCommandId(!showTerminalCarbons),
          label: "Show Terminal Carbons",
          active: showTerminalCarbons,
          disabled: atomLabelsDisabled,
          content: "C"
        }
      }
    ],
    secondary: [
      {
        kind: "fontFamilySelect",
        cells: 4,
        ariaLabel: "Atom label font",
        family: atomLabels?.values.fontFamily.value ?? null,
        mixed: atomLabels?.values.fontFamily.mixed ?? false,
        disabled: atomLabelsDisabled,
        presetFamilies: textFontCommands.map((command) => ({
          family: command.fontFamily,
          label: fontLabel(command.title)
        })),
        commandIdForFamily: moleculeAtomLabelFontFamilyCommandId
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Atom label size",
        disabled: atomLabelsDisabled,
        value: numericSelectValue(
          atomLabels?.values.fontSizePx.value ?? null,
          atomLabels?.values.fontSizePx.mixed ?? false,
          15,
          ATOM_LABEL_SIZE_PRESETS,
          moleculeAtomLabelFontSizeCommandId
        ),
        options: numericSelectOptions(
          ATOM_LABEL_SIZE_PRESETS,
          moleculeAtomLabelFontSizeCommandId,
          (value) => `${value} px`
        )
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Double bond spacing",
        disabled: structureDisabled,
        value: numericSelectValue(
          structure?.values.bondSpacingPercent.value ?? null,
          structure?.values.bondSpacingPercent.mixed ?? false,
          18,
          BOND_SPACING_PRESETS,
          moleculeStructureBondSpacingPercentCommandId
        ),
        options: numericSelectOptions(
          BOND_SPACING_PRESETS,
          moleculeStructureBondSpacingPercentCommandId,
          (value) => `${value} %`
        )
      },
      {
        kind: "action",
        commandId: "tool.settings",
        label: "More molecule settings",
        content: "…"
      }
    ]
  };
}
