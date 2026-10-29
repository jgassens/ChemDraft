import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { deserializeDocument, textStyleToObjectStyle, type TableObject } from "@chemdraft/chem-core";
import type { ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { exportTableClipboardPayloads } from "@chemdraft/export-engine";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, createPhase4Document, createSelectionClipboardPayload,
  insertNativeTemplateMolecule, insertNativeTextObject, insertTableIntoDocument, serializeSelectionClipboardPayload
} from "./documentWorkflow";
import { pasteTableIntoDocument, readTableClipboardPaste, tableClipboardPasteDecision, tableSelectionClipboardItems } from "./tableClipboardWiring";

const fixture = (name: string) => readFileSync(`packages/fixtures/clipboard-tables/${name}`, "utf8");
const parseHtml = (html: string) => new JSDOM(html).window.document;
const payload = (...textItems: ClipboardReadPayload["textItems"]): ClipboardReadPayload => ({ types: textItems.map(item => item.type), textItems });
const htmlPayload = (name = "word-like.html") => payload({ type: "text/html", text: fixture(name) });
const ids = () => { let count = 0; return (prefix: string) => `${prefix}-copy-test-${++count}`; };
function selectedTable() {
  const document = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
  document.selection = { pageId: document.pages[0].id, objectIds: document.pages[0].objects.map(object => object.id) };
  return document;
}

describe("table-only copy", () => {
  it("writes exactly the native selection, HTML, RTF and plain TSV items without images", () => {
    const selection = createSelectionClipboardPayload(selectedTable())!;
    const result = tableSelectionClipboardItems(selection)!;
    const table = selection.objects[0] as TableObject;
    const exported = exportTableClipboardPayloads(table);
    expect(result).toEqual({ items: [
      { type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: serializeSelectionClipboardPayload(selection) },
      { type: "text/html", text: exported.html }, { type: "text/rtf", text: exported.rtf },
      { type: "text/plain", text: exported.tsv }
    ], warnings: exported.warnings });
    expect(selection.objects[0]).toEqual(table);
  });

  it("declines empty, text, molecule, mixed and molecule-fragment selections", () => {
    const table = selectedTable();
    const text = insertNativeTextObject(table, { x: 10, y: 10 }, "caption");
    const molecule = insertNativeTemplateMolecule(table, { x: 10, y: 10 }, "cyclohexane");
    expect(createSelectionClipboardPayload(createPhase4Document())).toBeUndefined();
    expect(tableSelectionClipboardItems({ ...createSelectionClipboardPayload(table)!, objects: [] })).toBeUndefined();
    for (const document of [text, molecule]) {
      expect(tableSelectionClipboardItems(createSelectionClipboardPayload(document)!)).toBeUndefined();
      const mixed = { ...document, selection: { ...document.selection, objectIds: document.pages[0].objects.map(object => object.id) } };
      expect(tableSelectionClipboardItems(createSelectionClipboardPayload(mixed)!)).toBeUndefined();
    }
    const ring = molecule.pages[0].objects.find(object => object.type === "molecule")!;
    if (ring.type !== "molecule") throw new Error("Expected molecule");
    expect(tableSelectionClipboardItems(createSelectionClipboardPayload({ ...molecule, selection: table.selection }, [{
      objectId: ring.id, atomIds: [ring.atoms[0].id, ring.atoms[1].id], bondIds: [ring.bonds[0].id]
    }])!)).toBeUndefined();
  });

  it("joins tables in page order with one HTML document, one RTF document and empty TSV line", () => {
    const first = selectedTable();
    const second = structuredClone(insertTableIntoDocument(first, { rows: 2, columns: 2, headerRows: 0, preset: "grid",
      center: { x: 50, y: 50 }, textStyle: { fontFamily: "Times New Roman" }, newId: ids() }));
    const tables = second.pages[0].objects as TableObject[];
    tables[0].rotation = 15;
    tables[0].rows[0].cells[0].spans = [{ text: tables[0].rows[0].cells[0].text, script: "normal", style: { color: "#ff0000" } }];
    tables[1].rows[0].cells[0] = { text: "second", spans: [{ text: "second", script: "normal", style: { color: "#0000ff" } }] };
    tables[1].rows[1].cells[0] = { text: "literal \\f0 \\cf1 {braces}", spans: [] };
    second.selection.objectIds = tables.map(table => table.id).reverse();
    const copy = tableSelectionClipboardItems(createSelectionClipboardPayload(second)!)!;
    const [native, html, rtf, tsv] = copy.items;
    expect(JSON.parse(native.text).objects.map((table: TableObject) => table.id)).toEqual(tables.map(table => table.id));
    expect(html.text.match(/<!--StartFragment-->/g)).toHaveLength(1);
    expect(html.text.match(/<!--EndFragment-->/g)).toHaveLength(1);
    expect(html.text.match(/<html\b/g)).toHaveLength(1);
    const parsed = parseHtml(html.text);
    expect(parsed.querySelectorAll("table")).toHaveLength(2);
    const separator = parsed.querySelectorAll("table")[1].previousElementSibling!;
    expect(separator.tagName).toBe("P");
    expect(separator.textContent).toBe("");
    expect([...parsed.body.children].filter(element => element.tagName === "P" && element.textContent === "")).toHaveLength(1);
    expect(rtf.text.match(/\\rtf1/g)).toHaveLength(1);
    expect(rtf.text.match(/\\fonttbl/g)).toHaveLength(1);
    expect(rtf.text.match(/\\colortbl/g)).toHaveLength(1);
    expect(rtf.text).toContain("\\pard\\plain\\par\n");
    expect(rtf.text).toContain("\\f1");
    expect(rtf.text).toContain("\\cf2");
    expect(rtf.text).toContain("Times New Roman");
    expect(rtf.text).toContain("literal \\\\f0 \\\\cf1 \\{braces\\}");
    expect(tsv.text).toBe(tables.map(table => exportTableClipboardPayloads(table).tsv).join("\n\n"));
    expect(copy.warnings).toContain("A rotated table is copied unrotated.");
  });
});

