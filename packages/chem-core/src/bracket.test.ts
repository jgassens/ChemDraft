import { describe, expect, it } from "vitest";
import { applyPatch, BracketObjectSchema, createEmptyDocument, deserializeDocument, readDocument, serializeDocument, withoutBracketPairMetadata, type BracketObject, type MoleculeObject } from "./index";

const legacy: BracketObject = { id: "b1", type: "bracket", bracketKind: "square", x: 10, y: 20,
  width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [] };

describe("additive v1 bracket fields", () => {
  it("validates known usage, positive integer counts and molecule-scoped bond references strictly", () => {
    const bracket = { ...legacy, bracketUsage: "multiple", repeatCount: 3, crossingBondIds: [{ objectId: "m", bondId: "b" }] };
    expect(BracketObjectSchema.parse(bracket)).toEqual(bracket);
    expect(BracketObjectSchema.safeParse({ ...legacy, bracketUsage: "future" }).success).toBe(false);
    const document = createEmptyDocument();
    document.pages[0].objects = [{ ...legacy, pairId: "pair", side: "open" },
      { ...legacy, id: "close", pairId: "pair", side: "close" }];
    const source = JSON.parse(JSON.stringify(document));
    source.pages[0].objects[0].bracketUsage = "future";
    const read = readDocument(source);
    expect(read.warnings).toEqual([{
      code: "NATIVE_BRACKET_USAGE_PRESERVED", path: ["pages", 0, "objects", 0, "bracketUsage"], originalValue: "future",
      message: 'Unknown bracket usage "future" in object b1 was kept as-is; ChemDraft does not interpret it.'
    }]);
    expect(JSON.parse(serializeDocument(read.document))).toEqual({ ...source, formatVersion: "1.2.0", minAppVersion: "1.2.0" });
    for (const repeatCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) expect(BracketObjectSchema.safeParse({ ...bracket, repeatCount }).success).toBe(false);
    expect(BracketObjectSchema.parse({ ...bracket, repeatCount: Number.MAX_SAFE_INTEGER }).repeatCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(withoutBracketPairMetadata({ ...legacy, pairId: "p", repeatUnit: true, bracketUsage: "multiple", repeatCount: 3,
      crossingBondIds: bracket.crossingBondIds, label: "x" })).toEqual(legacy);
  });
  it("strips multipliers on orphan load, prunes deleted bond references, and keeps undo inputs unchanged", () => {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = { id: "m", type: "molecule", x: 20, y: 30, width: 20, height: 20, rotation: 0, style: {},
      structure: "", structureFormat: "unknown", atoms: [], bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single" }], superatoms: [], rGroups: [] };
    const open: BracketObject = { ...legacy, pairId: "p", side: "open", bracketUsage: "multiple", repeatCount: 3, containedObjectIds: [molecule.id],
      crossingBondIds: [{ objectId: molecule.id, bondId: "bond" }] };
    document.pages[0].objects = [molecule, open, { ...open, id: "close", side: "close" }];
    const edited = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { bonds: [] } });
    expect(edited.pages[0].objects.filter(object => object.type === "bracket").map(object => object.crossingBondIds)).toEqual([[], []]);
    expect(open.crossingBondIds).toHaveLength(1);
    const deleted = applyPatch(document, { op: "removeObject", objectId: "close" });
    expect(deleted.pages[0].objects.find(object => object.id === open.id)).toEqual({ ...legacy, side: "open" });
    const loaded = deserializeDocument(JSON.stringify({ ...document, pages: [{ ...document.pages[0], objects: [open] }] }));
    expect(loaded.pages[0].objects[0]).toEqual({ ...legacy, side: "open" });
  });
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
    expect(deserializeDocument(serializeDocument(document))).toEqual({ ...document, formatVersion: "1.2.0", minAppVersion: "1.2.0" });
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
