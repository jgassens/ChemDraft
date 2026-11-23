// @vitest-environment jsdom
import { Resvg } from "@resvg/resvg-js";
import { flatOpcBinaryParts, pngWithChemDraftSelection } from "@chemdraft/clipboard-adapter";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { readOfficeDocument, type OfficeContext, type OfficeDocument } from "./host";
import { A, OPC, P, PIC, PKG_REL, R, WORD, WP, WP14, xmlDocument } from "./ooxml";
import { powerpointAdapter, type PowerPointApi } from "./powerpoint";
import { wordAdapter, type WordApi } from "./word";

const plainPng = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="10"><rect width="30" height="10"/></svg>').render().asPng();
const sourceJson = '{"test":"original drawing"}';
const updateJson = '{"test":"updated drawing"}';
const carrier = pngWithChemDraftSelection(plainPng, sourceJson);
const updated = pngWithChemDraftSelection(plainPng, updateJson);
const size = { width: 30, height: 10 };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const rels = (relId: string, type: string, target: string) =>
  '<Relationships xmlns="' + PKG_REL + '"><Relationship Id="' + relId + '" Type="' + R + '/' + type +
  '" Target="' + target + '"/></Relationships>';
const pngRel = rels("rId7", "image", "media/chemistry.png");

function office({ sets = [], archive }: { sets?: string[]; archive?: Uint8Array } = {}) {
  const close = vi.fn<OfficeDocument["getFileAsync"]>();
  close.mockImplementation((_type, _options, result) => {
    if (!archive) throw new Error("Unexpected getFileAsync");
    result({ status: "succeeded", value: {
      size: archive.length, sliceCount: 1,
      getSliceAsync: (index, done) => done({ status: "succeeded", value: { index, size: archive.length, data: [...archive] } }),
      closeAsync: done => done({ status: "succeeded", value: undefined }),
    } });
  });
  return {
    requirements: { isSetSupported: (name, version) => sets.includes(name + " " + version) },
    document: { getFileAsync: close, setSelectedDataAsync: vi.fn(), addHandlerAsync: vi.fn(), removeHandlerAsync: vi.fn() },
  } satisfies OfficeContext;
}

function wordDocument({ floating = false, crop = false, group = false, text = "", id = 17, anchorId = "2200ACD1" } = {}) {
  const placement = floating ? "anchor" : "inline";
  const props = '<wp:docPr id="' + id + '" name="Figure 1" descr="Figure description"/>';
  const picture = '<pic:pic><pic:blipFill><a:blip r:embed="rId7"/><a:srcRect' + (crop ? ' l="3500"' : '') +
    '/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3810000" cy="1905000"/></a:xfrm></pic:spPr></pic:pic>';
  const anchor = floating ? '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>317500</wp:posOffset></wp:positionH>' +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>127000</wp:posOffset></wp:positionV>' : "";
  return '<w:document xmlns:w="' + WORD + '" xmlns:wp="' + WP + '" xmlns:a="' + A + '" xmlns:r="' + R +
    '" xmlns:pic="' + PIC + '" xmlns:wp14="' + WP14 + '"><w:body><w:p><w:r>' + text + '<w:drawing><wp:' + placement +
    ' wp14:anchorId="' + anchorId + '"' + (floating ? ' distL="114300" relativeHeight="251658240"' : '') + '>' + anchor +
    '<wp:extent cx="3810000" cy="1905000"/>' + (floating ? '<wp:wrapSquare wrapText="bothSides"/>' : "") + props +
    '<a:graphic><a:graphicData uri="' + PIC + '">' +
    (group ? '<wpg:wgp xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup">' + picture + '</wpg:wgp>' : picture) +
    '</a:graphicData></a:graphic></wp:' + placement + '></w:drawing></w:r></w:p></w:body></w:document>';
}

function flatOpc(document: string, png?: Uint8Array) {
  return '<pkg:package xmlns:pkg="' + OPC + '">' +
    '<pkg:part pkg:name="/word/document.xml"><pkg:xmlData>' + document + '</pkg:xmlData></pkg:part>' +
    '<pkg:part pkg:name="/word/_rels/document.xml.rels"><pkg:xmlData>' + pngRel + '</pkg:xmlData></pkg:part>' +
    (png ? '<pkg:part pkg:name="/word/media/chemistry.png" pkg:contentType="image/png"><pkg:binaryData>' + b64(png) +
      '</pkg:binaryData></pkg:part>' : "") + '</pkg:package>';
}

