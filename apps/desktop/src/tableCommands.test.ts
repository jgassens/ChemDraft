import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deserializeDocument, nativeTextStyleFromObjectStyle, type ChemDraftDocument, type TableObject } from "@chemdraft/chem-core";
import { planTableLayout } from "@chemdraft/layout-engine";
import { createPhase4Document, insertNativeTextObject, insertTableIntoDocument, moveDocumentObject,
  createSelectionClipboardPayload, parseSelectionClipboardPayload, pasteSelectionClipboardPayload,
  groupSelectedDocumentObjects, ungroupSelectedDocumentObjects } from "./documentWorkflow";
import { applyTableCommand, createTableCommands, createTableInsertAction, parseTableInsertCommandId,
  resolveActiveTableCell, selectedTable, tableColumnAlignCommandId, tableCommandDisabledReason,
  tableInsertCommandId, tableInspectorSnapshot, tableStyleCommandId } from "./tableCommands";
import { parseDialogMessage } from "./dialogs/dialogProtocol";
import { DialogCoordinator } from "./dialogs/DialogCoordinator";
import type { DialogMessage } from "./dialogs/dialogProtocol";

const fixture = (): ChemDraftDocument => {
  const document = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
  return { ...document, selection: { pageId: document.pages[0].id, objectIds: [document.pages[0].objects[0].id] } };
};
const ids = () => { let count = 0; return (prefix: string) => `${prefix}-test-${++count}`; };

