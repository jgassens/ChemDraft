import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CHEMDRAFT_PNG_SELECTION_KEYWORD, pngWithChemDraftSelection, recoverPasteBackFromClipboard, recoverPasteBackStructures,
  trimZipPadding, type ClipboardReadPayload,
} from "./index";

// A minimal ZIP writer (stored or deflated, no descriptors), as Office writes GVML.
function makeZip(entries: { name: string; data: Uint8Array | string; deflate?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const name = Buffer.from(entry.name);
    const body = entry.deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    records.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "latin1");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A 2×2 gray PNG: what Office's re-encoded rendition looks like to the reader (no carrier). */
function plainPng(gray = 0x80): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const pixels = deflateSync(Buffer.from([0, gray, gray, 0, gray, gray]));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header), pngChunk("IDAT", pixels), pngChunk("IEND", new Uint8Array())]));
}

function selection(label: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [], selectionIds: [], label,
    bounds: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 }, ...extra });
}
const carrier = (json: string) => pngWithChemDraftSelection(plainPng(), json);

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const GVML = "Art::GVML ClipFormat";
const MAC_GVML = "com.microsoft.Art--GVML-ClipFormat";

function rels(entries: [id: string, type: string, target: string][]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${entries.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
}

/** The GVML layout Office writes: root rels → clipboard/drawings/drawing1.xml → ../media/imageN.png. */
function gvml(media: Uint8Array[], extra: { name: string; data: Uint8Array | string }[] = []): Uint8Array {
  return makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "clipboard/drawings/drawing1.xml"]]) },
    { name: "clipboard/drawings/drawing1.xml", data: `<a:graphic xmlns:a="${A}"/>`, deflate: true },
    { name: "clipboard/drawings/_rels/drawing1.xml.rels",
      data: rels(media.map((_, index) => [`rId${index + 1}`, "image", `../media/image${index + 1}.png`])) },
    ...media.map((data, index) => ({ name: `clipboard/media/image${index + 1}.png`, data })),
    { name: "clipboard/theme/theme1.xml", data: "<a:theme/>", deflate: true },
    ...extra,
  ]);
}

/**
 * A GVML archive whose drawing lists its pictures explicitly, as Office writes it: `pictures` holds
 * each picture's `r:embed`, in drawing order; `targets` maps relationship IDs to `clipboard/media/`
 * parts; `media` holds the PNG parts by name.
 */
function gvmlDrawing(
  pictures: string[], targets: [id: string, name: string][], media: [name: string, data: Uint8Array][],
  /** Each picture's place, `[x, y, cx, cy]` in EMUs; a picture without one has an empty `a:spPr`. */
  boxes: ([x: number, y: number, cx: number, cy: number] | undefined)[] = [],
): Uint8Array {
  const LC = "http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas";
  const spPr = (box: [number, number, number, number] | undefined) => box
    ? `<a:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm></a:spPr>` : "<a:spPr/>";
  const pics = pictures.map((id, index) => `<a:pic><a:nvPicPr><a:cNvPr id="${index + 2}" name="Picture ${index + 1}"/><a:cNvPicPr/></a:nvPicPr>` +
    `<a:blipFill><a:blip r:embed="${id}"/></a:blipFill>${spPr(boxes[index])}</a:pic>`).join("");
  return makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "clipboard/drawings/drawing1.xml"]]) },
    { name: "clipboard/drawings/drawing1.xml", deflate: true, data: `<a:graphic xmlns:a="${A}" xmlns:r="${R}">` +
      `<a:graphicData uri="${LC}"><lc:lockedCanvas xmlns:lc="${LC}">${pics}</lc:lockedCanvas></a:graphicData></a:graphic>` },
    { name: "clipboard/drawings/_rels/drawing1.xml.rels", data: rels(targets.map(([id, name]) => [id, "image", `../media/${name}`])) },
    ...media.map(([name, data]) => ({ name: `clipboard/media/${name}`, data })),
  ]);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function officeRead(archive: Uint8Array | undefined, png?: Uint8Array, format = GVML): ClipboardReadPayload {
  return {
    types: [...archive ? [format] : [], ...png ? ["PNG"] : [], "image/emf"],
    textItems: [],
    ...archive ? { officeItems: [{ type: format, bytesBase64: base64(archive) }] } : {},
    ...png ? { imageItems: [{ type: "image/png" as const, bytesBase64: base64(png) }] } : {},
  };
}

