import { normalizeHexColor, textColorCommands, textScriptCommands, textSizeCommands } from "../../commands";
import { ScriptGlyph, closestSizeCommandId } from "../toolbarCells";
import type { ToolbarWidgetState } from "../toolbarWidgets";
import { mainToolbarSwatchCommands, type MainStyleRows } from "./cells";

/**
 * The widget's original layout, expressed as cells — the fallback for empty, mixed, and unclassified
 * selections, so the pre-variant behavior survives unchanged.
 *
 * Row 1: text-color swatches, alignment, superscript. Row 2: font, size, B/I/U + subscript.
 * Superscript rides the top row directly above subscript so the x²/x₂ pair lines up vertically;
 * both rows cost the same cell total so their right edges align.
 */
export function textVariantRows(state: ToolbarWidgetState): MainStyleRows {
  const { currentTextStyle, currentTextScript = "normal" } = state;
  const currentColor = normalizeHexColor(currentTextStyle?.color) ?? textColorCommands[0].color;
  const superscriptCommand = textScriptCommands.find((command) => command.script === "superscript");
  const subscriptCommand = textScriptCommands.find((command) => command.script === "subscript");
  const boldActive = (currentTextStyle?.fontWeight ?? 400) >= 600;
  const italicActive = currentTextStyle?.fontStyle === "italic";
  const underlineActive = currentTextStyle?.textDecoration === "underline";

  return {
    primary: [
      {
        kind: "swatches",
        ariaLabel: "Text color",
        commands: mainToolbarSwatchCommands,
        activeColor: normalizeHexColor(currentColor) ?? currentColor
      },
      { kind: "aligns", activeAlign: currentTextStyle?.textAlign ?? "left" },
      ...(superscriptCommand
        ? [{
            kind: "toggle" as const,
            toggle: {
              commandId: superscriptCommand.id,
              label: superscriptCommand.title,
              active: currentTextScript === "superscript",
              content: <ScriptGlyph script="superscript" />
            }
          }]
        : [])
    ],
    secondary: [
      { kind: "textFontSelect", currentTextStyle },
      {
        kind: "select",
        cells: 3,
        ariaLabel: "Text size",
        value: closestSizeCommandId(currentTextStyle?.fontSizePx),
        options: textSizeCommands.map((command) => ({
          value: command.id,
          label: command.title.replace("Size: ", "")
        })),
        labelClassName: "toolbar-control-label toolbar-size-control",
        selectClassName: "toolbar-select toolbar-size-select"
      },
      {
        kind: "toggleGroup",
        ariaLabel: "Text style",
        toggles: [
          { commandId: "text.bold", label: "Bold Text", active: boldActive, content: "B" },
          { commandId: "text.italic", label: "Italic Text", active: italicActive, content: "I" },
          { commandId: "text.underline", label: "Underline Text", active: underlineActive, content: "U" },
          ...(subscriptCommand
            ? [{
                commandId: subscriptCommand.id,
                label: subscriptCommand.title,
                active: currentTextScript === "subscript",
                content: <ScriptGlyph script="subscript" />
              }]
            : [])
        ]
      }
    ]
  };
}
