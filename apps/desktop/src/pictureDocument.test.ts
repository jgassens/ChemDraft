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
    const pasted = applyClipboardPastePayload(original, inspectClipboardPayload({
      types: [type], textItems: [], imageItems: [{ type, bytesBase64 }]
    }), { x: 200, y: 200 }).document;
    const id = pasted.selection.objectIds[0]!;
    const image = pasted.pages[0]!.objects.find(object => object.id === id) as GraphicObject;
    const moved = moveDocumentObjects(pasted, [id], 17, 23);
    const resized = scaleDocumentObjectsAroundPoint(moved, [id], { x: 217, y: 223 }, 2, 3);
    const rotated = applyPatch(resized, { op: "updateObject", objectId: id, changes: { rotation: 30 } });
    const expectedImage = rotated.pages[0]!.objects.find(object => object.id === id)!;
    const saved = createNativeSavePayload(rotated);
    const reopened = openNativeDocument(saved.contents);

    expect(saved.filename).toBe("Picture-Save.chemdraft");
    expect(reopened.document).toBeDefined();
    expect(reopened.document!.pages[0]!.objects.find(object => object.id === id)).toEqual(expectedImage);
    expect(expectedImage).toMatchObject({
      type: "graphic", graphicKind: "image", width: image.width * 2, height: image.height * 3,
      rotation: 30, data: { image: { mimeType: type, dataBase64: bytesBase64 } }
    });
    expect(reopened.document!.pages[0]!.objects.find(object => object.id === molecule.id)).toEqual(molecule);
  });
});
