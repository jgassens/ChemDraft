import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";
import { CHEMDRAFT_PNG_SELECTION_KEYWORD, importOfficeStructures, OfficeImportError, pngWithChemDraftSelection,
  readChemDraftSelectionFromPng, type OfficeImportResult } from "./index";
import { docxDrawingReferences, inReadingOrder, pptxSlideDrawingReferences, resolvePartTarget, type DrawingBox } from "./officePackage";
import { readChemDraftOleObject } from "./oleObject";
import { writeTestCompoundFile } from "./oleObject.testUtils";

// The real reader, counted, so a test can check that a shared object part is parsed once.
vi.mock("./oleObject", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oleObject")>();
  return { ...actual, readChemDraftOleObject: vi.fn(actual.readChemDraftOleObject) };
});
vi.mock("./pngSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pngSelection")>();
  return { ...actual, readChemDraftSelectionFromPng: vi.fn(actual.readChemDraftSelectionFromPng) };
});

// A minimal ZIP writer (stored or deflated, no descriptors): enough for real Office packages.
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

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
const V = "urn:schemas-microsoft-com:vml";

const plainPng = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><path d="M1 1L11 7" stroke="black"/></svg>').render().asPng());

function selection(label: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [], selectionIds: [], label,
    bounds: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 }, ...extra });
}
const carrier = (json: string) => pngWithChemDraftSelection(plainPng, json);

