import { applyPatch, createEmptyDocument } from "@chemdraft/chem-core";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import * as exportEngine from "./index";
import { exportDocumentToPdf } from "./pdf";
import { extractPdfTextRuns, pdfFontStreams } from "./pdf.testUtils";

// Factories throw if any font chunk is evaluated, including via a transitive
// package import. This guards loading itself, not merely addFont registration.
vi.mock("./fonts/NotoSans-Regular", () => { throw new Error("Loaded Noto regular"); });
vi.mock("./fonts/NotoSans-Bold", () => { throw new Error("Loaded Noto bold"); });
vi.mock("./fonts/NotoSans-Italic", () => { throw new Error("Loaded Noto italic"); });
vi.mock("./fonts/NotoSans-BoldItalic", () => { throw new Error("Loaded Noto bold italic"); });
vi.mock("./fonts/DejaVuSans", () => { throw new Error("Loaded DejaVu regular"); });
vi.mock("./fonts/DejaVuSans-Bold", () => { throw new Error("Loaded DejaVu bold"); });
vi.mock("./fonts/DejaVuSans-Oblique", () => { throw new Error("Loaded DejaVu italic"); });
vi.mock("./fonts/DejaVuSans-BoldOblique", () => { throw new Error("Loaded DejaVu bold italic"); });

afterEach(() => vi.unstubAllGlobals());

it("imports export-engine and exports standard-font text without loading any font module", async () => {
  expect(exportEngine.isExportFormatImplemented("pdf")).toBe(true);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const key of ["window", "document", "Node", "Element", "SVGElement", "HTMLElement", "XMLSerializer", "navigator"] as const) {
    vi.stubGlobal(key, key === "window" ? dom.window : dom.window[key]);
  }
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
    configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true, value: () => null
  });
  try {
    for (const text of ["H2O + NaCl", "80 °C ± 0.5 × 2, µL, é € Œ"]) {
      const document = applyPatch(createEmptyDocument(), {
        op: "addObject", pageId: "page_001", object: {
          id: "lazy_text", type: "text", x: 100, y: 120, width: 400, height: 40,
          rotation: 0, style: {}, text, spans: []
        }
      });
      const result = await exportDocumentToPdf(document, { domParser: new dom.window.DOMParser() });
      expect(extractPdfTextRuns(result.bytes)).toEqual([text]);
      expect(pdfFontStreams(result.bytes)).toHaveLength(0);
    }
  } finally {
    dom.window.close();
  }
});
