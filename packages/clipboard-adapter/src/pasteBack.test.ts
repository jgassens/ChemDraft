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