function compressedCarrier(json: string): Uint8Array {
  const body = Buffer.concat([Buffer.from(`iTXt${CHEMDRAFT_PNG_SELECTION_KEYWORD}\0\x01\0\0\0`), deflateSync(json)]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length - 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([plainPng.subarray(0, -12), size, body, checksum, plainPng.subarray(-12)]);
}

function rels(entries: [id: string, type: string, target: string, external?: boolean][]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${entries.map(([id, type, target, external]) =>
    `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
}

const rootRels = (main: string) => rels([["rId1", "officeDocument", main]]);

function slidePicture(id: number, embed: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr/></p:pic>`;
}

/** A slide picture placed at `[x, y, cx, cy]` (EMUs). */
function placedPicture(id: number, embed: string, [x, y, cx, cy]: [number, number, number, number]): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:pic>`;
}

function slide(body: string): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

/** Slides are listed in sldIdLst order, which here is the reverse of the part names. */
function pptx(slides: { xml: string; rels: string }[], extra: { name: string; data: Uint8Array | string }[] = []): Uint8Array {
  const order = slides.map((_, index) => slides.length - index);
  const presentation = `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${order.map((part, index) =>
    `<p:sldId id="${256 + index}" r:id="rIdS${part}"/>`).join("")}</p:sldIdLst></p:presentation>`;
  return makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "_rels/.rels", data: rootRels("ppt/presentation.xml") },
    { name: "ppt/presentation.xml", data: presentation, deflate: true },
    { name: "ppt/_rels/presentation.xml.rels", data: rels(order.map((part) => [`rIdS${part}`, "slide", `slides/slide${part}.xml`])) },
    ...order.flatMap((part, index) => [
      { name: `ppt/slides/slide${part}.xml`, data: slides[index]!.xml, deflate: true },
      { name: `ppt/slides/_rels/slide${part}.xml.rels`, data: slides[index]!.rels },
    ]),
    ...extra,
  ]);
}

function wordPicture(embed: string): string {
  return `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:blipFill>` +
    `<a:blip r:embed="${embed}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function docx(body: string, relationships: string, media: { name: string; data: Uint8Array }[],
  { root = rootRels("word/document.xml"), contentTypes = "<Types/>" }: { root?: string | Uint8Array; contentTypes?: string } = {},
): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" ` +
    `xmlns:pic="${PIC}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:wps="${WPS}" xmlns:v="${V}"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: root },
    { name: "word/document.xml", data: document, deflate: true },
    { name: "word/_rels/document.xml.rels", data: relationships },
    ...media,
  ]);
}

const labels = (result: OfficeImportResult) => result.structures.map((structure) => [structure.location, structure.document.label]);

async function refusal(bytes: Uint8Array, limits = {}): Promise<OfficeImportError> {
  const error = await importOfficeStructures(bytes, { limits }).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(OfficeImportError);
  return error as OfficeImportError;
}

describe("importOfficeStructures: PowerPoint", () => {
  it("finds every structure in slide order, including grouped pictures and the chosen AlternateContent branch", async () => {
    const first = slide(slidePicture(2, "rId1") + slidePicture(3, "rId2") + slidePicture(4, "rId3"));
    const second = slide(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/></p:nvGrpSpPr>${slidePicture(6, "rId1")}</p:grpSp>` +
      `<mc:AlternateContent><mc:Choice Requires="p">${slidePicture(7, "rId2")}</mc:Choice>` +
      `<mc:Fallback>${slidePicture(8, "rIdFallback")}</mc:Fallback></mc:AlternateContent>`);
    const bytes = pptx([
      { xml: first, rels: rels([["rId1", "image", "../media/a.png"], ["rId2", "image", "../media/plain.png"], ["rId3", "image", "../media/b.png"]]) },
      { xml: second, rels: rels([["rId1", "image", "../media/c.png"], ["rId2", "image", "/ppt/media/d.png"],
        ["rIdFallback", "image", "../media/fallback.png"]]) },
    ], [
      { name: "ppt/media/a.png", data: carrier(selection("A")) },
      { name: "ppt/media/b.png", data: carrier(selection("B")) },
      { name: "ppt/media/c.png", data: carrier(selection("C")) },
      { name: "ppt/media/d.png", data: carrier(selection("D")) },
      { name: "ppt/media/fallback.png", data: carrier(selection("Fallback")) },
      { name: "ppt/media/plain.png", data: plainPng },
    ]);
    const result = await importOfficeStructures(bytes);
    expect(result.kind).toBe("powerpoint");
    expect(labels(result)).toEqual([["slide 1", "A"], ["slide 1", "B"], ["slide 2", "C"], ["slide 2", "D"]]);
    expect(result.structures.map((structure) => structure.source)).toEqual([
      { kind: "slide", slide: 1 }, { kind: "slide", slide: 1 }, { kind: "slide", slide: 2 }, { kind: "slide", slide: 2 }]);
    expect(result.structures[0]).toMatchObject({ picture: 1, mediaPart: "ppt/media/a.png", json: selection("A") });
    expect(result).toMatchObject({ warnings: [], notes: [], picturesChecked: 5 });
  });

  it("returns nothing, without warnings, for a deck with no ChemDraft pictures", async () => {
    const bytes = pptx([{ xml: slide(slidePicture(2, "rId1")), rels: rels([["rId1", "image", "../media/plain.png"]]) }],
      [{ name: "ppt/media/plain.png", data: plainPng }]);
    expect(await importOfficeStructures(bytes)).toMatchObject({ kind: "powerpoint", structures: [], warnings: [], picturesChecked: 1 });
    expect(await importOfficeStructures(pptx([]))).toMatchObject({ structures: [], warnings: [], picturesChecked: 0 });
  });

  it("warns per picture for damaged, unknown-version and oversized carriers, and keeps the good ones", async () => {
    const damaged = carrier(selection("X"));
    // Flip one byte of the carrier's JSON without fixing its CRC.
    const at = Buffer.from(damaged).indexOf('"label"');
    damaged[at + 2] ^= 0x01;
    const big = selection("big", { padding: "x".repeat(4096) });
    const pictures = ["good", "damaged", "version", "notjson", "foreign", "big"];
    const bytes = pptx([{
      xml: slide(pictures.map((_, index) => slidePicture(index + 2, `rId${index + 1}`)).join("")),
      rels: rels(pictures.map((name, index) => [`rId${index + 1}`, "image", `../media/${name}.png`])),
    }], [
      { name: "ppt/media/good.png", data: carrier(selection("good")) },
      { name: "ppt/media/damaged.png", data: damaged },
      { name: "ppt/media/version.png", data: carrier(JSON.stringify({ kind: "chemdraft-selection", version: 7, objects: [] })) },
      { name: "ppt/media/notjson.png", data: carrier("{not json") },
      { name: "ppt/media/foreign.png", data: carrier(JSON.stringify({ kind: "something-else", version: 1 })) },
      { name: "ppt/media/big.png", data: carrier(big) },
    ]);
    const result = await importOfficeStructures(bytes, { limits: { maxCarrierJsonBytes: 2048 } });
    expect(labels(result)).toEqual([["slide 1", "good"]]);
    expect(result.warnings.map(({ picture, location, reason }) => [picture, location, reason])).toEqual([
      [2, "slide 1", "malformed"], [3, "slide 1", "unknown-version"], [4, "slide 1", "malformed"],
      [5, "slide 1", "malformed"], [6, "slide 1", "too-large"],
    ]);
    expect(result.warnings[0]!.message).toContain("CRC mismatch");
    expect(result.warnings[1]!.message).toContain("data version 7");
    expect(result.warnings[4]!.message).toContain("limit for one structure");
  });

  it("reads each slide's pictures and objects left to right, then top to bottom, not in stacking order", async () => {
    const STABLE = "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}";
    const object = writeTestCompoundFile(STABLE, [{ name: "ChemDraftDocument", data: selection("object") }]).bytes;
    // Added right first, so the left picture is stacked above it and comes later in the slide.
    const first = slide(placedPicture(2, "rIdR", [6000, 0, 1000, 1000]) + placedPicture(3, "rIdL", [0, 0, 1000, 1000]));
    // Second row, stacked: a grouped picture whose group moves it to the far right, an embedded
    // object in the middle, an unplaced picture, and a picture on the left a little lower.
    const second = slide(
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="8000" y="3000"/>` +
      `<a:ext cx="2000" cy="2000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>` +
      placedPicture(5, "rIdG", [0, 0, 500, 500]) + "</p:grpSp>" +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Object"/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="4000" y="3000"/><a:ext cx="1000" cy="1000"/></p:xfrm><a:graphic><a:graphicData uri="${P.replace("main", "ole")}">` +
      `<p:oleObj r:id="rIdO" progId="ChemDraft.Structure.1"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>` +
      slidePicture(7, "rIdU") + placedPicture(8, "rIdB", [0, 3300, 1000, 1000]));
    const bytes = pptx([
      { xml: first, rels: rels([["rIdR", "image", "../media/right.png"], ["rIdL", "image", "../media/left.png"]]) },
      { xml: second, rels: rels([["rIdG", "image", "../media/grouped.png"], ["rIdO", "oleObject", "../embeddings/oleObject1.bin"],
        ["rIdU", "image", "../media/unplaced.png"], ["rIdB", "image", "../media/lower-left.png"]]) },
    ], [
      ...["right", "left", "grouped", "unplaced", "lower-left"].map((label) => ({ name: `ppt/media/${label}.png`, data: carrier(selection(label)) })),
      { name: "ppt/embeddings/oleObject1.bin", data: object },
    ]);
    const result = await importOfficeStructures(bytes);
    expect(labels(result)).toEqual([["slide 1", "left"], ["slide 1", "right"],
      ["slide 2", "lower-left"], ["slide 2", "object"], ["slide 2", "grouped"], ["slide 2", "unplaced"]]);
    expect(result.structures.map((structure) => structure.picture)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pptxSlideDrawingReferences(second)[0]).toEqual({ relationshipId: "rIdG", box: { x: 8000, y: 3000, width: 1000, height: 1000 } });
  });

  it("caps the number of pictures examined and says so", async () => {
    const xml = slide(Array.from({ length: 3 }, (_, index) => slidePicture(index + 2, "rId1")).join(""));
    const bytes = pptx([
      { xml, rels: rels([["rId1", "image", "../media/a.png"]]) },
      { xml: slide(slidePicture(2, "rId2") + slidePicture(3, "rId2")), rels: rels([["rId2", "image", "../media/b.png"]]) },
    ], [{ name: "ppt/media/a.png", data: carrier(selection("A")) }, { name: "ppt/media/b.png", data: carrier(selection("B")) }]);
    vi.mocked(readChemDraftSelectionFromPng).mockClear();
    const result = await importOfficeStructures(bytes, { limits: { maxPictures: 3 } });
    expect(labels(result)).toEqual([["slide 1", "A"], ["slide 1", "A"], ["slide 1", "A"]]);
    expect(readChemDraftSelectionFromPng).toHaveBeenCalledTimes(1);
    expect(result.picturesChecked).toBe(3);
    expect(result.notes).toEqual(["Only the first 3 of 5 pictures were checked for ChemDraft structures."]);
  });

  it.each([
    [256, "rId2", "slides/slide2.xml", /Duplicate slide ID/],
    [257, "rId1", "slides/slide2.xml", /Duplicate slide relationship ID/],
    [257, "rId2", "SLIDES/SLIDE1.XML", /Duplicate slide part/],
  ] as const)("rejects a duplicate slide identity before traversing slides (%s, %s, %s)", async (id, relationship, target, reason) => {
    const bytes = makeZip([
      { name: "_rels/.rels", data: rootRels("ppt/presentation.xml") },
      { name: "ppt/presentation.xml", data: `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>` +
        `<p:sldId id="256" r:id="rId1"/><p:sldId id="${id}" r:id="${relationship}"/></p:sldIdLst></p:presentation>` },
      { name: "ppt/_rels/presentation.xml.rels", data: rels([["rId1", "slide", "slides/slide1.xml"], ["rId2", "slide", target]]) },
      { name: "ppt/slides/slide1.xml", data: "<broken" },
    ]);
    expect(await refusal(bytes)).toMatchObject({ code: "malformed-package", message: expect.stringMatching(reason) });
  });

  it("finds a PNG when the relationship and its package part differ in case", async () => {
    const bytes = pptx([{ xml: slide(slidePicture(2, "rId1")), rels: rels([["rId1", "image", "../MEDIA/IMAGE.PNG"]]) }],
      [{ name: "ppt/media/image.png", data: carrier(selection("case variant")) }]);
    const result = await importOfficeStructures(bytes);
    expect(labels(result)).toEqual([["slide 1", "case variant"]]);
    expect(result.structures[0]?.mediaPart).toBe("ppt/media/image.png");
  });
});