/** Flip one byte inside the carrier's JSON so its CRC no longer matches. */
function damaged(png: Uint8Array): Uint8Array {
  const copy = png.slice();
  const at = Buffer.from(copy).indexOf(Buffer.from('"chemdraft-selection"'));
  copy[at + 2] ^= 0x20;
  return copy;
}

describe("recoverPasteBackStructures: the Office picture archive", () => {
  it.each([GVML, MAC_GVML])("recovers the carrier from %s even when the PNG rendition was re-encoded", async (format) => {
    const result = await recoverPasteBackStructures([
      { type: format, bytes: gvml([carrier(selection("A"))]) },
      { type: "PNG", bytes: plainPng() },
    ]);
    expect(result).toMatchObject({ kind: "found", refusals: [], notes: [] });
    if (result.kind !== "found") return;
    expect(result.structures).toEqual([{ source: "office-archive", format, mediaPart: "clipboard/media/image1.png",
      json: selection("A"), document: JSON.parse(selection("A")) }]);
  });

  it("returns every carrier in drawing order and skips pictures without one", async () => {
    const result = await recoverPasteBackStructures([{ type: GVML, bytes: gvml([carrier(selection("A")), plainPng(), carrier(selection("B"))]) }]);
    expect(result.kind === "found" && result.structures.map((structure) => structure.document.label)).toEqual(["A", "B"]);
  });

  it("returns one structure per picture when two pictures share one media part", async () => {
    // PowerPoint stores a picture pasted twice once; both pictures point at the same part.
    const shared = await recoverPasteBackStructures([{ type: GVML,
      bytes: gvmlDrawing(["rId1", "rId1"], [["rId1", "image1.png"]], [["image1.png", carrier(selection("A"))]]) }]);
    expect(shared.kind === "found" && shared.structures.map((structure) => [structure.document.label, structure.mediaPart]))
      .toEqual([["A", "clipboard/media/image1.png"], ["A", "clipboard/media/image1.png"]]);
    // Two relationships to one part are two pictures as well.
    const aliased = await recoverPasteBackStructures([{ type: GVML, bytes: gvmlDrawing(["rId1", "rId2"],
      [["rId1", "image1.png"], ["rId2", "image1.png"]], [["image1.png", carrier(selection("A"))]]) }]);
    expect(aliased.kind === "found" && aliased.structures.map((structure) => structure.document.label)).toEqual(["A", "A"]);
  });

  it("follows the drawing's picture order, not the relationships file's", async () => {
    const result = await recoverPasteBackStructures([{ type: GVML,
      bytes: gvmlDrawing(["rId2", "rId1"], [["rId1", "image1.png"], ["rId2", "image2.png"]],
        [["image1.png", carrier(selection("A"))], ["image2.png", carrier(selection("B"))]]) }]);
    expect(result.kind === "found" && result.structures.map((structure) => structure.document.label)).toEqual(["B", "A"]);
  });

  it("orders placed pictures left to right, then top to bottom, not by stacking order", async () => {
    const labelsOf = async (pictures: [label: string, box?: [number, number, number, number]][]) => {
      const result = await recoverPasteBackStructures([{ type: GVML, bytes: gvmlDrawing(
        pictures.map((_, index) => `rId${index + 1}`),
        pictures.map((_, index) => [`rId${index + 1}`, `image${index + 1}.png`]),
        pictures.map(([label], index) => [`image${index + 1}.png`, carrier(selection(label))]),
        pictures.map(([, box]) => box)) }]);
      return result.kind === "found" ? result.structures.map((structure) => structure.document.label) : result;
    };
    // Two pictures added right one first: the left one is stacked on top, so it comes last in the drawing.
    expect(await labelsOf([["right", [5000, 0, 1000, 1000]], ["left", [0, 0, 1000, 1000]]])).toEqual(["left", "right"]);
    // A 2 × 2 grid stacked in reverse; the second row starts lower than the first row ends.
    expect(await labelsOf([
      ["D", [4000, 3000, 2000, 2000]], ["C", [0, 3000, 2000, 2000]], ["B", [4000, 0, 2000, 2000]], ["A", [0, 0, 2000, 2000]],
    ])).toEqual(["A", "B", "C", "D"]);
    // Centers within half the smaller height share a row and read left to right, even when the left one sits a little lower ...
    expect(await labelsOf([["right", [3000, 0, 1000, 1000]], ["left", [0, 400, 1000, 1000]]])).toEqual(["left", "right"]);
    // ... while a small vertical overlap puts the higher picture first, even when it is to the right.
    expect(await labelsOf([["lower", [0, 800, 1000, 1000]], ["higher", [3000, 0, 1000, 1000]]])).toEqual(["higher", "lower"]);
    // A picture without a place follows the placed ones.
    expect(await labelsOf([["unplaced"], ["right", [5000, 0, 1000, 1000]], ["left", [0, 0, 1000, 1000]]]))
      .toEqual(["left", "right", "unplaced"]);
  });

  it("counts every occurrence of a shared picture against the picture and size limits", async () => {
    const archive = gvmlDrawing(["rId1", "rId1", "rId1"], [["rId1", "image1.png"]], [["image1.png", carrier(selection("A"))]]);
    const capped = await recoverPasteBackStructures([{ type: GVML, bytes: archive }], { limits: { maxPictures: 2 } });
    expect(capped).toMatchObject({ kind: "found", notes: ["Only the first 2 of 3 copied pictures were checked for ChemDraft data."] });
    expect(capped.kind === "found" && capped.structures).toHaveLength(2);
    const bytes = new TextEncoder().encode(selection("A")).length;
    const budget = await recoverPasteBackStructures([{ type: GVML, bytes: archive }], { limits: { maxTotalCarrierJsonBytes: 2 * bytes } });
    expect(budget).toMatchObject({ kind: "found", refusals: [{ reason: "too-large", mediaPart: "clipboard/media/image1.png" }] });
    expect(budget.kind === "found" && budget.structures).toHaveLength(2);
  });

  it("reads an archive with Windows allocation padding after its end record", async () => {
    const archive = gvml([carrier(selection("A"))]);
    const padded = new Uint8Array(archive.length + 13);
    padded.set(archive);
    expect(trimZipPadding(padded, 4096)).toEqual(archive);
    expect((await recoverPasteBackStructures([{ type: GVML, bytes: padded }])).kind).toBe("found");
  });

  it("falls back to every PNG part when the archive lacks the usual relationships", async () => {
    const archive = makeZip([{ name: "media/z.png", data: plainPng() }, { name: "media/a.png", data: carrier(selection("A")) }]);
    const result = await recoverPasteBackStructures([{ type: GVML, bytes: archive }]);
    expect(result.kind === "found" && result.structures.map((structure) => structure.mediaPart)).toEqual(["media/a.png"]);
  });
});

