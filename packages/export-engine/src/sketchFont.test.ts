import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { jsPDF } from "jspdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SketchStylePreset, createEmptyDocument, stylePresetToObjectStyle, type TextObject } from "@chemdraft/chem-core";
import { atomLabelRunAdvance, planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { patrickHandAdvances } from "../../layout-engine/src/patrickHandMetrics.generated";
import { exportDocumentToSvg } from "./svg";
import { exportDocumentToPdf, exportSvgToPdf } from "./pdf";
import { preparePdfFonts } from "./pdfFonts";
import { fontCoverage } from "./fonts/coverage";
import data from "./fonts/PatrickHand-Regular";
import { extractPdfTextRuns, pdfFontStreams, sfntName, sfntTable, unicodeCmap } from "./pdf.testUtils";

const font = Buffer.from(data, "base64");
const appFont = new URL("../../../apps/desktop/src/assets/fonts/PatrickHand-Regular.ttf", import.meta.url);
function fixture(handwriting = true) {
  const document = createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" });
  const text: TextObject = { id: "caption", type: "text", x: 100, y: 120, width: 160, height: 40,
    rotation: 0, text: "Sketch H2O", spans: [], style: handwriting ? { fontFamily: "'Patrick Hand', cursive", fontSizePx: 15 } : {} };
  document.pages[0]!.objects = [text, {
    id: "molecule", type: "molecule", x: 100, y: 60, width: 40, height: 20, rotation: 0,
    structureFormat: "smiles", structure: "CO", superatoms: [], rGroups: [],
    atoms: [{ id: "c", element: "C", x: 100, y: 60, formalCharge: 0 }, { id: "o", element: "O", x: 122, y: 60, formalCharge: 0 }],
    bonds: [{ id: "co", fromAtomId: "c", toAtomId: "o", order: "single" }],
    style: handwriting ? stylePresetToObjectStyle(SketchStylePreset) : {}
  }];
  return document;
}
afterEach(() => vi.unstubAllGlobals());

describe("locally bundled Sketch handwriting", () => {
  it("preserves pre-Sketch SVG bytes for a document without handwriting", () => {
    const document = fixture(false);
    // Captured from the writer at 068b692b; also compared byte-for-byte during this change.
    expect(createHash("sha256").update(exportDocumentToSvg(document).contents).digest("hex"))
      .toBe("c03581b17ad784bc597569220342194a314b1b467512a59cf2286319ce125d42");
  });
  it("uses the reviewed 1.003 TTF and OFL verbatim for canvas and exports", () => {
    expect(readFileSync(appFont)).toEqual(font);
    expect(createHash("sha256").update(font).digest("hex"))
      .toBe("0f173b3e6cb6d1af25babf7f0057c5ac4ee11f9992b0469bb817e967ef4ad0fc");
    expect(sfntName(font, 5)).toContain("1.003");
    const ofl = readFileSync(new URL("./fonts/LICENSE_PATRICK_HAND.txt", import.meta.url), "utf8");
    expect(ofl).toBe(readFileSync(new URL("../../../apps/desktop/src/assets/fonts/OFL.txt", import.meta.url), "utf8"));
    expect(ofl).toContain("Copyright (c) 2010-2012 Patrick Wagesreiter");
    const css = readFileSync(new URL("../../../apps/desktop/src/App.css", import.meta.url), "utf8");
    expect(css).toContain("url('./assets/fonts/PatrickHand-Regular.ttf')");
    const csp = JSON.parse(readFileSync(new URL("../../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")).app.security.csp;
    expect(csp).toBeNull(); // Same-origin bundled assets are permitted by the current policy.
  });

  it("matches generated coverage and layout advances to the actual font tables", () => {
    const cmap = unicodeCmap(font);
    const ranges = fontCoverage.ChemDraftPatrickHand.normal;
    const hmtx = sfntTable(font, "hmtx"), hhea = sfntTable(font, "hhea"), head = sfntTable(font, "head");
    for (let code = 0; code < 0xffff; code++) {
      const covered = ranges.some((_, i) => i % 2 === 0 && code >= ranges[i]! && code <= ranges[i + 1]!);
      expect(covered, `coverage U+${code.toString(16)}`).toBe(cmap.has(code));
    }
    for (const [code, glyph] of cmap) {
      const advance = hmtx.readUInt16BE(Math.min(glyph, hhea.readUInt16BE(34) - 1) * 4) / head.readUInt16BE(18);
      expect(patrickHandAdvances[code]).toBe(advance);
    }
    const drawing = SketchStylePreset.drawing;
    expect(atomLabelRunAdvance({ text: "OH", script: "normal" }, drawing))
      .toBe((patrickHandAdvances[79]! + patrickHandAdvances[72]!) * drawing.atomLabelFontSizePx);
  });

  it("embeds the complete font once for rendered labels/text and keeps canvas geometry", () => {
    const document = fixture();
    const svg = exportDocumentToSvg(document).contents;
    expect(svg.match(/@font-face/g)).toHaveLength(1);
    expect(svg).toContain(`data:font/ttf;base64,${data}`);
    for (const fragment of planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments)) {
      if (fragment.attrs.class === "native-molecule-sketch") expect(svg).toContain(`d="${fragment.attrs.d}"`);
    }
    const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
    expect([...dom.window.document.querySelectorAll("text")].every(text => text.closest("[font-family]")?.getAttribute("font-family") === "'Patrick Hand', cursive")).toBe(true);
    dom.window.close();
  });

  it("does not embed a font for unused defaults or a different exported page", () => {
    const document = fixture(false);
    const before = exportDocumentToSvg(document).contents;
    document.styles.drawing = SketchStylePreset.drawing;
    document.pages.push({ ...fixture().pages[0]!, id: "handwriting-page" });
    expect(exportDocumentToSvg(document).contents).toBe(before);
    expect(before).not.toContain("@font-face");
    expect(exportDocumentToSvg(document, { pageIndex: 1 }).contents).toContain("@font-face");
  });

  it("embeds Patrick Hand for ASCII and falls back by cmap for missing Unicode", async () => {
    const dom = new JSDOM('<svg><text font-family="\'Patrick Hand\', cursive">Sketch H2O ⇌ μ</text></svg>');
    const pdf = new jsPDF();
    const addFont = vi.spyOn(pdf, "addFont");
    const release = await preparePdfFonts(dom.window.document.documentElement, pdf);
    expect(addFont.mock.calls.map(call => call[1])).toContain("ChemDraftPatrickHand");
    expect(dom.window.document.querySelector("text")!.textContent).toBe("Sketch H2O ⇌ μ");
    for (const span of dom.window.document.querySelectorAll("text tspan")) {
      const family = span.getAttribute("font-family")!;
      if ([...span.textContent!].every(character => cmapCovers(character))) expect(family).toBe("ChemDraftPatrickHand");
    }
    release(); dom.window.close();
  });

  it("still refuses external styles and unreviewed embedded font bytes", async () => {
    const dom = new JSDOM();
    const svg = exportDocumentToSvg(fixture()).contents;
    try {
      for (const modified of [
        svg.replace(data, `B${data.slice(1)}`),
        svg.replace("</style>", '@import url("https://invalid.test/font.css");</style>')
      ]) {
        await expect(exportSvgToPdf(modified, { outputWidth: 200, outputHeight: 200, domParser: new dom.window.DOMParser() }))
          .rejects.toThrow("external SVG styles are not allowed");
      }
    } finally { dom.window.close(); }
  });

  it("exports actual subset outlines and selectable handwriting text to PDF", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    for (const key of ["window", "document", "Node", "Element", "SVGElement", "HTMLElement", "XMLSerializer", "navigator"] as const) {
      vi.stubGlobal(key, key === "window" ? dom.window : dom.window[key]);
    }
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
    Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 }) });
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
    try {
      const result = await exportDocumentToPdf(fixture(), { domParser: new dom.window.DOMParser() });
      const embedded = pdfFontStreams(result.bytes);
      expect(embedded).toHaveLength(1);
      expect(sfntName(embedded[0]!, 6)).toBe("PatrickHand-Regular");
      expect(extractPdfTextRuns(result.bytes).join("")).toContain("Sketch H2O");
      expect(extractPdfTextRuns(result.bytes).join("")).toContain("OH");
      expect(sfntTable(embedded[0]!, "glyf").length).toBeLessThan(sfntTable(font, "glyf").length);
    } finally { dom.window.close(); }
  });
});

function cmapCovers(character: string) { return unicodeCmap(font).has(character.codePointAt(0)!); }
