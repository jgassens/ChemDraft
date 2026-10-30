// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeDocument, type ChemDraftDocument, type TableObject } from "@chemdraft/chem-core";
import { ensureOclResources } from "@chemdraft/ocl-adapter";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { exportTableClipboardPayloads } from "@chemdraft/export-engine";
import { MainWindow } from "./MainWindow";
import { CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, createPhase4Document, createSelectionClipboardPayload, insertNativeTextObject } from "./documentWorkflow";
import { readClipboardPayload, writeClipboardTextItems } from "./clipboard";
import { depictSmilesListForPaste } from "./smilesListPaste";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { ZodError } from "zod";
import * as tableClipboard from "./tableClipboardWiring";
import * as identityClient from "./depiction2d/identityClient";
import { IdentityWorkerUnavailableError } from "./depiction2d/identityWorkerClient";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./clipboard", async importOriginal => ({
  ...await importOriginal<typeof import("./clipboard")>(),
  readClipboardPayload: vi.fn(), writeClipboardTextItems: vi.fn()
}));
vi.mock("./smilesListPaste", async importOriginal => ({
  ...await importOriginal<typeof import("./smilesListPaste")>(),
  depictSmilesListForPaste: vi.fn()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MainWindow table clipboard wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(async () => {
    installDomRdkitLoader();
    await ensureOclResources();
  }, 20_000);
  beforeEach(() => {
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
      for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
        Object.defineProperty(prototype, key, { configurable: true, value: key === "hasPointerCapture" ? () => false : () => {} });
      }
    }
    vi.mocked(writeClipboardTextItems).mockReset().mockResolvedValue(true);
    vi.mocked(readClipboardPayload).mockReset().mockResolvedValue({ types: [], textItems: [] });
    vi.mocked(depictSmilesListForPaste).mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
      for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(prototype, key);
    }
  });
  async function render(nativeDocument = createPhase4Document("Table clipboard")) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: nativeDocument,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialCrosshairsVisible: false, initialRulersVisible: false })));
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 1056,
      width: 816, height: 1056, toJSON: () => ({}) });
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  function tableDocument(): ChemDraftDocument {
    const nativeDocument = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
    nativeDocument.selection = { pageId: nativeDocument.pages[0].id, objectIds: [nativeDocument.pages[0].objects[0].id] };
    return nativeDocument;
  }
  function clipboard(html: string, text?: string) {
    const textItems = [{ type: "text/html", text: html }, ...(text ? [{ type: "text/plain", text }] : [])];
    return { types: textItems.map(item => item.type), textItems };
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();

  it.each(["clipboard.copy", "clipboard.cut"])("%s writes the four table formats once; cut then deletes", async commandId => {
    const source = tableDocument();
    const table = source.pages[0].objects[0] as TableObject;
    table.rotation = 15;
    await render(source);
    await command(commandId);
    const exported = exportTableClipboardPayloads(table);
    expect(writeClipboardTextItems).toHaveBeenCalledTimes(1);
    const items = vi.mocked(writeClipboardTextItems).mock.calls[0][0];
    expect(items.map(item => item.type)).toEqual([CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, "text/html", "text/rtf", "text/plain"]);
    expect(JSON.parse(items[0].text)).toEqual(createSelectionClipboardPayload(source));
    expect(items.slice(1)).toEqual([
      { type: "text/html", text: exported.html }, { type: "text/rtf", text: exported.rtf }, { type: "text/plain", text: exported.tsv }
    ]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("A rotated table is copied unrotated.");
    expect(snapshot().document.pages[0].objects).toHaveLength(commandId === "clipboard.cut" ? 0 : 1);
    if (commandId === "clipboard.cut") {
      await command("edit.undo");
      expect(snapshot().document.pages[0].objects).toEqual(source.pages[0].objects);
    }
  });

  it("does not delete on an unsuccessful clipboard write", async () => {
    await render(tableDocument());
    vi.mocked(writeClipboardTextItems).mockResolvedValue(false);
    await command("clipboard.cut");
    expect(snapshot().document.pages[0].objects).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("clipboard unavailable");
  });

  it.each(["menu", "event"])("pastes Word-like HTML via %s as one selected native table and undoes once", async path => {
    // Keep an earlier object/edit so the undo assertion proves the paste is exactly one step.
    const before = insertNativeTextObject(createPhase4Document(), { x: 20, y: 20 }, "Existing");
    await render(before);
    const raw = clipboard(readFileSync("packages/fixtures/clipboard-tables/word-like.html", "utf8"), "fallback text");
    vi.mocked(readClipboardPayload).mockResolvedValue(raw);
    if (path === "menu") await command("clipboard.paste");
    else {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: raw.types,
        getData: (type: string) => raw.textItems.find(item => item.type === type)?.text ?? "" } });
      await act(async () => { window.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    }
    const objects = snapshot().document.pages[0].objects;
    expect(objects).toHaveLength(2);
    const table = objects[1] as TableObject;
    expect(table.type).toBe("table");
    expect(table.headerRowCount).toBe(1);
    expect(table.rows.map(row => row.cells.map(cell => cell.text))).toEqual([
      ["Material", "MW (g/mol)", "Density (g/mL)"], ["allyl alcohol", "58.08", "0.854"],
      ["Ti(OiPr)4", "284.22", "0.96"], ["TBHPa", "90.12", "—"]
    ]);
    expect(table.rows[2].cells[0].spans.some(span => span.text === "4" && span.script === "subscript")).toBe(true);
    expect(snapshot().selection.objectIds).toEqual([table.id]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Pasted table");
    await command("edit.undo");
    expect(snapshot().document.pages[0].objects).toEqual(before.pages[0].objects);
    expect(container.textContent).toContain("Undid Paste table");
    await command("edit.redo");
    expect(snapshot().document.pages[0].objects[1]).toEqual(table);
  });

  it.each([
    ["word-office-notes", "menu"], ["word-office-notes", "event"],
    ["excel-overflow-notes", "menu"], ["excel-overflow-notes", "event"]
  ])("pastes %s through %s as a table with notes and Density values", async (name, route) => {
    await render();
    const html = readFileSync(`packages/fixtures/clipboard-tables/${name}.html`, "utf8");
    const text = readFileSync(`packages/fixtures/clipboard-tables/${name}.tsv`, "utf8");
    if (route === "menu") {
      vi.mocked(readClipboardPayload).mockResolvedValue({ types: ["public.utf8-plain-text", "public.html"], textItems: [
        { type: "public.utf8-plain-text", text }, { type: "public.html", text: html }
      ] });
      await command("clipboard.paste");
    } else {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: {
        types: ["text/html", "text/plain"], getData: (type: string) => type === "text/html" ? html : type === "text/plain" ? text : ""
      } });
      await act(async () => { window.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(depictSmilesListForPaste).not.toHaveBeenCalled();
    const objects = snapshot().document.pages[0].objects;
    expect(objects).toHaveLength(1);
    const table = objects[0] as TableObject;
    expect(table.type).toBe("table");
    expect(table.columns).toHaveLength(7);
    expect(table.rows).toHaveLength(6);
    // Both existing Office-shaped fixtures retain their one header row and notes.
    expect(table.headerRowCount).toBe(1);
    expect(table.caption?.text).toBe(name === "word-office-notes"
      ? "Table S1. Sharpless reagent quantities (synthetic)." : "Table S2. Sharpless reagent plan (synthetic).");
    expect(table.footnotes.map(note => note.text)).toEqual(["a TBHP stock solution; synthetic example."]);
    expect(table.rows[1].cells[2].text).toBe("0.854");
    expect(table.rows[3].cells[2].text).toBe("1.204");
    expect(table.rows.map(row => row.cells[2].text)).toEqual(["Density (g/mL)", "0.854", "0.96", "1.204", "—", "1.33"]);
    expect(snapshot().selection.objectIds).toEqual([table.id]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Pasted table");
    await command("edit.undo");
    expect(snapshot().document.pages[0].objects).toHaveLength(0);
    await command("edit.redo");
    expect(snapshot().document.pages[0].objects).toEqual([table]);
  });

  it("shows a table parser refusal and pastes nothing", async () => {
    await render();
    // A single copied cell pastes as text, so use two cells to exercise table refusal.
    const html = `<table><tr><td>${"x".repeat(2001)}</td><td></td></tr></table>`;
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(html, "fallback text"));
    await command("clipboard.paste");
    expect(snapshot().document.pages[0].objects).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("2001 characters");
  });

  it("reports total-character and span refusals without pasting fallback text", async () => {
    await render();
    const before = snapshot().document;
    const row = `<tr><td>${"x".repeat(1000)}</td><td>${"y".repeat(1000)}</td></tr>`;
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(`<table>${row.repeat(101)}</table>`,
      "fallback text"));
    await command("clipboard.paste");
    expect(snapshot().document).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("This table has 202,000 characters; ChemDraft tables hold at most 200,000.");
    const spans = Array.from({ length: 201 }, (_, i) => i % 2 ? "<i>x</i>" : "<b>x</b>").join("");
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(`<table><tr><td>${spans}</td><td></td>`
      + "</tr></table>", "fallback text"));
    await command("clipboard.paste");
    expect(snapshot().document).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("The cell in row 1, column 1 has 201 spans; ChemDraft table cells hold at most 200.");
  });

  it("shows the first validation issue if a parsed paste fails document validation", async () => {
    await render();
    const before = snapshot().document;
    vi.spyOn(tableClipboard, "pasteTableIntoDocument").mockImplementationOnce(() => {
      throw new ZodError([{ code: "custom", path: [], message: "This table exceeds a document limit." }]);
    });
    const html = "<table><tr><td>a</td><td>b</td></tr></table>";
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(html));
    await command("clipboard.paste");
    expect(snapshot().document).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("This table exceeds a document limit.");
  });

  it("retains parser warnings in the status line", async () => {
    await render();
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(readFileSync("packages/fixtures/clipboard-tables/google-docs-like.html", "utf8")));
    await command("clipboard.paste");
    expect(snapshot().document.pages[0].objects[0].type).toBe("table");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Merged cells were split");
  });

  it.each(["CCO", "[13CH4]"])("verifies plain-text %s as a molecule ahead of an HTML table", async text => {
    await render();
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(
      readFileSync("packages/fixtures/clipboard-tables/word-like.html", "utf8"), text));
    await command("clipboard.paste");
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Pasted SMILES structure");
    }, { timeout: 15_000 });
    const objects = snapshot().document.pages[0].objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("molecule");
    if (objects[0].type === "molecule" && text === "[13CH4]") {
      expect(objects[0].atoms).toEqual([expect.objectContaining({ element: "C", isotope: 13 })]);
    }
  }, 20_000);

  it("pastes a Word-shaped table containing CH2Cl2 and MW as a table", async () => {
    await render();
    const actual = await vi.importActual<typeof import("./smilesListPaste")>("./smilesListPaste");
    vi.mocked(depictSmilesListForPaste).mockImplementation(actual.depictSmilesListForPaste);
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><table class="MsoTableGrid"><tr><td>Solvent</td><td>MW</td></tr><tr><td>CH2Cl2</td><td>84.93</td></tr></table></body></html>',
      "Solvent\tMW\nCH2Cl2\t84.93"));
    await command("clipboard.paste");
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Pasted table");
    }, { timeout: 15_000 });
    const objects = snapshot().document.pages[0].objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: "table", rows: [
      { cells: [{ text: "Solvent" }, { text: "MW" }] },
      { cells: [{ text: "CH2Cl2" }, { text: "84.93" }] }
    ] });
  }, 20_000);

  it("keeps a rectangular SMILES list as verified structures ahead of an HTML table", async () => {
    await render();
    const text = "CCO\tCCN\nCCC\tCCCC";
    const actual = await vi.importActual<typeof import("./smilesListPaste")>("./smilesListPaste");
    vi.mocked(depictSmilesListForPaste).mockImplementation(actual.depictSmilesListForPaste);
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(readFileSync("packages/fixtures/clipboard-tables/word-like.html", "utf8"), text));
    await command("clipboard.paste");
    expect(depictSmilesListForPaste).toHaveBeenCalledOnce();
    expect(vi.mocked(depictSmilesListForPaste).mock.calls[0][4]).toBeTypeOf("function");
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(snapshot().document.pages[0].objects).toHaveLength(4);
    }, { timeout: 15_000 });
    const objects = snapshot().document.pages[0].objects;
    expect(objects.filter(object => object.type === "molecule")).toHaveLength(4);
    expect(objects.some(object => object.type === "table")).toBe(false);
  }, 20_000);

  it("keeps the table status and conversion warnings when RDKit cannot verify a SMILES list", async () => {
    await render();
    const actual = await vi.importActual<typeof import("./smilesListPaste")>("./smilesListPaste");
    vi.mocked(depictSmilesListForPaste).mockImplementation(actual.depictSmilesListForPaste);
    const inspect = vi.spyOn(identityClient, "inspectStructureOffThread")
      .mockRejectedValue(new IdentityWorkerUnavailableError("RDKit unavailable in test"));
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard(
      readFileSync("packages/fixtures/clipboard-tables/google-docs-like.html", "utf8"),
      "CCO\tCCN\nCCC\tCCCC"));

    await command("clipboard.paste");
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(snapshot().document.pages[0].objects).toHaveLength(1);
      expect(snapshot().document.pages[0].objects[0].type).toBe("table");
    }, { timeout: 15_000 });
    expect(inspect).toHaveBeenCalled();
    expect(container.querySelector('[data-status-message]')?.textContent)
      .toMatch(/^Pasted table; .*Merged cells were split/);
  }, 20_000);

  it("tries TSV when a prospective SMILES list fails to parse", async () => {
    await render();
    vi.mocked(depictSmilesListForPaste).mockReturnValue(Promise.resolve(undefined));
    vi.mocked(readClipboardPayload).mockResolvedValue({ types: ["text/plain"], textItems: [{ type: "text/plain", text: "CCO\tlabel\nCCN\tother" }] });
    await command("clipboard.paste");
    expect(snapshot().document.pages[0].objects[0].type).toBe("table");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Pasted table");
  });

  it("pastes the quoted spreadsheet fixture as native cells after chemical parsing declines", async () => {
    await render();
    vi.mocked(depictSmilesListForPaste).mockReturnValue(Promise.resolve(undefined));
    vi.mocked(readClipboardPayload).mockResolvedValue({ types: ["text/plain"], textItems: [{ type: "text/plain",
      text: readFileSync("packages/fixtures/clipboard-tables/excel-quoted.tsv", "utf8") }] });
    await command("clipboard.paste");
    const table = snapshot().document.pages[0].objects[0] as TableObject;
    expect(table.type).toBe("table");
    expect(table.rows[1].cells[2].text).toBe("first line\nsecond line");
    expect(table.rows[2].cells[2].text).toBe("has a\ttab");
    expect(table.rows[3].cells[2].text).toBe('says "neat"');
    expect(snapshot().selection.objectIds).toEqual([table.id]);
    await command("edit.undo");
    expect(snapshot().document.pages[0].objects).toHaveLength(0);
    expect(container.textContent).toContain("Undid Paste table");
  });
});
