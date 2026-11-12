import { describe, expect, it } from "vitest";
import { MAGIC, readCdx, type CdxWarning } from "./cdxBinary";

// Same synthetic binary builders as cdxBinary.test.ts; no external document fixtures.
const u16 = (v: number) => [v & 255, v >>> 8 & 255];
const u32 = (v: number) => [...u16(v), ...u16(v >>> 16)];
const ascii = (s: string) => [...new TextEncoder().encode(s)];
const header = [...ascii(MAGIC), 4, 3, 2, 1, ...Array(10).fill(0)];
const property = (tag: number, bytes: number[]) => [...u16(tag), ...u16(bytes.length), ...bytes];
const object = (tag: number, id: number, ...inner: number[][]) => [...u16(tag), ...u32(id), ...inner.flat(), 0, 0];
const file = (...inner: number[][]) => new Uint8Array([...header, ...object(0x8000, 0, ...inner)]);
const fontTable = property(0x0100, [...u16(1), ...u16(1), ...u16(1), ...u16(1252), ...u16(5), ...ascii("Arial")]);
const run = (bytes: number[], font = 1) => [...u16(1), ...[0, font, 0, 240, 3].flatMap(u16), ...bytes];

describe("legacy CDX text with document font metadata after the page", () => {
  it("decodes a styled Name using the later font table", () => {
    const warnings: CdxWarning[] = [];
    const root = readCdx(file(
      object(0x8001, 2, property(0x0008, run([0xe9]))),
      fontTable
    ), true, warnings);

    expect(root.kids.find((kid) => kid.name === "page")?.attrs.Name).toBe("é");
    expect(warnings).toEqual([]);
  });

  it("decodes a String tag value using the later font table", () => {
    const warnings: CdxWarning[] = [];
    const root = readCdx(file(
      object(0x8011, 2, property(0x0d00, u16(3)), property(0x0d05, run([0xe9]))),
      fontTable
    ), true, warnings);

    expect(root.kids.find((kid) => kid.name === "objecttag")?.attrs.Value).toBe("é");
    expect(warnings).toEqual([]);
  });

  it("decodes byte E9 using font 1's later Windows Latin-1 declaration", () => {
    const warnings: CdxWarning[] = [];
    const root = readCdx(file(
      object(0x8001, 2, object(0x8006, 3, property(0x0700, run([0xe9])))),
      fontTable
    ), true, warnings);

    expect(root.kids.find((kid) => kid.name === "page")?.kids[0].kids[0].text).toBe("é");
    expect(warnings).toEqual([]);
  });

  it("resolves an inherited run font after the document default font is read", () => {
    const root = readCdx(file(
      object(0x8001, 2, object(0x8006, 3, property(0x0700, run([0xe9], 0xffff)))),
      fontTable,
      property(0x081a, u16(1))
    ));

    expect(root.kids.find((kid) => kid.name === "page")?.kids[0].kids[0].text).toBe("é");
  });

  it("still prefers the Unicode text copy with a later font table", () => {
    const root = readCdx(file(
      object(0x8001, 2, object(0x8006, 3,
        property(0x0700, run([0xe9])), property(0x0709, run(ascii("→"))))),
      fontTable
    ));

    expect(root.kids.find((kid) => kid.name === "page")?.kids[0].kids[0].text).toBe("→");
  });
});
