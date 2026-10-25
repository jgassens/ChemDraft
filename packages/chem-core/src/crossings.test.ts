import { describe, expect, it } from "vitest";
import {
  bondRefFromKey, bondRefKey, crossingPairKey,
  applyPatch, createEmptyDocument, CrossingOverrideSchema, deserializeDocument, DocumentObjectSchema,
  sameBondRef, sameCrossingBondPair, serializeDocument, type BondRef, type CrossingOverride
} from "./index";

const ref = (objectId: string, bondId: string): BondRef => ({ objectId, bondId });
const scoped: [BondRef, BondRef] = [ref("a", "x::b"), ref("c", "d")];
const outside: [BondRef, BondRef] = [ref("a::x", "b"), scoped[1]];

function documentWithBonds(refs: BondRef[]) {
  const document = createEmptyDocument();
  document.pages[0]!.objects = [...new Map(refs.map(bond => [bond.objectId, bond])).values()].map(bond =>
    DocumentObjectSchema.parse({
      id: bond.objectId, type: "molecule", x: 0, y: 0, width: 30, height: 30,
      structureFormat: "smiles", structure: "CC",
      atoms: [{ id: "a", element: "C", x: 0, y: 0 }, { id: "b", element: "C", x: 30, y: 30 }],
      bonds: [...new Set(refs.filter(ref => ref.objectId === bond.objectId).map(ref => ref.bondId))]
        .map(id => ({ id, fromAtomId: "a", toAtomId: "b", order: "single" }))
    })
  );
  return document;
}

describe("structured crossing identity", () => {
  it.each([
    { name: "object/bond delimiter", first: scoped, second: outside },
    { name: "pair delimiter", first: [ref("a", "b|c::d"), ref("e", "f")] as [BondRef, BondRef],
      second: [ref("a", "b"), ref("c", "d|e::f")] as [BondRef, BondRef] }
  ])("keeps $name aliases independent when setting, replacing, and clearing", ({ first, second }) => {
    let document = documentWithBonds([...first, ...second]);
    const pageId = document.pages[0]!.id;
    const existing: CrossingOverride = { bonds: second, front: second[0], clearancePx: 9 };
    document = applyPatch(document, { op: "setCrossingOverride", pageId, crossing: existing });
    document = applyPatch(document, { op: "setCrossingOverride", pageId, crossing: { bonds: first, front: first[0] } });
    expect(document.pages[0]!.crossings).toHaveLength(2);
    document = applyPatch(document, { op: "setCrossingOverride", pageId,
      crossing: { bonds: [first[1], first[0]], front: first[1], clearancePx: 3 } });
    expect(document.pages[0]!.crossings).toHaveLength(2);
    expect(document.pages[0]!.crossings).toContainEqual(existing);
    expect(document.pages[0]!.crossings.find(entry => sameCrossingBondPair(entry.bonds, first))?.front).toEqual(first[1]);
    document = applyPatch(document, { op: "clearCrossingOverride", pageId, bonds: [first[1], first[0]] });
    expect(document.pages[0]!.crossings).toEqual([existing]);
  });

  it("distinguishes aliased bonds within a crossing and validates the exact front reference", () => {
    const bonds: [BondRef, BondRef] = [scoped[0], outside[0]];
    expect(sameBondRef(...bonds)).toBe(false);
    const crossing = { bonds, front: outside[0] };
    expect(CrossingOverrideSchema.safeParse(crossing).success).toBe(true);
    const document = documentWithBonds(bonds);
    const updated = applyPatch(document, { op: "setCrossingOverride", pageId: document.pages[0]!.id, crossing });
    expect(updated.pages[0]!.crossings[0]!.front).toEqual(outside[0]);
    const invalid = { bonds: scoped, front: outside[0] };
    expect(CrossingOverrideSchema.safeParse(invalid).success).toBe(false);
    expect(() => applyPatch(documentWithBonds([...scoped, ...outside]), {
      op: "setCrossingOverride", pageId: document.pages[0]!.id, crossing: invalid
    })).toThrow("front bond must be one of the crossing bonds");
  });

  it("loads the existing saved form and round-trips both formerly colliding crossings without migration", () => {
    const legacy = documentWithBonds([...scoped, ...outside]);
    // Saved documents contain structured references, never the old runtime-only keys.
    const existing: CrossingOverride = { bonds: [outside[1], outside[0]], front: outside[0], clearancePx: 7 };
    legacy.pages[0]!.crossings = [existing];
    const loaded = deserializeDocument(JSON.stringify(legacy));
    expect(loaded).toEqual(legacy);
    const pageId = loaded.pages[0]!.id;
    const updated = applyPatch(loaded, { op: "setCrossingOverride", pageId,
      crossing: { bonds: scoped, front: scoped[0] } });
    const roundTrip = deserializeDocument(serializeDocument(updated));
    expect(roundTrip).toEqual(updated);
    expect(roundTrip.schema).toBe(legacy.schema);
    expect(roundTrip.pages[0]!.crossings).toHaveLength(2);
    expect(applyPatch(roundTrip, { op: "clearCrossingOverride", pageId, bonds: scoped }).pages[0]!.crossings).toEqual([existing]);
  });
});

describe("crossing keys", () => {
  it("keeps delimiter-bearing bond tuples distinct and decodes arbitrary IDs", () => {
    const refs = [
      { objectId: "a::b", bondId: "c" },
      { objectId: "a", bondId: "b::c" },
      { objectId: 'a|["\\\n', bondId: "::|]\u0000" }
    ];
    expect(new Set(refs.map(bondRefKey)).size).toBe(refs.length);
    for (const ref of refs) expect(bondRefFromKey(bondRefKey(ref))).toEqual(ref);
  });

  it("canonicalizes unordered pairs even when collation equates distinct IDs", () => {
    const refs = [
      { objectId: "a::b", bondId: "c" },
      { objectId: "a", bondId: "b::c" },
      { objectId: "é", bondId: "b" },
      { objectId: "e\u0301", bondId: "b" }
    ];
    const partner = { objectId: "other", bondId: "bond" };
    expect(new Set(refs.map((ref) => crossingPairKey([ref, partner]))).size).toBe(refs.length);
    for (const left of refs) {
      for (const right of refs) {
        expect(crossingPairKey([left, right])).toBe(crossingPairKey([right, left]));
      }
    }
  });

  it.each(['a::b', '{}', '["a"]', '["a", 1]', '["a", "b", "c"]'])("rejects invalid key %s", (key) => {
    expect(() => bondRefFromKey(key)).toThrow();
  });
});
