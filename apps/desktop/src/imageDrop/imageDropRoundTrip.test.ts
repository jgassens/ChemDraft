// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPatch, createDocumentHistory, redo, undo, type ChemDraftDocument, type GraphicObject
} from "@chemdraft/chem-core";
import { planNativeArtVisual } from "@chemdraft/art-engine";
import {
  copyAsScopedDocument, createNativeSavePayload, createPhase4Document, createSelectionClipboardPayload,
  duplicateSelectedDocumentObjects, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg, insertNativeTemplateMolecule,
  moveDocumentObjects, openNativeDocument, parseSelectionClipboardPayload, pasteSelectionClipboardPayload,
  scaleDocumentObjectsAroundPoint, selectDocumentObjects, serializeSelectionClipboardPayload
} from "../documentWorkflow";
import { createDocumentFileSave } from "../documentFileFormats";
import { graphicArtTransformPreviewSvgDataUrl } from "../MainWindow";
import { rasterizeSvgNative } from "../nativeRasterExport";
import { rasterPicturePlaceholderHref, readPngSize } from "../rasterPictureDecode";
import { picturePngBase64 } from "../testSupport/imageFixture";
import { insertDroppedImages } from "./insertDroppedImages";
import { prepareDroppedImage, type PreparedDroppedImage } from "./prepareDroppedImage";
import type { DroppedImageDecoders } from "./rasterDecode";
import { PNG_1X1_BASE64, jpegHeader, pngBytes, svgBytes } from "./testFixtures";

