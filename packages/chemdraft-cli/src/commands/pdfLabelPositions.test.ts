import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { afterAll, beforeAll, expect, it } from "vitest";
import { buildSmilesDocument } from "../document";
import { installNodeEngines } from "../engine";
import { runExportCommand, withPdfDom } from "./export";
import { runRenderDocumentCommand } from "./renderDocument";

const exporterRequire = createRequire(createRequire(import.meta.url).resolve("@chemdraft/export-engine/pdf"));
const { jsPDF } = exporterRequire("jspdf");
const { svg2pdf } = exporterRequire("svg2pdf.js");
let directory: string;
beforeAll(async () => {
  installNodeEngines();
  directory = await mkdtemp(join(tmpdir(), "chemdraft-pdf-positions-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}

interface TextPosition { text: string; x: number; y: number; width: number; anchor?: string; fontName?: string }

// Standard PDF fonts omit /Widths. Read their built-in width tables directly,
// independently of the DOM measuring helper and jsPDF's string/kerning routines.
function glyphAdvance(text: string, font: { metadata: { Unicode: { widths: Record<number, number> & { fof: number } } } }, size: number) {
  const widths = font.metadata.Unicode.widths;
  let advance = 0;
  for (let i = 0; i < text.length; i++) advance += (widths[text.charCodeAt(i)] || widths[0] || widths.fof) / widths.fof;
  return advance * size;
}

// Read the actual PDF content stream, retaining the graphics-state transforms. The fixtures
// have unrotated text; coordinates are converted from PDF points back to page CSS pixels.
function pdfTextPositions(bytes: Buffer, pageHeight: number, pointsPerUnit = 0.75): TextPosition[] {
  const source = bytes.toString("latin1");
  const metrics = new jsPDF({ unit: "pt" });
  const result: TextPosition[] = [];
  const baseFonts: Record<string, [string, string]> = {
    Helvetica: ["helvetica", "normal"], "Helvetica-Bold": ["helvetica", "bold"],
    "Helvetica-Oblique": ["helvetica", "italic"], "Helvetica-BoldOblique": ["helvetica", "bolditalic"],
    "Times-Roman": ["times", "normal"], "Times-Bold": ["times", "bold"],
    "Times-Italic": ["times", "italic"], "Times-BoldItalic": ["times", "bolditalic"],
    Courier: ["courier", "normal"], "Courier-Bold": ["courier", "bold"]
  };
  const fonts = new Map<string, [string, string]>();
  for (const ref of source.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const object = source.match(new RegExp(`(?:^|\\n)${ref[2]} 0 obj\\n([\\s\\S]*?)endobj`))?.[1];
    const name = object?.match(/\/BaseFont \/([^\s]+)/)?.[1];
    if (name && baseFonts[name]) fonts.set(ref[1]!, baseFonts[name]!);
  }
  for (const stream of source.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gs)) {
    const data = Buffer.from(stream[2]!, "latin1");
    const content = (stream[1]!.includes("/FlateDecode") ? inflateSync(data) : data).toString("latin1");
    let ctm = identity(), textMatrix = identity(), font = "F1", size = 16;
    const stack: Matrix[] = [];
    for (const line of content.split("\n")) {
      if (line === "q") stack.push([...ctm]);
      else if (line === "Q") ctm = stack.pop()!;
      else if (line.endsWith(" cm")) ctm = multiply(ctm, line.split(" ").slice(0, 6).map(Number) as Matrix);
      else if (line.endsWith(" Tm")) textMatrix = line.split(" ").slice(0, 6).map(Number) as Matrix;
      else if (line.endsWith(" Td")) {
        const [x, y] = line.split(" ").map(Number);
        textMatrix = multiply(textMatrix, [1, 0, 0, 1, x!, y!]);
      } else if (line.endsWith(" Tf")) {
        const parts = line.split(" "); font = parts[0]!.slice(1); size = Number(parts[1]);
      } else {
        const match = line.match(/^\((.*)\) Tj$/);
        if (!match) continue;
        const text = match[1]!.replace(/\\([\\()])/g, "$1");
        if (!text.trim()) continue;
        const matrix = multiply(ctm, textMatrix);
        const selected = fonts.get(font);
        expect(selected, `PDF font ${font}`).toBeDefined();
        const selectedFont = metrics.getFont(...selected!);
        result.push({ text, x: matrix[4] / pointsPerUnit, y: pageHeight - matrix[5] / pointsPerUnit,
          fontName: selectedFont.postScriptName,
          width: glyphAdvance(text, selectedFont, size) * Math.hypot(matrix[0], matrix[1]) / pointsPerUnit });
      }
    }
  }
  return result;
}

async function svgTextPositions(svg: string): Promise<TextPosition[]> {
  return withPdfDom(async (parser) => {
    const root = parser.parseFromString(svg, "image/svg+xml");
    return [...root.querySelectorAll("text")].flatMap((text) => {
      const leaves = text.querySelectorAll("tspan");
      return (leaves.length ? [...leaves] : [text]).map((leaf) => {
        const ancestors: Element[] = [];
        for (let node: Element | null = leaf; node; node = node.parentElement) ancestors.unshift(node);
        let x = 0, y = 0, ctm = identity();
        for (const node of ancestors) {
          if (node.hasAttribute("x")) x = Number(node.getAttribute("x"));
          if (node.hasAttribute("y")) y = Number(node.getAttribute("y"));
          for (const transform of (node.getAttribute("transform") ?? "").matchAll(/(translate|matrix)\(([^)]+)\)/g)) {
            const values = transform[2]!.split(/[ ,]+/).map(Number);
            ctm = multiply(ctm, transform[1] === "matrix" ? values as Matrix : [1, 0, 0, 1, values[0]!, values[1] ?? 0]);
          }
        }
        const size = Number(text.getAttribute("font-size") || text.parentElement?.getAttribute("font-size"));
        const dy = leaf.getAttribute("dy") ?? text.getAttribute("dy") ?? "0";
        y += parseFloat(dy) * (dy.endsWith("em") ? size : 1);
        return { text: leaf.textContent ?? "", x: ctm[0]*x+ctm[2]*y+ctm[4],
          y: ctm[1]*x+ctm[3]*y+ctm[5], width: 0,
          anchor: leaf.getAttribute("text-anchor") ?? text.getAttribute("text-anchor") ?? "start" };
      });
    });
  });
}

async function checkPositions(pdfPath: string, svgPath: string, pageHeight: number) {
  const svg = await svgTextPositions(await readFile(svgPath, "utf8"));
  const pdf = pdfTextPositions(await readFile(pdfPath), pageHeight);
  expect(pdf, JSON.stringify(pdf)).toHaveLength(svg.length);
  const positions = svg.map((expected, index) => {
    const actual = pdf[index]!;
    if (/^[\x20-\x7e]+$/.test(expected.text)) expect(actual.text).toBe(expected.text);
    expect(Math.abs(actual.y - expected.y), `Baseline for ${expected.text}`).toBeLessThan(0.15);
    const alignedX = actual.x + (expected.anchor === "middle" ? actual.width / 2 : expected.anchor === "end" ? actual.width : 0);
    return { text: expected.text, anchor: expected.anchor, expectedX: expected.x, actualX: alignedX };
  });
  for (const position of positions) {
    expect(Math.abs(position.actualX - position.expectedX), JSON.stringify(positions)).toBeLessThan(0.15);
  }
  return positions;
}

const io = { stdout: (_line: string) => {}, stderr: (_line: string) => {} };
it.each(["export", "render-document"])("centres sodium benzoate labels and preserves charge starts in %s PDF", async (command) => {
  const smiles = "[Na+].[O-]C(=O)c1ccccc1";
  const built = await buildSmilesDocument(smiles);
  const input = join(directory, `${command}.json`), pdf = join(directory, `${command}.pdf`), svg = join(directory, `${command}.svg`);
  await writeFile(input, JSON.stringify(built.document));
  expect(await runRenderDocumentCommand(["--document", input, "--out", svg], io)).toBe(0);
  const args = command === "export" ? ["--smiles", smiles, "--out", pdf] : ["--document", input, "--out", pdf];
  expect(await (command === "export" ? runExportCommand : runRenderDocumentCommand)(args, io)).toBe(0);
  const positions = await checkPositions(pdf, svg, built.document.pages[0]!.height);
  // Atom glyphs are exported twice (background stroke, then fill); check both copies.
  expect(positions.filter((run) => run.anchor === "middle").map((run) => run.text)).toEqual(["Na", "Na", "O", "O", "O", "O"]);
  expect(positions.filter((run) => run.anchor === "start").map((run) => run.text)).toEqual(["+", "+", "-", "-"]);
}, 60_000);

it.each([
  ["Arial, Helvetica, sans-serif", 18, 400, "normal"],
  ["Times New Roman, Times, serif", 24, 700, "italic"],
  ["Courier, monospace", 12, 700, "normal"]
] as const)("centres native text/tspans with %s PDF metrics", async (fontFamily, fontSizePx, fontWeight, fontStyle) => {
  const built = structuredClone(await buildSmilesDocument("C"));
  built.document.pages[0]!.objects = [{ id: "centred", type: "text", text: "Yield", spans: [],
    x: 100, y: 100, width: 200, height: 80, rotation: 0,
    style: { fontFamily, fontSizePx, fontWeight, fontStyle, textAlign: "center" } }];
  const input = join(directory, `text-${fontSizePx}.json`), pdf = join(directory, `text-${fontSizePx}.pdf`), svg = join(directory, `text-${fontSizePx}.svg`);
  await writeFile(input, JSON.stringify(built.document));
  expect(await runRenderDocumentCommand(["--document", input, "--out", svg], io)).toBe(0);
  expect(await runRenderDocumentCommand(["--document", input, "--out", pdf], io)).toBe(0);
  const positions = await checkPositions(pdf, svg, built.document.pages[0]!.height);
  expect(positions.map((run) => run.anchor)).toEqual(["middle"]);
}, 60_000);

it("measures inherited text/tspan styles and restores shims and the jsPDF hook after failure", async () => {
  const before = [...jsPDF.API.events];
  let prototype: SVGElement;
  let getAttribute: SVGElement["getAttribute"];
  await expect(withPdfDom(async (parser) => {
    prototype = SVGElement.prototype;
    getAttribute = Element.prototype.getAttribute;
    const pdf = new jsPDF({ unit: "pt" });
    const root = parser.parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><text x="50" y="20" font-family="Arial" font-size="18" text-anchor="middle">Na<tspan font-size="12" font-weight="700">+</tspan></text></svg>', "image/svg+xml");
    const text = root.querySelector("text") as unknown as SVGTextElement;
    const tspan = root.querySelector("tspan") as unknown as SVGTSpanElement;
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(18);
    const naWidth = glyphAdvance("Na", pdf.getFont(), 18);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(12);
    const plusWidth = glyphAdvance("+", pdf.getFont(), 12);
    expect(tspan.getComputedTextLength()).toBeCloseTo(plusWidth, 6);
    expect(tspan.getBBox().width).toBeCloseTo(plusWidth, 6);
    expect(text.getBBox().width).toBeCloseTo(naWidth + plusWidth, 6);
    expect(text.getBBox().x).toBeCloseTo(50 - (naWidth + plusWidth) / 2, 6);
    expect(pdf.getFont().fontStyle).toBe("bold");
    expect(pdf.getFontSize()).toBe(12);
    throw new Error("intentional PDF failure");
  })).rejects.toThrow("intentional PDF failure");
  expect(jsPDF.API.events).toEqual(before);
  // JSDOM originally has neither method, so teardown must delete them, even on failure.
  expect(Object.getOwnPropertyDescriptor(prototype!, "getBBox")).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(prototype!, "getComputedTextLength")).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(prototype!, "getAttribute")).toBeUndefined();
  expect(prototype!.getAttribute).toBe(getAttribute!);
});

