import { inflateSync } from "node:zlib";
import { jsPDF } from "jspdf";

/** Deterministic Helvetica advances for the headless ASCII alignment tests (SVG px in/out). */
export function standardFontTextWidth(text: string, fontSizePx: number): number {
  const metrics = new jsPDF({ unit: "pt" });
  metrics.setFont("helvetica").setFontSize(fontSizePx);
  return metrics.getTextWidth(text);
}

// Decode actual jsPDF objects and streams, including compressed content and CMaps.
function pdfObjects(bytes: Uint8Array): Map<number, string> {
  return new Map([...Buffer.from(bytes).toString("latin1").matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)]
    .map((match) => [Number(match[1]), match[2]!]));
}

function stream(object: string): Buffer {
  const start = object.indexOf("stream\n") + 7;
  const length = Number(object.match(/\/Length (\d+)/)![1]);
  const bytes = Buffer.from(object.slice(start, start + length), "latin1");
  return object.includes("/FlateDecode") ? inflateSync(bytes) : bytes;
}

export function extractPdfTextRuns(bytes: Uint8Array): string[] {
  const objects = pdfObjects(bytes);
  const fontMaps = new Map<number, Map<number, string>>();
  for (const [id, object] of objects) {
    const reference = object.match(/\/ToUnicode (\d+) 0 R/);
    if (!reference) continue;
    const cmap = stream(objects.get(Number(reference[1]))!).toString("ascii");
    const mapping = new Map<number, string>();
    for (const block of cmap.matchAll(/\d+ beginbfchar\n([\s\S]*?)endbfchar/g)) {
      for (const entry of block[1]!.matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
        mapping.set(parseInt(entry[1]!, 16), String.fromCharCode(parseInt(entry[2]!, 16)));
      }
    }
    fontMaps.set(id, mapping);
  }
  const resources = new Map([...Buffer.from(bytes).toString("latin1").matchAll(/\/F(\d+) (\d+) 0 R/g)]
    .map((match) => [Number(match[1]), Number(match[2])]));
  const result: string[] = [];
  for (const object of objects.values()) {
    if (!object.includes("stream\n")) continue;
    const contents = stream(object).toString("latin1");
    let font = 0;
    for (const token of contents.matchAll(/\/F(\d+)\s+[\d.]+\s+Tf|<([\da-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (token[1]) font = Number(token[1]);
      else if (token[2]) {
        const mapping = fontMaps.get(resources.get(font)!);
        if (!mapping) throw new Error(`Missing ToUnicode mapping for F${font}`);
        result.push(token[2].match(/.{4}/g)!.map((hex) => {
          const character = mapping.get(parseInt(hex, 16));
          if (character === undefined) throw new Error(`Unmapped glyph ${hex}`);
          return character;
        }).join(""));
      } else {
        const literal = token[3]!.replace(/\\([\\()])/g, "$1");
        const fontObject = objects.get(resources.get(font)!) ?? "";
        result.push(fontObject.includes("/Encoding /WinAnsiEncoding")
          ? new TextDecoder("windows-1252").decode(Buffer.from(literal, "latin1"))
          : literal);
      }
    }
  }
  return result;
}

/** Positions and effective sizes in PDF page points (y increases upwards), after cm/Tm.
 * This reads the real Tj operators, rather than trusting the input SVG's attributes.
 */
export function extractPdfPositionedTextRuns(bytes: Uint8Array): Array<{
  text: string; x: number; y: number; fontSize: number;
}> {
  type Matrix = [number, number, number, number, number, number];
  const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
  const multiply = (a: Matrix, b: Matrix): Matrix => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  const texts = extractPdfTextRuns(bytes);
  const result: Array<{ text: string; x: number; y: number; fontSize: number }> = [];
  for (const object of pdfObjects(bytes).values()) {
    if (!object.includes("stream\n")) continue;
    let matrix = identity(), textMatrix = identity(), fontSize = 0;
    const stack: Array<{ matrix: Matrix; fontSize: number }> = [];
    for (const line of stream(object).toString("latin1").split("\n")) {
      const parts = line.trim().split(/\s+/), op = parts.pop();
      const numbers = parts.map(Number);
      if (op === "q") stack.push({ matrix: [...matrix], fontSize });
      else if (op === "Q") {
        const saved = stack.pop();
        if (saved) { matrix = saved.matrix; fontSize = saved.fontSize; }
      } else if (op === "cm") matrix = multiply(matrix, numbers as Matrix);
      else if (op === "BT") textMatrix = identity();
      else if (op === "Tf") fontSize = numbers[1]!;
      else if (op === "Tm") textMatrix = numbers as Matrix;
      else if (op === "Td") textMatrix = multiply(textMatrix, [1, 0, 0, 1, numbers[0]!, numbers[1]!]);
      else if (op === "Tj") {
        const effective = multiply(matrix, textMatrix);
        const text = texts[result.length];
        if (text === undefined) throw new Error("Missing decoded PDF text run");
        result.push({ text, x: effective[4], y: effective[5],
          fontSize: fontSize * Math.hypot(effective[2], effective[3]) });
      }
    }
  }
  return result;
}

export function pdfFontStreams(bytes: Uint8Array): Buffer[] {
  const objects = pdfObjects(bytes);
  return [...objects.values()].flatMap((object) => {
    const reference = object.match(/\/FontFile2 (\d+) 0 R/);
    return reference ? [stream(objects.get(Number(reference[1]))!)] : [];
  });
}

export function sfntTable(font: Buffer, name: string): Buffer {
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const offset = 12 + i * 16;
    if (font.toString("ascii", offset, offset + 4) === name) {
      const start = font.readUInt32BE(offset + 8);
      return font.subarray(start, start + font.readUInt32BE(offset + 12));
    }
  }
  throw new Error(`Missing TrueType table ${name}`);
}

/** Ink bounds from the actual glyph header, including composite glyphs, in em. */
export function glyphBounds(font: Buffer, code: number): { yMin: number; yMax: number } {
  const glyph = unicodeCmap(font).get(code);
  if (!glyph) throw new Error(`Missing glyph U+${code.toString(16)}`);
  const head = sfntTable(font, "head");
  const unitsPerEm = head.readUInt16BE(18);
  const loca = sfntTable(font, "loca");
  const offset = head.readInt16BE(50) === 0 ? loca.readUInt16BE(glyph * 2) * 2 : loca.readUInt32BE(glyph * 4);
  const glyf = sfntTable(font, "glyf");
  return { yMin: glyf.readInt16BE(offset + 4) / unitsPerEm, yMax: glyf.readInt16BE(offset + 8) / unitsPerEm };
}

export function sfntName(font: Buffer, id: number): string {
  const names = sfntTable(font, "name");
  for (let i = 0; i < names.readUInt16BE(2); i++) {
    const record = 6 + i * 12;
    if (names.readUInt16BE(record) !== 3 || names.readUInt16BE(record + 6) !== id) continue;
    const start = names.readUInt16BE(4) + names.readUInt16BE(record + 10);
    const value = Buffer.from(names.subarray(start, start + names.readUInt16BE(record + 8)));
    return value.swap16().toString("utf16le");
  }
  throw new Error(`Missing TrueType name ${id}`);
}

/** Read the font's BMP cmap (format 4) independently of jsPDF's font parser. */
export function unicodeCmap(font: Buffer): Map<number, number> {
  const cmap = sfntTable(font, "cmap");
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const record = 4 + i * 8;
    if (cmap.readUInt16BE(record) !== 3 || cmap.readUInt16BE(record + 2) !== 1) continue;
    const table = cmap.subarray(cmap.readUInt32BE(record + 4));
    if (table.readUInt16BE(0) !== 4) continue;
    const count = table.readUInt16BE(6) / 2;
    const starts = 16 + count * 2;
    const deltas = starts + count * 2;
    const ranges = deltas + count * 2;
    const result = new Map<number, number>();
    for (let segment = 0; segment < count; segment++) {
      const end = table.readUInt16BE(14 + segment * 2);
      const start = table.readUInt16BE(starts + segment * 2);
      const delta = table.readInt16BE(deltas + segment * 2);
      const rangeAddress = ranges + segment * 2;
      const range = table.readUInt16BE(rangeAddress);
      for (let code = start; code <= end && code < 0xffff; code++) {
        let glyph = range ? table.readUInt16BE(rangeAddress + range + 2 * (code - start)) : code;
        if (!range || glyph) glyph = (glyph + delta) & 0xffff;
        if (glyph) result.set(code, glyph);
      }
    }
    return result;
  }
  throw new Error("Missing Unicode BMP cmap");
}