describe("recoverPasteBackStructures: pictures without ChemDraft data", () => {
  it("says there is no carrier for a plain Office picture, so it pastes as a picture", async () => {
    const result = await recoverPasteBackStructures([{ type: GVML, bytes: gvml([plainPng()]) }, { type: "PNG", bytes: plainPng() }]);
    expect(result).toEqual({ kind: "none", reason: "no-carrier", message: "The copied picture has no ChemDraft data.", notes: [] });
  });

  it("reads ChemDraft's own carrier PNG when there is no archive", async () => {
    const result = await recoverPasteBackStructures([{ type: "image/png", bytes: carrier(selection("P")) }]);
    expect(result.kind === "found" && result.structures[0]).toMatchObject({ source: "png", format: "image/png", json: selection("P") });
  });

  it("skips EMF and says so", async () => {
    const result = await recoverPasteBackStructures([], { advertisedTypes: ["image/emf"] });
    expect(result).toMatchObject({ kind: "none", reason: "no-pictures" });
    expect(result.notes).toEqual(["The image/emf picture was not checked: ChemDraft cannot read ChemDraft data from EMF pictures."]);
  });
});

describe("recoverPasteBackStructures: malformed and oversized input", () => {
  it.each([
    ["not a ZIP", new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), "Missing or truncated ZIP central directory"],
    ["a crafted entry name", gvml([carrier(selection("A"))], [{ name: "../evil.png", data: carrier(selection("E")) }]), "contains a '.' or '..' segment"],
    ["damaged relationships", makeZip([{ name: "_rels/.rels", data: "<Relationships" }]), "relationships are damaged"],
  ])("refuses %s without reading it, and still reads the PNG", async (_label, archive, detail) => {
    const unreadable = await recoverPasteBackStructures([{ type: GVML, bytes: archive }, { type: "PNG", bytes: plainPng() }]);
    expect(unreadable).toMatchObject({ kind: "none", reason: "archive-unreadable" });
    expect(unreadable.kind === "none" && unreadable.message).toContain(detail);
    const withCarrier = await recoverPasteBackStructures([{ type: GVML, bytes: archive }, { type: "PNG", bytes: carrier(selection("P")) }]);
    expect(withCarrier.kind === "found" && withCarrier.structures[0]!.source).toBe("png");
  });

  it("refuses an archive over its limit before reading it", async () => {
    const archive = gvml([carrier(selection("A"))]);
    const result = await recoverPasteBackStructures([{ type: GVML, bytes: archive }],
      { limits: { maxArchiveBytes: 100, maxArchivePaddingBytes: 0 } });
    expect(result).toMatchObject({ kind: "none", reason: "archive-unreadable" });
    expect(result.kind === "none" && result.message).toContain("larger than the");
    const parts = await recoverPasteBackStructures([{ type: GVML, bytes: archive }], { limits: { maxEntries: 3 } });
    expect(parts.kind === "none" && parts.message).toContain("exceeds 3 entries");
  });

  it("pastes nothing for a damaged, unknown-version or oversized carrier, and says why", async () => {
    const crc = await recoverPasteBackStructures([{ type: GVML, bytes: gvml([damaged(carrier(selection("A")))]) }]);
    expect(crc).toMatchObject({ kind: "refused", refusals: [{ reason: "malformed", mediaPart: "clipboard/media/image1.png" }] });
    expect(crc.kind === "refused" && crc.message).toBe("The copied structure has damaged ChemDraft data: PNG iTXt CRC mismatch.");
    const newer = await recoverPasteBackStructures([{ type: GVML, bytes: gvml([carrier(selection("A", { version: 7 }))]) }]);
    expect(newer.kind === "refused" && newer.message).toBe("The copied structure was made by a newer or unknown ChemDraft (data version 7).");
    const large = await recoverPasteBackStructures([{ type: "PNG", bytes: carrier(selection("A")) }], { limits: { maxCarrierJsonBytes: 10 } });
    expect(large).toMatchObject({ kind: "refused", refusals: [{ reason: "too-large", source: "png" }] });
  });

  it("caps the pictures it checks", async () => {
    const result = await recoverPasteBackStructures([{ type: GVML, bytes: gvml([plainPng(), carrier(selection("B"))]) }],
      { limits: { maxPictures: 1 } });
    expect(result).toMatchObject({ kind: "none", reason: "no-carrier",
      notes: ["Only the first 1 of 2 copied pictures were checked for ChemDraft data."] });
  });
});

