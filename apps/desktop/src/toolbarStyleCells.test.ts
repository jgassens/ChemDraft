// The Main style widget's eleven-cell span is declared once and held equal everywhere: the raw
// manifest, the widget table and the exported constant. Layouts saved by 1.2.2/RC5 with twelve cells
// load as eleven, with no two items on one cell.
import { describe, expect, it } from "vitest";
import { MAIN_STYLE_CONTROLS_GRID_SPAN, createDesktopToolsetRegistry, getToolsetItemGroups, toolbarWidgetGridSpan } from "./toolsets";
import { TOOLBAR_WIDGET_GRID_SPANS, TOOLBAR_WIDGET_IDS } from "./toolbars/toolbarWidgets";
import { MAIN_TOOLBAR_DEFAULTS_REVISION } from "./toolbars/toolbarLayoutState";
import manifest from "./toolsets/desktop-toolsets.json";

const STYLE = TOOLBAR_WIDGET_IDS.mainStyleControls;

/** Column-flow placement (fill each column top to bottom, then move right); throws on overlap. */
function assertNoOverlap(items: { id: string; colSpan: number; rowSpan: number }[], rows: number) {
  const owner = new Set<string>();
  const occupied = (c: number, r: number) => owner.has(`${c},${r}`);
  for (const item of items) {
    let placed = false;
    for (let column = 0; !placed; column += 1) {
      for (let row = 0; row + item.rowSpan <= rows && !placed; row += 1) {
        const cells: string[] = [];
        let free = true;
        for (let c = column; c < column + item.colSpan && free; c += 1) {
          for (let r = row; r < row + item.rowSpan; r += 1) {
            if (occupied(c, r)) { free = false; break; }
            cells.push(`${c},${r}`);
          }
        }
        if (free) { cells.forEach(cell => owner.add(cell)); placed = true; }
      }
    }
    expect(placed, item.id).toBe(true);
  }
}

describe("Main style widget grid span", () => {
  const twelve = { colSpan: 12, rowSpan: 2 };

  it("is eleven by two in the manifest, the widget table and the constant", () => {
    expect(MAIN_STYLE_CONTROLS_GRID_SPAN).toEqual({ colSpan: 11, rowSpan: 2 });
    expect(TOOLBAR_WIDGET_GRID_SPANS[STYLE]).toEqual(MAIN_STYLE_CONTROLS_GRID_SPAN);
    expect(toolbarWidgetGridSpan(STYLE)).toEqual(MAIN_STYLE_CONTROLS_GRID_SPAN);
    const manifestStyle = (manifest as unknown as { toolsets: { id: string; groups: { items: { id?: string; layout?: unknown }[] }[] }[] })
      .toolsets.find(toolset => toolset.id === "core.main")!.groups.flatMap(group => group.items).find(item => item.id === STYLE);
    expect(manifestStyle?.layout).toEqual(MAIN_STYLE_CONTROLS_GRID_SPAN);
  });

  it("loads a saved twelve-cell layout as eleven cells with no overlap", () => {
    const shippedIds = getToolsetItemGroups("core.main").flat().map(item => item.id);
    const saved = JSON.parse(JSON.stringify({
      version: 1,
      mainToolbarDefaultsRevision: MAIN_TOOLBAR_DEFAULTS_REVISION,
      toolsetOverrides: [{
        toolsetId: "core.main",
        itemOrder: { "core.main.items": ["tool.select", "tool.lasso", STYLE] },
        itemOverrides: [{ commandId: STYLE, layout: twelve }]
      }],
      userToolsets: []
    }));
    const registry = createDesktopToolsetRegistry(saved, undefined, [], () => undefined);
    const items = getToolsetItemGroups("core.main", registry).flat();
    expect([...items.map(item => item.id)].sort()).toEqual([...shippedIds].sort());
    expect(items.slice(0, 3).map(item => item.id)).toEqual(["tool.select", "tool.lasso", STYLE]);
    expect(items.find(item => item.id === STYLE)!.layout).toMatchObject({ colSpan: 11, rowSpan: 2 });
    assertNoOverlap(items.map(item => ({ id: item.id, colSpan: item.layout.colSpan, rowSpan: item.layout.rowSpan })),
      registry.require("core.main").gridLayout!.rows!);
  });
});