describe("importOfficeStructures: Word", () => {
  it("finds structures in body order with their paragraph, reading one AlternateContent branch", async () => {
    const body = `<w:p>${wordPicture("rId1")}</w:p><w:p/><w:p>${wordPicture("rId2")}${wordPicture("rId9")}</w:p>` +
      `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:spPr><a:blipFill>` +
      `<a:blip r:embed="rId3"/></a:blipFill></wps:spPr></wps:wsp></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rIdFallback"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>` +
      `<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId4"/></v:shape></w:pict></w:r></w:p>`;
    const relationships = rels([["rId1", "image", "media/one.png"], ["rId2", "image", "media/two.png"],
      ["rId3", "image", "media/three.png"], ["rId4", "image", "media/four.png"], ["rId9", "image", "https://example.org/x.png", true],
      ["rIdFallback", "image", "media/fallback.png"]]);
    const bytes = docx(body, relationships, [
      { name: "word/media/one.png", data: carrier(selection("one")) },
      { name: "word/media/two.png", data: carrier(selection("two")) },
      { name: "word/media/three.png", data: carrier(selection("three")) },
      { name: "word/media/four.png", data: carrier(selection("four")) },
      { name: "word/media/fallback.png", data: carrier(selection("Fallback")) },
    ]);
    const result = await importOfficeStructures(bytes);
    expect(result.kind).toBe("word");
    expect(labels(result)).toEqual([["paragraph 1", "one"], ["paragraph 3", "two"], ["paragraph 4", "three"], ["paragraph 5", "four"]]);
    expect(result.warnings).toEqual([]);
    expect(docxDrawingReferences(`<w:document xmlns:w="${W}" xmlns:a="${A}" xmlns:r="${R}"><w:body><w:p/><w:p>` +
      `<a:blip r:embed="rIdX"/></w:p></w:body></w:document>`)).toEqual([{ relationshipId: "rIdX", paragraph: 2 }]);
  });

  it.each(["UTF-8", "UTF-16LE", "UTF-16BE"] as const)("reads %s root relationships", async (encoding) => {
    const xml = rootRels("word/document.xml").replace('encoding="UTF-8"',
      encoding === "UTF-8" ? 'encoding="UTF-8"' : 'encoding="UTF-16"');
    const root = encoding === "UTF-8" ? Buffer.from(xml, "utf8") : Buffer.from(`\uFEFF${xml}`, "utf16le");
    if (encoding === "UTF-16BE") root.swap16();
    const bytes = docx(`<w:p>${wordPicture("rId1")}</w:p>`, rels([["rId1", "image", "media/drawing.png"]]),
      [{ name: "word/media/drawing.png", data: carrier(selection("drawing")) }], { root });
    expect(labels(await importOfficeStructures(bytes))).toEqual([["paragraph 1", "drawing"]]);
  });

  it("refuses malformed UTF-16 root relationships", async () => {
    const bytes = docx("", rels([]), [], { root: Uint8Array.of(0xff, 0xfe, 0x3c) });
    expect(await refusal(bytes)).toMatchObject({ code: "malformed-package", message: expect.stringContaining("not valid UTF-16LE XML") });
  });

  it("loads a referenced PNG with a content type override and a non-PNG extension", async () => {
    const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/word/media/drawing.bin" ContentType="image/png"/></Types>';
    const bytes = docx(`<w:p>${wordPicture("rId1")}</w:p>`, rels([["rId1", "image", "media/drawing.bin"]]),
      [{ name: "word/media/drawing.bin", data: carrier(selection("drawing")) }], { contentTypes });
    expect(labels(await importOfficeStructures(bytes))).toEqual([["paragraph 1", "drawing"]]);
  });

  it("returns nothing for a document whose pictures are not ChemDraft structures", async () => {
    const bytes = docx(`<w:p>${wordPicture("rId1")}</w:p>`, rels([["rId1", "image", "media/plain.png"]]),
      [{ name: "word/media/plain.png", data: plainPng }]);
    expect(await importOfficeStructures(bytes)).toMatchObject({ kind: "word", structures: [], warnings: [], picturesChecked: 1 });
  });
});

