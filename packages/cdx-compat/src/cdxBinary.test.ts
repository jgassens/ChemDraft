// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: ported codec checks to Vitest with typed-property coverage and specific hostile-input diagnostics.

import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { CDX_POINT3D_ORDER_ATTRIBUTE, MAGIC, cdxElementFromOrderedTree, cdxElementToCdxml, readCdx, writeCdx, type CdxElement, type CdxWarning } from "./cdxBinary";
import { OBJECTS, PROPS } from "./cdxTags";
import { importCdx } from "./index";

const u16 = (v: number) => [v & 255, v >>> 8 & 255];
const u32 = (v: number) => [...u16(v), ...u16(v >>> 16)];
const ascii = (s: string) => [...new TextEncoder().encode(s)];
const header = [...ascii(MAGIC), 4, 3, 2, 1, ...Array(10).fill(0)];
const property = (tag: number, bytes: number[]) => [...u16(tag), ...u16(bytes.length), ...bytes];
const object = (tag: number, id: number, ...inner: number[][]) => [...u16(tag), ...u32(id), ...inner.flat(), 0, 0];
const file = (...inner: number[][]) => new Uint8Array([...header, ...object(0x8000, 0, ...inner)]);
const coord = (v: number) => u32(Math.round(v * 65536));
const float = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [...b]; };
const styled = (text: string) => [...u16(1), ...[0, 3, 1, 240, 3].flatMap(u16), ...ascii(text)];
const element = (name: string, attrs: Record<string, string> = {}, kids: CdxElement[] = [], text = ""): CdxElement => ({ name, attrs, kids, text });

