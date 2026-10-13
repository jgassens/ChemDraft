import {
  applyPatch,
  createEmptyDocument,
  createPageLayout,
  type TextObject,
  type UnknownCompatibilityObject
} from "@chemdraft/chem-core";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { exportDocumentToPdf } from "./pdf";
import { exportDocumentToSvg } from "./svg";
import { extractPdfTextRuns, pdfFontStreams, sfntName, sfntTable } from "./pdf.testUtils";
import { filledRingFixture, polygonPathFaces, ringFixtureFills } from "../../layout-engine/src/ringFillNotches.fixture";

const timestamp = "2026-05-29T00:00:00.000Z";

describe("exportDocumentToPdf", () => {
  it.each([true, false])("preserves Unicode text and labels with compression=%s", async (compress) => {
    const text = "μmol H₂O SO₄²⁻ Na⁺";
    const label = "μ₆⁻";
    const document = applyPatch(documentWithText(text), {
      op: "addObject", pageId: "page_001", object: {
        id: "unicode_label", type: "molecule", x: 100, y: 180,
        width: 150, height: 30, rotation: 0, style: { atomLabelBackgroundColor: "transparent" }, structureFormat: "unknown", structure: "",
        atoms: [{ id: "label_atom", element: label, labelLiteral: true, x: 120, y: 200, formalCharge: 0 }],
        bonds: [], superatoms: [], rGroups: [], chemistry: { warnings: [], isotopeLabels: [], stereochemistry: [] }
      }
    }, { now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress }));
    expect(extractPdfTextRuns(result.bytes)).toEqual([text, label]);
    expect(Buffer.from(result.bytes).toString("latin1")).toContain("/Encoding /Identity-H");
    // The primary regular face is 825,628 bytes. jsPDF retains font metadata
    // tables, but subsets outlines: <60 KB compressed, <150 KB uncompressed.
    expect(result.bytes.length).toBeLessThan(compress ? 60_000 : 150_000);
    const streams = pdfFontStreams(result.bytes);
    expect(streams).toHaveLength(1);
    expect(sfntTable(streams[0]!, "glyf").length).toBeLessThan(10_000);
  });

  it("leaves the standard-font ASCII output unchanged", async () => {
    const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText("H2O + NaCl"), { domParser, compress: false }));
    expect(extractPdfTextRuns(result.bytes)).toEqual(["H2O + NaCl"]);
    expect(pdfFontStreams(result.bytes)).toHaveLength(0);
    expect(Buffer.from(result.bytes).toString("latin1")).toContain("/BaseFont /Helvetica");
  });

  it.each([true, false])("keeps Latin-1 text on standard fonts with compression=%s", async (compress) => {
    const text = "80 °C ± 0.5 × 2, µL, é";
    const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser, compress }));
    expect(pdfFontStreams(result.bytes)).toHaveLength(0);
    expect(extractPdfTextRuns(result.bytes)).toEqual([text]);
  });

  it("embeds mixed Latin-1 and Greek mu text", async () => {
    const text = "80 °C ± 0.5 × 2, µL, é, μ";
    const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser }));
    expect(pdfFontStreams(result.bytes)).toHaveLength(1);
    expect(extractPdfTextRuns(result.bytes)).toEqual([text]);
  });

  // All 27 WinAnsi additions above U+00FF, decoded using the PDF's encoding.
  it.each([true, false])("round-trips WinAnsi additions on standard fonts with compression=%s", async (compress) => {
    const text = "ŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™";
    const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser, compress }));
    expect(pdfFontStreams(result.bytes)).toHaveLength(0);
    expect(extractPdfTextRuns(result.bytes)).toEqual([text]);
  });

  it.each([
    { fontWeight: 400, fontStyle: "normal" },
    { fontWeight: 700, fontStyle: "normal" },
    { fontWeight: 400, fontStyle: "italic" },
    { fontWeight: 700, fontStyle: "italic" }
  ])("embeds a real face for $fontWeight/$fontStyle", async (style) => {
    const text = "μ µ ₀₁₂₃₄₅₆₇₈₉ ⁺⁻⁰¹²³⁴⁵⁶⁷⁸⁹ →←↔⇌⇋ Δ±×°−";
    const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text, style), { domParser }));
    expect(extractPdfTextRuns(result.bytes).join("")).toBe(text);
    expect(pdfFontStreams(result.bytes)).toHaveLength(2);
    const names = pdfFontStreams(result.bytes).map((font) => sfntName(font, 6));
    const bold = style.fontWeight >= 600;
    const italic = style.fontStyle === "italic";
    expect(names).toEqual([
      `NotoSans-${bold ? (italic ? "BoldItalic" : "Bold") : (italic ? "Italic" : "Regular")}`,
      `DejaVuSans${bold ? (italic ? "-BoldOblique" : "-Bold") : (italic ? "-Oblique" : "")}`
    ]);
  });

  it.each([
    { fontWeight: 400, fontStyle: "normal" },
    { fontWeight: 700, fontStyle: "normal" },
    { fontWeight: 400, fontStyle: "italic" },
    { fontWeight: 700, fontStyle: "italic" }
  ])("round-trips Noto/DejaVu splits in $fontWeight/$fontStyle", async (style) => {
    const text = "K ⇌ 10⁻³, SO₄²⁻ μmol H₂O";
    for (const compress of [true, false]) {
      const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text, style), { domParser, compress }));
      expect(extractPdfTextRuns(result.bytes)).toEqual(["K ", "⇌", " 10⁻³, SO₄²⁻ μmol H₂O"]);
      const fonts = pdfFontStreams(result.bytes);
      expect(fonts).toHaveLength(2);
      for (const font of fonts) expect(sfntTable(font, "glyf").length).toBeLessThan(10_000);
      expect(result.bytes.length).toBeLessThan(compress ? 120_000 : 300_000);
    }
  });

  it("preserves differently styled spans within Unicode text", async () => {
    const document = structuredClone(documentWithText("μmol H₂O"));
    const object = document.pages[0]!.objects[0] as TextObject;
    object.spans = [
      { text: "μmol ", script: "normal", style: {} },
      { text: "H₂O", script: "normal", style: { fontWeight: 700, fontStyle: "italic" } }
    ];
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));
    expect(extractPdfTextRuns(result.bytes).join("")).toBe(object.text);
    expect(pdfFontStreams(result.bytes)).toHaveLength(2);
  });

  it("refuses characters the embedded font cannot preserve", async () => {
    await expect(withPdfDom((domParser) => exportDocumentToPdf(documentWithText("μ \u{1f9ea}"), { domParser })))
      .rejects.toThrow("does not support U+1F9EA");
  });

  it("specifically refuses a BMP character absent from both cmaps", async () => {
    await expect(withPdfDom((domParser) => exportDocumentToPdf(documentWithText("μ \u4e00"), { domParser })))
      .rejects.toThrow("embedded font normal does not support U+4E00");
  });

  it("refuses Arabic that jsPDF would shape into different Unicode", async () => {
    const text = "μ مرحبا";
    expect(new jsPDF().processArabic(text)).not.toBe(text);
    await expect(withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser })))
      .rejects.toThrow("Arabic script not supported in PDF export yet (U+0645); jsPDF shaping or reordering cannot preserve original Unicode.");
  });

  it.each([
    ["μ שלום", "U+05E9"],
    ["μ שׁשׁ", "U+FB2A"]
  ])("refuses mixed RTL text %s instead of reordering it", async (text, code) => {
    await expect(withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser })))
      .rejects.toThrow(`Right-to-left scripts not supported in PDF export yet (${code})`);
  });

  it.each(["\\s+", "μ \\s+"])("refuses the literal sequence jsPDF replaces in %s", async (text) => {
    await expect(withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser })))
      .rejects.toThrow("U+005C in the literal sequence \\s+ is not supported; jsPDF text processing cannot preserve original Unicode.");
  });

  it.each([true, false])("keeps chemistry characters and Greek unchanged with compression=%s", async (compress) => {
    const text = "μ ₆ ⁻ ² → ← ↔ ⇌ α β γ Δ Ω";
    const result = await withPdfDom((domParser) => exportDocumentToPdf(documentWithText(text), { domParser, compress }));
    expect(extractPdfTextRuns(result.bytes).join("")).toBe(text);
  });

  it("exports the active page as PDF bytes through the SVG renderer", async () => {
    const document = createEmptyDocument({ title: "PDF Export", now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));

    expect(result.format).toBe("pdf");
    expect(result.kind).toBe("binary");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.extension).toBe("pdf");
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    expect(result.bytes.length).toBeGreaterThan(1000);
    expect(result.warnings).toEqual([]);
  });

  it("accepts the PDF compression option", async () => {
    const document = createEmptyDocument({ title: "Uncompressed PDF Export", now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }));

    expect(result.format).toBe("pdf");
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("exports the same notched ring path as SVG, with an even-odd PDF hole", async () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    // Only ring atoms notch the fill, even when their authored label offset is inward.
    Object.assign(object.atoms[1]!, { element: "N", labelLiteral: true, labelOffset: { x: -40, y: 40 } });
    object.style.atomLabelBackgroundColor = "#ffffff";
    const document = applyPatch(createEmptyDocument({ now: timestamp }), {
      op: "addObject", pageId: "page_001", object
    }, { now: timestamp });
    const pathD = String(ringFixtureFills(object)[0]!.attrs.d);
    const faces = polygonPathFaces(pathD);
    expect(faces).toHaveLength(2); // A corner bite plus an interior hole.
    const svg = exportDocumentToSvg(document).contents;
    expect(svg).toContain(`d="${pathD}" fill-rule="evenodd"`);
    let parsedPathD: string | null = null;
    const result = await withPdfDom((domParser) => {
      const trackingParser = {
        parseFromString: (source: string, mime: DOMParserSupportedType) => {
          const parsed = domParser.parseFromString(source, mime);
          const fill = parsed.querySelector('[data-molecule-fill-ring="true"]')!;
          parsedPathD = fill.getAttribute("d");
          expect(fill.getAttribute("fill-rule")).toBe("evenodd");
          return parsed;
        }
      } as DOMParser;
      return exportDocumentToPdf(document, { domParser: trackingParser, compress: false });
    });
    expect(parsedPathD).toBe(pathD);
    const pdfText = new TextDecoder("latin1").decode(result.bytes);
    // Inspect actual PDF drawing operators, not just the SVG handed to the writer.
    const filledPaths = [...pdfText.matchAll(/((?:[-\d.]+ [-\d.]+ [ml]\n|h\n)+)f\*/g)];
    const vertices = faces.flat();
    const ringPath = filledPaths.find((match) => (match[1]!.match(/[ml]\n/g) ?? []).length === vertices.length);
    expect(ringPath, "PDF must emit the notched compound path with the even-odd f* operator").toBeDefined();
    const pdfVertices = [...ringPath![1]!.matchAll(/([-\d.]+) ([-\d.]+) [ml]/g)];
    pdfVertices.forEach((vertex, index) => {
      expect(Number(vertex[1])).toBeCloseTo(vertices[index]!.x, 3);
      expect(Number(vertex[2])).toBeCloseTo(vertices[index]!.y, 3);
    });
    expect((ringPath![1]!.match(/h\n/g) ?? []).length).toBe(faces.length);
  });

  it("uses the ChemDraft page dimensions for the PDF media box", async () => {
    const document = applyPatch(
      createEmptyDocument({ title: "A4 PDF Export", now: timestamp }),
      {
        op: "updatePageLayout",
        pageId: "page_001",
        layout: createPageLayout("a4")
      },
      { now: timestamp }
    );
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));
    const pdfText = new TextDecoder("latin1").decode(result.bytes);

    expect(pdfText).toMatch(/\/MediaBox \[0 0 595\.275590551181\d* 841\.889763779527\d*\]/);
  });

  it("propagates SVG fallback warnings into the PDF export result", async () => {
    const unknownObject = {
      id: "unknown_pdf_001",
      type: "unknown-compatibility-object",
      x: 96,
      y: 144,
      width: 128,
      height: 48,
      rotation: 0,
      style: {},
      sourceFormat: "synthetic",
      sourceObjectType: "unsupported-shape",
      warning: "Synthetic unsupported object for PDF warning coverage."
    } satisfies UnknownCompatibilityObject;
    const document = applyPatch(
      createEmptyDocument({ title: "PDF Warning Propagation", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: unknownObject },
      { now: timestamp }
    );
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));

    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    expect(result.warnings).toEqual([
      {
        code: "export.svg.object_fallback",
        message: 'SVG export used a labeled fallback for object type "unknown-compatibility-object".',
        severity: "warning",
        objectId: "unknown_pdf_001"
      }
    ]);
  });

  it("exports PDF bytes through a Node ESM dynamic import", () => {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", nodePdfExportScript()],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const result = JSON.parse(stdout) as { header: string; byteLength: number; pdfBase64: string };

    expect(result.header).toBe("%PDF-");
    expect(result.byteLength).toBeGreaterThan(1000);
    expect(extractPdfTextRuns(Buffer.from(result.pdfBase64, "base64"))).toEqual(["μmol H₂O SO₄²⁻ Na⁺ ₆"]);
  }, 60_000);
});