it.each([undefined, "57.6"])("centres a monospace tspan inside serif text (textLength=%s)", async (textLength) => {
  await withPdfDom(async (parser) => {
    const pdf = new jsPDF({ unit: "pt", format: [300, 150], orientation: "landscape" });
    // A natural textLength still executes TextChunk.measureText (2691), rather
    // than the ordinary put measurement (2706), without extra letter spacing.
    const svg = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><text x="100" y="60" font-family="serif" font-size="24" text-anchor="middle" ${textLength ? `textLength="${textLength}"` : ""}><tspan font-family="monospace">MMMM</tspan></text></svg>`, "image/svg+xml");
    await svg2pdf(svg.documentElement, pdf);
    const runs = pdfTextPositions(Buffer.from(pdf.output("arraybuffer")), 150, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.fontName).toBe("Courier");
    expect(runs[0]!.width).toBeCloseTo(57.6, 6);
    expect(runs[0]!.x).toBeCloseTo(71.2, 6);
    expect(runs[0]!.x + runs[0]!.width / 2).toBeCloseTo(100, 6);
  });
});

it.each(([
  ["", '<tspan font-weight="500">M<tspan font-weight="700">MM</tspan>M</tspan>',
    ["Times-Roman", "Helvetica-Bold", "Times-Roman"], [21.36, 39.84, 21.36]],
  ['font-weight="500"', '<tspan font-family="monospace">M<tspan font-weight="700">MM</tspan>M</tspan>',
    ["Courier", "Courier-Bold", "Courier"], [14.4, 28.8, 14.4]],
  ['font-weight="500"', '<tspan font-weight="700"><tspan font-family="monospace" font-weight="500">MMMM</tspan></tspan>',
    ["Courier"], [57.6]],
  ["", '<tspan font-family="monospace" font-weight="500">M<tspan font-weight="700">MM</tspan>M</tspan>',
    ["Times-Roman", "Courier-Bold", "Times-Roman"], [21.36, 28.8, 21.36]]
] as const).flatMap(test => [undefined, test[3].reduce((sum: number, width) => sum + width, 0)]
  .map(textLength => [...test, textLength] as const)))("centres nested font overrides from text attributes %s: %s (fonts=%s, widths=%s, textLength=%s)", async (attributes, content, expectedFonts, expectedWidths, textLength) => {
  await withPdfDom(async (parser) => {
    const pdf = new jsPDF({ unit: "pt", format: [300, 150], orientation: "landscape" });
    const svg = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><text x="100" y="60" font-family="Arial" font-size="24" text-anchor="middle" ${attributes} ${textLength ? `textLength="${textLength}"` : ""}>${content}</text></svg>`, "image/svg+xml");
    await svg2pdf(svg.documentElement, pdf);
    const runs = pdfTextPositions(Buffer.from(pdf.output("arraybuffer")), 150, 1);
    expect(runs.map(run => run.fontName)).toEqual(expectedFonts);
    const totalWidth = expectedWidths.reduce((total, width) => total + width, 0);
    let x = 100 - totalWidth / 2;
    runs.forEach((run, index) => {
      expect(run.width).toBeCloseTo(expectedWidths[index]!, 6);
      expect(run.x).toBeCloseTo(x, 6);
      x += run.width;
    });
    expect((runs[0]!.x + x) / 2).toBeCloseTo(100, 6);
  });
});