describe("binary CDX headers and reference codec cases", () => {
  it("writes the magic, little-endian marker, ten reserved bytes and document tag/id", () => {
    const bytes = writeCdx(element("CDXML"));
    expect([...bytes]).toEqual([...header, ...u16(0x8000), ...u32(0), 0, 0]);
  });

  it("writes GenericNickname as a CDXString with a zero style-run count", () => {
    const bytes = writeCdx(element("CDXML", {}, [element("n", { id: "10", GenericNickname: "NMe" })]));
    expect(bytes).toEqual(file(object(0x8004, 10, property(0x0433, [0, 0, 0x4e, 0x4d, 0x65]))));
  });

  it.each([
    ["C", "6", undefined], ["Cl", "17", undefined], ["D", "1", "2"], ["T", "1", "3"], ["6", "6", undefined]
  ])("keeps %s as an element rather than a nickname", (symbol, atomicNumber, isotope) => {
    const node = readCdx(writeCdx(element("CDXML", {}, [element("n", { Element: symbol! })]))).kids[0];
    expect(node.attrs.Element).toBe(atomicNumber);
    expect(node.attrs.Isotope).toBe(isotope);
    expect(node.attrs.GenericNickname).toBeUndefined();
    expect(node.kids).toEqual([]);
  });

  it("reads little-endian and big-endian coordinates and signed charges", () => {
    const little = file(property(0x0805, coord(14.4)), object(0x8004, 12, property(0x0200, [...coord(-10), ...coord(20)]), property(0x0421, [255])));
    const big = new Uint8Array([...ascii(MAGIC), 1, 2, 3, 4, ...Array(10).fill(0), 128, 0, 0, 0, 0, 0,
      8, 5, 0, 4, ...coord(14.4).reverse(),
      128, 4, 0, 0, 0, 12, 2, 0, 0, 8, ...coord(-10).reverse(), ...coord(20).reverse(), 4, 33, 0, 1, 255, 0, 0, 0, 0]);
    expect(readCdx(big)).toEqual(readCdx(little));
    expect(readCdx(big).kids[0].attrs).toEqual({ id: "12", p: "20 -10", Charge: "-1" });
    // A zero document tag/id is used by some writers.
    const zeroTag = little.slice(); zeroTag[23] = 0;
    expect(readCdx(zeroTag)).toEqual(readCdx(little));
    // Offsets within a larger backing buffer must be respected.
    const backing = new Uint8Array(little.length + 5); backing.set(little, 3);
    expect(readCdx(backing.subarray(3, 3 + little.length))).toEqual(readCdx(little));
  });

  it("prefers UTF-8 text, reads legacy Mac Roman, and writes both copies", () => {
    const tree = readCdx(file(object(0x8006, 2, property(0x0700, [1, 0, ...[0, 3, 0, 0, 3].flatMap(u16), 0xa5, 32, 109, 97, 99])),
      object(0x8006, 3, property(0x0700, styled("old")), property(0x0709, styled("→ new")))));
    expect(tree.kids[0].kids[0].text).toBe("• mac");
    expect(tree.kids[1].kids[0]).toMatchObject({ text: "→ new", attrs: { face: "1", size: "12" } });
    const bytes = writeCdx(element("CDXML", {}, [element("page", {}, [element("t", {}, [element("s", { font: "3", size: "10" }, [], "A → B")])])]));
    expect(Buffer.from(bytes).includes(Buffer.from([0, 7]))).toBe(true);
    expect(Buffer.from(bytes).includes(Buffer.from([9, 7]))).toBe(true);
    expect(readCdx(bytes).kids[0].kids[0].kids[0].text).toBe("A → B");
  });

  it.each(PROPS.filter((p) => p[2] === "p3"))("uses x/y/z bytes for %s (%s)", (tag, name) => {
    // Independent fixed-point bytes for x=40, y=100, z=-2; 2D's y/x order does not apply.
    const bytes = [0, 0, 40, 0, 0, 0, 100, 0, 0, 0, 254, 255];
    expect(readCdx(file(property(tag, bytes))).attrs[name]).toBe("40 100 -2");
    expect(writeCdx(element("CDXML", { [name]: "40 100 -2" }))).toEqual(file(property(tag, bytes)));
    const big = new Uint8Array([...ascii(MAGIC), 1, 2, 3, 4, ...Array(10).fill(0), 128, 0, 0, 0, 0, 0,
      ...u16(tag).reverse(), 0, 12, 0, 40, 0, 0, 0, 100, 0, 0, 255, 254, 0, 0, 0, 0]);
    expect(readCdx(big).attrs[name]).toBe("40 100 -2");
  });

  it("uses extended property lengths and keeps unknown binary properties", () => {
    const value = "A".repeat(70_000);
    const tree = element("CDXML", { attrib4567: `|x|${"41".repeat(value.length)}` });
    const bytes = writeCdx(tree);
    expect([...bytes.subarray(28, 36)]).toEqual([...u16(0x4567), 255, 255, ...u32(value.length)]);
    expect(readCdx(bytes)).toEqual(tree);
  });

  it("keeps a single text run larger than a short property length", () => {
    const original = element("CDXML", {}, [element("t", {}, [], "a".repeat(70_000))]);
    expect(readCdx(writeCdx(original)).kids[0].kids[0].text).toBe(original.kids[0].text);
  });
});