function wordHost(xml: string) {
  const getOoxml = vi.fn(() => ({ value: xml }));
  const getInsertedOoxml = vi.fn((insertedXml: string) => ({ value: insertedXml }));
  const insertOoxml = vi.fn((replacement: string, _location: "Replace") => ({
    getOoxml: () => getInsertedOoxml(replacement),
    insertOoxml() { throw new Error("Unexpected second insert."); },
  }));
  const word = { run: async work => work({ document: { getSelection: () => ({ getOoxml, insertOoxml }) },
    sync: async () => undefined }) } satisfies WordApi;
  return { word, getOoxml, insertOoxml, getInsertedOoxml };
}

describe("Word Office adapter", () => {
  it.each([false, true])("replaces an inline or floating picture without stretching (floating=%s)", async floating => {
    const { word, insertOoxml } = wordHost(flatOpc(wordDocument({ floating }), carrier));
    const adapter = wordAdapter(office({ sets: ["WordApi 1.1"] }), word);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: expect.any(String) });
    const [xml, location] = insertOoxml.mock.calls[0]!;
    expect(location).toBe("Replace");
    const document = xmlDocument(xml);
    const placement = document.getElementsByTagNameNS(WP, floating ? "anchor" : "inline")[0]!;
    const layout = placement.getElementsByTagNameNS(WP, "extent")[0]!;
    const extent = placement.getElementsByTagNameNS(A, "ext")[0]!;
    for (const node of [layout, extent]) {
      expect(node.getAttribute("cx")).toBe("3810000");
      expect(node.getAttribute("cy")).toBe("1270000");
    }
    expect(placement.getElementsByTagNameNS(WP, "docPr")[0]?.getAttribute("descr")).toBe("ChemDraft · Figure description");
    if (floating) {
      expect(placement.getAttributeNS(WP14, "anchorId")).toBe("2200ACD1");
      expect(placement.getAttribute("relativeHeight")).toBe("251658240");
      expect(placement.getElementsByTagNameNS(WP, "wrapSquare")[0]?.getAttribute("wrapText")).toBe("bothSides");
      expect(placement.getElementsByTagNameNS(WP, "positionH")[0]?.textContent).toBe("317500");
      expect(placement.getElementsByTagNameNS(WP, "positionV")[0]?.textContent).toBe("127000");
    }
    expect([...flatOpcBinaryParts(xml)[0]!.bytes]).toEqual([...updated]);
  });

  it("finds only the selected drawing's related media in a full DOCX fallback", async () => {
    const document = wordDocument({ floating: true });
    const { word, insertOoxml } = wordHost(flatOpc(document));
    const host = office({ sets: ["WordApi 1.1", "CompressedFile 1.1"], archive: zipSync({
      "word/document.xml": strToU8(document.replaceAll("rId7", "rId19")),
      "word/_rels/document.xml.rels": strToU8(rels("rId19", "image", "media/chemistry.png")),
      "word/media/chemistry.png": carrier,
      "word/media/unrelated.png": updated,
    }) });
    const adapter = wordAdapter(host, word);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(host.document.getFileAsync).toHaveBeenCalledWith("compressed", { sliceSize: 1048576 }, expect.any(Function));
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: expect.any(String) });
    expect(insertOoxml).toHaveBeenCalledOnce();
  });

  it.each([
    [{ crop: true }, carrier, /cropped/i],
    [{ group: true }, carrier, /grouped/i],
    [{ text: "<w:t>Keep this text</w:t>" }, carrier, /surrounding content/i],
    [{}, plainPng, /no ChemDraft carrier/i],
  ] as const)("refuses unsafe or uneditable Word selections", async (options, png, reason) => {
    const { word, insertOoxml } = wordHost(flatOpc(wordDocument(options), png));
    const adapter = wordAdapter(office({ sets: ["WordApi 1.1"] }), word);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "refusal", reason: expect.stringMatching(reason) });
    expect(insertOoxml).not.toHaveBeenCalled();
  });

  it("gates WordApi and rechecks a changed selection before writing", async () => {
    const { word, getOoxml, insertOoxml } = wordHost(flatOpc(wordDocument(), carrier));
    expect(await wordAdapter(office(), word).readSelectedStructure()).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("WordApi 1.1"),
    });
    const adapter = wordAdapter(office({ sets: ["WordApi 1.1"] }), word);
    await adapter.readSelectedStructure();
    getOoxml.mockReturnValue({ value: flatOpc(wordDocument({ id: 31 }), carrier) });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("selection changed"),
    });
    expect(insertOoxml).not.toHaveBeenCalled();
  });

  it("returns the inserted Word range's identity when the selection has moved to an identical carrier", async () => {
    const { word, getOoxml, getInsertedOoxml } = wordHost(flatOpc(wordDocument(), carrier));
    const adapter = wordAdapter(office({ sets: ["WordApi 1.1"] }), word);
    await adapter.readSelectedStructure();
    const inserted = flatOpc(wordDocument({ id: 31, anchorId: "2200ACD2" }), updated);
    const other = flatOpc(wordDocument({ id: 46, anchorId: "2200ACD3" }), updated);
    getInsertedOoxml.mockImplementationOnce(() => {
      getOoxml.mockReturnValue({ value: other });
      return { value: inserted };
    });
    const replacement = await adapter.replaceSelectedStructure(updated, updateJson, size);
    const selected = await adapter.readSelectedStructure();
    expect(selected).toMatchObject({ kind: "structure", json: updateJson });
    getOoxml.mockReturnValue({ value: inserted });
    const actual = await adapter.readSelectedStructure();
    expect(actual).toMatchObject({ kind: "structure", json: updateJson });
    expect(replacement).toEqual({ kind: "replaced", key: actual.kind === "structure" ? actual.key : undefined });
    expect(replacement).not.toMatchObject({ key: selected.kind === "structure" ? selected.key : undefined });
  });

  it("reports a completed Word write when the new range cannot be identified", async () => {
    const { word, getInsertedOoxml, insertOoxml } = wordHost(flatOpc(wordDocument(), carrier));
    const adapter = wordAdapter(office({ sets: ["WordApi 1.1"] }), word);
    await adapter.readSelectedStructure();
    getInsertedOoxml.mockImplementationOnce(() => { throw new Error("The inserted range is unavailable."); });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: undefined, warnings: ["Could not identify the replacement Word picture."],
    });
    expect(insertOoxml).toHaveBeenCalledOnce();
  });
});

