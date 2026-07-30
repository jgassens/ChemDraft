import {
  normalizeHexColor,
  objectColorCommands,
  objectMarkerKindCommandId,
  objectMarkerKindCommands,
  objectMarkerNumberRanges,
  objectMarkerSizeCommandId,
  objectStrokeDashCommands,
  objectStrokeWidthCommands
} from "../../commands";
import { closestObjectStrokeWidthCommandId, objectStrokeDashCommandId } from "../toolbarCells";
import type { ToolbarWidgetState } from "../toolbarWidgets";
import { closestPreset, type MainStyleRows } from "./cells";

const arrowSwatchCommands = objectColorCommands.slice(0, 6);
const arrowheadKindCommands = objectMarkerKindCommands.filter((command) => command.markerId === "markerEnd");

/** Head sizes a compact select can offer (the canvas handle drags the full 4–96px range). */
const HEAD_SIZE_PRESETS = [8, 12, 16, 20, 24, 32] as const;

const MIXED = "mixed";

/**
 * Arrow layout — stroke styling plus the two properties only arrows have: head kind and head size.
 * Row 1: stroke swatches, arrowhead kind, tail-head toggle, Set-as-Default-Arrow-Style.
 * Row 2: stroke width, dash, head size, flip, More… (opens the Art toolbar).
 * Arrows report supportsFill: false, so the art model's active paint target is already "stroke" —
 * no Fill|Stroke toggle needed.
 */
export function arrowVariantRows(state: ToolbarWidgetState): MainStyleRows {
  const art = state.currentArtStyle;
  const selected = (art?.selectedCount ?? 0) > 0;
  const supportsMarkers = art?.supportsMarkersAny ?? false;
  const singleArrowSelected = art?.selectedCount === 1 && art.isArrowAll;
  const headKind = art?.values.markerEndKind;
  const tailKind = art?.values.markerStartKind;
  const tailPresent = tailKind?.value !== undefined && tailKind.value !== null && tailKind.value !== "none";
  // Adding a tail head mirrors the end head's kind (resonance-style), falling back to filled.
  const tailKindToAdd = headKind?.value && headKind.value !== "none" ? headKind.value : "filled-arrow";
  // The renderer floors head size at strokeWidth×4; hiding smaller presets keeps the select honest.
  const headSizeFloor = Math.max(
    objectMarkerNumberRanges.markerSizePx.min,
    Math.ceil(((art?.values.strokeWidth.value ?? 2) * 4) / objectMarkerNumberRanges.markerSizePx.step)
      * objectMarkerNumberRanges.markerSizePx.step
  );
  const headSizePresets = HEAD_SIZE_PRESETS.filter((preset) => preset >= headSizeFloor);
  const effectiveHeadSizePresets = headSizePresets.length > 0 ? headSizePresets : [headSizeFloor];

  return {
    primary: [
      {
        kind: "swatches",
        ariaLabel: "Arrow color",
        commands: arrowSwatchCommands,
        activeColor: normalizeHexColor(art?.values.strokeColor.value ?? state.currentObjectColor ?? "") ?? undefined
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Arrowhead style",
        disabled: !selected || !supportsMarkers,
        value: headKind?.mixed
          ? MIXED
          : objectMarkerKindCommandId("markerEnd", headKind?.value ?? "filled-arrow"),
        options: arrowheadKindCommands.map((command) => ({ value: command.id, label: command.label }))
      },
      {
        kind: "toggle",
        toggle: {
          commandId: tailPresent
            ? objectMarkerKindCommandId("markerStart", "none")
            : objectMarkerKindCommandId("markerStart", tailKindToAdd),
          label: tailPresent ? "Remove Arrow Tail Head" : "Add Arrow Tail Head",
          active: tailPresent,
          disabled: !selected || !supportsMarkers,
          content: "◀"
        }
      },
      {
        kind: "action",
        commandId: "arrow.setDefaultStyle",
        label: "Set as Default Arrow Style",
        disabled: !singleArrowSelected,
        content: "★"
      }
    ],
    secondary: [
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Stroke width",
        disabled: !selected,
        value: art?.values.strokeWidth.mixed
          ? MIXED
          : closestObjectStrokeWidthCommandId(art?.values.strokeWidth.value ?? undefined),
        options: objectStrokeWidthCommands.map((command) => ({
          value: command.id,
          label: `${command.strokeWidth} px`
        }))
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Dash pattern",
        disabled: !selected,
        value: art?.values.dash.mixed
          ? MIXED
          : objectStrokeDashCommandId(art?.values.dash.value ?? undefined),
        options: objectStrokeDashCommands.map((command) => ({
          value: command.id,
          label: command.title.replace(" Stroke", "")
        }))
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Arrowhead size",
        disabled: !selected || !supportsMarkers,
        value: art?.values.markerSizePx.mixed
          ? MIXED
          : objectMarkerSizeCommandId(
              closestPreset(art?.values.markerSizePx.value ?? 16, effectiveHeadSizePresets)
            ),
        options: effectiveHeadSizePresets.map((preset) => ({
          value: objectMarkerSizeCommandId(preset),
          label: `${preset} px`
        }))
      },
      {
        kind: "action",
        commandId: "layout.flipHorizontal",
        label: "Flip Horizontal",
        disabled: !selected,
        content: "⇆"
      },
      {
        kind: "action",
        commandId: "tool.settings",
        label: "More arrow settings",
        content: "…"
      }
    ]
  };
}