describe("Point3D binary interchange and legacy provenance", () => {
  const points: [number, string, number[]][] = [
    [0x0207, "Head3D", [100, 200, 0]],
    [0x0208, "Tail3D", [-50, 200, 9]],
    [0x020d, "Center3D", [25, 175, -12]],
    [0x020e, "MajorAxisEnd3D", [75, 175, 3]],
    [0x020f, "MinorAxisEnd3D", [25, 225, -4]]
  ];
  const pointProperties = (legacy = false) => points.map(([tag, , xyz]) =>
    property(tag, (legacy ? [...xyz].reverse() : xyz).flatMap(coord)));
  const pointAttributes = Object.fromEntries(points.map(([, name, xyz]) => [name, xyz.join(" ")]));

  it("decodes independently built arrow bytes to exact CDXML x/y/z attributes", () => {
    const bytes = file(object(0x8001, 1, object(0x8021, 2, ...pointProperties())));
    const arrow = readCdx(bytes).kids[0].kids[0];
    expect(arrow.attrs).toEqual({ id: "2", ...pointAttributes });
    expect(cdxElementToCdxml(arrow)).toBe('<arrow id="2" Head3D="100 200 0" Tail3D="-50 200 9" Center3D="25 175 -12" MajorAxisEnd3D="75 175 3" MinorAxisEnd3D="25 225 -4"></arrow>');
  });

  it("writes CDXML arrow and orbital attributes as independent x/y/z byte sequences", () => {
    const attrs = Object.entries(pointAttributes).map(([name, value]) => `${name}="${value}"`).join(" ");
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false });
    const source = cdxElementFromOrderedTree(parser.parse(`<CDXML><page id="1"><arrow id="2" ${attrs}/><graphic id="3" GraphicType="Orbital" OrbitalType="p" ${attrs}/></page></CDXML>`));
    const bytes = writeCdx(source);
    expect(bytes).toEqual(file(object(0x8001, 1,
      object(0x8021, 2, ...pointProperties()),
      object(0x8007, 3, property(0x0a00, u16(5)), property(0x0a05, u16(3)), ...pointProperties()))));
    expect(readCdx(bytes)).toEqual(source);
    expect(cdxElementToCdxml(readCdx(bytes))).toBe(cdxElementToCdxml(source));
  });

  it.each([[100, 200, 0], [-40.25, 100.5, -2.75]])("uses x/y/z for all six Point3D tags on every codec object (%s, %s, %s)", (x, y, z) => {
    const props = PROPS.filter(([, , kind]) => kind === "p3");
    expect(props.map(([, name]) => name)).toEqual(["xyz", "Head3D", "Tail3D", "Center3D", "MajorAxisEnd3D", "MinorAxisEnd3D"]);
    const expected = Object.fromEntries(props.map(([, name]) => [name, `${x} ${y} ${z}`]));
    for (const [tag, name] of Object.entries(OBJECTS)) {
      const bytes = file(object(Number(tag), 1, ...props.map(([tag]) => property(tag, [x, y, z].flatMap(coord)))));
      expect(readCdx(bytes).kids[0], name).toMatchObject({ name, attrs: expected });
      expect(writeCdx(element("CDXML", {}, [element(name, { id: "1", ...expected })])), name).toEqual(bytes);
    }
  });

  it.each(["creator", "envelope"])("restores old ChemDraft Point3D from %s metadata after child objects", provenance => {
    const metadata = provenance === "creator" ? property(0x0003, [0, 0, ...ascii("ChemDraft")])
      : property(0x4344, ascii(JSON.stringify({ format: "org.chemdraft/cdx-envelope.v1", tags: [] })));
    const props = PROPS.filter(([, , kind]) => kind === "p3");
    const bytes = file(object(0x8001, 1, ...Object.entries(OBJECTS).map(([tag], index) =>
      object(Number(tag), index + 2, ...props.map(([tag]) => property(tag, [-2, 100, 40].flatMap(coord))),
        property(0x0200, [100, 40].flatMap(coord))))), metadata);
    const decoded = readCdx(bytes);
    const expected = Object.fromEntries(props.map(([, name]) => [name, "40 100 -2"]));
    for (const child of decoded.kids[0].kids) expect(child.attrs).toMatchObject({ ...expected, p: "40 100" });
    const rewritten = readCdx(writeCdx(decoded));
    expect(rewritten.attrs[CDX_POINT3D_ORDER_ATTRIBUTE]).toBe("|x|78797A");
    expect(rewritten.kids).toEqual(decoded.kids);
    expect(decoded.attrs[CDX_POINT3D_ORDER_ATTRIBUTE]).toBeUndefined(); // no input-tree mutation
  });

  it.each(["", "Independent CDX producer", "ChemDraft custom producer"])("does not infer legacy order for unrecognized provenance %j", creator => {
    const bytes = file(property(0x0003, [0, 0, ...ascii(creator)]), object(0x8021, 2, ...pointProperties()));
    expect(readCdx(bytes).kids[0].attrs).toEqual({ id: "2", ...pointAttributes });
  });

  describe.each(["creator", "envelope", "other producer"])("Point3D order marker with %s provenance", provenance => {
    const metadata = provenance === "envelope"
      ? property(0x4344, ascii(JSON.stringify({ format: "org.chemdraft/cdx-envelope.v1", tags: [] })))
      : property(0x0003, [0, 0, ...ascii(provenance === "creator" ? "ChemDraft" : "Independent CDX producer")]);

    it("uses x/y/z only for the exact UTF-8 xyz marker", () => {
      const warnings: CdxWarning[] = [];
      const decoded = readCdx(file(object(0x8021, 2, ...pointProperties()), metadata,
        property(0x4347, ascii("xyz"))), true, warnings);
      expect(decoded.kids[0].attrs).toEqual({ id: "2", ...pointAttributes });
      expect(decoded.attrs[CDX_POINT3D_ORDER_ATTRIBUTE]).toBe("|x|78797A");
      expect(warnings).toEqual([]);
    });

    it.each(["zyx", "XYZ", "xyz\0", ""])("warns and falls back to provenance for unexpected marker %j", marker => {
      const warnings: CdxWarning[] = [];
      const decoded = readCdx(file(object(0x8021, 2, ...pointProperties(provenance !== "other producer")),
        metadata, property(0x4347, ascii(marker))), true, warnings);
      const encoded = `|x|${Buffer.from(marker).toString("hex").toUpperCase()}`;
      expect(decoded.kids[0].attrs).toEqual({ id: "2", ...pointAttributes });
      expect(decoded.attrs[CDX_POINT3D_ORDER_ATTRIBUTE]).toBe(encoded);
      expect(warnings).toEqual([{
        code: "cdx.point3d_order_marker_unrecognized",
        message: expect.stringContaining(JSON.stringify(encoded))
      }]);
    });
  });
});