describe("Office compressed-file reads", () => {
  it("opens one file of a document at a time, so Office never sees a third open file", async () => {
    const archive = zipSync({ "a.xml": strToU8("<a/>") });
    const host = office({ sets: ["CompressedFile 1.1"], archive });
    let open = 0;
    let most = 0;
    const closes: (() => void)[] = [];
    host.document.getFileAsync.mockImplementation((_type, _options, result) => {
      if (open === 2) return result({ status: "failed", value: undefined!, error: { message: "Too many open files." } });
      most = Math.max(most, ++open);
      result({ status: "succeeded", value: {
        size: archive.length, sliceCount: 1,
        getSliceAsync: (index, done) => done({ status: "succeeded", value: { index, size: archive.length, data: [...archive] } }),
        // Office closes the file later, after the read has finished with it.
        closeAsync: done => closes.push(() => { open--; done({ status: "succeeded", value: undefined }); }),
      } });
    });
    const reads = [readOfficeDocument(host), readOfficeDocument(host), readOfficeDocument(host)];
    for (let index = 0; index < 3; index++) {
      await vi.waitFor(() => expect(closes).toHaveLength(index + 1));
      closes[index]!();
    }
    for (const read of reads) expect((await read).map(entry => entry.name)).toEqual(["a.xml"]);
    expect(most).toBe(1);
  });

  it.each([
    [true, "Office returned an incomplete document. Closing the Office document also failed. Close failed."],
    [false, "Close failed."],
  ])("reports the primary Office file error when close fails (incomplete=%s)", async (incomplete, message) => {
    const archive = zipSync({ "a.xml": strToU8("<a/>") });
    const host = office({ sets: ["CompressedFile 1.1"], archive });
    const close = vi.fn();
    host.document.getFileAsync.mockImplementation((_type, _options, result) => {
      result({ status: "succeeded", value: {
        size: archive.length, sliceCount: 1,
        getSliceAsync: (index, done) => done({
          status: "succeeded", value: { index, size: archive.length, data: incomplete ? [] : [...archive] },
        }),
        closeAsync: done => {
          close();
          done({ status: "failed", value: undefined, error: { message: "Close failed." } });
        },
      } });
    });
    await expect(readOfficeDocument(host)).rejects.toMatchObject({ message });
    expect(close).toHaveBeenCalledOnce();
  });
});

