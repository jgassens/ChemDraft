import { attachedConditionsDocument } from "./attachedConditions.fixture";
import {
  applyPatch,
  createEmptyDocument,
  createImageGraphicObject,
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
import { exportDocumentToCdxml } from "@chemdraft/cdx-compat";
import { describe, expect, it } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { exportDocumentToPdf, exportSvgToPdf, svgPictureRasterSize, SVG_PICTURE_MAX_RASTER_PIXELS, type SvgPictureRasterRequest } from "./pdf";
import { exportDocumentToSvg } from "./svg";
import { extractPdfPositionedTextRuns, extractPdfTextRuns, largePicturePng, pdfFontStreams, sfntName, sfntTable, standardFontTextWidth } from "./pdf.testUtils";
import { multilineScriptedTextDocument, scriptedTextDocument } from "./scriptedText.fixture";
import { ringHaloDocument } from "../../layout-engine/src/ringFillHalos.fixture";
import { nativeMoleculeRings, planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";

function filledRingFixture(): MoleculeObject {
  const atoms = [[100, 100], [180, 100], [180, 180], [100, 180]].map(([x, y], i) => ({ id: `a${i}`, element: "C", x: x!, y: y!, formalCharge: 0 }));
  return { id: "square", type: "molecule", x: 90, y: 90, width: 100, height: 100, rotation: 0,
    structureFormat: "smiles", structure: "C1CCC1", superatoms: [], rGroups: [], atoms,
    bonds: atoms.map((a, i) => ({ id: `b${i}`, fromAtomId: a.id, toAtomId: atoms[(i + 1) % 4]!.id, order: "single" })), style: {} };
}

const timestamp = "2026-05-29T00:00:00.000Z";

describe("exportDocumentToPdf", () => {
  it.each(["document", "SVG"].flatMap(caller => [0, 0.35, 1].map(opacity => ({ caller, opacity }))))(
    "applies picture opacity $opacity once in the $caller PDF path", async ({ caller, opacity }) => {
      const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>').render().asPng()).toString("base64");
      const picture = createImageGraphicObject({ id: "opacity-picture", mimeType: "image/png",
        dataBase64: png, center: { x: 200, y: 200 } });
      picture.style.opacity = opacity;
      const document = createEmptyDocument();
      const opaque = { ...picture, id: "opaque-picture", x: 300, style: {} };
      const page = document.pages[0]!;
      page.objects = [picture, opaque];
      const result = await withPdfDom(domParser => caller === "document"
        ? exportDocumentToPdf(document, { domParser, compress: false })
        : exportSvgToPdf(exportDocumentToSvg(document).contents, { domParser, compress: false,
          outputWidth: page.width, outputHeight: page.height, pageSize: page,
          pictures: new Map([[picture.id, picture], [opaque.id, opaque]]) }));
      const pdf = Buffer.from(result.bytes).toString("latin1");
      const states = new Map([...pdf.matchAll(/(\d+) 0 obj\s*<<\s*\/ca ([\d.]+)\s*>>/g)]
        .map(match => [match[1]!, Number(match[2])]));
      const resources = new Map([...pdf.matchAll(/\/(GS\d+) (\d+) 0 R/g)]
        .map(match => [match[1]!, states.get(match[2]!)]));
      // Interpret q/Q so a missing restore cannot leak translucency to the next picture.
      const stack: number[] = [];
      let alpha = 1;
      const painted: number[] = [];
      const contents = pdf.match(/stream\n([\s\S]*?)\nendstream/)![1]!;
      for (const token of contents.matchAll(/\b(q|Q)\b|\/(GS\d+) gs|\/I\d+ Do/g)) {
        if (token[1] === "q") stack.push(alpha);
        else if (token[1] === "Q") alpha = stack.pop() ?? 1;
        else if (token[2]) alpha = resources.get(token[2]) ?? alpha;
        else painted.push(alpha);
      }
      expect(painted).toEqual([opacity, 1]);
      expect(result.warnings).toEqual([]);
    });

  it.each(["document", "SVG"])("draws a paste-accepted ~16.8 MB PNG through the %s PDF caller", async (caller) => {
    const png = largePicturePng();
    expect(png.length).toBeGreaterThan(16_700_000);
    expect(png.length).toBeLessThan(16_900_000);
    const picture = createImageGraphicObject({ id: "large-picture", mimeType: "image/png",
      dataBase64: png.toString("base64"), center: { x: 400, y: 300 } });
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    const frame = { ...picture, x: 100, y: 100, width: 200, height: 200 };
    page.objects = [frame];
    const svg = exportDocumentToSvg(document).contents;
    expect(Buffer.byteLength(svg)).toBeGreaterThan(20 * 1024 * 1024);
    const result = await withPdfDom(domParser => caller === "document"
      ? exportDocumentToPdf(document, { domParser, compress: false })
      : exportSvgToPdf(svg, { domParser, compress: false, outputWidth: page.width, outputHeight: page.height,
        pictures: new Map([[picture.id, frame]]), pageSize: page }));
    const pdf = Buffer.from(result.bytes).toString("latin1");
    expect(pdf).toContain("/Subtype /Image");
    expect(pdf).toContain("/Width 2048");
    expect(pdf).toContain("/Height 2048");
    expect(pdf).toMatch(/\/I\d+ Do/);
    expect(result.warnings).toEqual([]);
  }, 20_000);

  it.each(["document", "SVG"])("rejects pictures over 25 MB with a specific error in the %s PDF caller", async (caller) => {
    const picture = createImageGraphicObject({ id: "too-large", mimeType: "image/svg+xml",
      dataBase64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'), center: { x: 40, y: 40 } });
    picture.data.image!.dataBase64 = Buffer.alloc(26 * 1024 * 1024).toString("base64");
    picture.data.image!.mimeType = "image/png";
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    page.objects = [picture];
    await expect(caller === "document" ? exportDocumentToPdf(document)
      : exportSvgToPdf("<svg/>", { outputWidth: page.width, outputHeight: page.height,
        pictures: new Map([[picture.id, picture]]), pageSize: page }))
      .rejects.toThrow("Cannot export PDF: Image object too-large is 26.0 MB; the limit is 25 MB.");
  });

  it("skips picture-less graphics with format-specific warnings", async () => {
    const document = createEmptyDocument();
    document.pages[0]!.objects = [{ id: "missing-picture", type: "graphic", graphicKind: "image",
      x: 0, y: 0, width: 1, height: 1, rotation: 0, data: {}, style: {} }];
    const svg = exportDocumentToSvg(document);
    expect(svg.contents).not.toContain('data-object-id="missing-picture"');
    expect(svg.warnings).toEqual([{ code: "export.svg.picture_missing_data", severity: "warning", objectId: "missing-picture",
      message: "SVG export: picture missing-picture has no picture data and was not drawn" }]);
    const pdf = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));
    expect(pdf.warnings).toEqual([{ code: "export.pdf.picture_missing_data", severity: "warning", objectId: "missing-picture",
      message: "PDF export: picture missing-picture has no picture data and was not drawn" }]);
    expect(exportDocumentToCdxml(document).warnings).toEqual([{ code: "cdxml.picture_not_saved", sourceObjectId: "missing-picture",
      message: "CDXML export: picture missing-picture has no picture data, so nothing of it is saved in CDXML" }]);
  });

  it("exports picture frames in SVG and embeds PNGs in PDF, warning for SVG pictures", async () => {
    const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>').render().asPng()).toString("base64");
    const picture = { ...createImageGraphicObject({ id: "g12", mimeType: "image/png", dataBase64: png, center: { x: 0, y: 0 } }),
      x: 10.12345, y: 20, width: 80, height: 40, rotation: 30 };
    const svgPicture = { ...picture, id: "g13", data: { image: { ...picture.data.image!, mimeType: "image/svg+xml" as const,
      dataBase64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') } } };
    const document = createEmptyDocument({ now: timestamp });
    document.pages[0]!.objects = [picture, svgPicture];
    const result = exportDocumentToSvg(document);
    const dom = new JSDOM(result.contents, { contentType: "image/svg+xml" });
    const image = dom.window.document.querySelector('[data-object-id="g12"] image')!;
    expect(["x", "y", "width", "height", "preserveAspectRatio", "href"].map((name) => image.getAttribute(name)))
      .toEqual(["10.12345", "20", "80", "40", "none", `data:image/png;base64,${png}`]);
    expect(image.parentElement!.getAttribute("transform")).toBe("rotate(30 50.123 40)");
    expect(result.warnings).toEqual([]);
    dom.window.close();
    const pdf = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }));
    const content = Buffer.from(pdf.bytes).toString("latin1");
    expect(content).toContain("/Subtype /Image");
    expect(content).toMatch(/\/I\d+ Do/);
    expect(content).toContain("80. 0 0 40. 10.12345");
    expect(pdf.warnings).toEqual([{ code: "export.pdf.svg_picture_not_drawn", severity: "warning", objectId: "g13",
      message: "PDF export: SVG picture g13 was not drawn: no SVG rasteriser is available in this export; export SVG or PNG to keep the picture" }]);
  });

  it.each([1, 0.5, 2])("keeps PNGs at physical size with output page scale %s, moving their centres with the layout", async outputScale => {
    const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="288" height="144"><rect width="288" height="144" fill="red"/></svg>').render().asPng()).toString("base64");
    const document = createEmptyDocument();
    const picture = { ...createImageGraphicObject({ id: "physical-picture", mimeType: "image/png", dataBase64: png,
      pixelsPerMeter: { x: 5669, y: 5669 }, center: { x: 400, y: 300 } }), rotation: 30 };
    document.pages[0]!.objects = [picture];
    const page = document.pages[0]!;
    const pdf = await withPdfDom(domParser => exportDocumentToPdf(document, { domParser, compress: false,
      outputWidth: page.width * outputScale, outputHeight: page.height * outputScale }));
    const [frame] = pdfPictureFrames(Buffer.from(pdf.bytes).toString("latin1"));
    expect(frame.width).toBeCloseTo(144, 1);
    expect(frame.height).toBeCloseTo(72, 1);
    expect(frame.cx).toBeCloseTo(400 * 0.75 * outputScale, 6);
    expect(frame.cy).toBeCloseTo((page.height - 300) * 0.75 * outputScale, 6);
  });
  it("exports CC=CC with either stereo as the canvas's crossed segments in SVG and painted PDF strokes", async () => {
    const document = createEmptyDocument({ now: timestamp });
    const molecule: MoleculeObject = {
      id: "either-alkene", type: "molecule", x: 30, y: 30, width: 180, height: 120, rotation: 0,
      structureFormat: "smiles", structure: "CC=CC", superatoms: [], rGroups: [],
      style: { source: "chemdraft-native-drawing" },
      atoms: [
        { id: "a", element: "C", x: 30, y: 130, formalCharge: 0 },
        { id: "b", element: "C", x: 60, y: 80, formalCharge: 0 },
        { id: "c", element: "C", x: 120, y: 80, formalCharge: 0 },
        { id: "d", element: "C", x: 150, y: 30, formalCharge: 0 }
      ],
      bonds: [
        { id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
        { id: "bc", fromAtomId: "b", toAtomId: "c", order: "double", stereo: "either",
          display: { doubleBondSide: "right" } },
        { id: "cd", fromAtomId: "c", toAtomId: "d", order: "single" }
      ]
    };
    const page = document.pages[0]!;
    page.objects = [molecule];
    const before = JSON.stringify(document);
    const canvasLines = planPageSvgRender(page).fragments.flatMap(elementFragments).filter((fragment) =>
      fragment.tag === "line" && String(fragment.attrs.class).startsWith("native-bond-line"));
    const crossed = canvasLines.filter((line) => line.attrs["data-bond-stereo"] === "either");
    expect(canvasLines).toHaveLength(4);
    expect(crossed).toHaveLength(2);
    for (const { attrs } of crossed) {
      expect((Number(attrs.x1) + Number(attrs.x2)) / 2).toBe(90);
      expect((Number(attrs.y1) + Number(attrs.y2)) / 2).toBe(80);
      expect(attrs.y1).not.toBe(attrs.y2);
    }

    const svgDom = new JSDOM(exportDocumentToSvg(document).contents, { contentType: "image/svg+xml" });
    try {
      expect(svgDom.window.document.querySelectorAll('line[data-bond-stereo="either"]')).toHaveLength(2);
      for (const { attrs } of canvasLines) {
        const line = svgDom.window.document.querySelector(
          `line[data-bond-id="${attrs["data-bond-id"]}"][data-bond-segment="${attrs["data-bond-segment"]}"]`)!;
        expect(line).not.toBeNull();
        for (const key of ["x1", "y1", "x2", "y2", "stroke-width"] as const) {
          expect(Number(line.getAttribute(key))).toBeCloseTo(Number(attrs[key]), 3);
        }
        expect(line.getAttribute("stroke")).toBe(attrs.stroke);
      }
    } finally {
      svgDom.window.close();
    }

    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }));
    const points = pdfDrawingPoints(Buffer.from(result.bytes).toString("latin1"));
    const endpoints = canvasLines.flatMap(({ attrs }) => [
      [Number(attrs.x1), Number(attrs.y1)], [Number(attrs.x2), Number(attrs.y2)]
    ]);
    expect(points).toHaveLength(endpoints.length);
    // The default full-page SVG maps document pixels to points (72/96), then PDF flips Y.
    endpoints.forEach(([x, y], index) => {
      expect(points[index]![0]).toBeCloseTo(x! * 0.75, 6);
      expect(points[index]![1]).toBeCloseTo((page.height - y!) * 0.75, 6);
    });
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it("preserves the SVG isotope label runs and superscript geometry in PDF", async () => {
    const molecule = filledRingFixture();
    molecule.atoms[0]!.isotope = 13;
    molecule.atoms.push(
      { id: "d", element: "D", x: 70, y: 100, formalCharge: 0 },
      { id: "t", element: "T", x: 210, y: 180, formalCharge: 0 }
    );
    molecule.bonds.push(
      { id: "bd", fromAtomId: "a0", toAtomId: "d", order: "single" },
      { id: "bt", fromAtomId: "a2", toAtomId: "t", order: "single" }
    );
    const document = applyPatch(createEmptyDocument({ now: timestamp }), {
      op: "addObject", pageId: "page_001", object: molecule
    });
    const svg = exportDocumentToSvg(document).contents;
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, {
      domParser: { parseFromString(source: string, mime: DOMParserSupportedType) {
        expect(source).toBe(svg);
        const parsed = domParser.parseFromString(source, mime);
        const runs = [...parsed.querySelectorAll('[data-atom-label="13CH"] [data-atom-label-run]')];
        expect(runs.map((run) => run.textContent)).toEqual(["13", "CH"]);
        expect(Number(runs[0]!.getAttribute("y"))).toBeLessThan(Number(runs[1]!.getAttribute("y")));
        return parsed;
      } } as DOMParser, compress: false
    }));
    expect(extractPdfTextRuns(result.bytes)).toEqual(expect.arrayContaining(["13", "CH", "D", "T"]));
  });

  it("sets the leading HO as tightly as the trailing OH in PDF (ethylene glycol)", async () => {
    const molecule: MoleculeObject = {
      id: "glycol", type: "molecule", x: 90, y: 130, width: 125, height: 40, rotation: 0,
      structureFormat: "smiles", structure: "OCCO", superatoms: [], rGroups: [],
      style: { source: "chemdraft-native-drawing" },
      atoms: [
        { id: "o1", element: "O", x: 100, y: 140, formalCharge: 0 },
        { id: "c1", element: "C", x: 135, y: 160, formalCharge: 0 },
        { id: "c2", element: "C", x: 170, y: 140, formalCharge: 0 },
        { id: "o2", element: "O", x: 205, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "b1", fromAtomId: "o1", toAtomId: "c1", order: "single" },
        { id: "b2", fromAtomId: "c1", toAtomId: "c2", order: "single" },
        { id: "b3", fromAtomId: "c2", toAtomId: "o2", order: "single" }
      ]
    };
    const document = applyPatch(createEmptyDocument({ now: timestamp }), { op: "addObject", pageId: "page_001", object: molecule });
    const result = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser, compress: false }), true);
    const runs = extractPdfPositionedTextRuns(result.bytes);
    expect(runs.map((run) => run.text)).toEqual(expect.arrayContaining(["H", "O", "OH"]));
    const hydrogen = runs.find((run) => run.text === "H")!;
    const oxygen = runs.find((run) => run.text === "O")!;
    // "OH" is one text run, so the PDF sets O and H by their advances with no space: the leading
    // "HO" must put its O where the H's advance ends, within half a point.
    expect(Math.abs(oxygen.x - hydrogen.x - standardFontTextWidth("H", hydrogen.fontSize))).toBeLessThan(0.5);
    expect(oxygen.y).toBeCloseTo(hydrogen.y, 6);
  });

  it.each(["left", "center", "right"] as const)("exports contiguous %s-aligned scripted formulas without whitespace runs", async (align) => {
    const fixture = scriptedTextDocument(align);
    const document = { ...fixture, pages: [{ ...fixture.pages[0], objects: fixture.pages[0].objects.slice(0, 2) }] };
    const result = await withPdfDom(domParser => exportDocumentToPdf(document, { domParser }), true);
    const runs = extractPdfPositionedTextRuns(result.bytes);
    for (const run of runs) {
      expect(run.text.trim().length).toBeGreaterThan(0);
      expect(run.text).toBe(run.text.trim());
    }
    expect(runs.map(run => run.text)).toEqual(["H", "2", "O", "SO", "4", "2-"]);
    const [h, two, o, so, four, charge] = runs;
    for (const [first, second, size] of [
      [h, two, h.fontSize], [two, o, h.fontSize * 0.72],
      [so, four, so.fontSize], [four, charge, so.fontSize * 0.72]
    ] as const) {
      expect(Math.abs(second.x - first.x - standardFontTextWidth(first.text, size))).toBeLessThan(0.5);
    }
  });

  it("keeps scripted text spacing identical across left, centre and right alignment", async () => {
    const aligned = [];
    for (const align of ["left", "center", "right"] as const) {
      const result = await withPdfDom(domParser => exportDocumentToPdf(scriptedTextDocument(align), { domParser }), true);
      aligned.push(extractPdfPositionedTextRuns(result.bytes).filter(run => run.text.trim().length > 0));
    }
    const left = aligned[0]!;
    for (const runs of aligned.slice(1)) {
      // H2O and SO4 followed immediately by a superscript charge share one anchor per line.
      for (const start of [0, 3]) {
        const shift = runs[start]!.x - left[start]!.x;
        expect(shift).toBeGreaterThan(0);
        for (let i = start; i < start + 3; i++) {
          expect(Math.abs(runs[i]!.x - left[i]!.x - shift)).toBeLessThan(0.5);
          if (i > start) {
            expect(Math.abs((runs[i]!.x - runs[i - 1]!.x) - (left[i]!.x - left[i - 1]!.x))).toBeLessThan(0.5);
          }
        }
      }
    }
  });

  it("centres each line independently when only the second line has scripts", async () => {
    const aligned = [];
    for (const align of ["left", "center", "right"] as const) {
      const result = await withPdfDom(domParser => exportDocumentToPdf(multilineScriptedTextDocument(align), { domParser }), true);
      const positioned = extractPdfPositionedTextRuns(result.bytes);
      if (align === "center") {
        const secondLine = positioned.findIndex(run => run.text === "H");
        // Anchoring measures the whole chunk, including inter-line SVG whitespace.
        for (const line of [positioned.slice(0, secondLine), positioned.slice(secondLine)]) {
          const last = line.at(-1)!;
          const rightEdge = last.x + standardFontTextWidth(last.text, last.fontSize);
          expect(Math.abs((line[0]!.x + rightEdge) / 2 - 225)).toBeLessThan(0.5);
        }
      }
      aligned.push(positioned.filter(run => run.text.trim().length > 0));
    }
    const [left, center, right] = aligned;
    expect(left!.map(run => run.text)).toEqual(["plain", "H", "2", "O"]);
    for (const [start, end] of [[0, 1], [1, 4]]) {
      const shift = center![start]!.x - left![start]!.x;
      for (let i = start; i < end; i++) {
        expect(Math.abs(center![i]!.x - left![i]!.x - shift)).toBeLessThan(0.5);
        expect(Math.abs(right![i]!.x - left![i]!.x - 2 * shift)).toBeLessThan(0.5);
      }
    }
    // Different line widths require different anchor offsets, with their baselines unchanged.
    expect(center![0]!.x - left![0]!.x).not.toBeCloseTo(center![1]!.x - left![1]!.x, 1);
    expect(center![1]!.y - center![0]!.y).toBeCloseTo(-28 * 0.75, 6);
    expect(center![3]!.y).toBeCloseTo(center![1]!.y, 6);
  });

  it.each([false, true])("draws scripted formula digits and charges with positive size, offset and advance (compression=%s)", async (compress) => {
    const result = await withPdfDom(domParser => exportDocumentToPdf(scriptedTextDocument(), { domParser, compress }));
    const runs = extractPdfPositionedTextRuns(result.bytes).filter(run => run.text.trim().length > 0);
    expect(runs.map(run => run.text)).toEqual([
      "H", "2", "O", "SO", "4", "2-", "NH", "4", "+", "13", "C", "H", "2", "O",
      "H", "2", "O", "SO", "4", "2-", "end"
    ]);
    const [h, sub, o, so, four, charge, nh, nhFour, plus, isotope, c, bigH, bigSub, bigO] = runs;
    const script = (parent: typeof h, child: typeof sub, offsetEm: number, sizeRatio = 0.72) => {
      expect(parent.fontSize).toBeCloseTo(15, 6); // 20 document px at 72/96 pt/px
      expect(child.fontSize).toBeGreaterThan(0);
      expect(Math.abs(child.fontSize / parent.fontSize - sizeRatio)).toBeLessThan(sizeRatio * 0.01);
      expect(child.y - parent.y).toBeCloseTo(offsetEm * parent.fontSize, 6);
    };
    script(h, sub, -0.4);
    expect(o.y).toBeCloseTo(h.y, 6);
    const metrics = new jsPDF({ unit: "pt" });
    const positiveAdvance = (left: typeof sub, right: typeof o) => {
      metrics.setFont("helvetica").setFontSize(left.fontSize);
      const width = metrics.getTextWidth(left.text);
      expect(width).toBeGreaterThan(0);
      expect(right.x).toBeGreaterThan(left.x + width * 0.99);
    };
    positiveAdvance(sub, o);
    script(so, four, -0.4);
    script(so, charge, 0.4);
    positiveAdvance(four, charge);
    script(nh, nhFour, -0.4);
    script(nh, plus, 0.4);
    script(c, isotope, 0.4);
    positiveAdvance(isotope, c);
    // A span's own 30 px size must not enlarge the script relative to its 20 px text object.
    script(bigH, bigSub, -0.4);
    expect(bigO.y).toBeCloseTo(bigH.y, 6);
    expect(bigO.x).toBeGreaterThan(bigSub.x);
    // Empty middle lines and a normal line after a superscript retain their original advance.
    expect(runs[17].y - runs[14].y).toBeCloseTo(-56 * 0.75, 6);
    expect(runs[20].y - runs[17].y).toBeCloseTo(-28 * 0.75, 6);
  });

  it("applies relative script shifts once across embedded-font fallback segments", async () => {
    const document = applyPatch(createEmptyDocument({ now: timestamp }), {
      op: "addObject", pageId: "page_001", object: {
        id: "mixed_font_scripts", type: "text", x: 100, y: 100, width: 400, height: 80,
        rotation: 0, style: { fontSizePx: 20, textAlign: "center" }, text: "H2⇌3+⇌−O", spans: [
          { text: "H", script: "normal", style: {} },
          { text: "2⇌3", script: "subscript", style: {} },
          { text: "+⇌−", script: "superscript", style: {} },
          { text: "O", script: "normal", style: {} }
        ]
      }
    }, { now: timestamp });
    const result = await withPdfDom(domParser => exportDocumentToPdf(document, { domParser }));
    const runs = extractPdfPositionedTextRuns(result.bytes).filter(run => run.text.trim().length > 0);
    expect(runs.map(run => run.text)).toEqual(["H", "2", "⇌", "3", "+", "⇌", "−", "O"]);
    const parent = runs[0]!;
    runs.slice(1, 7).forEach((run, index) => {
      expect(run.y - parent.y).toBeCloseTo(index < 3 ? -6 : 6, 6);
      expect(run.fontSize / parent.fontSize).toBeCloseTo(0.72, 6);
    });
    expect(runs[7]!.y).toBeCloseTo(parent.y, 6);
    runs.slice(1).forEach((run, index) => expect(run.x).toBeGreaterThan(runs[index]!.x));
  });
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
  it('preserves multiline formatted conditions with explicit independent script baselines',async()=>{
    const document=attachedConditionsDocument();
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

describe("SVG pictures in PDF export", () => {
  const redPng = () => new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="red"/></svg>').render().asPng());
  const svgSource = (tag = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="blue"/>${tag}</svg>`;
  const pictureOf = (id: string, mimeType: "image/png" | "image/svg+xml", frame: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>, opacity?: number, source = svgSource()) => {
    const dataBase64 = mimeType === "image/png" ? Buffer.from(redPng()).toString("base64") : btoa(source);
    const picture = { ...createImageGraphicObject({ id, mimeType, dataBase64, center: { x: 0, y: 0 } }),
      x: 100, y: 120, width: 96, height: 48, rotation: 30, ...frame };
    if (opacity !== undefined) picture.style = { ...picture.style, opacity };
    return picture;
  };
  const documentOf = (...objects: ReturnType<typeof pictureOf>[]) => {
    const document = createEmptyDocument({ now: timestamp });
    document.pages[0]!.objects = objects;
    return document;
  };
  const pictureAlphas = (pdf: string) => {
    const states = new Map([...pdf.matchAll(/(\d+) 0 obj\s*<<\s*\/ca ([\d.]+)\s*>>/g)].map(match => [match[1]!, Number(match[2])]));
    const resources = new Map([...pdf.matchAll(/\/(GS\d+) (\d+) 0 R/g)].map(match => [match[1]!, states.get(match[2]!)]));
    const stack: number[] = [];
    let alpha = 1;
    const painted: number[] = [];
    for (const token of pdf.match(/stream\n([\s\S]*?)\nendstream/)![1]!.matchAll(/\b(q|Q)\b|\/(GS\d+) gs|\/I\d+ Do/g)) {
      if (token[1] === "q") stack.push(alpha);
      else if (token[1] === "Q") alpha = stack.pop() ?? 1;
      else if (token[2]) alpha = resources.get(token[2]) ?? alpha;
      else painted.push(alpha);
    }
    return painted;
  };
  const pdfOf = (document: ReturnType<typeof documentOf>, rasterizeSvgPicture?: (request: SvgPictureRasterRequest) => Promise<Uint8Array>) =>
    withPdfDom(domParser => exportDocumentToPdf(document, { domParser, compress: false, rasterizeSvgPicture }));
  const notDrawn = (id: string, reason: string) => ({ code: "export.pdf.svg_picture_not_drawn", severity: "warning", objectId: id,
    message: `PDF export: SVG picture ${id} was not drawn: ${reason}` });

  it("places a PNG and an SVG picture of the same frame identically in SVG and PDF export", async () => {
    const document = documentOf(pictureOf("png-picture", "image/png", {}, 0.4), pictureOf("svg-picture", "image/svg+xml", {}, 0.4));
    const requests: SvgPictureRasterRequest[] = [];
    const result = await pdfOf(document, async request => { requests.push(request); return redPng(); });
    expect(result.warnings).toEqual([]);

    const dom = new JSDOM(exportDocumentToSvg(document).contents, { contentType: "image/svg+xml" });
    const groups = [...dom.window.document.querySelectorAll("g[data-object-id]")];
    expect(groups.map(group => group.getAttribute("data-object-id"))).toEqual(["png-picture", "svg-picture"]);
    const attributes = (group: Element) => ["x", "y", "width", "height", "preserveAspectRatio"].map(name => group.querySelector("image")!.getAttribute(name))
      .concat(group.getAttribute("transform")!, group.getAttribute("opacity")!);
    expect(attributes(groups[1]!)).toEqual(attributes(groups[0]!));
    dom.window.close();

    const pdf = Buffer.from(result.bytes).toString("latin1");
    const [first, second] = pdfPictureFrames(pdf);
    expect(second!.width).toBeCloseTo(first!.width, 6);
    expect(second!.height).toBeCloseTo(first!.height, 6);
    expect(second!.cx).toBeCloseTo(first!.cx, 6);
    expect(second!.cy).toBeCloseTo(first!.cy, 6);
    expect(first!.width).toBeCloseTo(72, 1);
    expect(pictureAlphas(pdf)).toEqual([0.4, 0.4]);
    // 96 x 48 page units drawn at 300 dpi; the hook sees the frame and the PNG size it must produce.
    expect(requests).toEqual([{ svg: svgSource(), width: 96, height: 48, pixelWidth: 300, pixelHeight: 150 }]);
  });

  it("keeps SVG pictures in z-order between vector objects and PNG pictures", async () => {
    const document = createEmptyDocument({ now: timestamp });
    const text = (id: string, content: string, y: number): TextObject => ({ id, type: "text", x: 20, y, width: 80, height: 20, rotation: 0,
      text: content, spans: [], style: {} });
    document.pages[0]!.objects = [text("t1", "Before", 40), pictureOf("svg-picture", "image/svg+xml", { rotation: 0 }),
      text("t2", "Between", 60), pictureOf("png-picture", "image/png", { rotation: 0, y: 300 }), text("t3", "After", 80)];
    const result = await pdfOf(document, async () => redPng());
    const pdf = Buffer.from(result.bytes).toString("latin1");
    const draws = [...pdf.matchAll(/\/I\d+ Do/g)].map(match => match.index!);
    expect(draws).toHaveLength(2);
    expect(draws[0]).toBeGreaterThan(pdf.indexOf("(Before)"));
    expect(pdf.indexOf("(Between)")).toBeGreaterThan(draws[0]!);
    expect(draws[1]).toBeGreaterThan(pdf.indexOf("(Between)"));
    expect(pdf.indexOf("(After)")).toBeGreaterThan(draws[1]!);
  });

  it("sizes rasters at 300 dpi, no smaller than the picture's own pixels, no larger than 4096 on a side", () => {
    expect(svgPictureRasterSize({ width: 96, height: 48 }, { pixelWidth: 96, pixelHeight: 48 })).toEqual({ pixelWidth: 300, pixelHeight: 150 });
    expect(svgPictureRasterSize({ width: 96, height: 48 }, { pixelWidth: 1000, pixelHeight: 500 })).toEqual({ pixelWidth: 1000, pixelHeight: 500 });
    expect(svgPictureRasterSize({ width: 2000, height: 1000 }, { pixelWidth: 2000, pixelHeight: 1000 })).toEqual({ pixelWidth: 4096, pixelHeight: 2048 });
    expect(svgPictureRasterSize({ width: 1, height: 1 }, { pixelWidth: 1, pixelHeight: 1 })).toEqual({ pixelWidth: 3, pixelHeight: 3 });
  });

  it("rasterises identical pictures once", async () => {
    const document = documentOf(pictureOf("one", "image/svg+xml", { x: 50 }), pictureOf("two", "image/svg+xml", { x: 300, rotation: 0 }),
      pictureOf("larger", "image/svg+xml", { x: 500, width: 192, height: 96 }));
    const requests: SvgPictureRasterRequest[] = [];
    const result = await pdfOf(document, async request => { requests.push(request); return redPng(); });
    expect(result.warnings).toEqual([]);
    expect(requests.map(request => [request.width, request.pixelWidth])).toEqual([[96, 300], [192, 600]]);
    expect(pdfPictureFrames(Buffer.from(result.bytes).toString("latin1"))).toHaveLength(3);
  });

  it("gives different rasters different PDF images even when jsPDF's default alias would collide", async () => {
    // Two 1x1 PNGs of one length whose first halves match (a padding text chunk) and whose pixels differ:
    // jsPDF's default alias hashes only that first half, so it would draw the first picture twice.
    const chunk = (type: string, data: Buffer) => {
      const bytes = Buffer.alloc(data.length + 12);
      bytes.writeUInt32BE(data.length, 0);
      bytes.write(type, 4, "ascii");
      data.copy(bytes, 8);
      bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
      return bytes;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 2;
    const pngOf = (rgb: number[]) => new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
      chunk("tEXt", Buffer.from(`Comment\0${"x".repeat(120)}`, "latin1")),
      chunk("IDAT", deflateSync(Buffer.from([0, ...rgb]), { level: 0 })), chunk("IEND", Buffer.alloc(0))]));
    const red = pngOf([255, 0, 0]), blue = pngOf([0, 0, 255]);
    const sHashCode = (jsPDF.API as unknown as { __addimage__: { sHashCode(data: Uint8Array): number } }).__addimage__.sHashCode;
    expect(Buffer.from(red).equals(Buffer.from(blue))).toBe(false);
    expect(sHashCode(red)).toBe(sHashCode(blue));

    const redSource = svgSource('<desc>red</desc>'), blueSource = svgSource('<desc>blue</desc>');
    const document = documentOf(pictureOf("red", "image/svg+xml", { x: 50, rotation: 0 }, undefined, redSource),
      pictureOf("blue", "image/svg+xml", { x: 300, rotation: 0 }, undefined, blueSource),
      pictureOf("red-again", "image/svg+xml", { x: 550, rotation: 0 }, undefined, redSource));
    const result = await pdfOf(document, async request => request.svg === redSource ? red : blue);
    expect(result.warnings).toEqual([]);
    const pdf = Buffer.from(result.bytes).toString("latin1");
    // Two image resources, painted red, blue, red; identical pictures still share one image.
    expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect([...pdf.matchAll(/(\/I\d+) Do/g)].map(match => match[1])).toEqual(["/I0", "/I1", "/I0"]);
  });

  it("warns by picture and still exports the rest when the rasteriser fails", async () => {
    const document = documentOf(pictureOf("png-picture", "image/png", { x: 10 }), pictureOf("svg-picture", "image/svg+xml", { x: 300 }));
    const result = await pdfOf(document, async () => { throw new Error("the SVG has content that can't be drawn"); });
    expect(result.warnings).toEqual([notDrawn("svg-picture", "the SVG has content that can't be drawn")]);
    expect(pdfPictureFrames(Buffer.from(result.bytes).toString("latin1"))).toHaveLength(1);
    // Non-Error throws still name the reason.
    const thrown = await pdfOf(documentOf(pictureOf("svg-picture", "image/svg+xml", {})), () => Promise.reject("boom"));
    expect(thrown.warnings).toEqual([notDrawn("svg-picture", "boom")]);
  });

  it("warns when the rasteriser returns something that is not a usable PNG", async () => {
    const document = documentOf(pictureOf("svg-picture", "image/svg+xml", {}));
    const garbage = await pdfOf(document, async () => new Uint8Array([1, 2, 3, 4]));
    expect(garbage.warnings).toEqual([notDrawn("svg-picture", "the rasteriser returned an invalid PNG (the PNG has invalid structure.)")]);
    const notBytes = await pdfOf(document, async () => "iVBORw0KGgo=" as unknown as Uint8Array);
    expect(notBytes.warnings).toEqual([notDrawn("svg-picture", "the rasteriser did not return PNG bytes")]);
    // Well-framed PNG whose pixels cannot decode: jsPDF refuses it, and only this picture is lost.
    const png = Buffer.from(redPng());
    const idat = png.indexOf("IDAT");
    const corrupt = Buffer.from(png);
    corrupt.fill(0x55, idat + 4, idat + 12);
    const corrupted = await pdfOf(document, async () => new Uint8Array(corrupt));
    expect(corrupted.bytes.length).toBeGreaterThan(0);
    expect(corrupted.warnings).toEqual([notDrawn("svg-picture", "the rasterised PNG could not be embedded (Error while decompressing the data: -3)")]);
  });

  it("warns by picture, and exports the rest, when a native PNG picture cannot be embedded", async () => {
    // Well-framed PNG whose pixels cannot decode: the structure check passes it, jsPDF refuses it.
    const png = Buffer.from(redPng());
    png.fill(0x55, png.indexOf("IDAT") + 4, png.indexOf("IDAT") + 12);
    const broken = { ...createImageGraphicObject({ id: "broken", mimeType: "image/png", dataBase64: png.toString("base64"), center: { x: 0, y: 0 } }),
      x: 300, y: 120, width: 96, height: 48, rotation: 0 };
    const result = await pdfOf(documentOf(pictureOf("fine", "image/png", { x: 10 }), broken));
    expect(result.warnings).toEqual([{ code: "export.pdf.picture_not_drawn", severity: "warning", objectId: "broken",
      message: "PDF export: picture broken was not drawn: the PNG could not be embedded (Error while decompressing the data: -3)" }]);
    expect(pdfPictureFrames(Buffer.from(result.bytes).toString("latin1"))).toHaveLength(1);
  });

  it("rejects a rasteriser result larger than the size cap", async () => {
    const chunk = (type: string, data: Buffer) => {
      const bytes = Buffer.alloc(data.length + 12);
      bytes.writeUInt32BE(data.length, 0);
      bytes.write(type, 4, "ascii");
      data.copy(bytes, 8);
      bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
      return bytes;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(5000, 0);
    header.writeUInt32BE(10, 4);
    header[8] = 8;
    header[9] = 6;
    const huge = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", Buffer.from([0])), chunk("IEND", Buffer.alloc(0))]);
    const result = await pdfOf(documentOf(pictureOf("svg-picture", "image/svg+xml", {})), async () => new Uint8Array(huge));
    expect(result.warnings).toEqual([notDrawn("svg-picture", "the rasteriser returned a 5000 x 10 PNG; the limit is 4096 pixels on a side")]);
  });

  it("warns by picture when no rasteriser is given, in the document and SVG callers", async () => {
    const document = documentOf(pictureOf("svg-picture", "image/svg+xml", {}));
    const reason = "no SVG rasteriser is available in this export; export SVG or PNG to keep the picture";
    expect((await pdfOf(document)).warnings).toEqual([notDrawn("svg-picture", reason)]);
    const page = document.pages[0]!;
    const picture = page.objects[0] as ReturnType<typeof pictureOf>;
    // The same document through the SVG caller, now with a rasteriser.
    const viaSvg = await withPdfDom(domParser => exportSvgToPdf(exportDocumentToSvg(document).contents, { domParser, compress: false,
      outputWidth: page.width, outputHeight: page.height, pictures: new Map([[picture.id, picture]]), pageSize: page,
      rasterizeSvgPicture: async () => redPng() }));
    expect(viaSvg.warnings).toEqual([]);
    expect(pdfPictureFrames(Buffer.from(viaSvg.bytes).toString("latin1"))).toHaveLength(1);
  });

  it("shares one pixel budget across a document of many large pictures", async () => {
    const pictures = Array.from({ length: 14 }, (_, index) => pictureOf(`big-${index}`, "image/svg+xml",
      { width: 1500, height: 1500, rotation: 0 }, undefined,
      `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1500"><desc>${index}</desc></svg>`));
    const requests: SvgPictureRasterRequest[] = [];
    const result = await pdfOf(documentOf(...pictures), async request => { requests.push(request); return redPng(); });
    expect(requests[0]).toMatchObject({ pixelWidth: 4096, pixelHeight: 4096 });
    expect(requests.reduce((total, request) => total + request.pixelWidth * request.pixelHeight, 0)).toBeLessThanOrEqual(SVG_PICTURE_MAX_RASTER_PIXELS);
    expect(requests.length).toBeLessThan(pictures.length);
    expect(result.warnings).toHaveLength(pictures.length - requests.length);
    for (const warning of result.warnings) expect(warning.message).toContain("too many SVG pictures");
  }, 30_000);

  it("gives a failed raster's pixels back to the budget, once, for the pictures after it", async () => {
    const svgOf = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1500"><desc>${label}</desc></svg>`;
    const big = (id: string, label: string) => pictureOf(id, "image/svg+xml", { width: 1500, height: 1500, rotation: 0 }, undefined, svgOf(label));
    // Six failures that would reserve the whole budget, a duplicate of the first (one cached
    // failure, no second refund), then seven good pictures: six fill the budget exactly.
    const pictures = [
      ...Array.from({ length: 6 }, (_, index) => big(`bad-${index}`, `bad ${index}`)),
      big("bad-again", "bad 0"),
      ...Array.from({ length: 7 }, (_, index) => big(`good-${index}`, `good ${index}`))
    ];
    const good: SvgPictureRasterRequest[] = [];
    const result = await pdfOf(documentOf(...pictures), async request => {
      if (request.svg.includes("bad")) throw new Error("renderer crashed");
      good.push(request);
      return redPng();
    });
    expect(result.warnings.map(warning => warning.message.includes("renderer crashed"))).toEqual([...Array(7).fill(true), false]);
    expect(result.warnings[7]!.message).toContain("too many SVG pictures");
    // Six good pictures draw whole; the seventh has no budget left. A second refund for the
    // duplicate would have let it through.
    expect(good).toHaveLength(6);
    expect(good.every(request => request.pixelWidth === 4096 && request.pixelHeight === 4096)).toBe(true);
    expect(good.reduce((total, request) => total + request.pixelWidth * request.pixelHeight, 0)).toBeLessThanOrEqual(SVG_PICTURE_MAX_RASTER_PIXELS);
  }, 30_000);
});

async function withPdfDom<T>(callback: (domParser: DOMParser) => Promise<T>, useStandardTextMetrics = false): Promise<T> {
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
    value: function (this: Element) {
      return { x: 0, y: 0, width: useStandardTextMetrics && this.tagName === "text"
        ? standardFontTextWidth(this.textContent ?? "", parseFloat(this.getAttribute("font-size") ?? "16"))
        : 80, height: 16 };
    }
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

// Read the effective image matrices from the PDF, including rotation and nested q/Q state.
function pdfPictureFrames(pdf: string) {
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const frames: Array<{ width: number; height: number; cx: number; cy: number }> = [];
  const streams = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(match => match[1]);
  for (const line of streams.join("\n").split("\n")) {
    const parts = line.trim().split(/\s+/), op = parts.pop();
    if (op === "q") stack.push([...matrix]);
    else if (op === "Q") matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === "cm") {
      const n = parts.map(Number), [a, b, c, d, e, f] = matrix;
      matrix = [a*n[0]+c*n[1], b*n[0]+d*n[1], a*n[2]+c*n[3], b*n[2]+d*n[3],
        a*n[4]+c*n[5]+e, b*n[4]+d*n[5]+f];
    } else if (op === "Do" && /^\/I\d+$/.test(parts[0])) {
      const [a, b, c, d, e, f] = matrix;
      frames.push({ width: Math.hypot(a, b), height: Math.hypot(c, d), cx: e + (a + c) / 2, cy: f + (b + d) / 2 });
    }
  }
  return frames;
}
