import { describe, expect, it } from "vitest";
import { createEmptyDocument, readDocument, serializeDocument, serializeDocumentWithWarnings } from "./document";
import { applyPatchWithHistory, createDocumentHistory, redo, undo } from "./history";
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
  it.each(["removal", "format edit", "replacement"] as const)(
    "permanently retires positional chemistry after %s, retaining the loss warning and exact undo",
    change => {
      const raw = JSON.parse(serializeDocument(openedDocument()));
      raw.pages[0].objects[0].bonds[0].order = "single";
      raw.pages[0].objects[0].superatoms = [{ label: "Me", expandedStructure: "opaque source",
        expandedStructureFormat: "future-format" }];
      const opened = readDocument(raw).document;
      const molecule = opened.pages[0]!.objects[0]!;
      if (molecule.type !== "molecule") throw new Error("Expected molecule");
      const originalContents = serializeDocument(opened);
      const changed = applyPatchWithHistory(createDocumentHistory(opened), {
        op: "updateObject", objectId: molecule.id, changes: { superatoms: change === "removal" ? []
          : molecule.superatoms.map(superatom => change === "format edit"
            ? { ...superatom, expandedStructureFormat: "smiles" }
            : { ...superatom, label: "Et" }) }
      });
      const reset = applyPatchWithHistory(changed, { op: "updateObject", objectId: molecule.id,
        changes: { superatoms: structuredClone(molecule.superatoms) } });
      const saved = serializeDocumentWithWarnings(reset.present);
      expect(JSON.parse(saved.contents).pages[0].objects[0].superatoms[0].expandedStructureFormat).toBe("unknown");
      expect(saved.warnings).toEqual([expect.objectContaining({ code: "NATIVE_EXTENSION_DATA_DROPPED",
        path: ["pages", opened.pages[0]!.id, "objects", molecule.id, "superatoms"], originalValue: "future-format" })]);

      const undoneReset = undo(reset);
      expect(undoneReset.present).toBe(changed.present);
      expect(serializeDocumentWithWarnings(undoneReset.present).warnings).toEqual(saved.warnings);
      const undoneChange = undo(undoneReset);
      expect(undoneChange.present).toBe(opened);
      expect(serializeDocument(undoneChange.present)).toBe(originalContents);
      expect(serializeDocumentWithWarnings(undoneChange.present).warnings).toEqual([]);
      const redone = redo(redo(undoneChange));
      expect(redone.present).toBe(reset.present);
      expect(serializeDocumentWithWarnings(redone.present)).toEqual(saved);
    }
  );

  it("retires positional chemistry between updates in the same atomic batch", () => {
    const raw = JSON.parse(serializeDocument(openedDocument()));
    raw.pages[0].objects[0].superatoms = [{ label: "Me", expandedStructureFormat: "future-format" }];
    const opened = readDocument(raw).document;
    const molecule = opened.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    const replaced = applyPatches(opened, [
      { op: "updateObject", objectId: molecule.id, changes: { superatoms: [] } },
      { op: "updateObject", objectId: molecule.id, changes: { superatoms: molecule.superatoms } }
    ]);
    expect(JSON.parse(serializeDocument(replaced)).pages[0].objects[0].superatoms[0].expandedStructureFormat).toBe("unknown");
  });

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