interface PptxOptions {
  rotation?: number; crop?: boolean; group?: boolean; noCarrier?: boolean;
  /** Attributes and children added to the picture's p:cNvPr. */
  properties?: { attributes?: string; children?: string };
  /** Children added to the picture's p:spPr after a:xfrm. */
  shapeProperties?: string;
  /** Extra slide relationships. */
  relationships?: string;
  /** Animate the picture (p:timing targeting spid 22). */
  animated?: boolean;
  /** The picture fills a slide layout placeholder (p:nvPicPr/p:nvPr/p:ph). */
  placeholder?: boolean;
  /** Repeat the picture in an mc:Choice and its mc:Fallback, as PowerPoint 2010 and later may write it. */
  alternate?: boolean;
}

function pptx({ rotation = 0, crop = false, group = false, noCarrier = false, properties = {}, shapeProperties = "",
  relationships = "", animated = false, placeholder = false, alternate = false }: PptxOptions = {}) {
  const picture = '<p:pic><p:nvPicPr><p:cNvPr id="22" name="Original figure"' + (properties.attributes ?? "") + '>' +
    (properties.children ?? "") + '</p:cNvPr>' +
    (placeholder ? '<p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="13"/></p:nvPr>' : "") + '</p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId7"/><a:srcRect' + (crop ? ' t="1000"' : "") + '/></p:blipFill>' +
    '<p:spPr><a:xfrm rot="' + rotation * 60000 + '"/>' + shapeProperties + '</p:spPr></p:pic>';
  const branches = alternate ? '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">' + picture +
    "</mc:Choice><mc:Fallback>" + picture + "</mc:Fallback></mc:AlternateContent>" : picture;
  const wrapped = group ? "<p:grpSp>" + branches + "</p:grpSp>" : branches;
  const timing = animated ? '<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:anim><p:cBhvr><p:tgtEl>' +
    '<p:spTgt spid="22"/></p:tgtEl></p:cBhvr></p:anim></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>' : "";
  const slide = '<p:sld xmlns:p="' + P + '" xmlns:a="' + A + '" xmlns:r="' + R +
    '"><p:cSld><p:spTree>' + wrapped + "</p:spTree></p:cSld>" + timing + "</p:sld>";
  const slideRels = '<Relationships xmlns="' + PKG_REL + '"><Relationship Id="rId7" Type="' + R +
    '/image" Target="../media/chemistry.png"/>' + relationships + '</Relationships>';
  return zipSync({
    "ppt/presentation.xml": strToU8('<p:presentation xmlns:p="' + P + '" xmlns:r="' + R +
      '"><p:sldIdLst><p:sldId id="307" r:id="rId2"/></p:sldIdLst></p:presentation>'),
    "ppt/_rels/presentation.xml.rels": strToU8(rels("rId2", "slide", "slides/slide4.xml")),
    "ppt/slides/slide4.xml": strToU8(slide),
    "ppt/slides/_rels/slide4.xml.rels": strToU8(slideRels),
    "ppt/media/chemistry.png": noCarrier ? plainPng : carrier,
    "ppt/media/unrelated.png": updated,
  });
}

interface HostOptions extends PptxOptions {
  version?: number;
  writableRotation?: boolean;
  /** The inserted picture's name cannot be written. */
  unwritableName?: boolean;
  /** Fail the nth context.sync() after the picture is inserted. */
  failSyncAfterInsert?: number;
  /** Insert a second, unrelated picture alongside the new one. */
  extraInsert?: boolean;
  /** Switch slides as the insert runs, and add an unrelated picture to the original slide. */
  insertOnOtherSlide?: boolean;
  /** Make the rollback unable to delete the inserted picture. */
  undeletable?: boolean;
  /** Make delete() of the old picture throw. */
  oldUndeletable?: boolean;
  /** Setting the inserted picture decorative clears its title and description. */
  decorativeClearsAltText?: boolean;
  /** PowerPoint ignores writes to the inserted picture's title and description. */
  ignoresAltTextWrites?: boolean;
}