describe("paste precedence and table building", () => {
  it.each([
    "external,html,tsv", "external,tsv,html", "html,external,tsv",
    "html,tsv,external", "tsv,external,html", "tsv,html,external"
  ])("pastes the complete Excel table in any text flavour order (%s)", order => {
    const tsv = fixture("excel-overflow-notes.tsv");
    const items: Record<string, ClipboardReadPayload["textItems"][number]> = {
      external: { type: "public.utf16-external-plain-text", text: tsv.replace(/0\.854|1\.204/g, "#######").replace(/\t/g, "\n") },
      html: { type: "public.html", text: fixture("excel-overflow-notes.html") },
      tsv: { type: "public.utf16-plain-text", text: tsv }
    };
    const raw = payload(...order.split(",").map(name => items[name]));
    const parsed = readTableClipboardPaste(raw, parseHtml);
    expect(tableClipboardPasteDecision(raw, parseHtml)).toEqual({ kind: "table", result: parsed });
    if (!parsed?.ok) throw new Error("Expected Excel-shaped table");
    expect(parsed.source).toBe("html");
    expect(parsed.spec.caption).toBe("Table S2. Sharpless reagent plan (synthetic).");
    expect(parsed.spec.headerRows).toHaveLength(1);
    expect(parsed.spec.headerRows?.[0]).toHaveLength(7);
    expect(parsed.spec.columns).toHaveLength(7);
    expect(parsed.spec.rows).toHaveLength(5);
    expect(parsed.spec.rows.every(row => row.length === 7)).toBe(true);
    expect(parsed.spec.rows[0][2]).toBe("0.854");
    expect(parsed.spec.rows[2][2]).toBe("1.204");
    expect(parsed.spec.footnotes).toEqual([{ text: "a TBHP stock solution; synthetic example.", spans: [
      { text: "a", script: "superscript" }, { text: " TBHP stock solution; synthetic example." }
    ] }]);
    expect(parsed.warnings).toEqual([]);
  });

  it.each([
    "public.utf8-plain-text", "public.utf16-plain-text", "text/plain", "public.plain-text", "NSStringPboardType"
  ])("prefers %s over external plain text for TSV-only paste", type => {
    const tsv = fixture("excel-overflow-notes.tsv");
    const external = { type: "public.utf16-external-plain-text", text: tsv.replace(/0\.854|1\.204/g, "#######").replace(/\t/g, "\n") };
    const plain = { type, text: tsv };
    for (const items of [[external, plain], [plain, external]]) {
      const parsed = readTableClipboardPaste(payload(...items), parseHtml);
      expect(parsed).toMatchObject({ ok: true, source: "tsv", warnings: [] });
      if (!parsed?.ok) throw new Error("Expected TSV table");
      expect(parsed.spec.caption).toBeUndefined();
      expect(parsed.spec.columns).toHaveLength(7);
      // Tab-padded boundary lines remain rows because they may contain empty data cells.
      expect(parsed.spec.rows).toHaveLength(8);
      expect(parsed.spec.rows[0][0]).toBe("Table S2. Sharpless reagent plan (synthetic).");
      expect(parsed.spec.rows[2][2]).toBe("0.854");
      expect(parsed.spec.rows[4][2]).toBe("1.204");
      expect(parsed.spec.rows[7][0]).toBe("a TBHP stock solution; synthetic example.");
      expect(parsed.spec.footnotes).toBeUndefined();
    }
  });

  it.each(["text/plain", "public.text", "public.utf16-external-plain-text"])("prefers tabbed %s among equally preferred flavours", type => {
    const lines = { type, text: "one\ntwo\nthree\nfour" };
    const tabs = { type, text: "one\ttwo\nthree\tfour" };
    for (const items of [[lines, tabs], [tabs, lines]]) {
      expect(readTableClipboardPaste(payload(...items), parseHtml)).toMatchObject({
        ok: true, source: "tsv", spec: { rows: [["one", "two"], ["three", "four"]] }, warnings: []
      });
    }
  });

  it("prefers standard plain text even when the external flavour has tabs", () => {
    const external = { type: "public.utf16-external-plain-text", text: "wrong\tgrid\nwrong\tgrid" };
    const plain = { type: "text/plain", text: "ordinary prose" };
    expect(readTableClipboardPaste(payload(external, plain), parseHtml)).toBeUndefined();
  });

  it("reads the Windows Excel payload with RTF before HTML and CF_UNICODETEXT", () => {
    // The native reader maps HTML Format and CF_UNICODETEXT to these MIME types.
    // CF_TEXT is omitted; Csv and workbook formats appear only in types, not textItems.
    const raw = payload(
      { type: "text/rtf", text: "{\\rtf1 synthetic table}" },
      { type: "text/html", text: fixture("excel-overflow-notes.html") },
      { type: "text/plain", text: fixture("excel-overflow-notes.tsv").replace(/\r\n|\r|\n/g, "\r\n") }
    );
    raw.types.push("Csv", "Biff8");
    const parsed = readTableClipboardPaste(raw, parseHtml);
    expect(tableClipboardPasteDecision(raw, parseHtml)).toEqual({ kind: "table", result: parsed });
    if (!parsed?.ok) throw new Error("Expected Windows Excel-shaped table");
    expect(parsed.spec.caption).toBe("Table S2. Sharpless reagent plan (synthetic).");
    expect(parsed.spec.headerRows).toHaveLength(1);
    expect(parsed.spec.columns).toHaveLength(7);
    expect(parsed.spec.rows).toHaveLength(5);
    expect(parsed.spec.rows.every(row => row.length === 7)).toBe(true);
    expect(parsed.spec.rows[0][2]).toBe("0.854");
    expect(parsed.spec.rows[2][2]).toBe("1.204");
    expect(parsed.spec.footnotes).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
    expect(readTableClipboardPaste({ ...raw, textItems: raw.textItems.filter(item => item.type !== "text/html") }, parseHtml))
      .toMatchObject({ ok: true, source: "tsv", warnings: [] });
  });

  it.each(["word-office-notes", "excel-overflow-notes"])("recognizes the %s table despite incidental SMILES candidates", name => {
    const raw = payload(
      { type: "public.utf8-plain-text", text: fixture(`${name}.tsv`) },
      { type: "public.html", text: fixture(`${name}.html`) }
    );
    const parsed = readTableClipboardPaste(raw, parseHtml);
    expect(tableClipboardPasteDecision(raw, parseHtml)).toEqual({ kind: "table", result: parsed });
    if (!parsed?.ok) throw new Error("Expected Office-shaped table");
    expect(parsed.source).toBe("html");
    expect(parsed.spec.columns).toHaveLength(7);
    expect(parsed.spec.rows.length + (parsed.spec.headerRows?.length ?? 0)).toBe(6);
    expect(parsed.spec.caption).toBeDefined();
    expect(parsed.spec.footnotes).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.spec.headerRows).toHaveLength(1);
    const built = pasteTableIntoDocument(createPhase4Document(), parsed, { x: 408, y: 528 }, {}, ids());
    const table = built.document.pages[0].objects[0] as TableObject;
    expect(table.rows).toHaveLength(6);
    expect(table.caption?.text).toBe(name === "word-office-notes"
      ? "Table S1. Sharpless reagent quantities (synthetic)." : "Table S2. Sharpless reagent plan (synthetic).");
    expect(table.footnotes.map(note => note.text)).toEqual(["a TBHP stock solution; synthetic example."]);
    expect(table.rows[1].cells[2].text).toBe("0.854");
    expect(table.rows[3].cells[2].text).toBe("1.204");
  });

  it("centers tables when possible and keeps them within page edges", () => {
    const parsed = readTableClipboardPaste(htmlPayload("excel-like.html"), parseHtml);
    if (!parsed?.ok) throw new Error("Expected parsed table");
    const document = createPhase4Document();
    const page = document.pages[0];
    const wide = { ...parsed, spec: { ...parsed.spec, columns: parsed.spec.columns.map(column => ({ ...column, widthPx: 90 })) } };
    const paste = (center: { x: number; y: number }) =>
      pasteTableIntoDocument(document, wide, center, {}, ids()).document.pages[0].objects[0] as TableObject;
    const left = paste({ x: 0, y: page.height / 2 });
    expect(left.width).toBeLessThanOrEqual(page.width);
    expect(left.x).toBe(0);
    expect(left.x + left.width).toBeLessThanOrEqual(page.width);
    const bottomRight = paste({ x: page.width, y: page.height });
    expect(bottomRight.x + bottomRight.width).toBeCloseTo(page.width);
    expect(bottomRight.y + bottomRight.height).toBeCloseTo(page.height);
    const middle = paste({ x: page.width / 2, y: page.height / 2 });
    expect(middle.x + middle.width / 2).toBeCloseTo(page.width / 2);
    expect(middle.y + middle.height / 2).toBeCloseTo(page.height / 2);
    const oversized = { ...wide, spec: { ...wide.spec, columns: wide.spec.columns.map(column => ({ ...column, widthPx: 500 })) } };
    const large = pasteTableIntoDocument(document, oversized, { x: page.width / 2, y: page.height / 2 }, {}, ids())
      .document.pages[0].objects[0] as TableObject;
    expect(large.width).toBeGreaterThan(page.width);
    expect({ x: large.x, y: large.y }).toEqual({ x: 0, y: 0 });
  });

  it.each(["word-like.html", "excel-like.html", "google-docs-like.html", "google-sheets-like.html", "word-like.cfhtml.txt"])("pastes the lone table in %s before artwork/text", name => {
    const result = tableClipboardPasteDecision(payload(...htmlPayload(name).textItems,
      { type: "text/plain", text: "fallback text" }, { type: "image/svg+xml", text: "<svg/>" }), parseHtml);
    expect(result.kind).toBe("table");
    if (result.kind !== "table" || !result.result.ok) throw new Error("Expected parsed table");
    expect(result.result.source).toBe("html");
    const built = pasteTableIntoDocument(createPhase4Document(), result.result, { x: 408, y: 528 },
      { fontFamily: "Georgia", fontSizePx: 18, fontWeight: 700, color: "#123456" }, ids());
    const table = built.document.pages[0].objects[0] as TableObject;
    expect(table.type).toBe("table");
    expect(table.x + table.width / 2).toBeCloseTo(408);
    expect(table.y + table.height / 2).toBeCloseTo(528);
    expect(table.style).toEqual(textStyleToObjectStyle({ fontFamily: "Georgia", fontSizePx: 18, fontWeight: 700, color: "#123456" }));
    expect(built.document.selection.objectIds).toEqual([table.id]);
    expect(built.warnings).toEqual(result.result.warnings);
  });

  it("prefers HTML over TSV, then accepts quoted rectangular TSV", () => {
    const tsv = { type: "text/plain", text: fixture("excel-quoted.tsv") };
    // Chemical-looking reagent names first visit today's SMILES parser; these are its fallbacks.
    const html = readTableClipboardPaste(payload(...htmlPayload().textItems, tsv), parseHtml);
    expect(html).toMatchObject({ source: "html" });
    const result = readTableClipboardPaste(payload(tsv), parseHtml);
    expect(result).toMatchObject({ ok: true, source: "tsv" });
    if (!result?.ok) throw new Error("Expected TSV table");
    expect(result.spec.rows[1][2]).toBe("first line\nsecond line");
    expect(result.spec.rows[2][2]).toBe("has a\ttab");
    expect(result.spec.rows[3][2]).toBe('says "neat"');
  });

  it("lets a ChemDraft selection item win over chemistry and HTML", () => {
    const selection = createSelectionClipboardPayload(selectedTable())!;
    const result = tableClipboardPasteDecision(payload(...htmlPayload().textItems,
      { type: "chemical/x-daylight-smiles", text: "CCO" },
      { type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: serializeSelectionClipboardPayload(selection) }), parseHtml);
    expect(result).toEqual({ kind: "selection", payload: selection });
  });

  it.each([
    ["chemical/x-mdl-molfile", "test\nChemDraft\n\n  1  0  0  0  0  0            999 V2000\n    0.0000    0.0000    0.0000 C   0  0\nM  END", "molfile"],
    ["chemical/x-mdl-rxnfile", "$RXN\nreaction", "rxnfile"],
    ["chemical/x-cdxml", '<CDXML><page/></CDXML>', "cdxml"],
    ["chemical/x-daylight-smiles", "CCO", "smiles"],
    ["text/plain", "InChI=1S/CH4/h1H4", "inchi"]
  ])("keeps %s ahead of HTML and TSV", (type, text, kind) => {
    expect(tableClipboardPasteDecision(payload(...htmlPayload().textItems, { type, text }), parseHtml))
      .toMatchObject({ kind: "existing", payload: { kind } });
  });

  it("keeps CDX ahead of HTML", () => {
    const raw = htmlPayload();
    raw.types.push("com.cambridgesoft.cdx");
    expect(tableClipboardPasteDecision(raw, parseHtml)).toMatchObject({ kind: "existing", payload: { kind: "cdx" } });
  });

  it.each(["CCO", "CCO\nCCN", "CCO\tCCN\nCCC\tCCCC", "CCO\tethanol\nCCN\tethylamine", "CCO\tethanol sample\nCCN\tethylamine sample"])("sends SMILES/list %j to today's structure parser first", text => {
    expect(tableClipboardPasteDecision(payload(...htmlPayload().textItems, { type: "text/plain", text }), parseHtml))
      .toMatchObject({ kind: "existing", payload: { kind: "plain-text", text } });
  });

  it("tries a table after a prospective SMILES list fails its chemical parse", () => {
    const raw = payload({ type: "text/plain", text: "CCO\tlabel\nCCN\tother" });
    expect(tableClipboardPasteDecision(raw, parseHtml).kind).toBe("existing");
    expect(readTableClipboardPaste(raw, parseHtml)).toMatchObject({ ok: true, source: "tsv" });
  });

  it("refuses multiple HTML tables without falling through to TSV, and declines unrelated prose", () => {
    const multiple = { type: "text/html", text: "<table><tr><td>one</td></tr></table><table><tr><td>two</td></tr></table>" };
    expect(tableClipboardPasteDecision(payload(multiple), parseHtml))
      .toMatchObject({ kind: "table", result: { ok: false, reason: expect.stringContaining("multiple HTML tables") } });
    expect(readTableClipboardPaste(payload(multiple, { type: "text/plain", text: fixture("excel-quoted.tsv") }), parseHtml))
      .toMatchObject({ ok: false, reason: expect.stringContaining("multiple HTML tables") });
    for (const text of ["ordinary prose", "a\tb", "one\ntwo"]) {
      expect(tableClipboardPasteDecision(payload({ type: "text/plain", text }), parseHtml).kind).toBe("existing");
    }
  });

  it("returns table limit refusals without falling through to a different format", () => {
    // A single copied cell pastes as text, so use two cells to exercise table refusal.
    const html = `<table><tr><td>${"x".repeat(2001)}</td><td></td></tr></table>`;
    expect(tableClipboardPasteDecision(payload({ type: "text/html", text: html },
      { type: "text/plain", text: "unrelated fallback" }), parseHtml))
      .toMatchObject({ kind: "table", result: { ok: false, reason: expect.stringContaining("2001 characters") } });
    expect(tableClipboardPasteDecision(payload({ type: "text/plain", text: Array.from({ length: 501 }, () => "1\t2").join("\n") }), parseHtml))
      .toMatchObject({ kind: "table", result: { ok: false, reason: expect.stringContaining("501 rows") } });
    const office = fixture("word-office-notes.html").replace("allyl alcohol", "x".repeat(2001));
    expect(tableClipboardPasteDecision(payload({ type: "public.html", text: office },
      { type: "public.utf8-plain-text", text: fixture("word-office-notes.tsv") }), parseHtml))
      .toMatchObject({ kind: "table", result: { ok: false, reason: expect.stringContaining("2001 characters") } });
    expect(tableClipboardPasteDecision(payload({ type: "text/plain", text: "a\tb\nc" }), parseHtml))
      .toMatchObject({ kind: "table", result: { ok: false, reason: expect.stringContaining("at least two rows") } });
  });
});
