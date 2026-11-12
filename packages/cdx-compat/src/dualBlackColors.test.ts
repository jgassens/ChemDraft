import { describe, expect, it } from "vitest";
import { DefaultNativeTextStyle, type TextObject } from "@chemdraft/chem-core";
import { MAGIC, readCdx } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

// Synthetic palette, indexed from 2. In particular, 3 and 10 are both black;
// entries after the second black must retain their indices.
const palette = [
  [255, 255, 255], [0, 0, 0], [255, 0, 0], [255, 255, 0],
  [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [0, 0, 128]
];
const indices = [3, 4, 8, 9, 10, 11, 12, 13];
const expected = ["#000000", "#ff0000", "#0000ff", "#ff00ff", "#000000", "#800000", "#008000", "#000080"];
const u16 = (n: number) => [n & 255, n >>> 8 & 255];
const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
const object = (tag: number, id: number, data: number[]) => [...u16(tag), ...u32(id), ...data, 0, 0];

function syntheticBinary(parentColor?: number): Uint8Array {
  return new Uint8Array([
    ...new TextEncoder().encode(MAGIC), 4, 3, 2, 1, ...Array(10).fill(0),
    ...object(0x8000, 0, [
      ...property(0x0300, [...u16(palette.length), ...palette.flatMap(rgb => rgb.flatMap(channel => u16(channel * 257)))]),
      ...object(0x8001, 1, indices.flatMap((color, i) => object(0x8006, i + 2, [
        ...property(0x0200, [...u32((40 + i * 20) * 65536), ...u32(30 * 65536)]),
        ...(parentColor === undefined ? [] : property(0x0301, u16(parentColor))),
        ...property(0x0700, [...u16(1), ...[0, 0xffff, 0, 0, color].flatMap(u16), ...new TextEncoder().encode(`slot${color}`)])
      ])))
    ])
  ]);
}

function syntheticXml(): string {
  return `<CDXML><colortable>${palette.map(([r, g, b]) =>
    `<color r="${r / 255}" g="${g / 255}" b="${b / 255}"/>`).join("")}</colortable><page id="1">${indices.map((color, i) =>
    `<t id="${i + 2}" p="30 ${40 + i * 20}"><s color="${color}">slot${color}</s></t>`).join("")}</page></CDXML>`;
}

function texts(result: ReturnType<typeof importCdx>): TextObject[] {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  const objects = result.document!.pages[0].objects;
  expect(objects.every(object => object.type === "text")).toBe(true);
  return objects as TextObject[];
}

const colorsByText = (objects: TextObject[]) => Object.fromEntries(objects.map(text =>
  [text.text, text.spans.map(span => span.style.color ?? text.style.color ?? DefaultNativeTextStyle.color)]));
const expectedByText = Object.fromEntries(indices.map((index, i) => [`slot${index}`, [expected[i]]]));

describe("duplicate black palette text colours", () => {
  for (const parentColor of [4, 8, 11]) {
    for (const viaXml of [false, true]) {
      it(`keeps binary foreground black against parent colour ${parentColor}${viaXml ? " via CDXML" : ""}`, () => {
        let opened = importCdx(syntheticBinary(parentColor));
        expect(opened.document).toBeDefined();
        expect(colorsByText(texts(opened))).toEqual(expectedByText);
        expect(texts(opened).find(text => text.text === "slot3")!.spans[0].style.color).toBe("#000000");
        if (viaXml) opened = openChemDraftPayload(exportDocumentToCdxml(opened.document!, { embedNativePayload: false }).contents);
        const exported = exportDocumentToCdx(opened.document!, { embedNativePayload: false });
        const reopened = importCdx(exported.bytes);
        expect(colorsByText(texts(reopened))).toEqual(expectedByText);
        expect(texts(reopened).find(text => text.text === "slot10")!.spans[0].style.color).toBe("#000000");
      });
    }
  }

  for (const source of ["CDX", "CDXML"] as const) {
    for (const viaXml of [false, true]) {
      it(`keeps colours assigned to each text through payload-less ${source}${viaXml ? " → CDXML" : ""} → CDX`, () => {
        let opened = source === "CDX" ? importCdx(syntheticBinary()) : openChemDraftPayload(syntheticXml());
        // The existing binary contract normalizes foreground black without a
        // parent colour to an uncoloured native run; compare its actual drawn default.
        const drawn = { ...expectedByText, ...(source === "CDX" ? { slot3: [DefaultNativeTextStyle.color] } : {}) };
        expect(colorsByText(texts(opened))).toEqual(drawn);
        expect(texts(opened).find(text => text.text === "slot10")!.spans[0].style.color).toBe("#000000");
        for (let cycle = 0; cycle < 3; cycle++) {
          if (viaXml) {
            const xml = exportDocumentToCdxml(opened.document!, { embedNativePayload: false });
            expect(xml.warnings).toEqual([]);
            opened = openChemDraftPayload(xml.contents);
            expect(colorsByText(texts(opened))).toEqual(drawn);
          }
          const exported = exportDocumentToCdx(opened.document!, { embedNativePayload: false });
          expect(exported.warnings).toEqual([]);
          const table = readCdx(exported.bytes).kids.find(child => child.name === "colortable")!;
          expect(table.kids.slice(0, palette.length).map(color => ["r", "g", "b"].map(channel =>
            Math.round(Number(color.attrs[channel]) * 255)))).toEqual(palette);
          opened = importCdx(exported.bytes);
          expect(colorsByText(texts(opened))).toEqual(drawn);
          expect(texts(opened).find(text => text.text === "slot10")!.spans[0].style.color).toBe("#000000");
        }
      });
    }
  }
});
