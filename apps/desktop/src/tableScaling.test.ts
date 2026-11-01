import { describe, expect, it } from "vitest";
import { applyPatches, type TableObject } from "@chemdraft/chem-core";
import { planTableLayout } from "@chemdraft/layout-engine";
import { setTableCell } from "@chemdraft/document-workflow-core";
import { createPhase4Document, insertNativeTextObject, insertTableIntoDocument,
  groupSelectedDocumentObjects, scaleDocumentObjectsAroundPoint } from "./documentWorkflow";
import { selectedTable } from "./tableCommands";

describe("table selection scaling", () => {
  it.each([[2, 2], [0.5, 1.5], [1.5, 0.5]])(
    "keeps table size and scales its centre by %s/%s in a mixed group", (sx, sy) => {
      let serial = 0;
      let document = insertTableIntoDocument(createPhase4Document(), {
        rows: 2, columns: 2, headerRows: 1, preset: "three-line", center: { x: 200, y: 250 },
        newId: prefix => `${prefix}-${++serial}`
      });
      const table = selectedTable(document)!;
      document = insertNativeTextObject(document, { x: 500, y: 600 }, "Other object");
      document = applyPatches(document, [{ op: "setSelection", pageId: document.pages[0].id,
        objectIds: document.pages[0].objects.map(object => object.id) }]);
      document = groupSelectedDocumentObjects(document);
      const before = structuredClone(document);
      const centre = { x: 350, y: 400 };
      const scaled = scaleDocumentObjectsAroundPoint(document, document.selection.objectIds, centre, sx, sy);
      const changed = scaled.pages[0].objects.find(object => object.id === table.id) as TableObject;
      expect(changed.width).toBeCloseTo(table.width);
      expect(changed.height).toBeCloseTo(table.height);
      expect(changed.x + changed.width / 2).toBeCloseTo(centre.x + (200 - centre.x) * sx);
      expect(changed.y + changed.height / 2).toBeCloseTo(centre.y + (250 - centre.y) * sy);
      expect(changed.rows).toEqual(table.rows);
      expect(changed.columns).toEqual(table.columns);
      expect(planTableLayout(changed).width).toBeCloseTo(changed.width);
      expect(planTableLayout(changed).height).toBeCloseTo(changed.height);
      const edited = setTableCell(changed, changed.rows[0].id, changed.columns[0].id, {
        text: "", spans: []
      }).table;
      expect(edited.x).toBeCloseTo(changed.x);
      expect(edited.y).toBeCloseTo(changed.y);
      expect(edited.width).toBeCloseTo(changed.width);
      expect(edited.height).toBeCloseTo(changed.height);
      expect(document).toEqual(before);
    }
  );

  it("refreshes a stale stored table frame from layout", () => {
    let serial = 0;
    const document = insertTableIntoDocument(createPhase4Document(), {
      rows: 1, columns: 1, headerRows: 0, preset: "grid", center: { x: 200, y: 200 },
      newId: prefix => `${prefix}-${++serial}`
    });
    const table = selectedTable(document)!;
    const stale = applyPatches(document, [{ op: "updateObject", objectId: table.id,
      changes: { width: table.width * 2, height: table.height * 2 } }]);
    const scaled = scaleDocumentObjectsAroundPoint(stale, [table.id], { x: 0, y: 0 }, 2, 3);
    const changed = selectedTable(scaled)!;
    expect(changed.width).toBeCloseTo(planTableLayout(changed).width);
    expect(changed.height).toBeCloseTo(planTableLayout(changed).height);
  });
});