it.each([
  ["ToToTo", "400", 83.52, "Helvetica"],
  ["MMMM", "500", 85.44, "Times-Roman"],
  ["MMMM", "800", 85.44, "Times-Roman"]
] as const)("centres Arial 24px %s with weight %s using emitted glyph advances", async (text, weight, expectedWidth, expectedFont) => {
  await withPdfDom(async (parser) => {
    const pdf = new jsPDF({ unit: "pt", format: [300, 150], orientation: "landscape" });
    const svg = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><g transform="scale(0.75)"><text x="100" y="60" font-family="Arial" font-size="24" font-weight="${weight}" text-anchor="middle">${text}</text></g></svg>`, "image/svg+xml");
    const label = svg.querySelector("text") as unknown as SVGTextElement;
    expect(label.getBBox().width).toBeCloseTo(expectedWidth, 6);
    await svg2pdf(svg.documentElement, pdf);
    const runs = pdfTextPositions(Buffer.from(pdf.output("arraybuffer")), 200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe(text);
    expect(runs[0]!.fontName).toBe(expectedFont);
    expect(runs[0]!.width).toBeCloseTo(expectedWidth, 6);
    expect(runs[0]!.x + runs[0]!.width / 2).toBeCloseTo(100, 6);
  });
});

it.each(["500", "800"].flatMap(weight => [false, true].map(tspan => [weight, tspan] as const)))("uses a registered %snormal style before aliases and later families (tspan=%s)", async (weight, tspan) => {
  await withPdfDom(async (parser) => {
    // A standard-font registration exercises custom family/style lookup without
    // bundling a font fixture. The quoted comma also exercises the family parser.
    // Mark the test registration as a standard font before jsPDF's TTF loader
    // runs; it is an alias of a built-in PDF font, not an external font file.
    const registration = ["addFont", ({ font }: { font: { isStandardFont: boolean } }) => { font.isStandardFont = true; }];
    // jsPDF subscribes API events in reverse order when constructing an instance.
    jsPDF.API.events.push(registration);
    let pdf;
    try {
      pdf = new jsPDF({ unit: "pt", format: [300, 150], orientation: "landscape" });
      pdf.addFont("Helvetica-Bold", "Registered, Family", `${weight}normal`, "WinAnsiEncoding");
    } finally {
      jsPDF.API.events.splice(jsPDF.API.events.indexOf(registration), 1);
    }
    const fontAttributes = `font-family="'Registered, Family', Arial, serif" font-weight="${weight}"`;
    const svg = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><g transform="scale(0.75)"><text x="100" y="60" ${tspan ? 'font-family="Arial"' : fontAttributes} font-size="24" text-anchor="middle">${tspan ? `<tspan ${fontAttributes}>MMMM</tspan>` : "MMMM"}</text></g></svg>`, "image/svg+xml");
    const expectedWidth = glyphAdvance("MMMM", pdf.getFont("Registered, Family", `${weight}normal`), 24);
    expect((svg.querySelector("text") as unknown as SVGTextElement).getBBox().width).toBeCloseTo(expectedWidth, 6);
    await svg2pdf(svg.documentElement, pdf);
    const runs = pdfTextPositions(Buffer.from(pdf.output("arraybuffer")), 200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.fontName).toBe("Helvetica-Bold");
    expect(runs[0]!.width).toBeCloseTo(expectedWidth, 6);
    expect(runs[0]!.x + runs[0]!.width / 2).toBeCloseTo(100, 6);
  });
});