function powerpointHost({ version = 10, writableRotation = true, unwritableName = false, failSyncAfterInsert, extraInsert = false,
  insertOnOtherSlide = false, undeletable = false, oldUndeletable = false, decorativeClearsAltText = false,
  ignoresAltTextWrites = false, ...pptxOptions }: HostOptions = {}) {
  const rotation = pptxOptions.rotation ?? 0;
  const archive = pptx(pptxOptions);
  const sets = ["CompressedFile 1.1", "ImageCoercion 1.1"];
  for (const minor of [5, 8, 10]) if (version >= minor) sets.push("PowerPointApi 1." + minor);
  const host = office({ sets, archive });
  type Shape = ReturnType<typeof shape>;
  const stack: Shape[] = [];
  const mutations: string[] = [];
  let syncsAfterInsert: number | undefined;
  function shape(id: string, name: string, initialRotation = 0) {
    const tags = collection<{ key: string; value: string }>([]);
    // PowerPointApi 1.10 alt-text properties; an inserted picture may arrive with generated alt text.
    const altText: { altTextTitle?: string; altTextDescription?: string; isDecorative?: boolean } =
      version >= 10 ? { altTextTitle: "", altTextDescription: "Generated description", isDecorative: false } : {};
    return {
      id, name, type: "Image", left: 27, top: 16, width: 300, height: 150, rotation: initialRotation, ...altText,
      setHyperlink: vi.fn(),
      get zOrderPosition(): number { return stack.indexOf(this); },
      load: vi.fn(),
      tags: { ...tags, add: (key: string, value: string) => tags.items.push({ key, value }) },
      setZOrder: vi.fn((direction: "BringForward" | "SendBackward"): void => {
        const index = stack.indexOf(stack.find(item => item.id === id)!);
        const [item] = stack.splice(index, 1);
        stack.splice(direction === "SendBackward" ? index - 1 : index + 1, 0, item!);
        mutations.push("stack");
      }),
      delete: vi.fn((): void => {
        if (undeletable && id !== "22") throw new Error("Cannot delete.");
        if (oldUndeletable && id === "22") throw new Error("Cannot delete the old picture.");
        const index = stack.findIndex(item => item.id === id);
        stack.splice(index, 1);
        mutations.push("delete:" + id);
      }),
    };
  }
  function collection<T>(items: T[]) {
    return { items, load() { return this; } };
  }
  const old = shape("22", "Original figure", rotation);
  if (!writableRotation) Object.defineProperty(old, "rotation", { writable: false });
  old.tags.add("ORIGINAL", "keep");
  stack.push(shape("21", "Behind"), old, shape("23", "Front"));
  const slide = { id: "307", shapes: collection(stack), exportAsBase64: vi.fn(() => ({ value: b64(archive) })) };
  const otherSlide = { ...slide, id: "308", shapes: collection<Shape>([]) };
  let activeSlide = slide;
  const getSelectedSlides = vi.fn(() => collection([activeSlide]));
  const powerpoint = { run: async work => work({
    presentation: {
      getSelectedShapes: () => collection([old]), getSelectedSlides,
      slides: { getItem: id => id === otherSlide.id ? otherSlide : slide },
    }, sync: async () => {
      if (syncsAfterInsert === undefined) return;
      if (++syncsAfterInsert === failSyncAfterInsert) throw new Error("PowerPoint sync failed.");
    },
  }) } satisfies PowerPointApi;
  host.document.setSelectedDataAsync.mockImplementation(
    (_base64: string, options: Parameters<OfficeDocument["setSelectedDataAsync"]>[1], done: Parameters<OfficeDocument["setSelectedDataAsync"]>[2]) => {
      const inserted = { ...shape("24", "Inserted"), ...{ left: options.imageLeft, top: options.imageTop, width: options.imageWidth, height: options.imageHeight },
        get zOrderPosition(): number { return stack.indexOf(this); },
      };
      if (unwritableName) Object.defineProperty(inserted, "name", { writable: false });
      if (decorativeClearsAltText) {
        let decorative = inserted.isDecorative;
        Object.defineProperty(inserted, "isDecorative", {
          get: () => decorative,
          set(value: boolean) {
            decorative = value;
            if (value) Object.assign(inserted, { altTextTitle: "", altTextDescription: "" });
          },
        });
      }
      if (ignoresAltTextWrites) {
        for (const key of ["altTextTitle", "altTextDescription"] as const) {
          const kept = inserted[key];
          Object.defineProperty(inserted, key, { get: () => kept, set: () => undefined });
        }
      }
      if (insertOnOtherSlide) activeSlide = otherSlide;
      activeSlide.shapes.items.push(inserted);
      if (extraInsert || insertOnOtherSlide) {
        stack.push({ ...shape("25", "Unrelated"), left: 400, get zOrderPosition() { return stack.indexOf(this); } });
      }
      mutations.push("insert");
      syncsAfterInsert = 0;
      done({ status: "succeeded", value: undefined });
    });
  return { host, powerpoint, slide, otherSlide, getSelectedSlides, old, stack, mutations };
}

