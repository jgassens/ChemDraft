import { describe, expect, it } from "vitest";
import { applyPatch, bracketChemistryWarnings, BracketObjectSchema, createEmptyDocument, deserializeDocument, readDocument, resolveRepeatUnitAtomMembership, serializeDocument, withoutBracketPairMetadata, type BracketObject, type MoleculeObject } from "./index";

const legacy: BracketObject = { id: "b1", type: "bracket", bracketKind: "square", x: 10, y: 20,
  width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [] };

describe("additive v1 bracket fields", () => {
  function partialUnit() {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = { id: "pentane", type: "molecule", x: 0, y: 30, width: 80, height: 1, rotation: 0,
      style: {}, structureFormat: "smiles", structure: "CCCCC", superatoms: [], rGroups: [],
      atoms: [0, 20, 40, 60, 80].map((x, i) => ({ id: `a${i}`, element: "C", x, y: 30, formalCharge: 0 })),
      bonds: [0, 1, 2, 3].map(i => ({ id: `bond${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" })) };
    const open: BracketObject = { ...legacy, id: "open", x: 10, width: 2, pairId: "pair", side: "open", repeatUnit: true };
    const close: BracketObject = { ...open, id: "close", x: 70, side: "close", label: "n" };
    const pair = [open, close];
    document.pages[0].objects = [molecule, ...pair];
    return { document, molecule, pair };
  }

  it("resolves individual enclosed atoms without changing the graph, and explicit membership includes the whole molecule", () => {
    const { document, molecule, pair } = partialUnit();
    const before = structuredClone(document);
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects)).toMatchObject({
      members: [{ molecule, atomIds: ["a1", "a2", "a3"] }], unresolved: false, reason: undefined
    });
    expect(bracketChemistryWarnings(document, molecule)).toHaveLength(1);
    expect(document).toEqual(before);
    pair.forEach(bracket => { bracket.containedObjectIds = [molecule.id]; });
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects).members[0].atomIds).toEqual(molecule.atoms.map(atom => atom.id));
  });

  it("resolves a crossing's inner component when geometry supplies no members", () => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach(bracket => { bracket.y = 500; bracket.crossingBondIds = [{ objectId: molecule.id, bondId: "bond0" }]; });
    pair[0].compatibility = { warnings: [], unknown: { cdxmlBracketCrossings: [{
      ref: { objectId: molecule.id, bondId: "bond0" }, innerAtomId: "a1"
    }] } };
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects)).toMatchObject({
      members: [{ atomIds: ["a1", "a2", "a3", "a4"] }], unresolved: false
    });
  });

  it("keeps explicit native multiple-group membership when both sides reference a bond in the whole molecule", () => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach(bracket => {
      bracket.bracketUsage = "multiple";
      bracket.repeatCount = 3;
      bracket.containedObjectIds = [molecule.id];
      bracket.crossingBondIds = [{ objectId: molecule.id, bondId: "bond1" }];
    });
    const before = structuredClone(document);
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects)).toMatchObject({
      members: [{ molecule, atomIds: molecule.atoms.map(atom => atom.id) }], unresolved: false, reason: undefined
    });
    expect(bracketChemistryWarnings(document, molecule)[0].message).toBe(
      "Molecule pentane is inside a multiple group x3; values and molecular graph exports are for one drawn copy only.");
    expect(document).toEqual(before);
  });

  it.each([undefined, "multiple"] as const)("marks partial %s crossing-boundary rejection unresolved for export, analysis and the UI", usage => {
    const { document, molecule, pair } = partialUnit();
    if (usage) pair.forEach(bracket => { bracket.bracketUsage = usage; });
    pair[0].crossingBondIds = [{ objectId: molecule.id, bondId: "bond1" }];
    const membership = resolveRepeatUnitAtomMembership(pair, document.pages[0].objects);
    expect(membership).toMatchObject({ unresolved: true,
      reason: expect.stringContaining("crossing-bond references do not match the boundary") });
    expect(bracketChemistryWarnings(document, molecule)[0].message).toContain(membership.reason);
  });

  it.each([
    { objectId: "pentane", bondId: "missing" },
    { objectId: "missing", bondId: "bond1" }
  ])("rejects an explicit multiple group's missing crossing reference %j", ref => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach(bracket => {
      bracket.bracketUsage = "multiple";
      bracket.containedObjectIds = [molecule.id];
      bracket.crossingBondIds = [ref];
    });
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects)).toMatchObject({
      unresolved: true, reason: expect.stringContaining("crossing-bond references do not match the boundary")
    });
  });

  it("resolves horizontal glyphs in their rotated enclosure rather than their stored bounds", () => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach((bracket, index) => Object.assign(bracket, { x: 10, y: 10 + index * 64,
      width: 20, height: 64, rotation: 90 }));
    molecule.atoms = [{ ...molecule.atoms[0], id: "outside", x: 42, y: 20 },
      { ...molecule.atoms[0], id: "inside", x: 20, y: 80 }];
    molecule.bonds = [];
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects)).toMatchObject({
      members: [{ atomIds: ["inside"] }], unresolved: false, reason: undefined
    });
  });

  it("uses injected page-space atom positions for a rotated molecule without duplicating rendering math", () => {
    const { document, molecule, pair } = partialUnit();
    molecule.rotation = 90;
    const atomPosition = (_molecule: MoleculeObject, atom: MoleculeObject["atoms"][number]) =>
      ({ x: atom.id === "a2" ? 40 : 200, y: 30 });
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects, { atomPosition })).toMatchObject({
      members: [{ atomIds: ["a2"] }], unresolved: false, reason: undefined
    });
    expect(bracketChemistryWarnings(document, molecule, { atomPosition })).toHaveLength(1);
  });

  it("refuses unresolved imported membership touched by a live crossing instead of guessing from geometry", () => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach(bracket => {
      bracket.crossingBondIds = [{ objectId: molecule.id, bondId: "bond0" }];
      bracket.compatibility = { warnings: [], unknown: { bracketedGroup: { attributes: { BracketedObjectIDs: "missing" } },
        cdxmlBracketMembership: "[]", cdxmlBracketMembers: [] } };
    });
    const result = resolveRepeatUnitAtomMembership(pair, document.pages[0].objects);
    expect(result).toMatchObject({ members: [], imported: true, unresolved: true, reason: expect.stringContaining('member "missing"') });
    expect([...result.crossingAtomIds.get(molecule.id)!]).toEqual(["a0", "a1"]);
    expect(bracketChemistryWarnings(document, molecule)[0].message).toContain("cannot be resolved");
  });

  it("leaves empty and orphan brackets unrelated to a molecule", () => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach(bracket => { bracket.y = 500; });
    expect(bracketChemistryWarnings(document, molecule)).toEqual([]);
    document.pages[0].objects = [molecule, pair[0]];
    expect(bracketChemistryWarnings(document, molecule)).toEqual([]);
  });

  it("does not guess preserved CDXML atom membership when the source group is missing", () => {
    const { document, molecule, pair } = partialUnit();
    pair.forEach(bracket => { bracket.compatibility = { warnings: [], unknown: { cdxmlBracketMemberObjectIds: [molecule.id] } }; });
    expect(resolveRepeatUnitAtomMembership(pair, document.pages[0].objects)).toMatchObject({
      members: [], imported: true, unresolved: true, reason: expect.stringContaining("no source BracketedObjectIDs group")
    });
    expect(bracketChemistryWarnings(document, molecule)[0].message).toContain("cannot be resolved");
  });

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
