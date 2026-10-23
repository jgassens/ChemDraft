import {
  applyPatch,
  createEmptyDocument,
  createCustomPageLayout,
  createPageLayout,
  type TextObject,
  type MoleculeObject,
  type UnknownCompatibilityObject
} from "@chemdraft/chem-core";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { Resvg } from "@resvg/resvg-js";
import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { exportDocumentToPdf } from "./pdf";
import { exportDocumentToSvg } from "./svg";
import { nativeTextObjectLineMetrics } from "@chemdraft/layout-engine";
import { extractPdfTextRuns, pdfFontStreams, sfntName, sfntTable } from "./pdf.testUtils";
import { ringHaloDocument } from "../../layout-engine/src/ringFillHalos.fixture";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";

function filledRingFixture(): MoleculeObject {
  const atoms = [[100, 100], [180, 100], [180, 180], [100, 180]].map(([x, y], i) => ({ id: `a${i}`, element: "C", x: x!, y: y!, formalCharge: 0 }));
  return { id: "square", type: "molecule", x: 90, y: 90, width: 100, height: 100, rotation: 0,
    structureFormat: "smiles", structure: "C1CCC1", superatoms: [], rGroups: [], atoms,
    bonds: atoms.map((a, i) => ({ id: `b${i}`, fromAtomId: a.id, toAtomId: atoms[(i + 1) % 4]!.id, order: "single" })), style: {} };
}

const timestamp = "2026-05-29T00:00:00.000Z";

