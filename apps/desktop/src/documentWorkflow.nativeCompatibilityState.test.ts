import { describe, expect, it } from "vitest";
import {
  createDocumentHistory, createEmptyDocument, readDocument, redo, serializeDocument, undo,
  type ChemDraftDocument
} from "@chemdraft/chem-core";
import {
  copyAsMolfile, copyAsSmiles, createSelectionClipboardPayload, deleteSelectedDocumentObjects,
  createNativeSavePayload, duplicateSelectedDocumentObjects, groupSelectedDocumentObjects, openNativeDocument, parseSelectionClipboardPayload, pasteSelectionClipboardPayload,
  selectDocumentObjects, serializeSelectionClipboardPayload
} from "./documentWorkflow";

function sourceDocument(orders = ["quadruple"]) {
  const document = createEmptyDocument({ now: "2026-11-12T00:00:00.000Z" });
  return readDocument({ ...document, pages: [{ ...document.pages[0], objects: orders.map((order, index) => ({
    id: index === 0 ? "molecule_001" : "mol_copy_002", type: "molecule",
    x: 100 + index * 100, y: 100, width: 22, height: 22, rotation: 0, style: {},
    structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
    atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "b", element: "C", x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order }]
  })) }] }).document;
}

function savedOrders(document: ChemDraftDocument): string[] {
  return JSON.parse(serializeDocument(document)).pages[0].objects.map(
    (object: { bonds: { order: string }[] }) => object.bonds[0]!.order
  );
}

function mixedCopyDocument() {
  const raw = JSON.parse(serializeDocument(sourceDocument(["single"])));
  raw.pages[0].objects.push({ ...raw.pages[0].objects[0], id: "source-only", structure: "opaque source",
    structureFormat: "future-format", atoms: [], bonds: [] });
  raw.pages[0].objects.push({ id: "caption", type: "text", text: "Caption", spans: [],
    x: 100, y: 200, width: 100, height: 22, rotation: 0, style: {} });
  return readDocument(raw).document;
}

const chemistryCopyFormats = ["MOL V2000", "MOL V3000", "SMILES"] as const;
function copyChemistry(document: ChemDraftDocument, format: typeof chemistryCopyFormats[number], warnings: string[]) {
  return format === "SMILES" ? copyAsSmiles(document, warnings)
    : copyAsMolfile(document, format === "MOL V2000" ? "v2000" : "v3000", warnings);
}