// One independently constructed binary property for every codec kind in the source tag table.
const samples: Record<string, { bytes: number[]; expected?: string; extra?: number[][] }> = {
  raw: { bytes: [1, 255], expected: "|x|01FF" }, str: { bytes: [0, 0, ...ascii("ChemDraft")], expected: "ChemDraft" },
  i16: { bytes: u16(-7), expected: "-7" }, i32: { bytes: u32(123), expected: "123" }, i8: { bytes: [254], expected: "-2" },
  u16: { bytes: u16(300), expected: "300" }, flag: { bytes: [], expected: "yes" }, bool: { bytes: [0], expected: "no" },
  represent: { bytes: [...u32(12), ...u16(0x0421)] },
  fonttable: { bytes: [...u16(1), ...u16(1), ...u16(3), ...u16(10000), ...u16(5), ...ascii("Arial")] },
  colortable: { bytes: [...u16(1), ...u16(65535), ...u16(0), ...u16(0)] },
  p2: { bytes: [...coord(20), ...coord(10)], expected: "10 20" },
  p3: { bytes: [...coord(10), ...coord(20), ...coord(30)], expected: "10 20 30" },
  rect: { bytes: [...coord(2), ...coord(1), ...coord(4), ...coord(3)], expected: "1 2 3 4" },
  alpha: { bytes: u16(65535), expected: "1" }, e16: { bytes: u16(1), expected: "Element" }, e8: { bytes: [1], expected: "Left" },
  elist: { bytes: [...u16(-2), ...u16(6), ...u16(7)], expected: "NOT 6 7" },
  charge: { bytes: [255], expected: "-1" }, ids: { bytes: [...u32(12), ...u32(13)], expected: "12 13" },
  attachments: { bytes: [...u16(2), ...u32(12), ...u32(13)], expected: "12 13" },
  plain: { bytes: ascii("Me"), expected: "Me" }, glist: { bytes: [1, 2, 3], expected: "|x|010203" },
  order: { bytes: u16(3), expected: "1 2" }, text: { bytes: styled("hello") }, utf8: { bytes: styled("→") },
  lh: { bytes: u16(1), expected: "auto" }, wrap: { bytes: u16(40), expected: "40" },
  linestarts: { bytes: [...u16(2), ...u16(0), ...u16(5)], expected: "0 5" }, hex: { bytes: [0, 255], expected: "00FF" },
  angle: { bytes: coord(-45), expected: "-45" }, spacing: { bytes: u16(120), expected: "12" }, coord: { bytes: coord(30), expected: "30" },
  labelstyle: { bytes: [3, 0, 1, 0, 200, 0, 3, 0] }, captionstyle: { bytes: [3, 0, 1, 0, 200, 0, 3, 0] },
  style: { bytes: u16(3), expected: "3" }, b8: { bytes: [3], expected: "HOH NH2COOH" }, b16: { bytes: u16(3), expected: "Dashed Bold" },
  deg10: { bytes: u16(450), expected: "45" }, curve: { bytes: [...u16(1), ...coord(20), ...coord(10)], expected: "10 20" },
  f64: { bytes: float(2.5), expected: "2.5" }, spectrum: { bytes: [...float(2), ...float(3)] },
  tagvalue: { bytes: float(2.5), expected: "2.5", extra: [property(0x0d00, u16(1))] },
  sgvalue: { bytes: float(2.5), expected: "2.5" }
};

