import { describe, expect, it } from "vitest";
import { BracketObjectSchema, createEmptyDocument, deserializeDocument, serializeDocument, type BracketObject } from "./index";

const legacy: BracketObject = { id: "b1", type: "bracket", bracketKind: "square", x: 10, y: 20,
  width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [] };

describe("additive v1 bracket fields", () => {
  it("loads old single glyphs without changing their fields", () => {
    const document = createEmptyDocument(); document.pages[0].objects.push(legacy);
    expect(deserializeDocument(serializeDocument(document)).pages[0].objects[0]).toEqual(legacy);
  });
  it("round-trips pair sides, repeat semantics and custom labels", () => {
    const bracket = { ...legacy, bracketKind: "round", side: "close", pairId: "pair1", repeatUnit: true, label: "m" };
    expect(BracketObjectSchema.parse(bracket)).toEqual(bracket);
    expect(BracketObjectSchema.safeParse({ ...bracket, side: "other" }).success).toBe(false);
    expect(BracketObjectSchema.safeParse({ ...bracket, repeatUnit: "yes" }).success).toBe(false);
  });
});