describe("recoverPasteBackFromClipboard", () => {
  it("decodes the native read's archive and PNG", async () => {
    const result = await recoverPasteBackFromClipboard(officeRead(gvml([carrier(selection("A"))]), plainPng(), MAC_GVML));
    expect(result.kind === "found" && result.structures[0]).toMatchObject({ source: "office-archive", format: MAC_GVML });
    expect(await recoverPasteBackFromClipboard(officeRead(undefined, plainPng()))).toMatchObject({ kind: "none", reason: "no-carrier" });
  });

  it("leaves the clipboard to ChemDraft's own selection when that flavor is present", async () => {
    const read = officeRead(gvml([carrier(selection("A"))]), carrier(selection("P")));
    for (const withNative of [
      { ...read, types: [CHEMDRAFT_PNG_SELECTION_KEYWORD, ...read.types] },
      { ...read, textItems: [{ type: CHEMDRAFT_PNG_SELECTION_KEYWORD, text: selection("N") }] },
    ]) {
      expect(await recoverPasteBackFromClipboard(withNative)).toMatchObject({ kind: "none", reason: "native-data" });
    }
  });

  it("refuses an archive whose base64 exceeds the cap without decoding it", async () => {
    const read = officeRead(gvml([carrier(selection("A"))]), plainPng());
    const result = await recoverPasteBackFromClipboard(read, { limits: { maxArchiveBytes: 64, maxArchivePaddingBytes: 0 } });
    expect(result).toMatchObject({ kind: "none", reason: "archive-unreadable" });
    expect(result.kind === "none" && result.message).toContain("exceeds the 64-byte limit");
  });
});

