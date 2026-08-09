import { describe, expect, it } from "vitest";
import type { GraphicObject } from "@chemdraft/chem-core";
import {
  applyGraphicObjectMarkerKindToSelection,
  applyGraphicObjectMarkerSizeToSelection,
  createPhase4Document,
  graphicObjectSupportsMarkers,
  insertNativeArtGraphicObject
} from "./documentWorkflow";
import type { ChemDraftDocument } from "@chemdraft/chem-core";

function insertSelected(commandId: string): ChemDraftDocument {
  return insertNativeArtGraphicObject(createPhase4Document(`Markers ${commandId}`), { x: 220, y: 180 }, commandId);
}

function selectedGraphic(document: ChemDraftDocument): GraphicObject {
  const object = document.pages[0].objects.find(
    (candidate): candidate is GraphicObject =>
      candidate.type === "graphic" && document.selection.objectIds.includes(candidate.id)
  );
  if (!object) {
    throw new Error("Expected a selected graphic.");
  }
  return object;
}

describe("graphicObjectSupportsMarkers", () => {
  it("accepts arrows (including equilibrium) and rejects closed shapes and retro arrows", () => {
    expect(graphicObjectSupportsMarkers(selectedGraphic(insertSelected("tool.art.reactionArrow")))).toBe(true);
    expect(graphicObjectSupportsMarkers(selectedGraphic(insertSelected("tool.art.equilibriumArrow")))).toBe(true);
    expect(graphicObjectSupportsMarkers(selectedGraphic(insertSelected("tool.art.rect")))).toBe(false);
    // Retro "⇒" heads are path geometry, not markers — a marker command would draw a second head.
    expect(graphicObjectSupportsMarkers(selectedGraphic(insertSelected("tool.art.retroArrow")))).toBe(false);
    expect(graphicObjectSupportsMarkers(undefined)).toBe(false);
  });
});

describe("applyGraphicObjectMarkerKindToSelection", () => {
  it("adds a tail head seeded from the end head's size", () => {
    const document = insertSelected("tool.art.reactionArrowBold"); // markerEnd filled-arrow 24
    const next = applyGraphicObjectMarkerKindToSelection(document, "markerStart", "half-arrow");
    const arrow = selectedGraphic(next);
    expect(arrow.data.markerStart).toEqual({ kind: "half-arrow", sizePx: 24 });
    expect(arrow.data.markerEnd).toEqual({ kind: "filled-arrow", sizePx: 24 });
  });

  it("swaps an existing head's kind while keeping its size", () => {
    const document = insertSelected("tool.art.reactionArrow"); // markerEnd filled-arrow 16
    const next = applyGraphicObjectMarkerKindToSelection(document, "markerEnd", "bar");
    expect(selectedGraphic(next).data.markerEnd).toEqual({ kind: "bar", sizePx: 16 });
  });

  it("deletes the marker key for kind none instead of storing {kind: \"none\"}", () => {
    const document = insertSelected("tool.art.resonanceArrow"); // both heads
    const next = applyGraphicObjectMarkerKindToSelection(document, "markerStart", "none");
    const arrow = selectedGraphic(next);
    expect("markerStart" in arrow.data).toBe(false);
    expect(arrow.data.markerEnd?.kind).toBe("filled-arrow");
  });

  it("is a no-op (same document) when nothing changes or the object cannot carry markers", () => {
    const arrowDocument = insertSelected("tool.art.reactionArrow");
    expect(applyGraphicObjectMarkerKindToSelection(arrowDocument, "markerEnd", "filled-arrow")).toBe(arrowDocument);
    expect(applyGraphicObjectMarkerKindToSelection(arrowDocument, "markerStart", "none")).toBe(arrowDocument);
    const rectDocument = insertSelected("tool.art.rect");
    expect(applyGraphicObjectMarkerKindToSelection(rectDocument, "markerEnd", "filled-arrow")).toBe(rectDocument);
  });
});

describe("applyGraphicObjectMarkerSizeToSelection", () => {
  it("snaps to the 4px handle steps and sets both heads together", () => {
    const document = insertSelected("tool.art.equilibriumArrow"); // half-arrow 14 both ends
    const next = applyGraphicObjectMarkerSizeToSelection(document, 22); // snaps to 24
    const arrow = selectedGraphic(next);
    expect(arrow.data.markerStart?.sizePx).toBe(24);
    expect(arrow.data.markerEnd?.sizePx).toBe(24);
  });

  it("leaves bare ends bare and ignores marker-incapable graphics", () => {
    const arrowDocument = insertSelected("tool.art.reactionArrow"); // no markerStart
    const resized = applyGraphicObjectMarkerSizeToSelection(arrowDocument, 32);
    const arrow = selectedGraphic(resized);
    expect("markerStart" in arrow.data).toBe(false);
    expect(arrow.data.markerEnd?.sizePx).toBe(32);

    const rectDocument = insertSelected("tool.art.rect");
    expect(applyGraphicObjectMarkerSizeToSelection(rectDocument, 32)).toBe(rectDocument);
  });
});
