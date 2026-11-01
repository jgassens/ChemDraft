// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type TableObject } from "@chemdraft/chem-core";
import { buildTableObject } from "@chemdraft/document-workflow-core";
import { planTableLayout, transformPointForObject } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("table context-menu cell targets (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const tables = () => snapshot().document.pages[0].objects.filter(object => object.type === "table");
  const currentTable = () => tables()[0];
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const editor = () => container.querySelector<HTMLTextAreaElement>("[data-table-cell-editor] textarea");
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: () => false });
    }
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, method);
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function mount(rotation = 0, secondTable = false) {
    let id = 0;
    const makeTable = (tableId: string, y: number) => {
      const table = buildTableObject({ columns: [{ widthPx: 100 }, { widthPx: 110 }, { widthPx: 120 }],
        headerRows: [["Header A", "Header B", ""]], rows: [["A1", "B1", ""], ["A2", "B2", ""], ["A3", "B3", ""]],
        caption: "Caption", footnotes: ["Note"] },
      { id: tableId, x: 80, y, newId: prefix => `${prefix}-${++id}` }).object;
      table.rotation = rotation;
      return table;
    };
    const table = makeTable("table-context", 90);
    const empty = createPhase4Document("Table context menu");
    const doc = applyPatches(empty, [
      { op: "addObject", pageId: empty.pages[0].id, object: table },
      ...(secondTable ? [{ op: "addObject" as const, pageId: empty.pages[0].id, object: makeTable("table-other", 500) }] : []),
      { op: "setSelection", pageId: empty.pages[0].id, objectIds: [table.id] }
    ]);
    await act(async () => root.render(<MainWindow initialDocument={doc} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false}
      nativePalette shortcutPlatform={platform} />));
    vi.spyOn(page(), "getBoundingClientRect").mockReturnValue({ x: 20, y: -30, left: 20, top: -30,
      right: 836, bottom: 1026, width: 816, height: 1056, toJSON: () => ({}) });
  }
  function eventAt(table: TableObject, box: { x: number; y: number; width: number; height: number }, type: string) {
    const point = transformPointForObject(table, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const rect = page().getBoundingClientRect(), scale = (snapshot().viewport as { scale: number }).scale;
    return new MouseEvent(type, { bubbles: true, cancelable: true, button: type === "contextmenu" ? 2 : 0,
      clientX: rect.left + point.x * scale, clientY: rect.top + point.y * scale, detail: type === "dblclick" ? 2 : 1 });
  }
  const cellBox = (table: TableObject, row: number, column: number) =>
    planTableLayout(table).cells.find(cell => cell.rowIndex === row && cell.columnIndex === column)!.box;
  const hitTarget = (table: TableObject) => container.querySelector(`[data-page-svg-object-visual='${table.id}'] [data-table-hit-target]`)!;
  async function editCell(row: number, column: number, value: string, commit = true) {
    const table = currentTable();
    await act(async () => hitTarget(table).dispatchEvent(eventAt(table, cellBox(table, row, column), "dblclick")));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).not.toBeNull();
    await act(async () => {
      nativeValueSetter.call(editor(), value);
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (commit) {
      await act(async () => container.querySelector<HTMLElement>(".canvas-region")!.focus());
      expect(editor()).toBeNull();
      expect(currentTable().rows[row].cells[column].text).toBe(value);
    }
  }
  async function choose(commandId: string) {
    const button = container.querySelector<HTMLButtonElement>(`.object-context-menu [data-command-id='${commandId}']`)!;
    expect(button).not.toBeNull(); expect(button.disabled).toBe(false);
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(container.querySelector(".object-context-menu")).toBeNull();
  }
  async function rightClick(table: TableObject, box: { x: number; y: number; width: number; height: number }, commandId?: string) {
    const event = eventAt(table, box, "contextmenu");
    await act(async () => {
      hitTarget(table).dispatchEvent(event);
      // The native command bridge and inline menu both invoke the registered table handler.
      // Dispatch before React renders to exercise the synchronous target, not a fresh closure.
      if (commandId) window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
    expect(event.defaultPrevented).toBe(true);
  }

  for (const rotation of [0, 37]) {
    it.each(["inline menu", "registered command"])(`targets row/column edits after another cell was edited, rotation ${rotation}, %s`, async route => {
      await mount(rotation);
      const invokeAt = async (row: number, column: number, commandId: string) => {
        const table = currentTable();
        await rightClick(table, cellBox(table, row, column), route === "registered command" ? commandId : undefined);
        if (route === "inline menu") await choose(commandId);
      };
      await editCell(1, 0, "Edited before row insert");
      let before = currentTable();
      expect(before.headerRowCount).toBe(1);
      await invokeAt(0, 1, "table.row.insertAbove");
      expect(currentTable().rows.slice(1)).toEqual(before.rows);
      expect(currentTable().rows[0].cells.every(cell => cell.text === "")).toBe(true);
      expect(currentTable().rows[0].id).not.toBe(before.rows[0].id);

      await editCell(1, 0, "Edited before column insert");
      before = currentTable();
      await invokeAt(2, 1, "table.column.insertRight");
      expect(currentTable().columns.map(column => column.id)).toEqual([
        before.columns[0].id, before.columns[1].id, expect.any(String), before.columns[2].id
      ]);
      expect(before.columns.some(column => column.id === currentTable().columns[2].id)).toBe(false);
      expect(currentTable().rows.map(row => row.cells.filter((_, index) => index !== 2)))
        .toEqual(before.rows.map(row => row.cells));
      expect(currentTable().rows.every(row => row.cells[2].text === "")).toBe(true);

      await editCell(1, 0, "Edited before column delete");
      before = currentTable();
      expect(before.rows[3].cells[3].text).toBe("");
      await invokeAt(3, 3, "table.column.delete");
      expect(currentTable().columns).toEqual(before.columns.slice(0, 3));
      expect(currentTable().rows.map(row => row.cells)).toEqual(before.rows.map(row => row.cells.slice(0, 3)));
      expect(currentTable().rows.map(row => row.id)).toEqual(before.rows.map(row => row.id));
    });
  }

  it("commits a pending edit before a contextmenu event changes the active cell", async () => {
    await mount(); await editCell(1, 0, "Keep this draft", false);
    const before = currentTable();
    await rightClick(before, cellBox(before, 2, 1));
    await choose("table.column.delete");
    expect(currentTable().columns.map(column => column.id)).toEqual([before.columns[0].id, before.columns[2].id]);
    expect(currentTable().rows[1].cells[0].text).toBe("Keep this draft");
  });

  it.each(["caption", "footnote", "outside"] as const)("keeps a same-table cell for %s, and defaults safely when switching tables", async area => {
    await mount(0, true); await editCell(2, 1, "Previous target");
    const noteBox = (table: TableObject) => {
      const layout = planTableLayout(table);
      return area === "caption" ? layout.captionBox! : area === "footnote" ? layout.footnoteBoxes[0]
        : { x: table.x - 10, y: table.y - 10, width: 1, height: 1 };
    };
    // jsdom does not hit-test SVG: the outside case models an object-wrapper contextmenu.
    let before = currentTable();
    await rightClick(before, noteBox(before)); await choose("table.column.delete");
    expect(currentTable().columns.map(column => column.id)).toEqual([before.columns[0].id, before.columns[2].id]);
    const other = tables()[1]; before = currentTable();
    await rightClick(other, noteBox(other)); await choose("table.column.delete");
    expect(tables()[1].columns).toEqual(other.columns.slice(1));
    expect(currentTable()).toEqual(before);
  });
});
