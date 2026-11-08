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
    const bracket: BracketObject = { ...legacy, bracketKind: "round", side: "close", pairId: "pair1", repeatUnit: true, label: "m" };
    expect(BracketObjectSchema.parse(bracket)).toEqual(bracket);
    expect(BracketObjectSchema.safeParse({ ...bracket, side: "other" }).success).toBe(false);
    expect(BracketObjectSchema.safeParse({ ...bracket, repeatUnit: "yes" }).success).toBe(false);
    const document = createEmptyDocument();
    document.pages[0].objects = [{ ...bracket, id: "b2", side: "open", label: undefined }, bracket];
    expect(deserializeDocument(serializeDocument(document))).toEqual(document);
  });
  it("normalizes a broken pair on native load, naming the bracket and retaining the graph", () => {
    const document = createEmptyDocument();
    document.pages[0].objects = [{ ...legacy, id: "b12", pairId: "missing", repeatUnit: true, label: "m" }];
    const loaded = deserializeDocument(JSON.stringify(document));
    expect(loaded.pages[0].objects).toEqual([{ ...legacy, id: "b12" }]);
    expect(loaded.compatibility.warnings).toEqual([{
      code: "document.bracket_partner_missing", objectId: "b12",
      message: "Bracket b12 had no partner; repeat-unit mark removed."
    }]);
    expect(deserializeDocument(serializeDocument(loaded))).toEqual(loaded);
    expect(document.pages[0].objects[0]).toMatchObject({ pairId: "missing", repeatUnit: true, label: "m" });
  });
  it("does not use a partner on another page", () => {
    const document = createEmptyDocument();
    const opening: BracketObject = { ...legacy, pairId: "pair", side: "open", repeatUnit: true };
    document.pages[0].objects = [opening];
    document.pages.push({ ...document.pages[0], id: "other_page", objects: [{ ...opening, id: "b2", side: "close", label: "n" }] });
    const loaded = deserializeDocument(JSON.stringify(document));
    expect(loaded.pages.flatMap(page => page.objects).every(object => object.type === "bracket" && object.pairId === undefined && object.repeatUnit === undefined && object.label === undefined)).toBe(true);
    expect(loaded.compatibility.warnings).toHaveLength(2);
  });
});
