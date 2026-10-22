import { describe, expect, it } from "vitest";
import { applyPatch, BracketObjectSchema, type BracketObject } from "@chemdraft/chem-core";
import { bracketGlyphPathD, pairedBracketGlyphPathD } from "@chemdraft/layout-engine";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { getDrawingToolDefinition } from "./drawingTools";
import { getToolsetCommandSpecs } from "./toolsets";
import {
  createPhase4Document, createNativeSavePayload, openNativeDocument,
  insertNativeBracket, insertNativeBracketPair, pairedBracketKindForToolCommand,
  insertNativeSingleBondMolecule, moveDocumentObject, scaleDocumentObjectsAroundPoint,
  updateNativeBracketPairLabel
} from "./documentWorkflow";

describe("paired brackets", () => {
  it.each(["n", "12", "5–10", "<n & m>"])("saves and exports the attached label %s", label => {
    const original = insertNativeBracketPair(createPhase4Document("Label"), { x: 100, y: 100 }, "square", { x: 300, y: 300 });
    const id = original.selection.objectIds[0];
    const doc = updateNativeBracketPairLabel(original, id, label);
    expect(doc.pages[0].objects[0]).toMatchObject({ label, x: 100, y: 100, width: 200, height: 200 });
    expect(openNativeDocument(createNativeSavePayload(doc).contents).document!.pages[0].objects[0]).toMatchObject({ label });
    const svg = exportDocumentToSvg(doc).contents;
    expect(svg).toContain('<text ');
    expect(svg).toContain('x="303" y="304"');
    expect(svg).toContain(label === "<n & m>" ? "&lt;n &amp; m&gt;" : label);
    expect(updateNativeBracketPairLabel(doc, id, label)).toBe(doc);
    const moved = moveDocumentObject(doc, id, { x: 20, y: 30 });
    expect(exportDocumentToSvg(moved).contents).toContain('x="223" y="234"');
    expect(exportDocumentToSvg(updateNativeBracketPairLabel(doc, id, "")).contents).not.toContain('<text ');
  });

  it("does not attach pair labels to legacy singles or missing objects", () => {
    const doc = insertNativeBracket(createPhase4Document("Single"), { x: 100, y: 100 }, "square");
    expect(updateNativeBracketPairLabel(doc, doc.selection.objectIds[0], "n")).toBe(doc);
    expect(updateNativeBracketPairLabel(doc, "missing", "n")).toBe(doc);
  });

  it.each([{}, { tiltXDegrees: 25, tiltYDegrees: 15 }])("rotates/projects the label with the pair (%j)", style => {
    let doc = insertNativeBracketPair(createPhase4Document("Transform label"), { x: 100, y: 100 }, "curly", { x: 300, y: 300 });
    const id = doc.selection.objectIds[0];
    doc = updateNativeBracketPairLabel(doc, id, "n");
    doc = applyPatch(doc, { op: "updateObject", objectId: id, changes: { rotation: 90, style } });
    const svg = exportDocumentToSvg(doc).contents;
    expect(svg).toMatch(/<text[^>]+transform="(?:rotate|matrix)\([^"]+"[^>]*>n<\/text>/);
    const resized = scaleDocumentObjectsAroundPoint(doc, [id], { x: 100, y: 100 }, 2, 2);
    expect(resized.pages[0].objects[0]).toMatchObject({ label: "n", width: 400, height: 400 });
    expect(exportDocumentToSvg(resized).contents).toContain('x="503" y="504"');
  });
  it.each(["square", "curly"] as const)("registers a separate %s pair tool", kind => {
    const id = kind === "square" ? "tool.pairedSquareBracket" : "tool.pairedCurlyBracket";
    expect(pairedBracketKindForToolCommand(id)).toBe(kind);
    expect(getDrawingToolDefinition(id)?.kind).toBe("bracket");
    expect(getToolsetCommandSpecs().some(spec => spec.id === id)).toBe(true);
    expect(pairedBracketKindForToolCommand("tool.squareBracket")).toBeUndefined();
    expect(pairedBracketKindForToolCommand("tool.bracket")).toBeUndefined();
  });

  it.each(["square", "curly"] as const)("places one editable %s pair and saves it intact", kind => {
    const doc = insertNativeBracketPair(createPhase4Document("Pair"), { x: 100, y: 120 }, kind, { x: 300, y: 280 });
    const pair = doc.pages[0].objects[0] as BracketObject;
    expect(pair).toMatchObject({ type: "bracket", paired: true, bracketKind: kind, x: 100, y: 120, width: 200, height: 160 });
    expect(doc.pages[0].objects).toHaveLength(1);
    expect(doc.selection.objectIds).toEqual([pair.id]);
    const reopened = openNativeDocument(createNativeSavePayload(doc).contents).document!;
    expect(reopened.pages[0].objects[0]).toEqual(pair);
    const path = pairedBracketGlyphPathD(kind, pair.width, pair.height);
    expect(path.match(/M /g)).toHaveLength(2);
    expect(exportDocumentToSvg(doc).contents).toContain(`d="${path}"`);
  });

  it("normalizes reverse drags and clamps the pair to the page", () => {
    const blank = createPhase4Document("Bounds");
    const pair = insertNativeBracketPair(blank, { x: 300, y: 280 }, "square", { x: 100, y: 120 }).pages[0].objects[0];
    expect(pair).toMatchObject({ x: 100, y: 120, width: 200, height: 160 });
    const edge = insertNativeBracketPair(blank, { x: -40, y: -40 }, "curly", { x: 2000, y: 2000 }).pages[0].objects[0];
    expect(edge).toMatchObject({ x: 0, y: 0, width: blank.pages[0].width, height: blank.pages[0].height });
  });

  it("keeps a visible gap for tiny drags and centers click placements", () => {
    const blank = createPhase4Document("Small");
    expect(insertNativeBracketPair(blank, { x: 100, y: 100 }, "square", { x: 101, y: 101 }).pages[0].objects[0])
      .toMatchObject({ width: 32, height: 16 });
    expect(insertNativeBracketPair(blank, { x: 200, y: 200 }, "square").pages[0].objects[0])
      .toMatchObject({ x: 140, y: 160, width: 120, height: 80 });
  });

  it.each(["square", "curly"] as const)("preserves legacy single %s brackets", kind => {
    const old = insertNativeBracket(createPhase4Document("Single"), { x: 100, y: 100 }, kind);
    const single = old.pages[0].objects[0] as BracketObject;
    expect(single.paired).toBeUndefined();
    expect(single).toMatchObject({ width: 16, height: 64 });
    expect(BracketObjectSchema.parse(single).paired).toBeUndefined();
    expect(exportDocumentToSvg(old).contents).toContain(`d="${bracketGlyphPathD(kind, 16, 64)}"`);
    expect(() => BracketObjectSchema.parse({ ...single, paired: "yes" })).toThrow();
  });

  it("projects both sides in the same coordinate system", () => {
    const projected = pairedBracketGlyphPathD("square", 120, 80, point => ({ x: point.x * 2 + 5, y: point.y * 3 + 7 }));
    const starts = [...projected.matchAll(/M ([-.\d]+) ([-.\d]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(starts).toEqual([[35, 7], [213, 7]]);
  });

  it("moves and resizes the pair as one object without changing the molecule", () => {
    const source = insertNativeSingleBondMolecule(createPhase4Document("Chemistry"), { x: 200, y: 200 });
    const molecule = source.pages[0].objects[0];
    let doc = insertNativeBracketPair(source, { x: 100, y: 100 }, "square", { x: 300, y: 300 });
    const id = doc.selection.objectIds[0];
    doc = moveDocumentObject(doc, id, { x: 50, y: 60 });
    doc = scaleDocumentObjectsAroundPoint(doc, [id], { x: 150, y: 160 }, 2, 2);
    expect(doc.pages[0].objects.find(object => object.id === id)).toMatchObject({ paired: true, width: 400, height: 400 });
    expect(doc.pages[0].objects[0]).toEqual(molecule);
  });
});