describe("preserved source chemistry in native editing workflows", () => {
  it("duplicates preserved chemistry with the copy's object identity", () => {
    const opened = sourceDocument();
    expect(savedOrders(opened)).toEqual(["quadruple"]);
    const selected = selectDocumentObjects(opened, opened.pages[0]!.id, ["molecule_001"]);
    const duplicated = duplicateSelectedDocumentObjects(selected);
    expect(savedOrders(duplicated)).toEqual(["quadruple", "quadruple"]);
    expect(duplicated.selection.objectIds).toEqual(["mol_copy_002"]);
    const reopened = openNativeDocument(createNativeSavePayload(duplicated).contents).document!;
    expect(savedOrders(reopened)).toEqual(["quadruple", "quadruple"]);
  });

  it.each(["same document", "blank document"])("carries source chemistry through serialized native clipboard into %s", target => {
    const opened = sourceDocument();
    const selected = selectDocumentObjects(opened, opened.pages[0]!.id, ["molecule_001"]);
    const payload = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(createSelectionClipboardPayload(selected)!))!;
    const destination = target === "same document" ? selected : createEmptyDocument({ pageId: "different-page" });
    const pasted = pasteSelectionClipboardPayload(destination, payload, { x: 300, y: 300 });
    expect(savedOrders(pasted)).toEqual(target === "same document" ? ["quadruple", "quadruple"] : ["quadruple"]);
    expect(savedOrders(openNativeDocument(createNativeSavePayload(pasted).contents).document!)).toEqual(savedOrders(pasted));
    const copied = pasted.pages[0]!.objects.at(-1)!;
    expect(copied.id).not.toBe("molecule_001");
    if (copied.type !== "molecule") throw new Error("Expected a native molecule");
    expect(copied.atoms.map(atom => atom.id)).toEqual(["a", "b"]);
    expect(copied.bonds[0]).toMatchObject({ id: "bond", fromAtomId: "a", toAtomId: "b" });
  });

  it("never restores a deleted object's chemistry onto a duplicate that reuses its ID", () => {
    const opened = sourceDocument(["quintuple", "quadruple"]);
    const deleted = deleteSelectedDocumentObjects(opened, ["mol_copy_002"]);
    const selected = selectDocumentObjects(deleted, deleted.pages[0]!.id, ["molecule_001"]);
    const duplicated = duplicateSelectedDocumentObjects(selected);
    expect(duplicated.selection.objectIds).toEqual(["mol_copy_002"]);
    expect(savedOrders(duplicated)).toEqual(["quintuple", "quintuple"]);
  });

  it("prunes on delete while undo and redo restore exact recorded extension states", () => {
    const opened = sourceDocument(["quintuple", "quadruple"]);
    const originalContents = serializeDocument(opened);
    const deleted = deleteSelectedDocumentObjects(opened, ["mol_copy_002"]);
    expect(deleted.compatibility.nativeExtensions).toHaveLength(1);
    const history = { ...createDocumentHistory(opened), past: [opened], present: deleted };
    const undone = undo(history);
    expect(undone.present).toBe(opened);
    expect(serializeDocument(undone.present)).toBe(originalContents);
    const redone = redo(undone);
    expect(redone.present).toBe(deleted);
    expect(savedOrders(redone.present)).toEqual(["quintuple"]);
    expect(redone.present.compatibility.nativeExtensions).toHaveLength(1);
  });

  it("refuses a foreign clipboard format that cannot encode preserved source chemistry", () => {
    expect(() => copyAsMolfile(sourceDocument(), "v3000")).toThrow(/preserved|quadruple/i);
  });

  it("returns a visible refusal for MOL and SMILES copy, without emitting fallback chemistry", async () => {
    const document = sourceDocument();
    const warnings: string[] = [];
    expect(copyAsMolfile(document, "v2000", warnings)).toBeUndefined();
    expect(await copyAsSmiles(document, warnings)).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings.every(message => /refused.*preserved.*quadruple.*native ChemDraft copy/.test(message))).toBe(true);
  });

  describe.each(chemistryCopyFormats)("%s copy scope", format => {
    it.each(["selection", "whole page", "group", "annotation fallback"])(
      "refuses source-only preserved chemistry in the full %s before graph filtering",
      async scope => {
        let document = mixedCopyDocument();
        if (scope !== "whole page") {
          document = selectDocumentObjects(document, document.pages[0]!.id,
            scope === "annotation fallback" ? ["caption"] : ["molecule_001", "source-only"]);
          if (scope === "group") document = groupSelectedDocumentObjects(document);
        }
        const before = serializeDocument(document);
        const warnings: string[] = [];
        expect(await copyChemistry(document, format, warnings)).toBeUndefined();
        expect(warnings).toEqual([`Copy as ${format === "SMILES" ? "SMILES" : "MOL"} refused: preserved source chemistry ("future-format") cannot be represented. Use native ChemDraft copy to keep it.`]);
        expect(serializeDocument(document)).toBe(before);
      }
    );

    it("still copies normal selected chemistry when preserved chemistry is outside the scope", async () => {
      const opened = mixedCopyDocument();
      const document = selectDocumentObjects(opened, opened.pages[0]!.id, ["molecule_001"]);
      const warnings: string[] = [];
      const copied = await copyChemistry(document, format, warnings);
      expect(copied).toBeTruthy();
      expect(warnings).toEqual([]);
      if (format === "SMILES") expect(copied).toBe("CC");
      else expect(copied).toContain(format === "MOL V2000" ? "V2000" : "V3000");
    });
  });

  it("keeps distinct chemistry for copied molecules sharing atom and bond IDs", () => {
    const opened = sourceDocument(["quintuple", "quadruple"]);
    const selected = selectDocumentObjects(opened, opened.pages[0]!.id, ["molecule_001", "mol_copy_002"]);
    const copied = duplicateSelectedDocumentObjects(selected);
    expect(savedOrders(copied)).toEqual(["quintuple", "quadruple", "quintuple", "quadruple"]);
    expect(savedOrders(opened)).toEqual(["quintuple", "quadruple"]);
  });

  it("carries fragment chemistry only for the copied atoms and bonds", () => {
    const raw = JSON.parse(serializeDocument(sourceDocument()));
    raw.pages[0].objects[0].atoms.push({ id: "c", element: "C", x: 44, y: 0, formalCharge: 0 });
    raw.pages[0].objects[0].bonds.push({ id: "excluded-bond", fromAtomId: "b", toAtomId: "c", order: "quintuple" });
    const opened = readDocument(raw).document;
    const payload = createSelectionClipboardPayload(opened, [{ objectId: "molecule_001", atomIds: ["a", "b"], bondIds: [] }])!;
    const parsed = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(payload))!;
    const pasted = pasteSelectionClipboardPayload(createEmptyDocument(), parsed, { x: 300, y: 300 });
    expect(savedOrders(pasted)).toEqual(["quadruple"]);
    expect(pasted.compatibility.nativeExtensions).toHaveLength(1);
    const molecule = pasted.pages[0]!.objects[0]!;
    if (molecule.type !== "molecule") throw new Error("Expected native molecule");
    expect(molecule.atoms.map(atom => atom.id)).toEqual(["a", "b"]);
    expect(molecule.bonds.map(bond => bond.id)).toEqual(["bond"]);
  });

  it("serializes actual source values and validates them instead of accepting an executable sidecar", () => {
    const document = sourceDocument();
    const selected = selectDocumentObjects(document, document.pages[0]!.id, ["molecule_001"]);
    const serialized = serializeSelectionClipboardPayload(createSelectionClipboardPayload(selected)!);
    const raw = JSON.parse(serialized);
    expect(raw).not.toHaveProperty("nativeSource");
    expect(raw.objects[0].bonds[0].order).toBe("quadruple");
    raw.objects[0].bonds[0].stereo = "unsupported-chemistry";
    expect(parseSelectionClipboardPayload(JSON.stringify(raw))).toBeUndefined();
  });

  it("keeps the future version and ignorable-field contract across documents", () => {
    const raw = JSON.parse(serializeDocument(sourceDocument()));
    raw.formatVersion = "1.3.0";
    raw.minAppVersion = "1.3.0";
    raw.ignorableFields = ["pages.*.objects.*[type=molecule].atoms.*.futureHalo"];
    raw.pages[0].objects[0].atoms[0].futureHalo = { color: "red" };
    const opened = readDocument(raw).document;
    const selected = selectDocumentObjects(opened, opened.pages[0]!.id, ["molecule_001"]);
    const payload = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(createSelectionClipboardPayload(selected)!))!;
    const pasted = pasteSelectionClipboardPayload(createEmptyDocument({ pageId: "other" }), payload, { x: 300, y: 300 });
    const saved = JSON.parse(serializeDocument(pasted));
    expect(saved).toMatchObject({ formatVersion: "1.3.0", minAppVersion: "1.3.0", ignorableFields: raw.ignorableFields });
    expect(saved.pages[0].objects[0].atoms[0].futureHalo).toEqual({ color: "red" });
    expect(savedOrders(pasted)).toEqual(["quadruple"]);
    expect(savedOrders(readDocument(saved).document)).toEqual(["quadruple"]);
  });
});