describe("importOfficeStructures: untrusted input", () => {
  const good = () => docx(`<w:p>${wordPicture("rId1")}</w:p>`, rels([["rId1", "image", "media/one.png"]]),
    [{ name: "word/media/one.png", data: carrier(selection("one")) }]);

  it("refuses files over the archive limit before reading them", async () => {
    const bytes = good();
    const error = await refusal(bytes, { maxArchiveBytes: bytes.length - 1 });
    expect(error.code).toBe("too-large");
    expect(error.message).toMatch(/larger than the .* limit/);
  });

  it("refuses a ZIP bomb by its declared inflated size, per entry and in total", async () => {
    const zeros = new Uint8Array(1024 * 1024);
    const bomb = docx("<w:p/>", rels([]), [{ name: "word/media/zeros.png", data: zeros }]);
    // Deflated, a megabyte of zeros is about a kilobyte.
    const deflated = makeZip([{ name: "_rels/.rels", data: rootRels("word/document.xml") },
      { name: "word/document.xml", data: zeros, deflate: true }]);
    expect(deflated.length).toBeLessThan(4096);
    const perEntry = await refusal(deflated, { maxEntryBytes: 64 * 1024 });
    expect(perEntry.code).toBe("too-large");
    expect(perEntry.message).toContain("expands beyond");
    const total = await refusal(bomb, { maxInflatedBytes: 512 * 1024 });
    expect(total.code).toBe("too-large");
    expect(total.message).toContain("total inflated limit");
  });

  it("refuses too many entries", async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({ name: `word/media/x${index}.bin`, data: "x" }));
    const error = await refusal(makeZip(entries), { maxEntries: 10 });
    expect(error.code).toBe("too-large");
    expect(error.message).toContain("more than 10 parts");
  });

  it.each([
    ["../evil.xml", "'..' segment"],
    ["word/../../evil.xml", "'..' segment"],
    ["/etc/passwd", "absolute path"],
    ["C:/Windows/evil.xml", "drive letter"],
    ["word\\media\\evil.png", "backslash"],
    ["word/media/evil\u0001.png", "control character"],
  ])("refuses the crafted entry name %s", async (name, reason) => {
    const bytes = makeZip([{ name: "_rels/.rels", data: rootRels("word/document.xml") }, { name, data: "x" }]);
    const error = await refusal(bytes);
    expect(error.code).toBe("unsafe-entry-name");
    expect(error.message).toContain(reason);
  });

  it("refuses two entries whose names differ only by case", async () => {
    const error = await refusal(makeZip([{ name: "word/document.xml", data: "<a/>" }, { name: "Word/Document.xml", data: "<a/>" }]));
    expect(error.code).toBe("unsafe-entry-name");
  });

  it("warns, without reading anything, when a picture link climbs out of the package", async () => {
    const bytes = docx(`<w:p>${wordPicture("rId1")}${wordPicture("rId2")}</w:p>`,
      rels([["rId1", "image", "../../../../etc/passwd"], ["rId2", "image", "media/one.png"]]),
      [{ name: "word/media/one.png", data: carrier(selection("one")) }]);
    const result = await importOfficeStructures(bytes);
    expect(labels(result)).toEqual([["paragraph 1", "one"]]);
    expect(result.warnings).toEqual([expect.objectContaining({ picture: 1, reason: "malformed",
      message: "The picture on paragraph 1 points outside the file, so it was not read." })]);
    expect(resolvePartTarget("word", "../../x.png")).toBeNull();
    expect(resolvePartTarget("word", "%2e%2e/%2e%2e/x.png")).toBeNull();
    expect(resolvePartTarget("word", "file:///etc/passwd")).toBeNull();
    expect(resolvePartTarget("word", "media\\x.png")).toBeNull();
    expect(resolvePartTarget("ppt/slides", "../media/a.png")).toBe("ppt/media/a.png");
  });

  it("names what is wrong with files that are not Word or PowerPoint", async () => {
    expect((await refusal(new TextEncoder().encode("plain text"))).code).toBe("not-zip");
    expect((await refusal(plainPng)).code).toBe("not-zip");
    expect((await refusal(good().subarray(0, 200))).code).toBe("not-zip");
    expect((await refusal(makeZip([{ name: "hello.txt", data: "hi" }]))).code).toBe("not-office");
    const workbook = makeZip([{ name: "_rels/.rels", data: rootRels("xl/workbook.xml") },
      { name: "xl/workbook.xml", data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' }]);
    const error = await refusal(workbook);
    expect(error.code).toBe("not-office");
    expect(error.message).toBe("The file is an Office package but not a Word document or PowerPoint presentation.");
    const broken = makeZip([{ name: "_rels/.rels", data: rootRels("word/document.xml") },
      { name: "word/document.xml", data: `<w:document xmlns:w="${W}"><w:body>` }]);
    expect((await refusal(broken)).code).toBe("malformed-package");
  });

  it("lists slide pictures only from p:pic blip fills", () => {
    const xml = slide(`<p:sp><p:spPr><a:blipFill><a:blip r:embed="rIdFill"/></a:blipFill></p:spPr></p:sp>${slidePicture(2, "rIdPic")}`);
    expect(pptxSlideDrawingReferences(xml)).toEqual([{ relationshipId: "rIdPic" }]);
  });
});

describe("importOfficeStructures: ChemDraft embedded objects (made on Windows)", () => {
  const STABLE = "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}";
  const DEV = "{8D23DEDA-8B23-4D62-BEEC-6C6168D48BB4}";
  const O = "urn:schemas-microsoft-com:office:office";
  const oleBin = (json: string, clsid = STABLE) => writeTestCompoundFile(clsid, [
    { name: "\u0001CompObj", data: new Uint8Array(40) }, { name: "\u0001Ole", data: new Uint8Array(20) },
    { name: "ChemDraftDocument", data: json },
  ]).bytes;
  // Word writes an embedded object as VML: its preview picture, then the object itself.
  const wordObject = (preview: string, object: string, progId = "ChemDraft.Structure.1", type = "Embed") =>
    `<w:r><w:object xmlns:o="${O}"><v:shape><v:imagedata r:id="${preview}"/></v:shape>` +
    `<o:OLEObject Type="${type}" ProgID="${progId}" ShapeID="_x0000_i1025" DrawAspect="Content" r:id="${object}"/></w:object></w:r>`;
  // PowerPoint picks the VML branch it understands; this reader, like Office for Mac, the fallback with its preview picture.
  const slideObject = (preview: string, object: string, progId = "ChemDraft.Structure.1") =>
    `<p:graphicFrame><a:graphic><a:graphicData uri="${P.replace("main", "ole")}"><mc:AlternateContent>` +
    `<mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj spid="_x0000_s1026" r:id="${object}" progId="${progId}"><p:embed/></p:oleObj></mc:Choice>` +
    `<mc:Fallback><p:oleObj r:id="${object}" progId="${progId}"><p:embed/>${slidePicture(9, preview)}</p:oleObj></mc:Fallback>` +
    `</mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>`;

  it("reads a Word object's drawing from its compound file, in body order, and never its preview", async () => {
    const bytes = docx(`<w:p>${wordObject("rIdPrev", "rIdOle")}</w:p><w:p>${wordPicture("rIdPic")}</w:p>`, rels([
      ["rIdPrev", "image", "media/image1.png"], ["rIdOle", "oleObject", "embeddings/oleObject1.bin"], ["rIdPic", "image", "media/image2.png"],
    ]), [
      // A preview that happens to carry a drawing is still only the object's picture.
      { name: "word/media/image1.png", data: carrier(selection("preview")) },
      { name: "word/embeddings/oleObject1.bin", data: oleBin(selection("object")) },
      { name: "word/media/image2.png", data: carrier(selection("picture")) },
    ]);
    const result = await importOfficeStructures(bytes);
    expect(labels(result)).toEqual([["paragraph 1", "object"], ["paragraph 2", "picture"]]);
    expect(result.structures[0]).toMatchObject({ picture: 1, mediaPart: "word/embeddings/oleObject1.bin", json: selection("object") });
    expect(result).toMatchObject({ warnings: [], picturesChecked: 2 });
  });

  it("reads a PowerPoint object, and the dev build's class, from the chosen branch only", async () => {
    const bytes = pptx([{ xml: slide(slideObject("rIdPrev", "rIdOle")),
      rels: rels([["rIdPrev", "image", "../media/image1.png"], ["rIdOle", "oleObject", "../embeddings/oleObject1.bin"]]) }], [
      { name: "ppt/media/image1.png", data: carrier(selection("preview")) },
      { name: "ppt/embeddings/oleObject1.bin", data: oleBin(selection("object"), DEV) },
    ]);
    const result = await importOfficeStructures(bytes);
    expect(labels(result)).toEqual([["slide 1", "object"]]);
    expect(result).toMatchObject({ warnings: [], picturesChecked: 1 });
  });

  it("skips another program's object and a linked object without a word", async () => {
    const bytes = docx(`<w:p>${wordObject("rIdPrev", "rIdOle", "Equation.3")}</w:p><w:p>${wordObject("rIdPrev2", "rIdLink", "ChemDraft.Structure.1", "Link")}</w:p>`, rels([
      ["rIdPrev", "image", "media/image1.png"], ["rIdOle", "oleObject", "embeddings/oleObject1.bin"],
      ["rIdPrev2", "image", "media/image2.png"], ["rIdLink", "oleObject", "file:///C:/Structures/linked.chemdraft", true],
    ]), [
      { name: "word/media/image1.png", data: plainPng },
      { name: "word/embeddings/oleObject1.bin", data: oleBin(selection("equation"), "{0002CE02-0000-0000-C000-000000000046}") },
      { name: "word/media/image2.png", data: plainPng },
    ]);
    expect(await importOfficeStructures(bytes)).toMatchObject({ structures: [], warnings: [], picturesChecked: 2 });
  });

  it("warns only for a missing known ChemDraft object part and gives recovery guidance", async () => {
    const bytes = docx(`<w:p>${wordObject("rIdPrev", "rIdOle")}</w:p><w:p>${wordObject("rIdPrev", "rIdOther", "Equation.3")}</w:p>`,
      rels([["rIdOle", "oleObject", "embeddings/missing.bin"], ["rIdOther", "oleObject", "embeddings/other.bin"]]), []);
    const result = await importOfficeStructures(bytes);
    expect(result.structures).toEqual([]);
    expect(result.warnings).toEqual([{
      picture: 1, source: { kind: "paragraph", paragraph: 1 }, location: "paragraph 1",
      mediaPart: "word/embeddings/missing.bin", reason: "malformed",
      message: "The embedded ChemDraft object on paragraph 1 could not be read: the embedded part word/embeddings/missing.bin is missing. " +
        "Open the file in Word or PowerPoint on Windows, copy the object and paste it into ChemDraft.",
    }]);
  });

  it("refuses oversized compressed PNGs and shares the picture and JSON budgets across PNG and OLE", async () => {
    const object = selection("object");
    const small = selection("small");
    const oversized = selection("oversized", { padding: "x".repeat(4096) });
    const overTotal = selection("over total", { padding: "x".repeat(200) });
    const bytes = docx(`<w:p>${wordPicture("rIdBig")}${wordObject("rIdPrev", "rIdOle")}` +
      `${wordPicture("rIdOver")}${wordPicture("rIdBig")}${wordPicture("rIdSmall")}${wordPicture("rIdOver")}${wordPicture("rIdLate")}</w:p>`,
      rels([["rIdBig", "image", "media/big.png"], ["rIdOle", "oleObject", "embeddings/object.bin"],
        ["rIdOver", "image", "media/over.png"], ["rIdSmall", "image", "media/small.png"], ["rIdLate", "image", "media/late.png"]]), [
        { name: "word/media/big.png", data: compressedCarrier(oversized) },
        { name: "word/media/over.png", data: compressedCarrier(overTotal) },
        { name: "word/media/small.png", data: compressedCarrier(small) },
        { name: "word/media/late.png", data: carrier(selection("late")) },
        { name: "word/embeddings/object.bin", data: oleBin(object) },
      ]);
    vi.mocked(readChemDraftSelectionFromPng).mockClear();
    const actual = await vi.importActual<typeof import("./pngSelection")>("./pngSelection");
    const oversizedJsonAccess = vi.fn();
    vi.mocked(readChemDraftSelectionFromPng).mockImplementationOnce(async (png) => {
      const decoded = await actual.readChemDraftSelectionFromPng(png);
      if (decoded.kind !== "found") return decoded;
      return { kind: "found", chunk: decoded.chunk, get json() {
        oversizedJsonAccess();
        return decoded.json;
      } };
    });
    const result = await importOfficeStructures(bytes, { limits: { maxPictures: 6, maxCarrierJsonBytes: 512,
      maxTotalCarrierJsonBytes: Buffer.byteLength(object) + Buffer.byteLength(small) } });
    expect(labels(result)).toEqual([["paragraph 1", "object"], ["paragraph 1", "small"]]);
    expect(result.warnings.map(({ picture, reason, message }) => [picture, reason, message])).toEqual([
      [1, "too-large", expect.stringContaining("limit for one structure")],
      [3, "too-large", expect.stringContaining("structures together exceed")],
      [4, "too-large", expect.stringContaining("limit for one structure")],
      [6, "too-large", expect.stringContaining("structures together exceed")],
    ]);
    expect(readChemDraftSelectionFromPng).toHaveBeenCalledTimes(3);
    expect(oversizedJsonAccess).toHaveBeenCalledOnce();
    expect(result.notes).toEqual(["Only the first 6 of 7 pictures were checked for ChemDraft structures."]);
  });

  it("warns, with the carrier's words, for a ChemDraft object that is damaged, newer or too large", async () => {
    const bytes = docx([1, 2, 3, 4].map((n) => `<w:p>${wordObject(`rIdPrev${n}`, `rIdOle${n}`)}</w:p>`).join(""), rels([1, 2, 3, 4].flatMap((n) => [
      [`rIdPrev${n}`, "image", "media/preview.png"], [`rIdOle${n}`, "oleObject", `embeddings/oleObject${n}.bin`],
    ] as [string, string, string][])), [
      { name: "word/media/preview.png", data: plainPng },
      { name: "word/embeddings/oleObject1.bin", data: oleBin(selection("newer", { version: 3 })) },
      { name: "word/embeddings/oleObject2.bin", data: oleBin("{not json") },
      { name: "word/embeddings/oleObject3.bin", data: new TextEncoder().encode("not a compound file") },
      { name: "word/embeddings/oleObject4.bin", data: oleBin(selection("large", { padding: "x".repeat(400) })) },
    ]);
    const result = await importOfficeStructures(bytes, { limits: { maxCarrierJsonBytes: 300 } });
    expect(result.structures).toEqual([]);
    expect(result.warnings.map(({ location, reason, mediaPart }) => [location, reason, mediaPart])).toEqual([
      ["paragraph 1", "unknown-version", "word/embeddings/oleObject1.bin"],
      ["paragraph 2", "malformed", "word/embeddings/oleObject2.bin"],
      ["paragraph 3", "malformed", "word/embeddings/oleObject3.bin"],
      ["paragraph 4", "too-large", "word/embeddings/oleObject4.bin"],
    ]);
    expect(result.warnings[0]!.message).toBe("The structure on paragraph 1 was made by a newer or unknown ChemDraft (data version 3).");
    expect(result.warnings[1]!.message).toBe("The structure on paragraph 2 has damaged ChemDraft data: it is not valid JSON.");
    expect(result.warnings[2]!.message).toBe("The embedded ChemDraft object on paragraph 3 could not be read: the embedded object is not an " +
      "OLE compound file. Open the file in Word or PowerPoint on Windows, copy the object and paste it into ChemDraft.");
    expect(result.warnings[3]!.message).toBe("The structure on paragraph 4 is larger than the 0 MB limit for one structure.");
  });

  it("parses an object part once however many references share it, and counts each reference", async () => {
    const count = 6;
    const bytes = docx(Array.from({ length: count }, () => `<w:p>${wordObject("rIdPrev", "rIdOle")}</w:p>`).join(""), rels([
      ["rIdPrev", "image", "media/preview.png"], ["rIdOle", "oleObject", "embeddings/oleObject1.bin"],
    ]), [
      { name: "word/media/preview.png", data: plainPng },
      { name: "word/embeddings/oleObject1.bin", data: oleBin(selection("shared")) },
    ]);
    vi.mocked(readChemDraftOleObject).mockClear();
    const result = await importOfficeStructures(bytes);
    expect(readChemDraftOleObject).toHaveBeenCalledTimes(1);
    expect(result.structures.map((structure) => [structure.picture, structure.location, structure.document.label]))
      .toEqual(Array.from({ length: count }, (_, index) => [index + 1, `paragraph ${index + 1}`, "shared"]));
    // Each reference still counts against the limits.
    const jsonBytes = new TextEncoder().encode(selection("shared")).length;
    vi.mocked(readChemDraftOleObject).mockClear();
    const budget = await importOfficeStructures(bytes, { limits: { maxPictures: 4, maxTotalCarrierJsonBytes: 2 * jsonBytes } });
    expect(readChemDraftOleObject).toHaveBeenCalledTimes(1);
    expect(budget.structures).toHaveLength(2);
    expect(budget.warnings.map(({ picture, reason }) => [picture, reason])).toEqual([[3, "too-large"], [4, "too-large"]]);
    expect(budget.notes).toEqual([`Only the first 4 of ${count} pictures were checked for ChemDraft structures.`]);
  });

  it("folds a Word object's previews into the object, and keeps a linked object's preview as a picture", () => {
    const W14 = `xmlns:w="${W}" xmlns:a="${A}" xmlns:r="${R}" xmlns:v="${V}" xmlns:o="${O}"`;
    expect(docxDrawingReferences(`<w:document ${W14}><w:body><w:p><w:object><w:drawing><a:blip r:embed="rIdPrev"/></w:drawing>` +
      `<w:objectEmbed w:progId="ChemDraft.Structure.1" r:id="rIdOle"/></w:object></w:p><w:p><w:object><v:shape><v:imagedata r:id="rIdLinkPrev"/></v:shape>` +
      `<o:OLEObject Type="Link" ProgID="ChemDraft.Structure.1" r:id="rIdLink"/></w:object></w:p></w:body></w:document>`)).toEqual([
      { relationshipId: "rIdOle", paragraph: 1, oleProgId: "ChemDraft.Structure.1" },
      { relationshipId: "rIdLinkPrev", paragraph: 2 },
    ]);
  });
});

describe("inReadingOrder", () => {
  const order = (boxes: [label: string, box?: [number, number, number, number]][]) =>
    inReadingOrder(boxes, ([, box]) => box && ({ x: box[0], y: box[1], width: box[2], height: box[3] } satisfies DrawingBox))
      .map(([label]) => label);

  it("reads left to right, then top to bottom, whatever the input order", () => {
    expect(order([["B", [10, 0, 5, 5]], ["A", [0, 0, 5, 5]]])).toEqual(["A", "B"]);
    expect(order([["D", [10, 10, 5, 5]], ["C", [0, 10, 5, 5]], ["B", [10, 0, 5, 5]], ["A", [0, 0, 5, 5]]])).toEqual(["A", "B", "C", "D"]);
  });

  it("puts pictures in one row when their centers are within half the smaller height", () => {
    // Centers 2.5 apart; half the smaller height is 2.5: one row.
    expect(order([["right", [10, 0, 5, 5]], ["left", [0, 2.5, 5, 5]]])).toEqual(["left", "right"]);
    // A tall picture and a short one beside its middle: one row.
    expect(order([["short", [10, 8, 5, 4]], ["tall", [0, 0, 5, 20]]])).toEqual(["tall", "short"]);
    // Centers 3 apart: separate rows, so the higher one leads even on the right.
    expect(order([["right", [10, 0, 5, 5]], ["left", [0, 3, 5, 5]]])).toEqual(["right", "left"]);
  });

  it("keeps the input order for identical places and puts unplaced pictures last", () => {
    expect(order([["first", [0, 0, 5, 5]], ["second", [0, 0, 5, 5]]])).toEqual(["first", "second"]);
    expect(order([["none"], ["B", [10, 0, 5, 5]], ["also none"], ["A", [0, 0, 5, 5]]])).toEqual(["A", "B", "none", "also none"]);
  });
});

describe("reading order through group and picture flips and rotations", () => {
  type Rect = [number, number, number, number];
  const picture = (embed: string, [x, y, cx, cy]: Rect, attrs = "") =>
    `<p:pic><p:nvPicPr><p:cNvPr id="1" name="${embed}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/></p:blipFill>` +
    `<p:spPr><a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:pic>`;
  /** A group whose child space equals its own frame unless `child` says otherwise. */
  const group = (frame: Rect, attrs: string, body: string, child: Rect = frame) =>
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${attrs}>` +
    `<a:off x="${frame[0]}" y="${frame[1]}"/><a:ext cx="${frame[2]}" cy="${frame[3]}"/>` +
    `<a:chOff x="${child[0]}" y="${child[1]}"/><a:chExt cx="${child[2]}" cy="${child[3]}"/></a:xfrm></p:grpSpPr>${body}</p:grpSp>`;
  const read = (body: string) => {
    const references = pptxSlideDrawingReferences(slide(body));
    return { order: inReadingOrder(references, (reference) => reference.box).map((reference) => reference.relationshipId), references };
  };
  const boxOf = (references: ReturnType<typeof pptxSlideDrawingReferences>, id: string) => references.find((reference) => reference.relationshipId === id)?.box;
  const expectBox = (actual: DrawingBox | undefined, expected: Rect) => {
    expect(actual).toBeDefined();
    expect([actual!.x, actual!.y, actual!.width, actual!.height].map(Math.round)).toEqual(expected);
  };

  it("leaves an unflipped, unrotated group in its stored order", () => {
    const pictures = picture("A", [0, 0, 500, 1000]) + picture("B", [1500, 0, 500, 1000]);
    expect(read(group([0, 0, 2000, 1000], "", pictures)).order).toEqual(["A", "B"]);
  });

  it("reverses the order of a horizontally flipped group", () => {
    const { order, references } = read(group([0, 0, 2000, 1000], ' flipH="1"', picture("A", [0, 0, 500, 1000]) + picture("B", [1500, 0, 500, 1000])));
    expect(order).toEqual(["B", "A"]);
    expectBox(boxOf(references, "A"), [1500, 0, 500, 1000]);
    expectBox(boxOf(references, "B"), [0, 0, 500, 1000]);
  });

  it("reverses the rows of a vertically flipped group", () => {
    const body = picture("A", [500, 0, 500, 1000]) + picture("B", [0, 2000, 500, 1000]);
    expect(read(group([0, 0, 1000, 3000], "", body)).order).toEqual(["A", "B"]);
    const flipped = read(group([0, 0, 1000, 3000], ' flipV="1"', body));
    expect(flipped.order).toEqual(["B", "A"]);
    expectBox(boxOf(flipped.references, "A"), [500, 2000, 500, 1000]);
  });

  it("turns a column into a row when the group is rotated 90 degrees", () => {
    const body = picture("A", [0, 0, 1000, 1000]) + picture("B", [0, 2000, 1000, 1000]);
    // Unrotated, A is above B; a quarter turn clockwise puts A on the right and B on the left.
    expect(read(group([0, 0, 1000, 3000], "", body)).order).toEqual(["A", "B"]);
    const rotated = read(group([0, 0, 1000, 3000], ' rot="5400000"', body));
    expect(rotated.order).toEqual(["B", "A"]);
    expectBox(boxOf(rotated.references, "A"), [1000, 1000, 1000, 1000]);
    expectBox(boxOf(rotated.references, "B"), [-1000, 1000, 1000, 1000]);
  });

  it("composes a rotated group nested in a flipped group, and maps child space to the frame", () => {
    const inner = group([0, 0, 2000, 1000], ' rot="10800000"', picture("A", [0, 0, 500, 500]) + picture("B", [1500, 500, 500, 500]));
    const { order, references } = read(group([0, 0, 4000, 1000], ' flipH="1"', inner + picture("C", [2500, 0, 500, 1000])));
    expectBox(boxOf(references, "A"), [2000, 500, 500, 500]);
    expectBox(boxOf(references, "B"), [3500, 0, 500, 500]);
    expectBox(boxOf(references, "C"), [1000, 0, 500, 1000]);
    expect(order).toEqual(["C", "B", "A"]);
    // Child space scaled into the frame, then flipped: chExt 1000 -> ext 2000, so x 100..600 -> 200..1200 -> 800..1800.
    const scaled = read(group([0, 0, 2000, 1000], ' flipH="1"', picture("S", [100, 0, 500, 1000]), [0, 0, 1000, 500]));
    expectBox(boxOf(scaled.references, "S"), [800, 0, 1000, 2000]);
  });

  it("subtracts a distant child offset (chOff) before placing a group's pictures", () => {
    // The group sits at the left of the slide; its child space starts far away. A and B are
    // stored right-then-left, and C sits between them on the slide. Only with chOff subtracted
    // do B and A land at 0 and 1500 around C; unsubtracted they would both read after C.
    const far = 10_000_000;
    const body = picture("A", [far + 1500, far, 500, 1000]) + picture("B", [far, far, 500, 1000]);
    const middle = picture("C", [1000, 0, 500, 1000]);
    const { order, references } = read(group([0, 0, 2000, 1000], "", body, [far, far, 2000, 1000]) + middle);
    expectBox(boxOf(references, "A"), [1500, 0, 500, 1000]);
    expectBox(boxOf(references, "B"), [0, 0, 500, 1000]);
    expect(order).toEqual(["B", "C", "A"]);
  });

  it("subtracts chOff and then scales when the child extent differs from the frame", () => {
    // Child space 1000 x 500 at (far, far) maps onto a 2000 x 1000 frame at the origin (scale 2).
    const far = 10_000_000;
    const body = picture("A", [far + 750, far, 250, 500]) + picture("B", [far, far, 250, 500]);
    const middle = picture("C", [1000, 0, 500, 1000]);
    const { order, references } = read(group([0, 0, 2000, 1000], "", body, [far, far, 1000, 500]) + middle);
    expectBox(boxOf(references, "A"), [1500, 0, 500, 1000]);
    expectBox(boxOf(references, "B"), [0, 0, 500, 1000]);
    expect(order).toEqual(["B", "C", "A"]);
  });

  it("uses an individually rotated picture's bounds for the row rule", () => {
    // R is 3000 wide and 1000 high, so it shares no row with P (3000 high) until a quarter turn
    // makes it 3000 high too: then it reads before P, which sits to its right.
    const tall = picture("P", [5000, 0, 1000, 3000]);
    const flat = (attrs: string) => picture("R", [0, 1900, 3000, 1000], attrs);
    expect(read(tall + flat("")).order).toEqual(["P", "R"]);
    const rotated = read(tall + flat(' rot="5400000"'));
    expectBox(boxOf(rotated.references, "R"), [1000, 900, 1000, 3000]);
    expect(rotated.order).toEqual(["R", "P"]);
  });
});