describe("CDX property data types", () => {
  it("covers every kind in the copied tag table", () => {
    expect(Object.keys(samples).sort()).toEqual([...new Set(PROPS.map((p) => p[2]))].sort());
  });
  for (const [kind, sample] of Object.entries(samples)) {
    const [tag, name] = PROPS.find((p) => p[2] === kind)!;
    it(`reads ${kind} (${name || tag.toString(16)})`, () => {
      const warnings: CdxWarning[] = [];
      const tree = readCdx(file(...sample.extra ?? [], property(tag, sample.bytes)), true, warnings);
      expect(warnings).toEqual([]);
      if (sample.expected !== undefined) expect(tree.attrs[name]).toBe(sample.expected);
      else if (kind === "spectrum") expect(tree.text).toBe("2 3");
      else if (kind === "labelstyle" || kind === "captionstyle") expect(tree.attrs[kind === "labelstyle" ? "LabelSize" : "CaptionSize"]).toBe("10");
      else expect(tree.kids.length).toBeGreaterThan(0);
    });
    it(`writes ${kind} without losing its decoded value`, () => {
      let original = readCdx(file(...sample.extra ?? [], property(tag, sample.bytes)));
      if (kind === "spectrum") original = element("CDXML", {}, [element("spectrum", {}, [], original.text)]);
      const warnings: CdxWarning[] = [];
      const reopened = readCdx(writeCdx(original, warnings));
      if (kind === "utf8") expect(warnings).toMatchObject([{ code: "cdx.text_encoding_loss", message: expect.stringContaining("→") }]);
      else expect(warnings).toEqual([]);
      expect(reopened.attrs).toMatchObject(original.attrs);
      expect(reopened.text).toBe(original.text);
      expect(reopened.kids).toEqual(original.kids);
    });
  }

  it("reads fractional charge and alternate angle/line-height widths", () => {
    const tree = readCdx(file(property(0x0421, u32(-1.5 * 2 ** 24)), property(0x0803, u16(-450)), property(0x0702, coord(12))));
    expect(tree.attrs).toMatchObject({ Charge: "-1.5", ChainAngle: "-45", LineHeight: "12" });
  });

  it("warns once for every skipped malformed property", () => {
    const warnings: CdxWarning[] = [];
    const tree = readCdx(file(object(0x8004, 12, property(0x0200, [1, 2, 3]), property(0x0421, [1, 2, 3])), property(0x0300, [9, 0, 1])), true, warnings);
    expect(tree.kids[0].attrs.p).toBeUndefined();
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.code === "cdx.property_skipped")).toBe(true);
    expect(warnings.find((w) => w.message.includes("0x0200"))?.message).toContain("object 12");
  });

  it("warns when a tag value does not match its declared type", () => {
    const warnings: CdxWarning[] = [];
    const result = readCdx(file(property(0x0d00, u16(1)), property(0x0d05, [1, 2, 3])), true, warnings);
    expect(result.attrs.Value).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("0x0d05");
  });

  it("warns for unknown/unencodable XML data rather than silently dropping it", () => {
    const warnings: CdxWarning[] = [];
    writeCdx(element("CDXML", { FutureAttribute: "x", BondLength: "40000", Element: "70000", Order: "bad" }, [element("future")]), warnings);
    for (const name of ["FutureAttribute", "BondLength", "Element", "Order", "future"]) expect(warnings.some((w) => w.message.includes(name))).toBe(true);
  });

  it("does not retain the source codec's embedded-drawing property", () => {
    const warnings: CdxWarning[] = [];
    const decoded = readCdx(file(property(0x4f43, ascii("old embedded data"))), true, warnings);
    expect(decoded.attrs.attrib4f43).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("0x4f43");
  });
});