describe("table commands", () => {
  it("encodes dimensions and rejects invalid ids and bounds", () => {
    expect(tableInsertCommandId(6, 7, 1)).toBe("table.insert.r6c7h1");
    expect(createTableInsertAction(6, 7, 1).id).toBe("table.insert.r6c7h1");
    expect(parseTableInsertCommandId("table.insert.r6c7h1")).toEqual({ rows: 6, columns: 7, headerRows: 1 });
    for (const id of ["table.insert.r0c4h1", "table.insert.r501c4h1", "table.insert.r6c65h1", "table.insert.r6c4h7", "table.insert.r06c4h1", "table.insert.r6c4h1.extra"]) expect(parseTableInsertCommandId(id)).toBeUndefined();
    expect(() => tableInsertCommandId(1, 1, 2)).toThrow();
    expect(tableColumnAlignCommandId("decimal")).toBe("table.column.align.decimal");
    expect(tableStyleCommandId("three-line")).toBe("table.style.threeLine");
    const commands = createTableCommands(createPhase4Document());
    expect(commands[0]).toMatchObject({ id: "table.insertDialog", enabled: true });
    for (const command of commands.slice(1)) expect(command).toMatchObject({ enabled: false, disabledReason: "Select a table first" });
  });

  it("defaults to the first body cell and repairs deleted or stale cell ids", () => {
    const document = fixture();
    const table = selectedTable(document)!;
    expect(selectedTable({ ...document, selection: { objectIds: [table.id] } })).toBe(table);
    const expected = { tableId: table.id, rowId: table.rows[1].id, columnId: table.columns[0].id };
    expect(resolveActiveTableCell(table)).toEqual(expected);
    expect(resolveActiveTableCell(table, { ...expected, rowId: "removed" })).toEqual(expected);
    const active = { ...expected, rowId: table.rows[2].id, columnId: table.columns[3].id };
    expect(resolveActiveTableCell(table, active)).toBe(active);
    expect(resolveActiveTableCell(undefined, active)).toBeUndefined();
  });

  const cases: [string, string, (table: TableObject, before: TableObject) => void][] = [
    ["table.row.insertAbove", "Insert row", (t, b) => { expect(t.rows).toHaveLength(b.rows.length + 1); expect(t.rows[2].cells.every(c => c.text === "")).toBe(true); expect(t.rows[3].id).toBe(b.rows[2].id); }],
    ["table.row.insertBelow", "Insert row", (t, b) => { expect(t.rows).toHaveLength(b.rows.length + 1); expect(t.rows[3].cells.every(c => c.text === "")).toBe(true); }],
    ["table.row.delete", "Delete row", (t, b) => { expect(t.rows).toHaveLength(b.rows.length - 1); expect(t.rows.some(r => r.id === b.rows[2].id)).toBe(false); }],
    ["table.column.insertLeft", "Insert column", (t, b) => { expect(t.columns).toHaveLength(b.columns.length + 1); expect(t.columns[3].id).toBe(b.columns[2].id); }],
    ["table.column.insertRight", "Insert column", (t, b) => { expect(t.columns).toHaveLength(b.columns.length + 1); expect(t.columns[2].id).toBe(b.columns[2].id); expect(t.rows.every(r => r.cells[3].text === "")).toBe(true); }],
    ["table.column.delete", "Delete column", (t, b) => { expect(t.columns).toHaveLength(b.columns.length - 1); expect(t.columns.some(c => c.id === b.columns[2].id)).toBe(false); }],
    ...(["left", "center", "right", "decimal"] as const).map(align => [tableColumnAlignCommandId(align), "Align column", (t: TableObject) => expect(t.columns[2].align).toBe(align)] as [string, string, (t: TableObject) => void]),
    ["table.column.autoFit", "Resize column", t => expect(t.columns[2].width).toEqual({ mode: "auto" })],
    ["table.style.threeLine", "Style table", t => expect(t.tableStyle.preset).toBe("three-line")],
    ["table.style.grid", "Style table", t => expect(t.tableStyle.preset).toBe("grid")],
    ["table.header.bold.toggle", "Style table", t => expect(t.tableStyle.headerBold).toBe(true)],
    ["table.caption.toggle", "Edit caption", t => expect(t.caption).toBeUndefined()],
    ["table.footnote.add", "Edit footnotes", (t, b) => { expect(t.footnotes).toHaveLength(b.footnotes.length + 1); expect(t.footnotes.at(-1)?.text).toBe(""); }],
    ["table.cell.plainText", "Set formula rule", t => { expect(t.rows[2].cells[2].formula).toBe("off"); expect(t.rows[2].cells[2].spans.every(s => s.script === "normal")).toBe(true); }]
  ];
  it.each(cases)("%s edits the active cell's table and returns one undo label", (id, label, check) => {
    const document = fixture(), before = selectedTable(document)!;
    // Ensure auto-fit and three-line commands have a real change to make.
    before.columns[2].width = { mode: "fixed", px: 140 };
    before.tableStyle.preset = "grid";
    const baseline = structuredClone(before);
    const active = { tableId: before.id, rowId: before.rows[2].id, columnId: before.columns[2].id };
    const result = applyTableCommand(document, id, active, ids())!;
    expect(result.label).toBe(label);
    expect(result.document.selection.objectIds).toEqual([before.id]);
    check(selectedTable(result.document)!, before);
    expect(before).toEqual(baseline);
  });

  it("formats formula cells explicitly and plain text removes only scripts", () => {
    const document = fixture(), table = selectedTable(document)!;
    const row = table.rows.at(-1)!;
    row.cells[0] = { text: "CH2Cl2", spans: [] };
    const active = { tableId: table.id, rowId: row.id, columnId: table.columns[0].id };
    const result = applyTableCommand(document, "table.cell.formatFormula", active, ids())!;
    expect(result.label).toBe("Format formula");
    const formatted = selectedTable(result.document)!.rows.at(-1)!.cells[0];
    expect(formatted.spans.some(s => s.script === "subscript" && s.text.includes("2"))).toBe(true);
    const plain = applyTableCommand(result.document, "table.cell.plainText", active, ids())!;
    const value = selectedTable(plain.document)!.rows.at(-1)!.cells[0];
    expect(value.text).toBe("CH2Cl2");
    expect(value.formula).toBe("off");
    expect(value.spans.every(s => s.script === "normal")).toBe(true);
  });

  it("adds the default caption and prevents deleting the final row or column", () => {
    const document = insertTableIntoDocument(createPhase4Document(), { rows: 1, columns: 1, headerRows: 1,
      preset: "grid", center: { x: 200, y: 200 }, newId: ids() });
    const table = selectedTable(document)!;
    expect(tableCommandDisabledReason("table.row.delete", table)).toBe("Keep at least one row");
    expect(tableCommandDisabledReason("table.column.delete", table)).toBe("Keep at least one column");
    expect(applyTableCommand(document, "table.row.delete", undefined, ids())).toBeUndefined();
    const result = applyTableCommand(document, "table.caption.toggle", undefined, ids())!;
    expect(selectedTable(result.document)?.caption).toEqual({ text: "Table 1.", spans: [] });
  });

  it("centres the entire table, inherits text-tool style, and selects only the insertion", () => {
    const style = { fontFamily: "Georgia", fontSizePx: 19 };
    const document = insertNativeTextObject(createPhase4Document(), { x: 30, y: 30 }, "Existing", style);
    const result = insertTableIntoDocument(document, { rows: 6, columns: 7, headerRows: 1, preset: "grid",
      center: { x: 400, y: 500 }, newId: ids(), textStyle: style });
    const table = selectedTable(result)!;
    expect(table.x + table.width / 2).toBeCloseTo(400);
    expect(table.y + table.height / 2).toBeCloseTo(500);
    expect(planTableLayout(table).width).toBeCloseTo(table.width);
    expect(planTableLayout(table).height).toBeCloseTo(table.height);
    expect(nativeTextStyleFromObjectStyle(table.style)).toEqual(nativeTextStyleFromObjectStyle(document.pages[0].objects[0].style));
    expect(table.rows).toHaveLength(6);
    expect(table.columns).toHaveLength(7);
    expect(table.rows.every(r => r.cells.every(c => c.text === ""))).toBe(true);
    expect(result.pages[0].objects).toHaveLength(2);
    expect(result.selection.objectIds).toEqual([table.id]);
  });

  it("moves, internally copies/pastes and groups tables without changing contents", () => {
    const document = fixture(), table = selectedTable(document)!;
    const moved = moveDocumentObject(document, table.id, { x: 25, y: 30 });
    expect(selectedTable(moved)).toMatchObject({ x: 25, y: 30, rows: table.rows, columns: table.columns });
    const payload = createSelectionClipboardPayload(moved)!;
    const parsed = parseSelectionClipboardPayload(JSON.stringify(payload))!;
    expect(parsed.objects[0]).toMatchObject({ type: "table", rows: table.rows });
    const pasted = pasteSelectionClipboardPayload(moved, parsed, { x: 400, y: 400 });
    expect(selectedTable(pasted)?.id).not.toBe(table.id);
    expect(selectedTable(pasted)?.rows).toEqual(table.rows);
    const both = { ...pasted, selection: { ...pasted.selection, objectIds: pasted.pages[0].objects.map(o => o.id) } };
    const grouped = groupSelectedDocumentObjects(both);
    expect(grouped.pages[0].objects.some(o => o.type === "group")).toBe(true);
    expect(ungroupSelectedDocumentObjects(grouped).pages[0].objects.filter(o => o.type === "table")).toHaveLength(2);
  });

  it("feeds table state and active column to the floating inspector snapshot", () => {
    const document = fixture(), table = selectedTable(document)!;
    expect(tableInspectorSnapshot(document, { tableId: table.id, rowId: table.rows[3].id, columnId: table.columns[2].id }))
      .toMatchObject({ tableId: table.id, preset: "three-line", hasCaption: true, footnoteCount: 1,
        activeColumn: { id: table.columns[2].id, align: table.columns[2].align, formula: table.columns[2].formula } });
    expect(tableInspectorSnapshot({ ...document, selection: { objectIds: [] } })).toBeUndefined();
  });

  it("validates Insert Table protocol payloads strictly", () => {
    const message = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "insertTable",
      sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot",
      data: { title: "Drawing", rows: 6, columns: 4, headerRows: 1, preset: "three-line" } };
    expect(parseDialogMessage(message)).toEqual(message);
    expect(parseDialogMessage({ ...message, data: { ...message.data, rows: 0 } })).toBeUndefined();
    expect(parseDialogMessage({ ...message, data: { ...message.data, extra: true } })).toBeUndefined();
    expect(parseDialogMessage({ ...message, type: "action", data: { action: "apply", rows: 2, columns: 3, headerRows: 0, preset: "grid" } })).toBeDefined();
  });

  it("submits the modeless dialog once to its originating tab and closes after insertion", async () => {
    let snapshot!: DialogMessage;
    const insertTable = vi.fn();
    const close = vi.fn(async () => {});
    const coordinator = new DialogCoordinator({
      subscribe: async () => () => {},
      open: async value => { snapshot = value; return { hostId: "host", windowLabel: "dialog-main-insertTable-0" }; },
      publish: async () => {}, close
    }, { applyPageSize: () => {}, insertTable, onError: message => { throw new Error(message); } });
    const options = { rows: 6, columns: 4, headerRows: 1, preset: "grid" as const };
    try {
      await coordinator.openInsertTable("original-tab", { title: "Original", ...options });
      await coordinator.receive({ senderWindowId: "dialog-main-insertTable-0", windowLabel: "dialog-main-insertTable-0",
        message: { ...snapshot, type: "ready", data: {} } });
      const action = { senderWindowId: "dialog-main-insertTable-0", windowLabel: "dialog-main-insertTable-0",
        message: { ...snapshot, type: "action", data: { action: "apply", ...options }, requestId: "apply-once" } };
      await Promise.all([coordinator.receive(action), coordinator.receive(action)]);
      expect(insertTable).toHaveBeenCalledExactlyOnceWith("original-tab", { action: "apply", ...options });
      expect(close).toHaveBeenCalledWith("host", "apply");
    } finally { await coordinator.dispose(); }
  });
});
