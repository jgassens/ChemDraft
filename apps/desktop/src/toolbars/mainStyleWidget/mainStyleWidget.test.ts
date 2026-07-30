import { describe, expect, it } from "vitest";
import { mainStyleRowsForVariant } from "./MainStyleWidget";
import { MAIN_STYLE_ROW_CELLS, rowCellCost } from "./cells";
import type { ToolbarStyleVariant } from "../toolbarSelectionKind";
import type { ToolbarWidgetState } from "../toolbarWidgets";

const VARIANTS: readonly ToolbarStyleVariant[] = ["text", "molecule", "arrow", "shape"];

const minimalState: ToolbarWidgetState = { onInvoke: () => undefined };

describe("mainStyleRowsForVariant", () => {
  it("keeps every variant's rows at exactly the 11-cell budget", () => {
    // The widget's footprint is pinned in CSS to 11 cells; a row that budgets differently would
    // clip or leave a hole. jsdom has no layout, so assert the budget the pixels derive from.
    for (const variant of VARIANTS) {
      const { rows } = mainStyleRowsForVariant(variant, minimalState);
      expect(rowCellCost(rows.primary), `${variant} primary row`).toBe(MAIN_STYLE_ROW_CELLS);
      expect(rowCellCost(rows.secondary), `${variant} secondary row`).toBe(MAIN_STYLE_ROW_CELLS);
    }
  });

  it("reports the variant it actually rendered when a builder is missing", () => {
    // Arrow and shape builders land in later slices; until then they render the text layout and
    // must say so, so the data-main-style-variant attribute never lies about the visible controls.
    expect(mainStyleRowsForVariant("text", minimalState).effectiveVariant).toBe("text");
    expect(mainStyleRowsForVariant("molecule", minimalState).effectiveVariant).toBe("molecule");
  });
});