describe("paste-back of a copied ChemDraft OLE object (Windows)", () => {
  const STABLE = "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}";
  const DEV = "{8D23DEDA-8B23-4D62-BEEC-6C6168D48BB4}";
  const EQUATION = "{0002CE02-0000-0000-C000-000000000046}";
  const text = (json: string) => new TextEncoder().encode(json);
  const object = (json: string, clsid: string | null = STABLE, type = "Embedded Object") =>
    ({ type, bytes: text(json), ...clsid === null ? {} : { clsid } });

  it("prefers a ChemDraft object over the picture archive and the PNG, and reads neither", async () => {
    const result = await recoverPasteBackStructures([
      { type: "PNG", bytes: carrier(selection("P")) },
      { type: GVML, bytes: new Uint8Array([1, 2, 3]) }, // an unreadable archive would leave a note
      object(selection("O")),
    ]);
    expect(result).toEqual({ kind: "found", refusals: [], notes: [], structures: [
      { source: "embedded-object", format: "Embedded Object", json: selection("O"), document: JSON.parse(selection("O")) },
    ] });
  });

  it.each([
    ["the dev build's class", DEV, "Embed Source"],
    ["a class in lower case without braces", STABLE.slice(1, -1).toLowerCase(), "Embedded Object"],
  ])("reads %s", async (_, clsid, type) => {
    const result = await recoverPasteBackStructures([object(selection("O"), clsid, type), { type: GVML, bytes: gvml([carrier(selection("A"))]) }]);
    expect(result.kind === "found" && result.structures.map((structure) => [structure.source, structure.format])).toEqual([["embedded-object", type]]);
  });

  it.each([
    ["another program's object", EQUATION],
    ["an object without a class", null],
    ["the nil class", "{00000000-0000-0000-0000-000000000000}"],
  ])("ignores %s and falls through to the archive, then the PNG", async (_, clsid) => {
    const archive = await recoverPasteBackStructures([object(selection("O"), clsid), { type: GVML, bytes: gvml([carrier(selection("A"))]) },
      { type: "PNG", bytes: carrier(selection("P")) }]);
    expect(archive.kind === "found" && archive.structures.map((structure) => [structure.source, structure.document.label])).toEqual([["office-archive", "A"]]);
    const png = await recoverPasteBackStructures([object(selection("O"), clsid), { type: "PNG", bytes: carrier(selection("P")) }]);
    expect(png.kind === "found" && png.structures.map((structure) => [structure.source, structure.document.label])).toEqual([["png", "P"]]);
    expect(await recoverPasteBackStructures([object("not even JSON", clsid)])).toMatchObject({ kind: "none", reason: "no-pictures" });
  });

  it("refuses a ChemDraft object with damaged, unknown-version or oversized data, with the carrier's words", async () => {
    const damagedJson = await recoverPasteBackStructures([object("{\"kind\":")]);
    expect(damagedJson).toMatchObject({ kind: "refused", refusals: [{ source: "embedded-object", format: "Embedded Object", reason: "malformed" }] });
    expect(damagedJson.kind === "refused" && damagedJson.message).toBe("The copied structure has damaged ChemDraft data: it is not valid JSON.");
    const notUtf8 = await recoverPasteBackStructures([{ type: "Embedded Object", clsid: STABLE, bytes: new Uint8Array([0xff, 0xfe]) }]);
    expect(notUtf8.kind === "refused" && notUtf8.message).toBe("The copied structure has damaged ChemDraft data: the object's drawing is not UTF-8 text");
    const newer = await recoverPasteBackStructures([object(selection("O", { version: 2 }))]);
    expect(newer.kind === "refused" && newer.message).toBe("The copied structure was made by a newer or unknown ChemDraft (data version 2).");
    const large = await recoverPasteBackStructures([object(selection("O"))], { limits: { maxCarrierJsonBytes: 10 } });
    expect(large).toMatchObject({ kind: "refused", refusals: [{ reason: "too-large", source: "embedded-object" }] });
    // An unusable object does not hide a good carrier in the same copy; the refusal is still reported.
    const fallback = await recoverPasteBackStructures([object(selection("O", { version: 2 })), { type: GVML, bytes: gvml([carrier(selection("A"))]) }]);
    expect(fallback).toMatchObject({ kind: "found", refusals: [{ source: "embedded-object", reason: "unknown-version" }],
      structures: [{ source: "office-archive" }] });
  });

  it("decodes the native read's object, which only a ChemDraft class may supply", async () => {
    const read = (clsid: string | undefined): ClipboardReadPayload => ({
      types: ["Object Descriptor", "Embedded Object", GVML, "PNG", "image/emf"], textItems: [],
      officeItems: [{ type: "Embedded Object", bytesBase64: base64(text(selection("O"))), ...clsid === undefined ? {} : { clsid } }],
      imageItems: [{ type: "image/png", bytesBase64: base64(carrier(selection("P"))) }],
    });
    const found = await recoverPasteBackFromClipboard(read(STABLE));
    expect(found.kind === "found" && found.structures).toEqual([
      { source: "embedded-object", format: "Embedded Object", json: selection("O"), document: JSON.parse(selection("O")) },
    ]);
    for (const clsid of [EQUATION, undefined]) {
      const other = await recoverPasteBackFromClipboard(read(clsid));
      expect(other.kind === "found" && other.structures.map((structure) => structure.source)).toEqual(["png"]);
    }
    const native = await recoverPasteBackFromClipboard({ ...read(STABLE), types: [CHEMDRAFT_PNG_SELECTION_KEYWORD, ...read(STABLE).types] });
    expect(native).toMatchObject({ kind: "none", reason: "native-data" });
    const broken = await recoverPasteBackFromClipboard({ ...read(STABLE), officeItems: [{ type: "Embedded Object", clsid: STABLE, bytesBase64: "*" }] });
    expect(broken).toMatchObject({ kind: "found", refusals: [{ source: "embedded-object", reason: "malformed" }], structures: [{ source: "png" }] });
  });

  it("decodes the native GVML fallback only when the OLE drawing is refused", async () => {
    const bytesBase64 = base64(gvml([carrier(selection("A"))]));
    let archiveReads = 0;
    const read = (version: number): ClipboardReadPayload => ({
      types: ["Embedded Object", GVML, "image/png"],
      textItems: [],
      officeItems: [
        { type: "Embedded Object", clsid: STABLE, bytesBase64: base64(text(selection("O", { version }))) },
        { type: GVML, get bytesBase64() { archiveReads++; return bytesBase64; } },
      ],
      imageItems: [{ type: "image/png", bytesBase64: base64(plainPng()) }],
    });
    expect(await recoverPasteBackFromClipboard(read(1))).toMatchObject({
      kind: "found", structures: [{ source: "embedded-object", document: { label: "O" } }],
      refusals: [], notes: [],
    });
    expect(archiveReads).toBe(0);

    expect(await recoverPasteBackFromClipboard(read(2))).toMatchObject({
      kind: "found", structures: [{ source: "office-archive", document: { label: "A" } }],
      refusals: [{ source: "embedded-object", reason: "unknown-version" }],
    });
    expect(archiveReads).toBe(1);
  });
});
