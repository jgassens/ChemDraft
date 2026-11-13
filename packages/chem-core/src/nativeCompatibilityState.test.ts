import { describe, expect, it } from "vitest";
import { createEmptyDocument, readDocument, serializeDocument } from "./document";
import { applyPatch, applyPatches } from "./patches";

function openedDocument() {
  const document = createEmptyDocument();
  return readDocument({ ...document, pages: [{ ...document.pages[0], objects: [{
    id: "molecule", type: "molecule", x: 0, y: 0, width: 22, height: 22, rotation: 0,
    style: {}, structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
    atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "b", element: "C", x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "quintuple" }]
  }] }] }).document;
}

describe("native compatibility state lifecycle", () => {
  it("prunes deleted object state before an ID can be reused, even in one batch", () => {
    const opened = openedDocument();
    const replacement = structuredClone(opened.pages[0]!.objects[0]!);
    const replaced = applyPatches(opened, [
      { op: "removeObject", objectId: replacement.id },
      { op: "addObject", pageId: opened.pages[0]!.id, object: replacement }
    ]);
    expect(JSON.parse(serializeDocument(replaced)).pages[0].objects[0].bonds[0].order).toBe("unknown");
    expect(replaced.compatibility.nativeExtensions ?? []).toHaveLength(0);
    expect(JSON.parse(serializeDocument(opened)).pages[0].objects[0].bonds[0].order).toBe("quintuple");
  });

  it("prunes deleted bond state before a new bond reuses the local ID", () => {
    const opened = openedDocument();
    const molecule = opened.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    const deleted = applyPatch(opened, { op: "updateObject", objectId: molecule.id, changes: { bonds: [] } });
    const replaced = applyPatch(deleted, { op: "updateObject", objectId: molecule.id, changes: { bonds: molecule.bonds } });
    expect(JSON.parse(serializeDocument(replaced)).pages[0].objects[0].bonds[0].order).toBe("unknown");
    expect(deleted.compatibility.nativeExtensions ?? []).toHaveLength(0);
  });

  it("retires a source enum when explicitly edited so returning to unknown cannot revive it", () => {
    const opened = openedDocument();
    const molecule = opened.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    const edited = applyPatch(opened, { op: "updateObject", objectId: molecule.id,
      changes: { bonds: molecule.bonds.map(bond => ({ ...bond, order: "single" })) } });
    const reset = applyPatch(edited, { op: "updateObject", objectId: molecule.id, changes: { bonds: molecule.bonds } });
    expect(JSON.parse(serializeDocument(reset)).pages[0].objects[0].bonds[0].order).toBe("unknown");
    expect(edited.compatibility.nativeExtensions ?? []).toHaveLength(0);
  });

  it("prunes a removal run atomically without changing the source snapshot", () => {
    const opened = openedDocument();
    const raw = JSON.parse(serializeDocument(opened));
    raw.pages[0].objects.push({ ...raw.pages[0].objects[0], id: "other" });
    const source = readDocument(raw).document;
    const removed = applyPatches(source, [{ op: "removeObject", objectId: "molecule" }, { op: "removeObject", objectId: "other" }]);
    expect(removed.compatibility.nativeExtensions ?? []).toHaveLength(0);
    expect(source.compatibility.nativeExtensions).toHaveLength(2);
    expect(() => applyPatches(source, [{ op: "removeObject", objectId: "molecule" }, { op: "removeObject", objectId: "missing" }])).toThrow();
    expect(serializeDocument(source)).toBe(serializeDocument(readDocument(raw).document));
  });
});
