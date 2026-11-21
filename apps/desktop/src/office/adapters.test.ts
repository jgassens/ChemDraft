// @vitest-environment jsdom
import { Resvg } from "@resvg/resvg-js";
import { flatOpcBinaryParts, pngWithChemDraftSelection } from "@chemdraft/clipboard-adapter";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { type OfficeContext, type OfficeDocument } from "./host";
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

function wordDocument({ floating = false, crop = false, group = false, text = "", id = 17 } = {}) {
  const placement = floating ? "anchor" : "inline";
  const props = '<wp:docPr id="' + id + '" name="Figure 1" descr="Figure description"/>';
  const picture = '<pic:pic><pic:blipFill><a:blip r:embed="rId7"/><a:srcRect' + (crop ? ' l="3500"' : '') +
    '/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3810000" cy="1905000"/></a:xfrm></pic:spPr></pic:pic>';
  const anchor = floating ? '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>317500</wp:posOffset></wp:positionH>' +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>127000</wp:posOffset></wp:positionV>' : "";
  return '<w:document xmlns:w="' + WORD + '" xmlns:wp="' + WP + '" xmlns:a="' + A + '" xmlns:r="' + R +
    '" xmlns:pic="' + PIC + '" xmlns:wp14="' + WP14 + '"><w:body><w:p><w:r>' + text + '<w:drawing><wp:' + placement +
    ' wp14:anchorId="2200ACD1"' + (floating ? ' distL="114300" relativeHeight="251658240"' : '') + '>' + anchor +
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
  const insertOoxml = vi.fn<(xml: string, location: "Replace") => void>();
  const word = { run: async work => work({ document: { getSelection: () => ({ getOoxml, insertOoxml }) },
    sync: async () => undefined }) } satisfies WordApi;
  return { word, getOoxml, insertOoxml };
}

describe("Word Office adapter", () => {
  it.each([false, true])("replaces an inline or floating picture without stretching (floating=%s)", async floating => {
    const { word, insertOoxml } = wordHost(flatOpc(wordDocument({ floating }), carrier));
    const adapter = wordAdapter(office({ sets: ["WordApi 1.1"] }), word);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced" });
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
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced" });
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
});

function pptx({ rotation = 0, crop = false, group = false, noCarrier = false } = {}) {
  const picture = '<p:pic><p:nvPicPr><p:cNvPr id="22" name="Original figure"/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId7"/><a:srcRect' + (crop ? ' t="1000"' : "") + '/></p:blipFill>' +
    '<p:spPr><a:xfrm rot="' + rotation * 60000 + '"/></p:spPr></p:pic>';
  const wrapped = group ? "<p:grpSp>" + picture + "</p:grpSp>" : picture;
  const slide = '<p:sld xmlns:p="' + P + '" xmlns:a="' + A + '" xmlns:r="' + R +
    '"><p:cSld><p:spTree>' + wrapped + "</p:spTree></p:cSld></p:sld>";
  return zipSync({
    "ppt/presentation.xml": strToU8('<p:presentation xmlns:p="' + P + '" xmlns:r="' + R +
      '"><p:sldIdLst><p:sldId id="307" r:id="rId2"/></p:sldIdLst></p:presentation>'),
    "ppt/_rels/presentation.xml.rels": strToU8(rels("rId2", "slide", "slides/slide4.xml")),
    "ppt/slides/slide4.xml": strToU8(slide),
    "ppt/slides/_rels/slide4.xml.rels": strToU8(rels("rId7", "image", "../media/chemistry.png")),
    "ppt/media/chemistry.png": noCarrier ? plainPng : carrier,
    "ppt/media/unrelated.png": updated,
  });
}

function powerpointHost({ rotation = 0, crop = false, group = false, noCarrier = false, version = 10, writableRotation = true } = {}) {
  const archive = pptx({ rotation, crop, group, noCarrier });
  const sets = ["CompressedFile 1.1", "ImageCoercion 1.1"];
  for (const minor of [5, 8, 10]) if (version >= minor) sets.push("PowerPointApi 1." + minor);
  const host = office({ sets, archive });
  type Shape = ReturnType<typeof shape>;
  const stack: Shape[] = [];
  const mutations: string[] = [];
  function shape(id: string, name: string, initialRotation = 0) {
    const tags = collection<{ key: string; value: string }>([]);
    return {
      id, name, type: "Image", left: 27, top: 16, width: 300, height: 150, rotation: initialRotation,
      get zOrderPosition() { return stack.indexOf(this); },
      load: vi.fn(),
      tags: { ...tags, add: (key: string, value: string) => tags.items.push({ key, value }) },
      setZOrder: vi.fn((direction: "BringForward" | "SendBackward") => {
        const index = stack.indexOf(stack.find(item => item.id === id)!);
        const [item] = stack.splice(index, 1);
        stack.splice(direction === "SendBackward" ? index - 1 : index + 1, 0, item!);
        mutations.push("stack");
      }),
      delete: vi.fn(() => {
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
  const powerpoint = { run: async work => work({
    presentation: {
      getSelectedShapes: () => collection([old]), getSelectedSlides: () => collection([slide]),
      slides: { getItem: () => slide },
    }, sync: async () => undefined,
  }) } satisfies PowerPointApi;
  host.document.setSelectedDataAsync.mockImplementation(
    (_base64: string, options: Parameters<OfficeDocument["setSelectedDataAsync"]>[1], done: Parameters<OfficeDocument["setSelectedDataAsync"]>[2]) => {
      stack.push({ ...shape("24", "Inserted"), ...{ left: options.imageLeft, top: options.imageTop, width: options.imageWidth, height: options.imageHeight },
        get zOrderPosition() { return stack.indexOf(this); },
      });
      mutations.push("insert");
      done({ status: "succeeded", value: undefined });
    });
  return { host, powerpoint, slide, old, stack, mutations };
}

describe("PowerPoint Office adapter", () => {
  it("uses slide export, replaces at the same width, and restores rotation, name, z-order and tags", async () => {
    const { host, powerpoint, slide, stack, mutations } = powerpointHost({ rotation: 35 });
    const adapter = powerpointAdapter(host, powerpoint);
    expect(await adapter.readSelectedStructure()).toMatchObject({ kind: "structure", json: sourceJson });
    expect(slide.exportAsBase64).toHaveBeenCalledOnce();
    expect(host.document.getFileAsync).not.toHaveBeenCalled();
    expect(await adapter.replaceSelectedStructure(updated, updateJson, size)).toEqual({ kind: "replaced" });
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
});