function nodePdfExportScript(): string {
  const pdfModuleUrl = pathToFileURL(resolve(process.cwd(), "packages/export-engine/src/pdf.ts")).href;

  return `
    import { JSDOM } from "jsdom";
    const { applyPatch, createEmptyDocument } = await import("@chemdraft/chem-core");
    const { exportDocumentToPdf } = await import(${JSON.stringify(pdfModuleUrl)});
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      DOMParser: dom.window.DOMParser,
      Node: dom.window.Node,
      Element: dom.window.Element,
      SVGElement: dom.window.SVGElement,
      HTMLElement: dom.window.HTMLElement,
      XMLSerializer: dom.window.XMLSerializer,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      navigator: dom.window.navigator
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 16 })
    });
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null
    });
    const result = await exportDocumentToPdf(
      applyPatch(createEmptyDocument({ title: "Node PDF Export", now: "2026-05-29T00:00:00.000Z" }), {
        op: "addObject", pageId: "page_001", object: {
          id: "node_unicode", type: "text", x: 100, y: 120, width: 400, height: 40,
          rotation: 0, style: {}, text: "μmol H₂O SO₄²⁻ Na⁺ ₆", spans: []
        }
      }),
      { domParser: new dom.window.DOMParser() }
    );
    console.log(JSON.stringify({
      header: new TextDecoder().decode(result.bytes.slice(0, 5)),
      byteLength: result.bytes.length,
      pdfBase64: Buffer.from(result.bytes).toString("base64")
    }));
  `;
}