const replacementShapeKey = JSON.stringify(["307", "24"]);

describe("PowerPoint Office adapter", () => {
  it("uses slide export, replaces at the same width, and restores rotation, name, z-order and tags", async () => {
    const { host, powerpoint, slide, stack, mutations } = powerpointHost({ rotation: 35 });
    const adapter = powerpointAdapter(host, powerpoint);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(slide.exportAsBase64).toHaveBeenCalledOnce();
    expect(host.document.getFileAsync).not.toHaveBeenCalled();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: replacementShapeKey });
    expect(host.document.setSelectedDataAsync).toHaveBeenCalledWith(b64(updated), {
      coercionType: "image", imageLeft: 27, imageTop: 16, imageWidth: 300, imageHeight: 100,
    }, expect.any(Function));
    expect(mutations).toEqual(["insert", "stack", "delete:22"]);
    expect(stack.map(item => item.id)).toEqual(["21", "24", "23"]);
    expect(stack[1]).toMatchObject({
      name: "Original figure", rotation: 35,
      tags: { items: [{ key: "ORIGINAL", value: "keep" }, { key: "CHEMDRAFT", value: "1" }] },
    });
  });

  it("reads older PowerPoint via the compressed file and refuses its updates", async () => {
    const { host, powerpoint, slide } = powerpointHost({ version: 5 });
    const adapter = powerpointAdapter(host, powerpoint);
    expect(await adapter.readSelectedStructure()).toMatchObject({
      kind: "structure", json: sourceJson, updateRefusal: expect.stringContaining("newer PowerPoint"),
    });
    expect(slide.exportAsBase64).not.toHaveBeenCalled();
    expect(host.document.getFileAsync).toHaveBeenCalledOnce();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("newer PowerPoint"),
    });
    expect(host.document.setSelectedDataAsync).not.toHaveBeenCalled();
  });

  it("uses the full presentation if slide export fails", async () => {
    const { host, powerpoint, slide } = powerpointHost();
    slide.exportAsBase64.mockImplementation(() => { throw new Error("Cannot export slide."); });
    expect(await powerpointAdapter(host, powerpoint).readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(host.document.getFileAsync).toHaveBeenCalledOnce();
  });

  it.each([
    [{ crop: true }, /cropped/i],
    [{ group: true }, /grouped/i],
    [{ noCarrier: true }, /no ChemDraft carrier/i],
    [{ version: 3 }, /PowerPointApi 1.5/],
  ] as const)("refuses unsafe PowerPoint selections and unsupported hosts", async (options, reason) => {
    const { host, powerpoint } = powerpointHost(options);
    const adapter = powerpointAdapter(host, powerpoint);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "refusal", reason: expect.stringMatching(reason) });
    expect(host.document.setSelectedDataAsync).not.toHaveBeenCalled();
  });

  it.each([{ version: 8 }, { writableRotation: false }])("refuses to drop a rotation PowerPoint cannot write", async options => {
    const { host, powerpoint, stack } = powerpointHost({ rotation: 20, ...options });
    const adapter = powerpointAdapter(host, powerpoint);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("rotation"),
    });
    expect(host.document.setSelectedDataAsync).not.toHaveBeenCalled();
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23"]);
  });
  const link = '<a:hlinkClick r:id="rId9" tooltip="Reference"/>';
  const linkRel = '<Relationship Id="rId9" Type="' + R + '/hyperlink" Target="https://example.org/benzene" TargetMode="External"/>';

  it("keeps alt text, the decorative flag and a plain link, and warns about animations", async () => {
    const { host, powerpoint, stack } = powerpointHost({
      properties: { attributes: ' title="Benzene" descr="A benzene ring"', children: link },
      relationships: linkRel, animated: true,
    });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: animations."],
    });
    const inserted = stack.find(item => item.id === "24")!;
    expect(inserted).toMatchObject({ altTextTitle: "Benzene", altTextDescription: "A benzene ring", isDecorative: false });
    expect(inserted.setHyperlink).toHaveBeenCalledWith({ address: "https://example.org/benzene", screenTip: "Reference" });
    expect(stack.map(item => item.id)).toEqual(["21", "24", "23"]);
  });

  it("clears generated alt text and keeps a decorative picture decorative", async () => {
    const decorative = '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative ' +
      'xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';
    const { host, powerpoint, stack } = powerpointHost({ properties: { children: decorative } });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: replacementShapeKey });
    expect(stack.find(item => item.id === "24")).toMatchObject({ altTextTitle: "", altTextDescription: "", isDecorative: true });
  });

  it("updates a decorative picture whose alt text PowerPoint did not keep and warns about it", async () => {
    const decorative = '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative ' +
      'xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';
    const { host, powerpoint, stack } = powerpointHost({
      properties: { attributes: ' title="Benzene" descr="A benzene ring"', children: decorative }, decorativeClearsAltText: true,
    });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: its alt text."],
    });
    expect(stack.map(item => item.id)).toEqual(["21", "24", "23"]);
  });

  it("warns that the name was not carried over when PowerPoint cannot write the picture's name", async () => {
    const { host, powerpoint, stack } = powerpointHost({ unwritableName: true });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: its name."],
    });
    expect(stack.map(item => item.id)).toEqual(["21", "24", "23"]);
  });

  it("refuses a non-decorative picture whose alt text PowerPoint did not keep and removes the new picture", async () => {
    const { host, powerpoint, stack } = powerpointHost({
      properties: { attributes: ' title="Benzene" descr="A benzene ring"' }, ignoresAltTextWrites: true,
    });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("could not preserve the picture’s alt text"),
    });
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23"]);
  });

  it("keeps a decorative picture's alt text when PowerPoint keeps it", async () => {
    const decorative = '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative ' +
      'xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';
    const { host, powerpoint, stack } = powerpointHost({
      properties: { attributes: ' title="Benzene" descr="A benzene ring"', children: decorative },
    });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: replacementShapeKey });
    expect(stack.find(item => item.id === "24")).toMatchObject({
      altTextTitle: "Benzene", altTextDescription: "A benzene ring", isDecorative: true,
    });
  });

  it("names a slide layout placeholder in the warning after Update", async () => {
    const { host, powerpoint, stack } = powerpointHost({ placeholder: true });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: its place in the slide layout (placeholder)."],
    });
    expect(stack.map(item => item.id)).toEqual(["21", "24", "23"]);
  });

  it("warns about alt text and a link PowerPoint before PowerPointApi 1.10 cannot write", async () => {
    const { host, powerpoint, stack } = powerpointHost({
      version: 8, properties: { attributes: ' descr="A benzene ring"', children: link }, relationships: linkRel,
    });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: its alt text, its link."],
    });
    expect(stack.find(item => item.id === "24")!.setHyperlink).not.toHaveBeenCalled();
  });

  it("names actions, mouse-over actions, borders and effects it cannot carry over", async () => {
    const { host, powerpoint } = powerpointHost({
      properties: { attributes: ' hidden="1"', children: '<a:hlinkClick r:id="" action="ppaction://macro?name=Run"/><a:hlinkHover r:id="" action="ppaction://noaction"/>' },
      shapeProperties: '<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln><a:effectLst><a:outerShdw/></a:effectLst>',
    });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
      kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: its action setting, its mouse-over action, " +
        "its hidden setting, its border and effects."],
    });
  });

  it("does not warn about an outline with no fill or an empty effect list", async () => {
    const { host, powerpoint } = powerpointHost({ shapeProperties: '<a:ln><a:noFill/></a:ln><a:effectLst/>' });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: replacementShapeKey });
  });

  it("reads a picture repeated in an mc:Choice and its mc:Fallback, counting only the selected branch", async () => {
    const { host, powerpoint } = powerpointHost({ alternate: true });
    const adapter = powerpointAdapter(host, powerpoint);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: replacementShapeKey });
  });

  it("names a picture shape other than a rectangle in the warning after Update", async () => {
    for (const geometry of ['<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
      '<a:custGeom><a:pathLst><a:path w="1" h="1"><a:close/></a:path></a:pathLst></a:custGeom>']) {
      const { host, powerpoint } = powerpointHost({ shapeProperties: geometry });
      const adapter = powerpointAdapter(host, powerpoint);
      await adapter.readSelectedStructure();
      expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({
        kind: "replaced", key: replacementShapeKey, warnings: ["Not carried over from the old picture: its picture shape."],
      });
    }
    const { host, powerpoint } = powerpointHost({ shapeProperties: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced", key: replacementShapeKey });
  });

  it("removes the inserted picture when the sync after the ID is learned fails", async () => {
    const { host, powerpoint, stack, mutations } = powerpointHost({ failSyncAfterInsert: 2 });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("PowerPoint sync failed."),
    });
    expect(mutations).toContain("delete:24");
    expect(mutations).not.toContain("delete:22");
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23"]);
  });

  it("refuses to insert when the active PowerPoint slide changes before insertion", async () => {
    const { host, powerpoint, slide, otherSlide, getSelectedSlides, mutations } = powerpointHost();
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    const slides = getSelectedSlides();
    getSelectedSlides.mockReturnValueOnce(slides).mockReturnValueOnce(slides)
      .mockReturnValueOnce({ ...slides, items: [otherSlide] });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("selection changed"),
    });
    expect(host.document.setSelectedDataAsync).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
    expect(slide.shapes.items.map(item => item.id)).toEqual(["21", "22", "23"]);
  });

  it("deletes neither picture when insertion switches slides and an unrelated picture appears on the original slide", async () => {
    const { host, powerpoint, otherSlide, stack, mutations } = powerpointHost({ insertOnOtherSlide: true });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringMatching(/active PowerPoint slide changed.*delete it by hand/),
    });
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23", "25"]);
    expect(otherSlide.shapes.items.map(item => item.id)).toEqual(["24"]);
    expect(mutations).toEqual(["insert"]);
  });

  it("leaves the inserted picture and asks the user to delete it when the first sync fails before its ID is learned", async () => {
    // Changed from "removes the inserted picture when sync 1 after the insert fails": that case was
    // rolled back by the exact-placement fallback the owner retired on 2026-11-22.
    const { host, powerpoint, stack, mutations } = powerpointHost({ failSyncAfterInsert: 1 });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("Couldn't find the inserted structure to remove — delete it by hand."),
    });
    expect(mutations.filter(mutation => mutation.startsWith("delete:"))).toEqual([]);
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23", "24"]);
  });

  it("removes the inserted picture when deleting the old one throws", async () => {
    const { host, powerpoint, stack, mutations } = powerpointHost({ oldUndeletable: true });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    const result = await adapter.replaceSelectedStructure(updated, updateJson, size);
    expect(result).toMatchObject({ kind: "refusal", reason: expect.stringContaining("Cannot delete the old picture.") });
    expect(result).not.toMatchObject({ reason: expect.stringContaining("Check the slide") });
    expect(mutations).toContain("delete:24");
    // Exactly one picture remains: the old one, in its place.
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23"]);
  });

  it("deletes only the inserted picture, found by its ID, and nothing else", async () => {
    const { host, powerpoint, stack, mutations } = powerpointHost({ failSyncAfterInsert: 2 });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    await adapter.replaceSelectedStructure(updated, updateJson, size);
    expect(mutations.filter(mutation => mutation.startsWith("delete:"))).toEqual(["delete:24"]);
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23"]);
  });

  it("deletes nothing and tells the user to delete by hand when the inserted picture's ID is unknown, even with a shape at its exact placement", async () => {
    // Two new pictures, so the update cannot tell which is its own; shape 24 sits at the exact
    // placement the insert asked for, which the retired fallback would have deleted.
    const { host, powerpoint, stack, mutations } = powerpointHost({ extraInsert: true });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    const result = await adapter.replaceSelectedStructure(updated, updateJson, size);
    expect(result).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("Couldn't find the inserted structure to remove — delete it by hand."),
    });
    expect(result).not.toMatchObject({ reason: expect.stringContaining("may remain") });
    expect(mutations.filter(mutation => mutation.startsWith("delete:"))).toEqual([]);
    expect(stack.map(item => item.id)).toEqual(["21", "22", "23", "24", "25"]);
  });

  it("says the new picture may remain when the rollback cannot remove it", async () => {
    const { host, powerpoint, stack } = powerpointHost({ failSyncAfterInsert: 2, undeletable: true });
    const adapter = powerpointAdapter(host, powerpoint);
    await adapter.readSelectedStructure();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toMatchObject({
      kind: "refusal", reason: expect.stringContaining("may remain on the slide"),
    });
    expect(stack.map(item => item.id)).toContain("22");
  });
});