const native = vi.hoisted(() => ({ invoke: vi.fn(), rasterized: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke }));
// The webview rasteriser (jsdom has no canvas): one fixed PNG, recording what it was asked for.
vi.mock("../svgPicture/svgPictureRaster", () => ({ rasterizeSvgPicture: native.rasterized }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
const PICTURE_PNG = bytesOf(picturePngBase64);

/** An SVG that carries its own bitmap, plus a script the sanitiser must drop. */
const BITMAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><script>alert(1)</script>`
  + `<image href="data:image/png;base64,${PNG_1X1_BASE64}" width="60" height="30"/></svg>`;

/** The webview's decoders: the JPEG converter returns a real 1 × 1 PNG, and every check decodes. */
const decoders: DroppedImageDecoders = {
  rasterToPng: async () => ({ png: pngBytes(), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, downscaled: false }),
  rasterToJpeg: async () => { throw new Error("no JPEG here is over the side cap"); },
  decodeCheck: async () => ({ width: 1, height: 1 })
};

async function prepared(name: string, bytes: Uint8Array): Promise<PreparedDroppedImage> {
  const result = await prepareDroppedImage(name, bytes, decoders);
  if (!result.ok) throw new Error(result.reason);
  return result.image;
}

const pictures = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");

interface Scene { base: ChemDraftDocument; dropped: ChemDraftDocument; edited: ChemDraftDocument; ids: string[] }

/** Benzene, then a PNG, a JPEG-turned-PNG and a sanitised SVG dropped as one batch, then each one edited. */
async function scene(): Promise<Scene> {
  const base = insertNativeTemplateMolecule(createPhase4Document("Round trip"), { x: 500, y: 300 }, "benzene");
  const images = [await prepared("a.png", PICTURE_PNG), await prepared("b.jpg", jpegHeader(8, 8)),
    await prepared("c.svg", svgBytes(BITMAP_SVG))];
  expect(images.map(image => image.mimeType)).toEqual(["image/png", "image/png", "image/svg+xml"]);
  expect(atob(images[2]!.dataBase64)).not.toContain("script");
  const { document: dropped, objectIds: ids } = insertDroppedImages(base, images, { x: 200, y: 200 });
  // Move, resize and rotate, differently for each picture.
  let edited = moveDocumentObjects(dropped, [ids[0]!], 17, 23);
  edited = scaleDocumentObjectsAroundPoint(edited, [ids[1]!], { x: 224, y: 224 }, 30, 20);
  edited = scaleDocumentObjectsAroundPoint(edited, [ids[2]!], { x: 300, y: 300 }, 1.5, 0.5);
  edited = applyPatch(edited, { op: "updateObject", objectId: ids[0]!, changes: { rotation: 30 } });
  edited = applyPatch(edited, { op: "updateObject", objectId: ids[2]!, changes: { rotation: -45 } });
  return { base, dropped, edited: selectDocumentObjects(edited, edited.pages[0]!.id, ids), ids };
}

describe("a dropped picture through save, reopen and export", () => {
  it("starts from three distinct, edited pictures beside the chemistry", async () => {
    const { edited, ids } = await scene();
    expect(pictures(edited).map(object => object.id)).toEqual(ids);
    expect(pictures(edited).map(object => object.rotation)).toEqual([30, 0, -45]);
    expect(new Set(pictures(edited).map(object => `${object.width}x${object.height}`)).size).toBe(3);
  });

  it("(a) .chemdraft save keeps every picture, in order, with no picture warning, and reopens deep-equal", async () => {
    const { edited, ids } = await scene();
    const saved = createDocumentFileSave(edited, "/drawings/dropped.chemdraft");
    expect(saved.warnings.map(warning => warning.code)).not.toContain("cdxml.picture_not_saved");
    if (saved.kind !== "text") throw new Error("Expected the CDXML envelope");
    const reopened = openNativeDocument(saved.contents).document!;
    expect(pictures(reopened)).toEqual(pictures(edited));
    expect(reopened.pages[0]!.objects.map(object => object.id)).toEqual(edited.pages[0]!.objects.map(object => object.id));
    expect(reopened.pages[0]!.objects.at(-1)!.id).toBe(ids.at(-1));
    const objectIds = new Set(reopened.pages[0]!.objects.map(object => object.id));
    expect(reopened.selection.objectIds.every(id => objectIds.has(id))).toBe(true);
  });

  it("(a) still warns for a picture with no data, which a .chemdraft cannot keep", async () => {
    const { edited, ids } = await scene();
    const emptied = applyPatch(edited, { op: "updateObject", objectId: ids[0]!, changes: { data: {} } });
    const warnings = createDocumentFileSave(emptied, "/drawings/dropped.chemdraft").warnings
      .filter(warning => warning.code === "cdxml.picture_not_saved") as Array<{ sourceObjectId?: string }>;
    expect(warnings.map(warning => warning.sourceObjectId)).toEqual([ids[0]]);
  });

  it("(b) CDXML export carries the pictures in its embedded data, says so, and reopens deep-equal", async () => {
    const { edited, ids } = await scene();
    const exported = exportPhase4Cdxml(edited);
    const notes = exported.warnings.filter(warning => warning.code === "cdxml.picture_not_saved");
    expect(notes.map(warning => warning.objectId).sort()).toEqual([...ids].sort());
    expect(notes.every(warning => warning.message.includes("is kept for ChemDraft in this file's embedded ChemDraft data"))).toBe(true);
    const reopened = openNativeDocument(exported.contents).document!;
    expect(pictures(reopened)).toEqual(pictures(edited));
    expect(reopened.pages[0]!.objects.map(object => object.id)).toEqual(edited.pages[0]!.objects.map(object => object.id));
  });

  it("(c) SVG export draws each picture as an <image href=data:...> on its frame; the canvas draws the same frame", async () => {
    const { edited } = await scene();
    const page = edited.pages[0]!;
    const parse = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml");
    // Pixel output keeps native units: the frame is the object's own.
    const exact = parse((await exportPhase4Svg(edited, { outputWidth: page.width, outputHeight: page.height })).contents);
    // The default output is physical: the frame keeps its centre and takes the documented physical size.
    const physical = parse((await exportPhase4Svg(edited)).contents);
    for (const object of pictures(edited)) {
      const href = `data:${object.data.image!.mimeType};base64,${object.data.image!.dataBase64}`;
      const find = (svg: Document) => Array.from(svg.getElementsByTagName("image")).filter(image => image.getAttribute("href") === href);
      expect(find(exact)).toHaveLength(1);
      const [image] = find(exact);
      const frame = ["x", "y", "width", "height"].map(name => Number(image!.getAttribute(name)));
      expect(frame).toEqual([object.x, object.y, object.width, object.height]);
      expect(image!.getAttribute("data-chemdraft-picture-frame")).toBe(`${object.x} ${object.y} ${object.width} ${object.height} ${object.rotation}`);
      expect(image!.getAttribute("preserveAspectRatio")).toBe("none");
      expect(image!.parentElement!.getAttribute("data-object-id")).toBe(object.id);

      // Canvas side: the glyph is `viewBox 0 0 width height` stretched over the object's frame.
      const glyph = graphicArtTransformPreviewSvgDataUrl(object)!;
      expect(glyph.imageUrl).toBe(href);
      expect([glyph.width, glyph.height]).toEqual([object.width, object.height]);
      const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
      expect([plan.width, plan.height]).toEqual([object.width, object.height]);

      const [physicalImage] = find(physical);
      const placed = ["x", "y", "width", "height"].map(name => Number(physicalImage!.getAttribute(name)));
      expect(placed[0]! + placed[2]! / 2).toBeCloseTo(object.x + object.width / 2, 6);
      expect(placed[1]! + placed[3]! / 2).toBeCloseTo(object.y + object.height / 2, 6);
      expect(placed[2]! / placed[3]!).toBeCloseTo(object.width / object.height, 6);
      expect(physicalImage!.getAttribute("data-chemdraft-picture-frame")).toBe(image!.getAttribute("data-chemdraft-picture-frame"));
    }
  });

  it("(d) PDF export draws every picture with an injected rasteriser and reports no warnings", async () => {
    const { edited, ids } = await scene();
    const rasterizeSvgPicture = vi.fn(async () => PICTURE_PNG);
    const pdf = await exportPhase4Pdf(edited, { compress: false, rasterizeSvgPicture });
    expect(pdf.warnings).toEqual([]);
    expect(rasterizeSvgPicture).toHaveBeenCalledTimes(1);
    const request = (rasterizeSvgPicture.mock.calls[0] as unknown as [{ svg: string; width: number; height: number; pixelWidth: number }])[0];
    const svgPicture = pictures(edited).find(object => object.id === ids[2])!;
    expect(request).toMatchObject({ width: svgPicture.width, height: svgPicture.height });
    expect(request.svg).toBe(atob(svgPicture.data.image!.dataBase64));
    const text = new TextDecoder("latin1").decode(pdf.bytes);
    // Two distinct bitmaps (the native PNG and the 1 x 1 one) and the rasterised SVG, which equals the first.
    expect(text.match(/\/Subtype\s*\/Image/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text.match(/\/I\d+ Do/g)).toHaveLength(3);
  });

  it("(d) PDF export without a rasteriser (no webview canvas) still finishes and skips only the SVG picture", async () => {
    const { edited, ids } = await scene();
    const pdf = await exportPhase4Pdf(edited, { compress: false });
    expect(pdf.warnings.map(warning => [warning.code, warning.objectId])).toEqual([["export.pdf.svg_picture_not_drawn", ids[2]]]);
    expect(new TextDecoder("latin1").decode(pdf.bytes).match(/\/I\d+ Do/g)).toHaveLength(2);
  });

  it("(e) raster export preparation turns every picture, the SVG's embedded bitmap included, into supplied pixels", async () => {
    const { edited, ids } = await scene();
    // The decoder reports each PNG's own size, as the webview's does.
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
      const size = readPngSize(new Uint8Array(await blob.arrayBuffer()))!;
      return { ...size, close: vi.fn() };
    }));
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) };
      }
    });
    native.rasterized.mockResolvedValue(PICTURE_PNG);
    native.invoke.mockResolvedValue({ bytes: [1, 2, 3], width: 1, height: 1, warnings: [] });
    const svg = (await exportPhase4Svg(edited, { outputWidth: edited.pages[0]!.width, outputHeight: edited.pages[0]!.height })).contents;
    await rasterizeSvgNative(svg, "png", { scale: 2, background: "#ffffff" });

    // The SVG picture was rasterised once, at twice its frame (scale 2, pixel output), as its own bitmap needs.
    const svgPicture = pictures(edited).find(object => object.id === ids[2])!;
    expect(native.rasterized).toHaveBeenCalledTimes(1);
    expect(native.rasterized.mock.calls[0]![0]).toMatchObject({
      width: svgPicture.width, height: svgPicture.height,
      pixelWidth: Math.floor(svgPicture.width * 2), pixelHeight: Math.floor(svgPicture.height * 2)
    });
    const [command, { request }] = native.invoke.mock.calls.at(-1)!;
    expect(command).toBe("rasterize_svg");
    expect(request.pictures).toHaveLength(3);
    const sent = new DOMParser().parseFromString(request.svg, "image/svg+xml");
    const images = Array.from(sent.getElementsByTagName("image"));
    expect(images).toHaveLength(3);
    for (const [index, image] of images.entries()) {
      const picture = request.pictures[index];
      expect(image.getAttribute("id")).toBe(picture.id);
      expect(image.getAttribute("href")).toBe(rasterPicturePlaceholderHref(picture.width, picture.height, picture.id));
      const object = pictures(edited)[index]!;
      // Frame, transform and z-order are those of the document.
      expect(["x", "y", "width", "height"].map(name => Number(image.getAttribute(name)))).toEqual([object.x, object.y, object.width, object.height]);
      expect(image.parentElement!.getAttribute("data-object-id")).toBe(object.id);
    }
    expect(request.svg).not.toContain("data:image/svg+xml;base64");
  });

  it("(e) a picture whose rasterising fails keeps its SVG href, as before", async () => {
    const { edited } = await scene();
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => ({ ...readPngSize(new Uint8Array(await blob.arrayBuffer()))!, close: vi.fn() })));
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; }
    });
    native.rasterized.mockRejectedValue(new Error("the SVG could not be decoded"));
    native.invoke.mockResolvedValue({ bytes: [1], width: 1, height: 1, warnings: [] });
    const svg = (await exportPhase4Svg(edited)).contents;
    await rasterizeSvgNative(svg, "png", { scale: 1 });
    const { request } = native.invoke.mock.calls.at(-1)![1];
    expect(request.pictures).toHaveLength(2);
    expect(request.svg).toContain("data:image/svg+xml;base64,");
  });

  it("(f) Insert Image is one undo step that removes every picture and redo restores it identically", async () => {
    const { base, dropped } = await scene();
    // One entry for the whole drop, as the app commits it; the app's own history is covered in
    // MainWindow.imageDrop.dom.test.tsx.
    const history = { ...createDocumentHistory(base), past: [base], present: dropped };
    const undone = undo(history);
    expect(pictures(undone.present)).toEqual([]);
    expect(undone.present).toBe(base);
    expect(undone.present.selection.objectIds).toEqual(base.selection.objectIds);
    const redone = redo(undone);
    expect(redone.present).toBe(dropped);
    expect(pictures(redone.present)).toEqual(pictures(dropped));
    expect(redone.present.selection.objectIds).toEqual(dropped.selection.objectIds);
    expect(undo(redone).present).toBe(base);
  });

  it("(g) copy, paste and duplicate keep every picture: bytes, mime type, frame and rotation", async () => {
    const { edited, ids } = await scene();
    const payload = createSelectionClipboardPayload(edited)!;
    expect(payload.objects.filter(object => ids.includes(object.id))).toHaveLength(3);
    const parsed = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(payload))!;
    const emptyTarget = createPhase4Document("Paste target");
    const pasted = pictures(pasteSelectionClipboardPayload(emptyTarget, parsed, { x: 400, y: 300 }));
    const originals = pictures(edited);
    expect(pasted).toHaveLength(3);
    expect(new Set(pasted.map(object => object.id)).size).toBe(3);
    for (const [index, copy] of pasted.entries()) {
      const original = originals[index]!;
      expect(copy.data).toEqual(original.data);
      expect([copy.width, copy.height, copy.rotation]).toEqual([original.width, original.height, original.rotation]);
    }

    const duplicated = duplicateSelectedDocumentObjects(edited, { x: 24, y: 24 });
    const all = pictures(duplicated);
    expect(all).toHaveLength(6);
    const copies = all.filter(object => !ids.includes(object.id));
    expect(copies.map(object => object.data)).toEqual(originals.map(object => object.data));
    expect(copies.map(object => [object.x - 24, object.y - 24])).toEqual(originals.map(object => [object.x, object.y]));
    // The copies are real documents too: they save and reopen.
    expect(pictures(openNativeDocument(createNativeSavePayload(duplicated).contents).document!)).toEqual(all);
    // And the scoped copy used for Copy as Image keeps them.
    expect(pictures(copyAsScopedDocument(edited))).toHaveLength(3);
  });
});