describe("exportDocumentToPdf", () => {
  it.each(["pyridinium", "blue-box", "oxathiazinane"] as const)("%s PNG has no white antialias fringe around glyph halos", (name) => {
    const { document, object } = ringHaloDocument(name, "solid");
    const source = exportDocumentToSvg(document).contents.replace(/viewBox="[^"]*"/,
      `viewBox="${object.x - 20} ${object.y - 20} ${object.width + 40} ${object.height + 40}"`);
    const dom = new JSDOM(source, { contentType: "image/svg+xml" });
    const raster = new Resvg(source, { fitTo: { mode: "width", value: 1000 } }).render();
    const withHalos = raster.pixels;
    dom.window.document.querySelectorAll("text").forEach((text) => text.remove());
    const background = new Resvg(dom.serialize(), { fitTo: { mode: "width", value: 1000 } }).render().pixels;
    const rings = nativeMoleculeRings(object);
    const factor = Math.min(raster.width / (object.width + 40), raster.height / (object.height + 40));
    const offsetX = (raster.width - (object.width + 40) * factor) / 2;
    const offsetY = (raster.height - (object.height + 40) * factor) / 2;
    let sampled = 0, brightening = 0;
    for (let i = 0; i < background.length; i += 4) {
      // Fully covered blue pixels exclude bonds and polygon boundaries. A black glyph can only
      // darken them; the old paper-then-colour glyph overpainting left a bright outline here.
      if (background[i] !== 30 || background[i + 1] !== 136 || background[i + 2] !== 229) continue;
      const neighbors = [-3, 3, -3 * raster.width, 3 * raster.width];
      if (!neighbors.every((offset) => background[i + offset * 4] === 30
        && background[i + offset * 4 + 1] === 136 && background[i + offset * 4 + 2] === 229)) continue;
      sampled++;
      const difference = Math.max(...[0, 1, 2].map((c) => withHalos[i + c]! - background[i + c]!));
      if (difference <= 2) continue;
      const x = ((i / 4 % raster.width) - offsetX) / factor + object.x - 20;
      const y = (Math.floor(i / 4 / raster.width) - offsetY) / factor + object.y - 20;
      // Patterns and the base polygon may sample a shared ring edge on opposite sides of a
      // pixel. Exclude every polygon boundary, including internal edges of the blue box.
      const onBoundary = rings.some((ring) => ring.points.some((a, index) => {
        const b = ring.points[(index + 1) % ring.points.length]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < 1;
      }));
      if (!onBoundary) brightening = Math.max(brightening, difference);
    }
    expect(sampled).toBeGreaterThan(100);
    expect(brightening).toBeLessThanOrEqual(2);
    dom.window.close();
  });
  it('preserves enlarged normal multiline spans with the shared SVG line baselines',async()=>{
    const document=structuredClone(documentWithText('HHHH\n\nHHHH',{fontSizePx:16,textAlign:'center'}));
    const object=document.pages[0].objects[0] as TextObject;
    object.spans=[{text:object.text,script:'normal',style:{fontSizePx:48}}];
    const metrics=nativeTextObjectLineMetrics(object),svg=exportDocumentToSvg(document).contents;
    const baselines=[...svg.matchAll(/<tspan x="[^"]+" y="([^"]+)"\s*\/?>/g)].map(match=>Number(match[1]));
    expect(baselines).toHaveLength(3);
    metrics.lines.forEach((line,i)=>expect(baselines[i]).toBeCloseTo(object.y+line.baseline,3));
    const result=await withPdfDom(domParser=>exportDocumentToPdf(document,{domParser,compress:false}));
    expect(extractPdfTextRuns(result.bytes).join('')).toBe('HHHHHHHH');
  });
  it('preserves multiline formatted conditions with explicit independent script baselines',async()=>{
    const document=structuredClone(documentWithText('H2O\nZn2+'));
    const object=document.pages[0].objects[0] as TextObject;
    object.spans=[{text:'H',script:'normal',style:{}},{text:'2',script:'subscript',style:{}},
      {text:'O\nZn',script:'normal',style:{}},{text:'2+',script:'superscript',style:{}}];
    const svg=exportDocumentToSvg(document).contents;
    expect(svg).not.toContain('baseline-shift=');
    const result=await withPdfDom(domParser=>exportDocumentToPdf(document,{domParser,compress:false}));
    expect(extractPdfTextRuns(result.bytes).join('')).toBe('H2OZn2+');
  });
  it("does not count the white page background as drawing geometry", async () => {
    const document = createEmptyDocument({ now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }));
    // This is the negative control for the bond endpoint assertions below:
    // removing the molecule must leave no drawing points despite the painted background.
    expect(pdfDrawingPoints(Buffer.from(result.bytes).toString("latin1"))).toEqual([]);
  });

  it("accepts the maximum 200-inch PDF page without silently reducing it", async () => {
    const document = createEmptyDocument({ now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, {
      domParser, outputWidth: 19200, outputHeight: 19200
    }));
    expect(Buffer.from(result.bytes).toString("latin1")).toContain("/MediaBox [0 0 14400. 14400.]");
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid output dimensions (%s) before rendering", async (dimension) => {
    const document = createEmptyDocument({ now: timestamp });
    for (const options of [{ outputWidth: dimension }, { outputHeight: dimension }]) {
      await expect(exportDocumentToPdf(document, options)).rejects.toThrow("finite positive");
    }
  });

  it("refuses 8190 by 4095 px at 36 DPI before rendering instead of clipping", async () => {
    const document = createEmptyDocument({ now: timestamp });
    await expect(exportDocumentToPdf(document, { outputWidth: 8190 / 36 * 96, outputHeight: 4095 / 36 * 96 }))
      .rejects.toThrow("physical page size exceeds 14400 points (200 inches) per side");
  });

  it.each([96, 300, 600])("fits the entire drawing inside the DPI-derived physical PDF page at %s DPI", async (dpi) => {
    const original = createEmptyDocument({ now: timestamp });
    // A plain four-bond ring: every drawing primitive is checked below.
    const ring = { ...filledRingFixture(), style: { source: "chemdraft-native-drawing" } };
    const document = applyPatch({
      ...original,
      pages: [{ ...original.pages[0], width: 1000, height: 500, layout: createCustomPageLayout(1000, 500, "css-px") }]
    }, { op: "addObject", pageId: "page_001", object: ring }, { now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, {
      domParser, compress: false, outputWidth: 2008 / dpi * 96, outputHeight: 1004 / dpi * 96
    }));
    const pdf = Buffer.from(result.bytes).toString("latin1");
    const box = pdf.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;
    const widthPt = Number(box[1]), heightPt = Number(box[2]);
    expect(widthPt).toBeCloseTo(2008 / dpi * 72, 6);
    expect(heightPt).toBeCloseTo(1004 / dpi * 72, 6);
    const points = pdfDrawingPoints(pdf);
    // Fixed authored endpoints of all four bonds, independent of the exported SVG.
    // Comparing every endpoint catches missing bonds, rather than only checking an outer box.
    const endpoints = [[100, 100], [180, 100], [180, 100], [180, 180],
      [180, 180], [100, 180], [100, 180], [100, 100]];
    expect(points).toHaveLength(endpoints.length);
    endpoints.forEach(([x, y], index) => {
      expect(points[index][0]).toBeCloseTo(x / 1000 * widthPt, 6);
      expect(points[index][1]).toBeCloseTo(heightPt - y / 500 * heightPt, 6);
    });
  });


  it("keeps all bond endpoints visible when independent output dimensions change the aspect ratio", async () => {
    const original = createEmptyDocument({ now: timestamp });
    const ring = { ...filledRingFixture(), style: { source: "chemdraft-native-drawing" } };
    const document = applyPatch({ ...original, pages: [{ ...original.pages[0], width: 1000, height: 500, layout: createCustomPageLayout(1000, 500, "css-px") }] }, { op: "addObject", pageId: "page_001", object: ring }, { now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false, outputWidth: 960, outputHeight: 1920 }));
    const pdf = Buffer.from(result.bytes).toString("latin1");
    expect(pdf).toContain("/MediaBox [0 0 720. 1440.]");
    const points = pdfDrawingPoints(pdf);
    const endpoints = [[100, 100], [180, 100], [180, 100], [180, 180], [180, 180], [100, 180], [100, 180], [100, 100]];
    expect(points).toHaveLength(8);
    // Preserve the 2:1 source frame inside the 1:2 page: 720 x 360 pt, centred vertically.
    endpoints.forEach(([x, y], index) => {
      expect(points[index][0]).toBeCloseTo(x * 0.72, 6);
      expect(points[index][1]).toBeCloseTo(1440 - 540 - y * 0.72, 6);
    });
  });

  it("uses custom output dimensions for the physical PDF page", async () => {
    const document = createEmptyDocument({ title: "Sized PDF", now: timestamp });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, outputWidth: 960, outputHeight: 480 }));
    expect(new TextDecoder().decode(result.bytes)).toContain("/MediaBox [0 0 720. 360.]");
    await expect(exportDocumentToPdf(document, { outputWidth: 0 })).rejects.toThrow("finite positive");
  });

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

  for (const name of ["pyridinium", "blue-box", "oxathiazinane"] as const) {
    for (const style of ["light", "solid", "vivid"] as const) {
      it(`${name} ${style}: PDF uses the SVG polygons and clipped halo strokes`, async () => {
        const { document, object } = ringHaloDocument(name, style);
        const rings = nativeMoleculeRings(object);
        const svg = exportDocumentToSvg(document).contents;
        const result = await withPdfDom((domParser) => exportDocumentToPdf(document, {
          domParser: { parseFromString(source: string, mime: DOMParserSupportedType) {
            expect(source).toBe(svg);
            const parsed = domParser.parseFromString(source, mime);
            const fills = [...parsed.querySelectorAll("[data-molecule-fill-ring]")];
            expect(fills.map((f) => f.getAttribute("d"))).toEqual(rings.map((r) => r.pathD));
            expect(fills.every((f) => !f.hasAttribute("fill-rule"))).toBe(true);
            const halos = [...parsed.querySelectorAll("[data-label-halo-ring]")];
            expect(halos.length).toBeGreaterThan(0);
            for (const halo of halos) {
              const fill = fills.find((f) => f.getAttribute("data-ring-key") === halo.getAttribute("data-label-halo-ring"))!;
              expect(halo.getAttribute("clip-path")).toMatch(/^url/);
              expect(halo.querySelector("path")!.getAttribute("fill")).toBe(fill.getAttribute("fill"));
            }
            return parsed;
          } } as DOMParser, compress: false
        }));
        const pdf = new TextDecoder("latin1").decode(result.bytes);
        // Actual PDF polygon fills, clipping operators and stroked glyphs, not only input SVG.
        expect((pdf.match(/\nW\n/g) ?? []).length).toBeGreaterThanOrEqual(rings.length);
        expect(pdf).toContain("1 Tr");
        expect(pdf).toContain("/SMask << /S /Luminosity");
        const masks = [...pdf.matchAll(/\/Group << \/S \/Transparency \/CS \/DeviceGray >>\n\/Resources [^\n]+\n\/Length (\d+) >>\nstream\n/g)];
        expect(masks.length).toBeGreaterThan(0);
        for (const mask of masks) {
          const start = mask.index! + mask[0].length;
          const content = pdf.slice(start, start + Number(mask[1]));
          expect(pdf.slice(start + Number(mask[1]))).toMatch(/^\nendstream/);
          expect(content).toContain("1 G\n3.375 w"); // 4.5 px halo at 0.75 pt/px.
          expect(content.match(/\bq\b/g)?.length).toBe(content.match(/\bQ\b/g)?.length);
          expect(content).toContain("1 Tr");
        }
        const paths = [...pdf.matchAll(/((?:[-\d.]+ [-\d.]+ [ml]\n|h\n)+)f(?:\n|$)/g)].map((m) => m[1]!);
        for (const ring of rings) {
          const found = paths.some((path) => {
            const vertices = [...path.matchAll(/([-\d.]+) ([-\d.]+) [ml]/g)];
            return vertices.length === ring.points.length && vertices.every((v, i) =>
              Math.abs(Number(v[1]) - ring.points[i]!.x) < 0.001 && Math.abs(Number(v[2]) - ring.points[i]!.y) < 0.001);
          });
          expect(found, ring.ringKey).toBe(true);
        }
      });
    }
  }

  it.each(["linear-gradient", "radial-gradient"] as const)("paints %s halo strokes with a PDF pattern in the same coordinate space", async (kind) => {
    const { document, object } = ringHaloDocument("pyridinium", "solid");
    const ring = nativeMoleculeRings(object)[0]!;
    object.rotation = 27;
    object.style.ringStyles = { [ring.ringKey]: { fillOpacity: 0.25, fillPaint: {
      kind, units: "object", x1: 0, y1: 0, x2: 1, y2: 1, cx: 0.5, cy: 0.5, r: 0.5,
      stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }]
    } } };
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }));
    const pdf = new TextDecoder("latin1").decode(result.bytes);
    expect(pdf).toContain("/PatternType 1");
    expect(pdf).toContain("/SMask << /S /Luminosity");
    expect(pdf).toMatch(/\/Pattern cs\n\/P\d+ scn/);
    expect(pdf).toContain(kind === "linear-gradient" ? "/ShadingType 2" : "/ShadingType 3");
    expect(pdf).toContain("1 Tr");
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

