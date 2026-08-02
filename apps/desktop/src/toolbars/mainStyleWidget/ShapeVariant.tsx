import {
  normalizeHexColor,
  objectColorCommands,
  objectPaintTypeCommandId,
  objectPaintTypeCommands,
  objectStrokeDashCommands,
  objectStrokeLineJoinCommands,
  objectStrokeWidthCommands
} from "../../commands";
import { closestObjectStrokeWidthCommandId, objectStrokeDashCommandId } from "../toolbarCells";
import type { ToolbarWidgetState } from "../toolbarWidgets";
import type { MainStyleRows } from "./cells";

/** The same six palette colors as every other variant, bound to object-color commands (which apply
 *  to the active paint target). */
const shapeSwatchCommands = objectColorCommands.slice(0, 6);

const MIXED = "mixed";

/**
 * Shape layout (rect / ellipse / non-arrow paths) — the one selection where fill-vs-stroke actually
 * matters. Row 1: swatches painting the active target, the Fill|Stroke target toggle, paint type.
 * Row 2: stroke width, dash, corners, swap fill/stroke, More… (opens the Art toolbar).
 */
export function shapeVariantRows(state: ToolbarWidgetState): MainStyleRows {
  const art = state.currentArtStyle;
  const selected = (art?.selectedCount ?? 0) > 0;
  const target = art?.activePaintTarget ?? state.currentArtStyleTarget ?? "fill";
  const supportsFill = art?.supportsFillAny ?? true;
  const supportsStroke = art?.supportsStrokeAny ?? true;
  const supportsDash = art?.supportsDashAny ?? true;
  const supportsCorners = art?.supportsCornersAny ?? false;
  const activeColor = target === "fill" ? art?.values.fillColor.value : art?.values.strokeColor.value;
  const paintTypeValue = target === "fill" ? art?.values.fillPaintType : art?.values.strokePaintType;
  const paintTypeCommands = objectPaintTypeCommands.filter((command) => (
    target === "fill" || command.paintType !== "gloss"
  ));

  return {
    primary: [
      {
        kind: "swatches",
        ariaLabel: target === "fill" ? "Fill color" : "Stroke color",
        commands: shapeSwatchCommands,
        activeColor: normalizeHexColor(activeColor ?? state.currentObjectColor ?? "") ?? undefined
      },
      {
        kind: "toggleGroup",
        ariaLabel: "Paint target",
        toggles: [
          {
            commandId: "object.style.target.fill",
            label: "Target fill",
            active: target === "fill",
            disabled: !selected || !supportsFill,
            content: <span className="art-target-fill-glyph" aria-hidden="true" />
          },
          {
            commandId: "object.style.target.stroke",
            label: "Target stroke",
            active: target === "stroke",
            disabled: !selected || !supportsStroke,
            content: <span className="art-target-stroke-glyph" aria-hidden="true" />
          }
        ]
      },
      {
        kind: "select",
        cells: 3,
        ariaLabel: `${target === "fill" ? "Fill" : "Stroke"} paint type`,
        disabled: !selected,
        value: paintTypeValue?.mixed
          ? MIXED
          : objectPaintTypeCommandId(paintTypeValue?.value ?? "solid"),
        options: paintTypeCommands.map((command) => ({ value: command.id, label: command.label }))
      }
    ],
    secondary: [
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Stroke width",
        disabled: !selected || !supportsStroke,
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
        disabled: !selected || !supportsDash,
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
        ariaLabel: "Corners",
        disabled: !selected || !supportsCorners,
        value: art?.values.corners.mixed
          ? MIXED
          : objectStrokeLineJoinCommands.find((command) => command.strokeLineJoin === (art?.values.corners.value ?? "miter"))?.id
            ?? objectStrokeLineJoinCommands[0].id,
        options: objectStrokeLineJoinCommands.map((command) => ({
          value: command.id,
          label: command.title.replace("Corners: ", "")
        }))
      },
      {
        kind: "action",
        commandId: "object.style.swapFillStroke",
        label: "Swap fill and stroke",
        disabled: !selected || !supportsFill || !supportsStroke,
        content: "⇄"
      },
      {
        kind: "action",
        commandId: "tool.settings",
        label: "More shape settings",
        content: "…"
      }
    ]
  };
}
