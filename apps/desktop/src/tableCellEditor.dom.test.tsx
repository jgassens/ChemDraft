// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type TableObject } from "@chemdraft/chem-core";
import { buildTableObject } from "@chemdraft/document-workflow-core";
import {
  planTableLayout, tableCellElementId, tableVisualBoundsForArrangement, transformPointForObject
} from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("table real DOM editing (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const currentTable = () => snapshot().document.pages[0].objects[0] as TableObject;
  const editor = () => container.querySelector<HTMLTextAreaElement>("[data-table-cell-editor] textarea");
  const canvas = () => container.querySelector<HTMLElement>(".canvas-region")!;
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const scale = () => (snapshot().viewport as { scale: number }).scale;
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"
    ] });
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
  async function mount(options: { rows?: string[][]; formula?: "auto" | "off"; cellFormula?: "auto" | "off"; rotation?: number } = {}) {
    let id = 0;
    const table = buildTableObject({ columns: [{ widthPx: 100, formula: options.formula }, { widthPx: 110, formula: options.formula }],
      rows: options.rows ?? [["", ""], ["", ""]], style: { fontFamily: "Georgia", fontSizePx: 18 } },
    { id: "table-test", x: 80, y: 90, newId: prefix => `${prefix}-${++id}` }).object;
    table.rotation = options.rotation ?? 0;
    table.style.color = "#234567";
    if (options.cellFormula) table.rows[0].cells[0].formula = options.cellFormula;
    const empty = createPhase4Document("Table editing");
    const doc = applyPatches(empty, [{ op: "addObject", pageId: empty.pages[0].id, object: table },
      { op: "setSelection", pageId: empty.pages[0].id, objectIds: [table.id] }]);
    await act(async () => root.render(<MainWindow initialDocument={doc} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
    const rect = { x: 20, y: -30, left: 20, top: -30, right: 836, bottom: 1026, width: 816, height: 1056, toJSON: () => ({}) };
    vi.spyOn(page(), "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(canvas(), "getBoundingClientRect").mockReturnValue({ ...rect, left: 0, top: 0, x: 0, y: 0 });
    vi.spyOn(canvas(), "clientWidth", "get").mockReturnValue(816);
    vi.spyOn(canvas(), "clientHeight", "get").mockReturnValue(1056);
  }
  async function pointer(target: EventTarget, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    await act(async () => target.dispatchEvent(event));
    return event;
  }
  async function open(row = 0, column = 0) {
    const table = currentTable(), box = planTableLayout(table).cells.find(cell => cell.rowIndex === row && cell.columnIndex === column)!.box;
    const point = transformPointForObject(table, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const rect = page().getBoundingClientRect(), x = rect.left + point.x * scale(), y = rect.top + point.y * scale();
    const target = container.querySelector("[data-table-hit-target]")!;
    // Real DOM input path, including both pointer presses of the double-click; no bridge events.
    await pointer(target, "pointerdown", x, y); await pointer(page(), "pointerup", x, y);
    await pointer(target, "pointerdown", x, y); await pointer(page(), "pointerup", x, y);
    await act(async () => target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, clientX: x, clientY: y })));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).not.toBeNull(); expect(document.activeElement).toBe(editor());
  }
  async function type(value: string) {
    await act(async () => {
      nativeValueSetter.call(editor(), value);
      editor()!.setSelectionRange(value.length, value.length);
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function key(key: string, modifiers: KeyboardEventInit = {}, target: EventTarget = editor()!) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    await act(async () => target.dispatchEvent(event)); return event;
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  const cell = (row = 0, column = 0) => currentTable().rows[row].cells[column];

  it("opens only one cell, commits typing then formula as two labelled entries, and restores exact undo/redo", async () => {
    await mount(); const initial = currentTable(); await open();
    expect(container.querySelectorAll("[data-table-cell-editor] textarea")).toHaveLength(1);
    expect(editor()!.style.fontFamily).toBe("Georgia"); expect(editor()!.style.caretColor).toBe("rgb(35, 69, 103)");
    const box = planTableLayout(initial).cells[0].box;
    expect(editor()!.parentElement!.style.left).toBe(`${box.x * scale()}px`);
    expect(editor()!.parentElement!.style.width).toBe(`${box.width * scale()}px`);
    await type("CH2Cl2"); expect(cell().text).toBe("");
    const globalKey = vi.fn(); window.addEventListener("keydown", globalKey);
    try { expect((await key("Tab")).defaultPrevented).toBe(true); expect(globalKey).not.toHaveBeenCalled(); }
    finally { window.removeEventListener("keydown", globalKey); }
    expect(cell().text).toBe("CH2Cl2"); expect(cell().spans.filter(span => span.script === "subscript").map(span => span.text)).toEqual(["2", "2"]);
    expect(editor()!.parentElement!.dataset.columnId).toBe(currentTable().columns[1].id);
    expect(document.activeElement).toBe(editor());
    await key("z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(editor()).toBeNull(); expect(document.activeElement).toBe(canvas());
    expect(container.textContent).toContain("Undid Format formula");
    expect(cell().text).toBe("CH2Cl2"); expect(cell().spans.every(span => span.script === "normal")).toBe(true);
    await command("edit.undo"); expect(container.textContent).toContain("Undid Edit cell"); expect(currentTable()).toEqual(initial);
    await command("edit.redo"); expect(container.textContent).toContain("Redid Edit cell"); expect(cell().text).toBe("CH2Cl2");
    await command("edit.redo"); expect(container.textContent).toContain("Redid Format formula");
    expect(cell().spans.some(span => span.script === "subscript")).toBe(true);
  });

  it("Escape cancels and an unchanged commit creates no history", async () => {
    await mount(); const before = currentTable(); await open(); await type("cancelled"); await key("Escape");
    expect(editor()).toBeNull(); expect(currentTable()).toEqual(before);
    await key("Enter", {}, canvas()); expect(editor()).not.toBeNull();
    await key("Enter"); await key("Escape");
    await command("edit.undo"); expect(container.textContent).toContain("Nothing to undo");
  });

  it("creates no edit or formula entry for typing reverted to the original rich text", async () => {
    await mount({ rows: [["plain", ""], ["", ""]], formula: "off" }); await open();
    const before = currentTable(); await type("changed"); await type("plain");
    await key("Enter"); await key("Escape"); await command("edit.undo");
    expect(container.textContent).toContain("Nothing to undo"); expect(currentTable()).toEqual(before);
  });

  it("Shift+Enter inserts a newline, arrows on interior lines stay, Enter moves down and stops in the final row", async () => {
    await mount({ formula: "off" }); await open(); await type("first"); await key("Enter", { shiftKey: true });
    expect(editor()!.value).toBe("first\n"); await type("first\nsecond");
    await act(async () => {
      editor()!.scrollTop = 12; editor()!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector<HTMLElement>("[data-table-cell-preview]")!.style.transform).toBe("translate(0px, -12px)");
    editor()!.setSelectionRange(7, 7); expect((await key("ArrowUp")).defaultPrevented).toBe(false);
    expect(editor()!.parentElement!.dataset.rowId).toBe(currentTable().rows[0].id);
    await key("Enter"); expect(cell().text).toBe("first\nsecond");
    expect(editor()!.parentElement!.dataset.rowId).toBe(currentTable().rows[1].id);
    await type("last"); await key("Enter"); expect(editor()).toBeNull(); expect(cell(1).text).toBe("last");
  });

  it("Tab at the last cell inserts one row, while Shift+Tab crosses back to the previous row", async () => {
    await mount({ formula: "off" }); await open(1, 1); await type("tail"); await key("Tab");
    expect(currentTable().rows).toHaveLength(3); expect(cell(1, 1).text).toBe("tail");
    expect(editor()!.parentElement!.dataset.rowId).toBe(currentTable().rows[2].id);
    expect(editor()!.parentElement!.dataset.columnId).toBe(currentTable().columns[0].id);
    await key("Tab", { shiftKey: true });
    expect(editor()!.parentElement!.dataset.rowId).toBe(currentTable().rows[1].id);
    expect(editor()!.parentElement!.dataset.columnId).toBe(currentTable().columns[1].id);
    await key("Escape"); await command("edit.undo"); expect(container.textContent).toContain("Undid Insert row"); expect(currentTable().rows).toHaveLength(2);
    await command("edit.undo"); expect(cell(1, 1).text).toBe("");
  });

  it.each(["auto", "off"] as const)("honours the cell's %s formula override", async cellFormula => {
    await mount({ formula: cellFormula === "auto" ? "off" : "auto", cellFormula });
    await open(); await type("CH2Cl2"); await pointer(page(), "pointerdown", 600, 600);
    expect(editor()).toBeNull(); expect(cell().text).toBe("CH2Cl2");
    expect(cell().spans.some(span => span.script === "subscript")).toBe(cellFormula === "auto");
  });

  it("reuses text formatting commands, their keyboard chords and native symbol insertion", async () => {
    await mount({ formula: "off" }); await open(); await type("CH2");
    editor()!.setSelectionRange(2, 3);
    const modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    await key("=", modifier); await key("b", modifier); await key("i", modifier);
    // Native palette commands use the same registered command path as the text editor.
    await act(async () => editor()!.dispatchEvent(new Event("select", { bubbles: true })));
    await command("text.script.superscript");
    editor()!.setSelectionRange(3, 3);
    await act(async () => editor()!.dispatchEvent(new Event("select", { bubbles: true })));
    await command("tool.symbol.degree"); expect(editor()!.value).toBe("CH2°");
    await key("Enter"); await key("Escape");
    expect(cell().spans.find(span => span.text.includes("2"))).toMatchObject({ script: "superscript", style: { fontWeight: 700, fontStyle: "italic" } });
    expect(currentTable().rows[0].cells[0].text).toBe("CH2°");
  });

  it("keeps formatting chosen in an empty cell when typing begins", async () => {
    await mount({ formula: "off" }); await open();
    const modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    await key("b", modifier); await key("i", modifier); await key("=", modifier);
    await type("typed"); await key("Enter"); await key("Escape");
    expect(cell().spans).toEqual([{ text: "typed", script: "subscript", style: { fontWeight: 700, fontStyle: "italic" } }]);
  });

  it("moves across each cell edge with real arrow keys and updates the active column", async () => {
    await mount({ rows: [["ab", "cd"], ["ef", "gh"]], formula: "off" });
    await open(0, 1); editor()!.setSelectionRange(0, 0); await key("ArrowLeft");
    expect(editor()!.value).toBe("ab");
    editor()!.setSelectionRange(2, 2); await key("ArrowRight"); expect(editor()!.value).toBe("cd");
    await key("ArrowDown"); expect(editor()!.value).toBe("gh");
    await key("ArrowUp"); expect(editor()!.value).toBe("cd");
    await key("Escape"); await command("table.column.align.right");
    expect(currentTable().columns[1].align).toBe("right"); expect(currentTable().columns[0].align).toBe("left");
  });

  it("scales the editor with zoom and keeps the resize hit strip at six screen pixels", async () => {
    await mount(); await command("view.zoomIn"); await command("view.zoomIn");
    expect(scale()).not.toBe(1); await open();
    const table = currentTable(), box = planTableLayout(table).cells[0].box;
    expect(editor()!.parentElement!.style.top).toBe(`${box.y * scale()}px`);
    expect(editor()!.style.fontSize).toBe(`${18 * scale()}px`);
    expect(container.querySelector<HTMLElement>("[data-table-column-resizer]")!.style.width).toBe("6px");
    await key("Escape");
  });

  it("holds an outside click during composition and commits the final IME input after compositionend", async () => {
    await mount({ formula: "off" }); await open();
    await act(async () => editor()!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await type("入"); const outside = await pointer(page(), "pointerdown", 600, 600);
    expect(outside.defaultPrevented).toBe(true); expect(editor()).not.toBeNull();
    await act(async () => editor()!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await type("入力"); await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(editor()).toBeNull(); expect(cell().text).toBe("入力"); expect(document.activeElement).toBe(canvas());
  });

  it("blocks reload and canvas shortcuts, and leaves composing Enter inside the editor", async () => {
    await mount(); await open(); const globalKey = vi.fn(); window.addEventListener("keydown", globalKey);
    try {
      expect((await key("F5")).defaultPrevented).toBe(true);
      if (platform === "windows") expect((await key("r", { ctrlKey: true })).defaultPrevented).toBe(true);
      await key("Delete"); await key("b"); await key("Tab", { ctrlKey: true });
      await act(async () => editor()!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      await type("入力"); await key("Enter", { isComposing: true }); expect(cell().text).toBe("");
      await act(async () => editor()!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      expect(globalKey).not.toHaveBeenCalled(); expect(currentTable()).toBeDefined();
    } finally { window.removeEventListener("keydown", globalKey); }
    await key("Escape");
  });

  it("previews column width, commits one drag entry, then double-clicks back to auto", async () => {
    await mount(); const before = currentTable();
    const resizer = () => container.querySelector<HTMLElement>(`[data-table-column-resizer='${before.columns[0].id}']`)!;
    expect(resizer().style.width).toBe("6px"); expect(resizer().style.cursor).toBe("col-resize");
    await pointer(resizer(), "pointerdown", 200, 100);
    await pointer(page(), "pointermove", 210, 100); await pointer(page(), "pointermove", 240, 100);
    await act(async () => vi.advanceTimersToNextFrame());
    expect(currentTable()).toEqual(before); // Preview is never written into history/present.
    expect(resizer().style.left).toBe(`${(100 + 40 / scale()) * scale() - 3}px`);
    await pointer(page(), "pointerup", 250, 100);
    expect(currentTable().columns[0].width).toEqual({ mode: "fixed", px: 100 + 50 / scale() });
    await command("edit.undo"); expect(container.textContent).toContain("Undid Resize column"); expect(currentTable()).toEqual(before);
    await command("edit.undo"); expect(container.textContent).toContain("Nothing to undo");
    await command("edit.redo");
    await act(async () => resizer().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
    expect(currentTable().columns[0].width).toEqual({ mode: "auto" });
    await command("edit.undo"); expect(container.textContent).toContain("Undid Auto-fit column");
    expect(currentTable().columns[0].width.mode).toBe("fixed");
    await command("table.column.autoFit"); expect(currentTable().columns[0].width).toEqual({ mode: "auto" });
  });

  it("hides only the active cell's shared SVG ID while editing", async () => {
    await mount({ rows: [["first", "second"], ["third", "fourth"]], formula: "off" });
    const table = currentTable();
    const cellText = (column: number) => document.getElementById(
      `${tableCellElementId(table.id, table.rows[0].id, table.columns[column].id)}-line-0-piece-0`);
    expect(cellText(0)?.textContent).toBe("first");
    await open();
    expect(cellText(0)?.textContent).toBe("");
    expect(cellText(1)?.textContent).toBe("second");
    await key("Escape");
    expect(cellText(0)?.textContent).toBe("first");
  });

  it("uses the stored rotation pivot for editing and clamps/cancels a column drag", async () => {
    await mount({ rotation: 90 });
    const bounds = tableVisualBoundsForArrangement(currentTable());
    const hit = container.querySelector("[data-table-hit-target]")!;
    expect(Number(hit.getAttribute("x"))).toBeCloseTo(bounds.x);
    expect(Number(hit.getAttribute("y"))).toBeCloseTo(bounds.y);
    expect(Number(hit.getAttribute("width"))).toBeCloseTo(bounds.width);
    expect(Number(hit.getAttribute("height"))).toBeCloseTo(bounds.height);
    expect(hit.getAttribute("transform")).toBeNull();
    await open();
    const box = planTableLayout(currentTable()).cells[0].box;
    expect(editor()!.parentElement!.style.transform).toBe("rotate(90deg)");
    expect(editor()!.parentElement!.style.transformOrigin).toBe(`${(currentTable().x + currentTable().width / 2 - box.x) * scale()}px ${(currentTable().y + currentTable().height / 2 - box.y) * scale()}px`);
    await key("Escape");
    const resizer = container.querySelector("[data-table-column-resizer]")!;
    await pointer(resizer, "pointerdown", 200, 200); await pointer(page(), "pointerup", 200, 0);
    expect(currentTable().columns[0].width).toEqual({ mode: "fixed", px: 12 });
    await command("edit.undo");
    await pointer(resizer, "pointerdown", 200, 200); await pointer(page(), "pointermove", 200, 300);
    await pointer(page(), "pointercancel", 200, 300); expect(currentTable().columns[0].width).toEqual({ mode: "fixed", px: 100 });
    await act(async () => vi.advanceTimersToNextFrame());
    await command("edit.undo"); expect(container.textContent).toContain("Nothing to undo");
  });
});
