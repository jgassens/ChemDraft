import { crc32, deflateRawSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { importOfficeStructures, OfficeImportError, pngWithChemDraftSelection, type OfficeImportResult } from "./index";
import { docxPictureReferences, pptxSlidePictureRelationshipIds, resolvePartTarget } from "./officePackage";

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

function rels(entries: [id: string, type: string, target: string, external?: boolean][]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${entries.map(([id, type, target, external]) =>
    `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
}

const rootRels = (main: string) => rels([["rId1", "officeDocument", main]]);

function slidePicture(id: number, embed: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr/></p:pic>`;
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

function docx(body: string, relationships: string, media: { name: string; data: Uint8Array }[]): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" ` +
    `xmlns:pic="${PIC}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:wps="${WPS}" xmlns:v="${V}"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "_rels/.rels", data: rootRels("word/document.xml") },
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
      `<mc:Fallback>${slidePicture(8, "rId2")}</mc:Fallback></mc:AlternateContent>`);
    const bytes = pptx([
      { xml: first, rels: rels([["rId1", "image", "../media/a.png"], ["rId2", "image", "../media/plain.png"], ["rId3", "image", "../media/b.png"]]) },
      { xml: second, rels: rels([["rId1", "image", "../media/c.png"], ["rId2", "image", "/ppt/media/d.png"]]) },
    ], [
      { name: "ppt/media/a.png", data: carrier(selection("A")) },
      { name: "ppt/media/b.png", data: carrier(selection("B")) },
      { name: "ppt/media/c.png", data: carrier(selection("C")) },
      { name: "ppt/media/d.png", data: carrier(selection("D")) },
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

  it("caps the number of pictures examined and says so", async () => {
    const xml = slide(Array.from({ length: 5 }, (_, index) => slidePicture(index + 2, "rId1")).join(""));
    const bytes = pptx([{ xml, rels: rels([["rId1", "image", "../media/a.png"]]) }],
      [{ name: "ppt/media/a.png", data: carrier(selection("A")) }]);
    const result = await importOfficeStructures(bytes, { limits: { maxPictures: 3 } });
    expect(result.structures).toHaveLength(3);
    expect(result.picturesChecked).toBe(3);
    expect(result.notes).toEqual(["Only the first 3 of 5 pictures were checked for ChemDraft structures."]);
  });
});

describe("importOfficeStructures: Word", () => {
  it("finds structures in body order with their paragraph, reading one AlternateContent branch", async () => {
    const body = `<w:p>${wordPicture("rId1")}</w:p><w:p/><w:p>${wordPicture("rId2")}${wordPicture("rId9")}</w:p>` +
      `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:spPr><a:blipFill>` +
      `<a:blip r:embed="rId3"/></a:blipFill></wps:spPr></wps:wsp></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId3"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>` +
      `<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId4"/></v:shape></w:pict></w:r></w:p>`;
    const relationships = rels([["rId1", "image", "media/one.png"], ["rId2", "image", "media/two.png"],
      ["rId3", "image", "media/three.png"], ["rId4", "image", "media/four.png"], ["rId9", "image", "https://example.org/x.png", true]]);
    const bytes = docx(body, relationships, [
      { name: "word/media/one.png", data: carrier(selection("one")) },
      { name: "word/media/two.png", data: carrier(selection("two")) },
      { name: "word/media/three.png", data: carrier(selection("three")) },
      { name: "word/media/four.png", data: carrier(selection("four")) },
    ]);
    const result = await importOfficeStructures(bytes);
    expect(result.kind).toBe("word");
    expect(labels(result)).toEqual([["paragraph 1", "one"], ["paragraph 3", "two"], ["paragraph 4", "three"], ["paragraph 5", "four"]]);
    expect(result.warnings).toEqual([]);
    expect(docxPictureReferences(`<w:document xmlns:w="${W}" xmlns:a="${A}" xmlns:r="${R}"><w:body><w:p/><w:p>` +
      `<a:blip r:embed="rIdX"/></w:p></w:body></w:document>`)).toEqual([{ relationshipId: "rIdX", paragraph: 2 }]);
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
    expect(pptxSlidePictureRelationshipIds(xml)).toEqual(["rIdPic"]);
  });
});
