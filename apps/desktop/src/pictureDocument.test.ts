import { describe, expect, it } from "vitest";
import { applyPatch, type GraphicObject } from "@chemdraft/chem-core";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import {
  applyClipboardPastePayload, createNativeSavePayload, createPhase4Document,
  insertNativeTemplateMolecule, moveDocumentObjects, openNativeDocument, scaleDocumentObjectsAroundPoint
} from "./documentWorkflow";
import { picturePngBase64, pictureSvg } from "./testSupport/imageFixture";

describe("picture native document round trip", () => {
  it.each([
    ["image/png", picturePngBase64],
    ["image/svg+xml", btoa(pictureSvg)]
  ] as const)("preserves %s bytes, metadata and an edited frame beside real chemistry", (type, bytesBase64) => {
    const original = insertNativeTemplateMolecule(createPhase4Document("Picture Save"), { x: 500, y: 300 }, "benzene");
    const molecule = original.pages[0]!.objects.find(object => object.type === "molecule")!;
    const pasteResult = applyClipboardPastePayload(original, inspectClipboardPayload({
      types: [type], textItems: [], imageItems: [{ type, bytesBase64 }]
    }), { x: 200, y: 200 });
    expect(pasteResult.status).toBe("Pasted picture");
    const pasted = pasteResult.document;
    const image = pasted.pages[0]!.objects.find((object): object is GraphicObject =>
      object.type === "graphic" && object.graphicKind === "image")!;
    expect(image).toBeDefined();
    const id = image.id;
    expect(pasteResult.selectedObjectId).toBe(id);
    expect(pasted.selection.objectIds).toEqual([id]);
    const moved = moveDocumentObjects(pasted, [id], 17, 23);
    const resized = scaleDocumentObjectsAroundPoint(moved, [id], { x: 217, y: 223 }, 2, 3);
    const rotated = applyPatch(resized, { op: "updateObject", objectId: id, changes: { rotation: 30 } });
    const expectedImage = rotated.pages[0]!.objects.find(object => object.id === id)!;
    expect(expectedImage).toMatchObject({
      type: "graphic", graphicKind: "image",
      x: 217 - image.width, y: 223 - image.height * 1.5,
      width: image.width * 2, height: image.height * 3, rotation: 30,
      data: { image: { mimeType: type, dataBase64: bytesBase64, pixelWidth: 144, pixelHeight: 72 } }
    });
    const saved = createNativeSavePayload(rotated);
    const reopened = openNativeDocument(saved.contents);

    expect(saved.filename).toBe("Picture-Save.chemdraft");
    expect(reopened.document).toBeDefined();
    expect(reopened.document!.pages[0]!.objects).toHaveLength(2);
    expect(reopened.document!.pages[0]!.objects.find(object =>
      object.id === id && object.type === "graphic" && object.graphicKind === "image")).toEqual(expectedImage);
    expect(reopened.document!.pages[0]!.objects.find(object => object.id === molecule.id)).toEqual(molecule);
  });
});
