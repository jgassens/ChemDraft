import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { parseDocument, type TableObject } from "@chemdraft/chem-core";
import { exportDocumentToPdf } from "./pdf";
import { extractPdfPositionedTextRuns, extractPdfTextRuns } from "./pdf.testUtils";

afterEach(() => vi.unstubAllGlobals());

it("exports the Sharpless table text and three rules to PDF", async () => {
  const document = parseDocument(JSON.parse(readFileSync(
    new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url), "utf8")));
  const table = document.pages[0].objects[0] as TableObject;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const key of ["window", "document", "DOMParser", "Node", "Element", "SVGElement", "HTMLElement",
    "XMLSerializer", "navigator"] as const) {
    vi.stubGlobal(key, key === "window" ? dom.window : dom.window[key]);
  }
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
    configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true, value: () => null
  });
  const result = await exportDocumentToPdf(document, {
    domParser: new dom.window.DOMParser(), compress: false
  });
  const text = extractPdfTextRuns(result.bytes).join("");
  for (const cell of table.rows.flatMap(row => row.cells)) {
    expect(text.replace(/\s/g, "")).toContain(cell.text.replace(/\s/g, ""));
  }
  expect(text).toContain("—");
  expect(text.replace(/\s/g, "")).toContain("Ti(OiPr)4");
  expect(text).toContain(table.footnotes[0].text);
  const runs = extractPdfPositionedTextRuns(result.bytes);
  for (const [parentText, digit] of [["Ti(OiPr)", "4"], ["CH", "2"], ["Cl", "2"]]) {
    const index = runs.findIndex(run => run.text === parentText);
    expect(index).toBeGreaterThanOrEqual(0);
    const parent = runs[index], subscript = runs[index + 1];
    expect(parent.fontSize).toBeGreaterThan(0);
    expect(subscript.text).toBe(digit);
    expect(subscript.fontSize).toBeGreaterThan(0);
    expect(subscript.fontSize / parent.fontSize).toBeCloseTo(0.72, 6);
    expect(subscript.y - parent.y).toBeCloseTo(-0.4 * parent.fontSize, 6);
  }
  const pdf = Buffer.from(result.bytes).toString("latin1");
  expect(pdf.match(/\nS\n/g)).toHaveLength(3);
});