function documentWithText(text: string, style: TextObject["style"] = {}) {
  return applyPatch(createEmptyDocument({ now: timestamp }), {
    op: "addObject", pageId: "page_001", object: {
      id: "pdf_text", type: "text", x: 100, y: 120, width: 400, height: 40,
      rotation: 0, style, text, spans: []
    }
  }, { now: timestamp });
}

async function withPdfDom<T>(callback: (domParser: DOMParser) => Promise<T>): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true
  });
  const writableGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const globalKeys = [
    "window",
    "document",
    "DOMParser",
    "Node",
    "Element",
    "SVGElement",
    "HTMLElement",
    "XMLSerializer",
    "getComputedStyle",
    "navigator"
  ] as const;
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(writableGlobal, key)])
  );
  const previousGetBBox = Object.getOwnPropertyDescriptor(dom.window.SVGElement.prototype, "getBBox");
  const previousGetContext = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "getContext");

  defineTestGlobal(writableGlobal, "window", dom.window);
  defineTestGlobal(writableGlobal, "document", dom.window.document);
  defineTestGlobal(writableGlobal, "DOMParser", dom.window.DOMParser);
  defineTestGlobal(writableGlobal, "Node", dom.window.Node);
  defineTestGlobal(writableGlobal, "Element", dom.window.Element);
  defineTestGlobal(writableGlobal, "SVGElement", dom.window.SVGElement);
  defineTestGlobal(writableGlobal, "HTMLElement", dom.window.HTMLElement);
  defineTestGlobal(writableGlobal, "XMLSerializer", dom.window.XMLSerializer);
  defineTestGlobal(writableGlobal, "getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  defineTestGlobal(writableGlobal, "navigator", dom.window.navigator);
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null
  });

  try {
    return await callback(new dom.window.DOMParser());
  } finally {
    if (previousGetContext) {
      Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", previousGetContext);
    } else {
      Reflect.deleteProperty(dom.window.HTMLCanvasElement.prototype, "getContext");
    }
    if (previousGetBBox) {
      Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", previousGetBBox);
    } else {
      Reflect.deleteProperty(dom.window.SVGElement.prototype, "getBBox");
    }
    for (const [key, descriptor] of previousDescriptors) {
      if (!descriptor) {
        Reflect.deleteProperty(writableGlobal, key);
      } else {
        Object.defineProperty(writableGlobal, key, descriptor);
      }
    }
  }
}

function defineTestGlobal(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value
  });
}