it.each([
  ['font-weight="500"', 'font-family="monospace"', "Courier", 57.6],
  ['font-family="serif" font-weight="700"', 'font-family="monospace"', "Courier-Bold", 57.6],
  ['font-family="monospace" font-weight="500"', 'font-family="Arial"', "Helvetica", 79.68]
] as const)("preserves the effective PDF style from %s across %s", async (inherited, family, expectedFont, expectedWidth) => {
  await withPdfDom(async (parser) => {
    const pdf = new jsPDF({ unit: "pt", format: [300, 150], orientation: "landscape" });
    const svg = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><g ${inherited}><text x="100" y="60" ${family} font-size="24" text-anchor="middle">MMMM</text></g></svg>`, "image/svg+xml");
    await svg2pdf(svg.documentElement, pdf);
    // The reader derives width from the font actually emitted in the content
    // stream, using its glyph table rather than the measurement helper.
    const runs = pdfTextPositions(Buffer.from(pdf.output("arraybuffer")), 150, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.fontName).toBe(expectedFont);
    expect(runs[0]!.width).toBeCloseTo(expectedWidth, 6);
    expect(runs[0]!.x).toBeCloseTo(100 - expectedWidth / 2, 6);
    expect(runs[0]!.x + runs[0]!.width / 2).toBeCloseTo(100, 6);
  });
});