describe("CDX text charsets", () => {
  const fontTable = (charset: number) => property(0x0100, [...u16(1), ...u16(1), ...u16(3), ...u16(charset), ...u16(5), ...ascii("Arial")]);
  const run = (bytes: number[], font = 3) => [1, 0, ...[0, font, 0, 240, 3].flatMap(u16), ...bytes];
  const legacyOnly = (bytes: Uint8Array) => {
    // These fixtures have one short text property. Rename only UTF-8's property tag to unknown.
    const copy = bytes.slice(), view = new DataView(copy.buffer);
    let offset = 22;
    while (offset < copy.length) {
      const tag = view.getUint16(offset, true); offset += 2;
      if (!tag) continue;
      if (tag & 0x8000) { offset += 4; continue; }
      if (tag === 0x0709) view.setUint16(offset - 2, 0x4567, true);
      const size = view.getUint16(offset, true); offset += 2 + size;
    }
    return copy;
  };

  it("reads zero-style Latin-1 independently of a declared Mac Roman default font", () => {
    const root = readCdx(file(fontTable(10000), property(0x081a, u16(3)),
      property(0x0008, [0, 0, 99, 97, 102, 233]), object(0x8006, 1, property(0x0700, [0, 0, 99, 97, 102, 233]))));
    expect(root.attrs.Name).toBe("café");
    expect(root.kids.find((x) => x.name === "t")?.kids[0].text).toBe("café");
    expect(writeCdx(element("CDXML", { Name: "café" }))).toEqual(file(property(0x0008, [0, 0, 99, 97, 102, 233])));
  });

  it.each([[1252, 233], [10000, 142]])("uses charset %s for declared and default-font runs", (charset, lastByte) => {
    for (const font of [3, 0xffff]) {
      const root = readCdx(file(fontTable(charset), property(0x081a, u16(3)),
        object(0x8006, 1, property(0x0700, run([99, 97, 102, lastByte], font)))));
      expect(root.kids.find((x) => x.name === "t")?.kids[0].text).toBe("café");
    }
    for (const explicitFont of [true, false]) {
      const warnings: CdxWarning[] = [];
      const bytes = writeCdx(element("CDXML", { CaptionFont: "3" }, [
        element("fonttable", {}, [element("font", { id: "3", charset: charset === 1252 ? "iso-8859-1" : "x-mac-roman", name: "Arial" })]),
        element("t", {}, [element("s", explicitFont ? { font: "3" } : {}, [], "café")])
      ]), warnings);
      expect(warnings).toEqual([]);
      const legacy = readCdx(legacyOnly(bytes));
      expect(legacy.kids.find((x) => x.name === "t")?.kids[0].text).toBe("café");
      expect(Buffer.from(bytes).includes(Buffer.from([99, 97, 102, lastByte]))).toBe(true);
    }
  });

  it("does not guess UTF-8 for Mac Roman bytes that happen to form valid UTF-8", () => {
    const root = readCdx(file(property(0x0008, run([0xc3, 0xa9]))));
    expect(root.attrs.Name).toBe("√©");
    expect(readCdx(writeCdx(element("CDXML", { Name: "√©" }))).attrs.Name).toBe("√©");
  });

  const additionalCharsets: [number, string, string, number[]][] = [
    [1251, "windows-1251", "Я", [0xdf]],
    [932, "shift_jis", "日本", [0x93, 0xfa, 0x96, 0x7b]],
    [1200, "iso-10646", "café", [99, 0, 97, 0, 102, 0, 233, 0]],
    [65001, "utf-8", "α", [0xce, 0xb1]]
  ];
  it.each(additionalCharsets)("encodes charset %s with its specified bytes", (_code, charset, text, expectedBytes) => {
    const warnings: CdxWarning[] = [];
    const bytes = writeCdx(element("CDXML", {}, [
      element("fonttable", {}, [element("font", { id: "3", charset, name: "Arial" })]),
      element("t", {}, [element("s", { font: "3" }, [], text)])
    ]), warnings);
    expect(warnings).toEqual([]);
    expect(Buffer.from(bytes).includes(Buffer.from(property(0x0700, [1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, ...expectedBytes])))).toBe(true);
    expect(readCdx(legacyOnly(bytes)).kids.find((x) => x.name === "t")?.kids[0].text).toBe(text);
  });

  it("warns specifically when a legacy copy cannot represent a character", () => {
    const warnings: CdxWarning[] = [];
    const bytes = writeCdx(element("CDXML", {}, [element("fonttable", {}, [element("font", { id: "3", charset: "iso-8859-1", name: "Arial" })]),
      element("t", {}, [element("s", { font: "3" }, [], "café →")])]), warnings);
    expect(warnings).toMatchObject([{ code: "cdx.text_encoding_loss", message: expect.stringContaining('"→" cannot be represented in charset 1252') }]);
    expect(readCdx(bytes).kids.find((x) => x.name === "t")?.kids[0].text).toBe("café →");
    expect(readCdx(legacyOnly(bytes)).kids.find((x) => x.name === "t")?.kids[0].text).toBe("café ?");
  });

  it("warns for unsupported charsets and invalid UTF-8 without guessing another encoding", () => {
    const warnings: CdxWarning[] = [];
    readCdx(file(fontTable(10033), object(0x8006, 1, property(0x0700, run([0xff]))),
      object(0x8006, 2, property(0x0709, [0, 0, 0xff]))), true, warnings);
    expect(warnings).toMatchObject([
      { code: "cdx.text_encoding_loss", message: expect.stringContaining("unsupported charset 10033") },
      { code: "cdx.text_encoding_loss", message: expect.stringContaining("unsupported charset 10033") },
      { code: "cdx.text_encoding_loss", message: expect.stringContaining("invalid bytes for charset 65001") }
    ]);
  });
});