// Read only painted strokes, excluding filled backgrounds and clipping paths.
// Apply nested graphics-state matrices and verify active rectangular clips contain each stroke.
function pdfDrawingPoints(pdf: string): Array<[number, number]> {
  type Matrix = [number, number, number, number, number, number];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  type Clip = { left: number; top: number; right: number; bottom: number };
  let clips: Clip[] = [];
  let pendingClip = false;
  const stack: Array<{ matrix: Matrix; clips: Clip[] }> = [];
  const points: Array<[number, number]> = [];
  let path: Array<[number, number]> = [];
  const point = (x: number, y: number) => path.push([
    matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]
  ]);
  const source = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) => match[1]).join("\n");
  for (const line of source.split("\n")) {
    const parts = line.trim().split(/\s+/), op = parts.pop();
    const n = parts.map(Number);
    if (op === "W" || op === "W*") pendingClip = true;
    else if (op === "S" || op === "s") {
      for (const [x, y] of path) for (const clip of clips) {
        expect(x).toBeGreaterThanOrEqual(clip.left - 1e-6);
        expect(x).toBeLessThanOrEqual(clip.right + 1e-6);
        expect(y).toBeGreaterThanOrEqual(clip.top - 1e-6);
        expect(y).toBeLessThanOrEqual(clip.bottom + 1e-6);
      }
      points.push(...path);
      path = [];
    } else if (["f", "f*", "n", "B", "B*", "b", "b*"].includes(op ?? "")) {
      if (pendingClip) {
        clips = [...clips, {
          left: Math.min(...path.map(([x]) => x)), right: Math.max(...path.map(([x]) => x)),
          top: Math.min(...path.map(([, y]) => y)), bottom: Math.max(...path.map(([, y]) => y))
        }];
        pendingClip = false;
      }
      path = [];
    } else if (op === "q") stack.push({ matrix: [...matrix], clips: [...clips] });
    else if (op === "Q") {
      const saved = stack.pop();
      if (saved) { matrix = saved.matrix; clips = saved.clips; }
    }
    else if (op === "cm" && n.length === 6) {
      const [a,b,c,d,e,f] = matrix;
      matrix = [a*n[0]+c*n[1], b*n[0]+d*n[1], a*n[2]+c*n[3], b*n[2]+d*n[3], a*n[4]+c*n[5]+e, b*n[4]+d*n[5]+f];
    } else if (op === "m" || op === "l") point(n[0], n[1]);
    else if (op === "c") for (let i=0; i<6; i+=2) point(n[i], n[i+1]);
    else if (op === "re") { point(n[0], n[1]); point(n[0]+n[2], n[1]+n[3]); }
  }
  return points;
}
