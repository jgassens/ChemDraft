import { describe, expect, it } from "vitest";
import { adoptDerivedDocument, applyPatch, applyPatches, DocumentPatchError } from "./patches";
import { createEmptyDocument } from "./document";
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

  it("keeps the page shell validated: a layout whose size disagrees with the page is refused", () => {
    const document = documentWith(1);
    const page = document.pages[0]!;
    expect(() =>
      applyPatch(document, { op: "updatePageLayout", pageId: page.id, layout: { ...page.layout, widthPx: -5 } }, { now })
    ).toThrow();
  });
});