describe("hostile CDX", () => {
  const repeatedProperties = (count: number, tag: number) => {
    const bytes = new Uint8Array(30 + 4 * count);
    bytes.set(header); bytes.set([...u16(0x8000), ...u32(0)], 22);
    const view = new DataView(bytes.buffer);
    for (let k = 0; k < count; k++) view.setUint16(28 + 4 * k, tag, true);
    return bytes;
  };
  const refuse = (bytes: Uint8Array, message: string) => {
    expect(() => readCdx(bytes)).toThrow(message);
    const opened = importCdx(bytes);
    expect(opened.document).toBeUndefined();
    expect(opened.warnings.at(-1)).toMatchObject({ code: "cdx.invalid_binary", message: expect.stringContaining(message) });
  };
  it("rejects bad magic", () => refuse(new Uint8Array([...ascii("VjCD0101"), ...Array(24).fill(0)]), "invalid magic; expected VjCD0100"));
  it("rejects a truncated header", () => refuse(new Uint8Array(ascii(MAGIC)), "truncated header or document object"));
  it("rejects an invalid byte-order marker", () => { const b = file(); b[8] = 9; refuse(b, "invalid byte-order marker"); });
  it("rejects an invalid root tag", () => { const b = file(); b[22] = 1; refuse(b, "invalid document object tag 0x8001"); });
  it("rejects a truncated object terminator", () => refuse(file(object(0x8004, 12)).subarray(0, 35), "object 12: truncated tag runs 1 bytes past the end of the file"));
  it("names the property, object and exact length overrun", () => {
    const bytes = file(object(0x8005, 12, property(0x0600, [1, 0]))).slice(0, -4);
    new DataView(bytes.buffer).setUint16(36, 5, true);
    refuse(bytes, "property 0x0600 in object 12 runs 3 bytes past the end of the file");
  });
  it("rejects extended lengths past EOF", () => {
    refuse(new Uint8Array([...header, ...u16(0x8000), ...u32(0), ...u16(0x0600), 255, 255, ...u32(0xffffffff)]), "property 0x0600 in object 0 runs 4294967295 bytes past the end of the file");
  });
  it("rejects nesting past 64", () => {
    let deep: number[] = [];
    for (let k = 0; k < 65; k++) deep = object(0x8002, k + 1, deep);
    refuse(file(deep), "object nesting exceeds 64 levels");
  });
  it("rejects more than one million objects", () => {
    const bytes = new Uint8Array(30 + 8 * 1_000_000);
    bytes.set(header); bytes.set([...u16(0x8000), ...u32(0)], 22);
    for (let k = 0; k < 1_000_000; k++) { bytes[28 + 8 * k] = 4; bytes[29 + 8 * k] = 128; }
    refuse(bytes, "object count exceeds 1000000");
  }, 30_000);
  it("rejects files over 64 MB before parsing", () => refuse(new Uint8Array(64 * 1024 * 1024 + 1), "file exceeds the 64 MB size limit"));
  it("bounds retained malformed-property diagnostics and counts omitted warnings", () => {
    const warnings: CdxWarning[] = [];
    readCdx(repeatedProperties(50_000, 0x0200), true, warnings);
    expect(warnings).toHaveLength(1001);
    expect(warnings.slice(0, 1000).every((w) => w.code === "cdx.property_skipped")).toBe(true);
    expect(warnings.at(-1)).toEqual({ code: "cdx.warnings_truncated", message: "CDX: 49000 additional warnings omitted after the 1000-warning limit" });
    readCdx(repeatedProperties(5, 0x0200), true, warnings);
    expect(warnings).toHaveLength(1001);
    expect(warnings.at(-1)?.message).toContain("49005 additional warnings omitted");
  });
  it("rejects duplicate root native-envelope properties", () => {
    refuse(file(property(0x4344, [1]), property(0x4344, [2])), "duplicate native envelope property");
  });
  it("caps total properties, including valid zero-length flags", () => {
    refuse(repeatedProperties(1_000_001, 0x000f), "property count exceeds 1000000");
  });
  it("safely rejects or reads arbitrary truncations and byte mutations", () => {
    const good = file(object(0x8004, 12, property(0x0200, [...coord(1), ...coord(2)])));
    for (let k = 0; k < good.length; k++) {
      const bytes = good.slice(); bytes[k] ^= 255;
      for (const candidate of [bytes, good.subarray(0, k)]) {
        try { readCdx(candidate); } catch (error) { expect((error as Error).message).toMatch(/^CDX import failed:/); }
      }
    }
  });
});
