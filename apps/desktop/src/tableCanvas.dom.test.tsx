// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { planPageSvgRender, planTableLayout, type PageSvgFragment } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { DOM_COMMAND_EVENT, listenForToolsetTextStyle } from "./window-manager";
import { createPhase4Document } from "./documentWorkflow";
import { InsertTableForm } from "./dialogs/InsertTableForm";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("native tables on the canvas", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
      for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
        Object.defineProperty(prototype, key, { configurable: true, value: key === "hasPointerCapture" ? () => false : () => {} });
      }
    }
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(prototype, key);
  });
  const fixture = () => deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
  async function render(nativeDocument: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: nativeDocument,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialCrosshairsVisible: false, initialRulersVisible: false })));
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 1056, width: 816, height: 1056, toJSON: () => ({}) });
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function pointer(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, detail: 1, clientX: x, clientY: y });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 17 }, pointerType: { value: "mouse" } });
    await act(async () => target.dispatchEvent(event));
  }

  it("renders the shared page SVG fragment, selects the entire bounds, deletes and undoes", async () => {
    const nativeDocument = fixture();
    const table = nativeDocument.pages[0].objects[0];
    if (table.type !== "table") throw new Error("Expected a table");
    const fragment = planPageSvgRender(nativeDocument.pages[0]).fragments.find(f => f.attrs["data-object-id"] === table.id)!;
    await render(nativeDocument);
    const visual = container.querySelector(`[data-page-svg-object-visual='${table.id}']`)!;
    expect(visual.textContent).toContain("Sharpless epoxidation");
    const check = (part: PageSvgFragment) => {
      if (part.kind === "text") return;
      const id = part.attrs.id;
      if (id) {
        const element = visual.querySelector(`[id='${id}']`)!;
        expect(element, String(id)).not.toBeNull();
        for (const key of ["x", "y", "x1", "x2", "y1", "y2", "font-size", "stroke-width"]) {
          if (part.attrs[key] !== undefined) expect(element.getAttribute(key)).toBe(String(part.attrs[key]));
        }
      }
      part.children.forEach(check);
    };
    check(fragment);
    const hit = visual.querySelector("[data-table-hit-target]")!;
    expect(Number(hit.getAttribute("height"))).toBeCloseTo(planTableLayout(table).height);
    // The full bounds catcher includes whitespace in the footnote area.
    await pointer(hit, "pointerdown", table.x + 10, table.y + planTableLayout(table).height - 2);
    await pointer(container.querySelector(".page")!, "pointerup", table.x + 10, table.y + planTableLayout(table).height - 2);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().selection.objectIds).toEqual([table.id]);
    expect(container.querySelector(`[data-object-controls='${table.id}'].selected`)).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    expect(container.querySelector(`[data-page-svg-object-visual='${table.id}']`)).toBeNull();
    await command("edit.undo");
    expect(container.querySelector(`[data-page-svg-object-visual='${table.id}']`)).not.toBeNull();
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0]).toEqual(table);
  });

  it("registers insertion and table editing commands with one labelled undo each", async () => {
    await render(createPhase4Document());
    await command("table.insert.r6c7h1");
    let snapshot = window.__CHEMDRAFT_AGENT__!.snapshot();
    const table = snapshot.document.pages[0].objects[0];
    expect(table.type).toBe("table");
    if (table.type !== "table") throw new Error("Expected table");
    expect(table.rows).toHaveLength(6); expect(table.columns).toHaveLength(7);
    expect(snapshot.selection.objectIds).toEqual([table.id]);
    await command("edit.undo");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects).toHaveLength(0);
    expect(container.textContent).toContain("Undid Insert table");
    await command("edit.redo");
    for (const [id, label] of [["table.row.insertBelow", "Insert row"], ["table.column.insertRight", "Insert column"], ["table.style.grid", "Style table"], ["table.caption.toggle", "Edit caption"], ["table.footnote.add", "Edit footnotes"]]) {
      const before = window.__CHEMDRAFT_AGENT__!.snapshot().document;
      await command(id);
      snapshot = window.__CHEMDRAFT_AGENT__!.snapshot();
      expect(snapshot.selection.objectIds).toEqual([table.id]);
      expect(snapshot.document).not.toEqual(before);
      await command("edit.undo");
      expect(window.__CHEMDRAFT_AGENT__!.snapshot().document).toEqual(before);
      expect(container.textContent).toContain(`Undid ${label}`);
    }
  });

  it("broadcasts the selected table state to the floating inspector", async () => {
    const snapshots: unknown[] = [];
    const stop = await listenForToolsetTextStyle(payload => snapshots.push(payload.currentTable));
    try {
      const nativeDocument = fixture();
      nativeDocument.selection = { pageId: nativeDocument.pages[0].id, objectIds: ["table-sharpless"] };
      await render(nativeDocument);
      expect(snapshots.at(-1)).toMatchObject({ tableId: "table-sharpless", hasCaption: true, footnoteCount: 1,
        activeColumn: { id: "col-material", align: "left", formula: "auto" } });
      await command("table.style.grid");
      expect(snapshots.at(-1)).toMatchObject({ preset: "grid" });
    } finally { stop(); }
  });

  it("moves a table with the ordinary canvas drag path and undoes the move", async () => {
    await render(fixture());
    const hit = container.querySelector("[data-table-hit-target]")!;
    const before = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0];
    await pointer(hit, "pointerdown", before.x + 10, before.y + 10);
    await pointer(container.querySelector(".page")!, "pointermove", before.x + 40, before.y + 30);
    await pointer(container.querySelector(".page")!, "pointerup", before.x + 40, before.y + 30);
    const moved = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0];
    expect(moved.x).toBeGreaterThan(before.x);
    expect(moved.y).toBeGreaterThan(before.y);
    await command("edit.undo");
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0]).toEqual(before);
  });

  it.each(["macos", "windows"] as const)("submits defaults and cancels with Escape on %s", async platform => {
    const onSubmit = vi.fn(), onCancel = vi.fn();
    await act(async () => root.render(<InsertTableForm platform={platform} title="Drawing"
      initial={{ rows: 6, columns: 4, headerRows: 1, preset: "three-line" }} onSubmit={onSubmit} onCancel={onCancel} />));
    expect(document.activeElement).toBe(container.querySelector("input"));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ rows: 6, columns: 4, headerRows: 1, preset: "three-line" });
    await act(async () => container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
