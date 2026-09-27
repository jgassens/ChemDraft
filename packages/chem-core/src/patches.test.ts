import { describe, expect, it } from "vitest";
import {
  admitParsedDocument,
  adoptDerivedDocument,
  applyPatch,
  applyPatches,
  DocumentPatchError,
  isEngineDocument,
  toEngineDocument
} from "./patches";
import { createEmptyDocument, deserializeDocument } from "./document";
import type { ChemDraftDocument, DocumentObject } from "./schemas";

const now = "2026-09-26T00:00:00.000Z";

function textObject(id: string, x: number): DocumentObject {
  return { id, type: "text", x, y: 0, width: 10, height: 10, rotation: 0, style: {}, text: id, spans: [] } as DocumentObject;
}

function documentWith(count: number): ChemDraftDocument {
  const base = createEmptyDocument({ title: "t", now });
  const page = base.pages[0]!;
  return applyPatches(
    base,
    Array.from({ length: count }, (_, index) => ({ op: "addObject" as const, pageId: page.id, object: textObject(`t${index}`, index) })),
    { now }
  );
}

describe("patch engine structural sharing", () => {
  it("shares every object a patch does not touch, and replaces the one it does", () => {
    const before = documentWith(4);
    const after = applyPatch(before, { op: "moveObject", objectId: "t2", x: 50, y: 60 }, { now });
    const [b, a] = [before.pages[0]!.objects, after.pages[0]!.objects];
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
    expect(a[3]).toBe(b[3]);
    expect(a[2]).not.toBe(b[2]);
    expect(a[2]).toMatchObject({ id: "t2", x: 50, y: 60 });
    // The input is untouched.
    expect(b[2]).toMatchObject({ id: "t2", x: 2, y: 0 });
    expect(after.pages[0]!.objects).not.toBe(before.pages[0]!.objects);
  });

  it("freezes results under test, so an in-place mutation that would reach shared snapshots throws", () => {
    const document = documentWith(2);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.pages[0]!.objects)).toBe(true);
    expect(Object.isFrozen(document.pages[0]!.objects[0])).toBe(true);
    expect(() => {
      (document.pages[0]!.objects as DocumentObject[]).push(textObject("x", 0));
    }).toThrow(TypeError);
  });

  it("still fully validates and normalizes a document the engine did not produce", () => {
    const handBuilt = createEmptyDocument({ title: "t", now }) as ChemDraftDocument;
    const loose = {
      ...handBuilt,
      pages: [{ ...handBuilt.pages[0]!, objects: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "a" }] }]
    } as unknown as ChemDraftDocument;
    const result = applyPatch(loose, { op: "moveObject", objectId: "a", x: 5, y: 5 }, { now });
    // Defaults the schema supplies (rotation, style, spans) are filled in, as the old full parse did.
    expect(result.pages[0]!.objects[0]).toMatchObject({ id: "a", x: 5, rotation: 0, style: {}, spans: [] });
    expect(() =>
      applyPatch({ ...handBuilt, bogus: true } as unknown as ChemDraftDocument, { op: "setSelection", objectIds: [] }, { now })
    ).toThrow();
  });

  it("still rejects invalid changes, and applies nothing when a patch in the batch fails", () => {
    const document = documentWith(2);
    expect(() => applyPatch(document, { op: "updateObject", objectId: "t0", changes: { x: Number.NaN } }, { now })).toThrow();
    expect(() =>
      applyPatches(document, [
        { op: "moveObject", objectId: "t0", x: 9, y: 9 },
        { op: "removeObject", objectId: "missing" }
      ], { now })
    ).toThrow(DocumentPatchError);
    expect(document.pages[0]!.objects[0]).toMatchObject({ x: 0 });
  });

  it("passes compatibility warnings, styles, and plugin data through by reference", () => {
    const base = createEmptyDocument({ title: "t", now });
    const imported = applyPatch(
      {
        ...base,
        styles: { preset: "acs" },
        compatibility: { warnings: [{ code: "cdxml.w", message: "approximated" }] }
      } as ChemDraftDocument,
      { op: "addObject", pageId: base.pages[0]!.id, object: textObject("t", 0) },
      { now }
    );
    const edited = applyPatch(imported, { op: "moveObject", objectId: "t", x: 3, y: 3 }, { now });
    expect(edited.compatibility).toBe(imported.compatibility);
    expect(edited.styles).toBe(imported.styles);
    expect(edited.plugins).toBe(imported.plugins);
    expect(edited.compatibility.warnings).toHaveLength(1);
  });

  it("re-admits a document derived by replacing objects, so the next edit still shares", () => {
    const base = documentWith(4);
    const page = base.pages[0]!;
    const replaced = { ...page.objects[1]!, x: 99 } as DocumentObject;
    const derived = { ...base, pages: [{ ...page, objects: page.objects.map((object, index) => (index === 1 ? replaced : object)) }] };
    const adopted = adoptDerivedDocument(base, derived);
    expect(adopted.pages[0]!.objects[0]).toBe(page.objects[0]);
    expect(adopted.pages[0]!.objects[1]).toMatchObject({ id: "t1", x: 99 });
    // The next patch starts from the adopted document instead of deep-copying it: untouched
    // objects keep their identity.
    const next = applyPatch(adopted, { op: "moveObject", objectId: "t3", x: 1, y: 1 }, { now });
    expect(next.pages[0]!.objects[0]).toBe(page.objects[0]);
    expect(next.pages[0]!.objects[1]).toBe(adopted.pages[0]!.objects[1]);
  });

  it("validates what a derived document replaced, and ignores a base the engine did not produce", () => {
    const base = documentWith(2);
    const page = base.pages[0]!;
    const invalid = { ...base, pages: [{ ...page, objects: [{ ...page.objects[0]!, x: Number.NaN } as DocumentObject, page.objects[1]!] }] };
    expect(() => adoptDerivedDocument(base, invalid)).toThrow();

    const handBuilt = createEmptyDocument({ title: "t", now }) as ChemDraftDocument;
    const derived = { ...handBuilt, title: "u" };
    expect(adoptDerivedDocument(handBuilt, derived)).toBe(derived);
  });

  it("admits an outside document once, as an independent copy the next edit shares from", () => {
    const outside = JSON.parse(JSON.stringify(documentWith(3))) as ChemDraftDocument;
    expect(isEngineDocument(outside)).toBe(false);
    const admitted = toEngineDocument(outside);
    expect(isEngineDocument(admitted)).toBe(true);
    expect(admitted).not.toBe(outside);
    expect(admitted.pages[0]!.objects[0]).not.toBe(outside.pages[0]!.objects[0]);
    expect(toEngineDocument(admitted)).toBe(admitted);
    const edited = applyPatch(admitted, { op: "moveObject", objectId: "t2", x: 5, y: 5 }, { now });
    expect(edited.pages[0]!.objects[0]).toBe(admitted.pages[0]!.objects[0]);
  });

  it("admits a freshly parsed document as it is, without copying, and shares from it on the next edit", () => {
    const parsed = deserializeDocument(JSON.stringify(documentWith(3)));
    expect(isEngineDocument(parsed)).toBe(false);
    const admitted = admitParsedDocument(parsed);
    expect(admitted).toBe(parsed);
    expect(isEngineDocument(admitted)).toBe(true);
    // Frozen under test like every engine document, so a caller that broke the hand-over contract
    // and mutated it would throw rather than silently rewrite shared snapshots.
    expect(Object.isFrozen(admitted.pages[0]!.objects[0])).toBe(true);
    expect(admitParsedDocument(admitted)).toBe(admitted);
    expect(toEngineDocument(admitted)).toBe(admitted);
    const edited = applyPatch(admitted, { op: "moveObject", objectId: "t2", x: 5, y: 5 }, { now });
    expect(edited.pages[0]!.objects[0]).toBe(admitted.pages[0]!.objects[0]);
    expect(edited.pages[0]!.objects[2]).toMatchObject({ x: 5, y: 5 });
  });

  it("admits a created empty document as it is", () => {
    const created = createEmptyDocument({ title: "t", now });
    expect(admitParsedDocument(created)).toBe(created);
    expect(isEngineDocument(created)).toBe(true);
  });

  it("removes a run of objects in one pass with the same result as one patch at a time", () => {
    const base = documentWith(6);
    const page = base.pages[0]!;
    // A duplicate id, as a parsed legacy file may carry (addObject refuses one): removal takes the
    // first remaining one each time.
    const outside = JSON.parse(JSON.stringify(base)) as ChemDraftDocument;
    outside.pages[0]!.objects.push(textObject("t1", 99));
    outside.selection = { pageId: page.id, objectIds: ["t0", "t1", "t4"] };
    const withDuplicate = toEngineDocument(outside);
    const removals = ["t1", "t4", "t1", "t2"].map((objectId) => ({ op: "removeObject" as const, objectId }));
    const batched = applyPatches(withDuplicate, removals, { now });
    const sequential = removals.reduce((document, patch) => applyPatch(document, patch, { now }), withDuplicate);
    expect(batched.pages[0]!.objects.map((object) => [object.id, object.x])).toEqual(
      sequential.pages[0]!.objects.map((object) => [object.id, object.x])
    );
    expect(batched.pages[0]!.objects.map((object) => object.id)).toEqual(["t0", "t3", "t5"]);
    expect(batched.selection.objectIds).toEqual(sequential.selection.objectIds);
    expect(batched.selection.objectIds).toEqual(["t0"]);

    // And a missing id still fails the whole batch, naming it.
    expect(() => applyPatches(withDuplicate, [...removals, { op: "removeObject", objectId: "t1" }], { now }))
      .toThrow('object "t1" does not exist');
  });

  it("fails a batched removal on the id a sequential run would fail on, before removing anything", () => {
    const base = documentWith(3);
    // One "t0" and one "t1": [t1, t0, t0, t1] fails sequentially on the second "t0".
    const removals = ["t1", "t0", "t0", "t1"].map((objectId) => ({ op: "removeObject" as const, objectId }));
    expect(() => removals.reduce((document, patch) => applyPatch(document, patch, { now }), base))
      .toThrow('object "t0" does not exist');
    expect(() => applyPatches(base, removals, { now })).toThrow('object "t0" does not exist');
    expect(base.pages[0]!.objects.map((object) => object.id)).toEqual(["t0", "t1", "t2"]);
  });

  it("fails a batched removal whose patch names no id, as a single removal does", () => {
    const base = documentWith(2);
    const removals = [
      { op: "removeObject" as const, objectId: "t0" },
      { op: "removeObject" as const, objectId: undefined as unknown as string }
    ];
    expect(() => applyPatches(base, removals, { now })).toThrow(DocumentPatchError);
    expect(() => applyPatches(base, removals, { now })).toThrow('object "undefined" does not exist');
  });

  it("prunes crossings per page when a run of removals deletes both crossed molecules", () => {
    const molecule = (id: string, y: number): DocumentObject => ({
      id, type: "molecule", x: 0, y, width: 60, height: 60, rotation: 0, style: {},
      structureFormat: "smiles", structure: "CC",
      atoms: [
        { id: "a1", element: "C", x: 0, y, formalCharge: 0 },
        { id: "a2", element: "C", x: 60, y: 60 - y, formalCharge: 0 }
      ],
      bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }],
      superatoms: [],
      rGroups: []
    } as unknown as DocumentObject);
    const empty = createEmptyDocument({ title: "t", now });
    const pageId = empty.pages[0]!.id;
    const ref = (objectId: string) => ({ objectId, bondId: "b1" });
    const crossing = (left: string, right: string) => ({
      op: "setCrossingOverride" as const, pageId, crossing: { bonds: [ref(left), ref(right)] as [ReturnType<typeof ref>, ReturnType<typeof ref>], front: ref(left) }
    });
    // Two crossed pairs, plus one crossing that ties a deleted molecule to a surviving one.
    const drawn = applyPatches(empty, [
      ...["m1", "m2", "m3", "m4"].map((id, index) => ({ op: "addObject" as const, pageId, object: molecule(id, index % 2 === 0 ? 0 : 60) })),
      crossing("m1", "m2"),
      crossing("m3", "m4"),
      crossing("m1", "m3")
    ], { now });
    expect(drawn.pages[0]!.crossings).toHaveLength(3);

    const removals = ["m1", "m2"].map((objectId) => ({ op: "removeObject" as const, objectId }));
    const batched = applyPatches(drawn, removals, { now });
    const sequential = removals.reduce((document, patch) => applyPatch(document, patch, { now }), drawn);
    expect(batched.pages[0]!.crossings).toEqual(sequential.pages[0]!.crossings);
    expect(batched.pages[0]!.crossings.map((entry) => entry.bonds.map((bond) => bond.objectId))).toEqual([["m3", "m4"]]);
  });

  it("resolves an id to its first occurrence after a removal shifts a page that repeats it", () => {
    const base = documentWith(1);
    // [t0, Y(x=1), Y(x=2)]: the index records Y at slot 1. Removing t0 shifts both Ys down, so slot
    // 1 now holds the second Y — which shares the id and would pass a positional check.
    const outside = JSON.parse(JSON.stringify(base)) as ChemDraftDocument;
    outside.pages[0]!.objects.push(textObject("Y", 1), textObject("Y", 2));
    const withDuplicate = toEngineDocument(outside);
    const patches = [
      { op: "removeObject" as const, objectId: "t0" },
      { op: "updateObject" as const, objectId: "Y", changes: { x: 99 } }
    ];
    const batched = applyPatches(withDuplicate, patches, { now });
    const sequential = patches.reduce((document, patch) => applyPatch(document, patch, { now }), withDuplicate);
    expect(batched.pages[0]!.objects.map((object) => [object.id, object.x])).toEqual([["Y", 99], ["Y", 2]]);
    expect(sequential.pages[0]!.objects.map((object) => [object.id, object.x])).toEqual([["Y", 99], ["Y", 2]]);

    // The same after a batched run of removals, which replaces the page's array outright.
    const outsideTwo = JSON.parse(JSON.stringify(documentWith(2))) as ChemDraftDocument;
    outsideTwo.pages[0]!.objects.push(textObject("Y", 1), textObject("Y", 2));
    const afterRun = applyPatches(toEngineDocument(outsideTwo), [
      { op: "removeObject", objectId: "t0" },
      { op: "removeObject", objectId: "t1" },
      { op: "updateObject", objectId: "Y", changes: { x: 99 } }
    ], { now });
    expect(afterRun.pages[0]!.objects.map((object) => [object.id, object.x])).toEqual([["Y", 99], ["Y", 2]]);
  });

  it("validates compatibility, styles, and plugin data a derived document replaced", () => {
    const base = documentWith(1);
    expect(() => adoptDerivedDocument(base, { ...base, styles: "not-an-object" } as unknown as ChemDraftDocument)).toThrow();
    expect(() => adoptDerivedDocument(base, { ...base, plugins: [] } as unknown as ChemDraftDocument)).toThrow();
    expect(() =>
      adoptDerivedDocument(base, { ...base, compatibility: { warnings: [{ bogus: true }] } } as unknown as ChemDraftDocument)
    ).toThrow();
    // A valid replacement is admitted and kept.
    const adopted = adoptDerivedDocument(base, { ...base, styles: { preset: "acs" } });
    expect(isEngineDocument(adopted)).toBe(true);
    expect(adopted.styles).toEqual({ preset: "acs" });
  });

  it("sets a page's whole stacking order in one patch, and refuses anything but a permutation", () => {
    const base = documentWith(4);
    const pageId = base.pages[0]!.id;
    const withSelection = applyPatch(base, { op: "setSelection", pageId, objectIds: ["t1"] }, { now });
    const reordered = applyPatch(withSelection, { op: "setObjectOrder", pageId, objectIds: ["t2", "t0", "t3", "t1"] }, { now });
    expect(reordered.pages[0]!.objects.map((object) => object.id)).toEqual(["t2", "t0", "t3", "t1"]);
    // Objects move, they are not copied, and the selection stands.
    expect(reordered.pages[0]!.objects[3]).toBe(withSelection.pages[0]!.objects[1]);
    expect(reordered.selection.objectIds).toEqual(["t1"]);
    // Later lookups see the new positions.
    const moved = applyPatch(reordered, { op: "moveObject", objectId: "t3", x: 7, y: 7 }, { now });
    expect(moved.pages[0]!.objects[2]).toMatchObject({ id: "t3", x: 7 });

    for (const objectIds of [["t0", "t1", "t2"], ["t0", "t1", "t2", "t2"], ["t0", "t1", "t2", "zz"], ["t0", "t1", "t2", "t3", "t3"]]) {
      expect(() => applyPatch(base, { op: "setObjectOrder", pageId, objectIds }, { now })).toThrow(DocumentPatchError);
    }
    expect(() => applyPatch(base, { op: "setObjectOrder", pageId: "nope", objectIds: ["t0", "t1", "t2", "t3"] }, { now }))
      .toThrow(DocumentPatchError);
  });

  it("keeps the page shell validated: a layout whose size disagrees with the page is refused", () => {
    const document = documentWith(1);
    const page = document.pages[0]!;
    expect(() =>
      applyPatch(document, { op: "updatePageLayout", pageId: page.id, layout: { ...page.layout, widthPx: -5 } }, { now })
    ).toThrow();
  });
});
