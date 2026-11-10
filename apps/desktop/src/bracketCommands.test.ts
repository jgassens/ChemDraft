import { describe, expect, it, vi } from "vitest";
import { applyPatch, undo, redo, type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { repeatUnitExportWarnings } from "@chemdraft/export-engine";
import { bracketRepeatUnitStatus, createBracketCommands, selectedBracketPair, setBracketRepeatLabel, toggleBracketRepeatUnit } from "./bracketCommands";
import { bracketLabelContainsPoint, bracketLabelPlan, transformPointForObject } from "@chemdraft/layout-engine";
import { applySingleBondToolAtPoint, copyAsMolfile, copyAsSmiles, createPhase4Document,
  createSelectionClipboardPayload, deleteSelectedDocumentObjects, duplicateSelectedDocumentObjects, insertNativeBracket, pasteSelectionClipboardPayload } from "./documentWorkflow";
import { exportStructureListSdf, exportStructureListSmi } from "./structureListExport";
import { allShellCommands } from "./commands";

vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn(async () => undefined) }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

const brackets = () => insertNativeBracket(createPhase4Document("Bracket unit"), { x: 100, y: 100 }, "round", { x: 260, y: 200 });
const bracketObjects = (document: ChemDraftDocument) => document.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
const repeatAroundMolecule = () => toggleBracketRepeatUnit(insertNativeBracket(
  applySingleBondToolAtPoint(createPhase4Document("Unit"), { x: 140, y: 140 }),
  { x: 100, y: 100 }, "round", { x: 260, y: 200 }));
function expectPlainBracket(object: BracketObject) {
  expect(object.pairId).toBeUndefined();
  expect(object.repeatUnit).toBeUndefined();
  expect(object.label).toBeUndefined();
}

describe("bracket pair annotations", () => {
  it.each([0, 1, 2, 5])("reports %s enclosed atoms with the actual label and singular/plural wording", count => {
    const original = repeatAroundMolecule();
    const molecule = original.pages[0].objects.find(object => object.type === "molecule")!;
    const repeat = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "molecule" ? { ...object, atoms: Array.from({ length: count }, (_, index) =>
        ({ ...molecule.atoms[0], id: `count_atom_${index}`, x: 140 + index * 5, y: 140 })), bonds: [] } : object) }] };
    const closing = selectedBracketPair(repeat).find(object => object.side === "close")!;
    const edited = setBracketRepeatLabel(repeat, closing.id, "m");
    expect(bracketRepeatUnitStatus(edited)).toBe(`Marked ${count} ${count === 1 ? "atom" : "atoms"} as repeat unit "m"`);
    expect(bracketRepeatUnitStatus(toggleBracketRepeatUnit(edited))).toBe('Removed repeat unit "m"');
  });
  it("counts enclosed atoms of a partially bracketed molecule without counting outside atoms", () => {
    const original = repeatAroundMolecule();
    const partial = { ...original, pages: [{ ...original.pages[0], objects: original.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, containedObjectIds: [] } : object.type === "molecule"
        ? { ...object, atoms: object.atoms.map((atom, index) => index ? { ...atom, x: 400 } : atom) } : object) }] };
    expect(bracketRepeatUnitStatus(partial)).toBe('Marked 1 atom as repeat unit "n"');
  });
  it("hits the shared label bounds after rotating a bracket, and excludes its glyph", () => {
    const closing = selectedBracketPair(repeatAroundMolecule()).find(object => object.side === "close")!;
    const rotated = { ...closing, rotation: 35 };
    const bounds = bracketLabelPlan(rotated)!.bounds;
    const point = transformPointForObject(rotated, { x: rotated.x + bounds.x + bounds.width / 2,
      y: rotated.y + bounds.y + bounds.height / 2 });
    expect(bracketLabelContainsPoint(rotated, point)).toBe(true);
    expect(bracketLabelContainsPoint(rotated, transformPointForObject(rotated,
      { x: rotated.x + rotated.width / 2, y: rotated.y + rotated.height / 2 }))).toBe(false);
    expect(bracketLabelContainsPoint({ ...rotated, repeatUnit: false }, point)).toBe(false);
  });
  it("exposes the repeat-unit command with selection-dependent availability", () => {
    const document = brackets();
    expect(allShellCommands(document).find(command => command.id === "bracket.repeatUnit.toggle")).toMatchObject({ enabled: true });
    const unselected = applyPatch(document, { op: "setSelection", objectIds: [] });
    expect(allShellCommands(unselected).find(command => command.id === "bracket.repeatUnit.toggle")).toMatchObject({ enabled: false, disabledReason: expect.any(String) });
  });
  it("toggles both glyphs, labels only the closing side and keeps both selected", () => {
    const original = brackets();
    const repeat = toggleBracketRepeatUnit(original);
    expect(selectedBracketPair(repeat).every(object => object.repeatUnit)).toBe(true);
    const close = selectedBracketPair(repeat).find(object => object.side === "close")!;
    expect(close.label).toBe("n");
    const edited = setBracketRepeatLabel(repeat, close.id, "m");
    expect(selectedBracketPair(edited).find(object => object.side === "close")!.label).toBe("m");
    expect(edited.selection.objectIds).toEqual(original.selection.objectIds);
    expect(selectedBracketPair(toggleBracketRepeatUnit(edited)).every(object => !object.repeatUnit)).toBe(true);
    expect(createBracketCommands(original).find(action => action.id === "bracket.label.edit")).toMatchObject({ enabled: false, disabledReason: expect.any(String) });
  });
  it("also finds a pair from a selection of either side and refuses unrelated selections", () => {
    const original = brackets();
    const document = applyPatch(original, { op: "setSelection", objectIds: [original.selection.objectIds[1]] });
    expect(selectedBracketPair(document)).toHaveLength(2);
    const unselected = applyPatch(document, { op: "setSelection", objectIds: [] });
    expect(toggleBracketRepeatUnit(unselected)).toBe(unselected);
  });
  it("gives duplicated and pasted pairs independent identities", () => {
    const original = brackets();
    const duplicate = duplicateSelectedDocumentObjects(original);
    const copied = selectedBracketPair(duplicate);
    expect(copied).toHaveLength(2);
    expect(copied[0].pairId).not.toBe(selectedBracketPair(original)[0].pairId);
    const payload = createSelectionClipboardPayload(original)!;
    const pasted = pasteSelectionClipboardPayload(original, payload, { x: 300, y: 300 });
    expect(selectedBracketPair(pasted)).toHaveLength(2);
    expect(selectedBracketPair(pasted)[0].pairId).not.toBe(selectedBracketPair(original)[0].pairId);
  });

  it.each([false, true])("keeps only copied membership on duplicate and paste (molecule copied: %s)", includeMolecule => {
    const original = repeatAroundMolecule();
    const molecule = original.pages[0].objects.find(object => object.type === "molecule")!;
    expect(bracketObjects(original).every(object => object.containedObjectIds.includes(molecule.id))).toBe(true);
    const source = includeMolecule ? applyPatch(original, { op: "setSelection", objectIds: original.pages[0].objects.map(object => object.id) }) : original;
    const target = applySingleBondToolAtPoint(createPhase4Document("Other document"), { x: 400, y: 400 });
    expect(target.pages[0].objects[0].id).toBe(molecule.id);
    const payload = createSelectionClipboardPayload(source)!;
    expect(payload.objects.filter((object): object is BracketObject => object.type === "bracket")
      .map(object => object.containedObjectIds)).toEqual(includeMolecule ? [[molecule.id], [molecule.id]] : [[], []]);
    // Also accept older clipboard payloads that still contain uncopied member IDs.
    const olderPayload = { ...payload, objects: original.pages[0].objects.filter(object => includeMolecule || object.type === "bracket") };
    for (const result of [duplicateSelectedDocumentObjects(source),
      pasteSelectionClipboardPayload(target, payload, { x: 300, y: 300 }),
      pasteSelectionClipboardPayload(target, olderPayload, { x: 300, y: 300 })]) {
      const selected = result.pages[0].objects.filter(object => result.selection.objectIds.includes(object.id));
      const copiedMolecule = selected.find(object => object.type === "molecule");
      for (const bracket of selected.filter((object): object is BracketObject => object.type === "bracket")) {
        expect(bracket.containedObjectIds).toEqual(includeMolecule ? [copiedMolecule!.id] : []);
        expect(bracket.containedObjectIds).not.toContain(molecule.id);
      }
      const exported = exportDocumentToCdxml(result);
      const visible = exported.contents.replace(/<objecttag\b[^>]*\/>/g, "");
      if (!includeMolecule) {
        const groups = [...visible.matchAll(/<bracketedgroup\b([^>]*)>/g)];
        expect(groups.at(-1)![1]).not.toContain("BracketedObjectIDs");
      }
      const reopened = openChemDraftPayload(exported.contents).document!;
      expect(bracketObjects(reopened).map(object => object.containedObjectIds)).toEqual(bracketObjects(result).map(object => object.containedObjectIds));
    }
    expect(bracketObjects(original).every(object => object.containedObjectIds.includes(molecule.id))).toBe(true);
  });

  it.each(["open", "close"] as const)("copies only the %s glyph without pair metadata", side => {
    const original = repeatAroundMolecule();
    const selected = bracketObjects(original).find(object => object.side === side)!;
    const source = applyPatch(original, { op: "setSelection", objectIds: [selected.id] });
    const payload = createSelectionClipboardPayload(source)!;
    expect(payload.objects).toHaveLength(1);
    expectPlainBracket(payload.objects[0] as BracketObject);
    const olderPayload = { ...payload, objects: [selected] };
    for (const result of [duplicateSelectedDocumentObjects(source),
      pasteSelectionClipboardPayload(source, payload, { x: 400, y: 400 }),
      pasteSelectionClipboardPayload(source, olderPayload, { x: 400, y: 400 })]) {
      const copy = bracketObjects(result).find(object => result.selection.objectIds.includes(object.id))!;
      expectPlainBracket(copy);
      expect(copy.containedObjectIds).toEqual([]);
    }
    expect(selectedBracketPair(source)).toHaveLength(2);
  });

  it.each(["open", "close"] as const)("deletes/cuts the %s half and clears the survivor in one undo entry", side => {
    const original = repeatAroundMolecule();
    const removed = bracketObjects(original).find(object => object.side === side)!;
    for (const capturedIds of [undefined, [removed.id]]) {
      const before = capturedIds ? original : applyPatch(original, { op: "setSelection", objectIds: [removed.id] });
      const deleted = deleteSelectedDocumentObjects(before, capturedIds);
      const survivor = bracketObjects(deleted)[0];
      expect(bracketObjects(deleted)).toHaveLength(1);
      expectPlainBracket(survivor);
      expect(repeatUnitExportWarnings(deleted, "MOL")).toEqual([]);
      expect(setBracketRepeatLabel(deleted, survivor.id, "m")).toBe(deleted);
      const exported = exportDocumentToCdxml(deleted);
      expect(exported.contents).toContain('GraphicType="Bracket"');
      expect(exported.contents).not.toContain("<bracketedgroup");
      expect(exported.warnings).toEqual([]);
      const history = { past: [before], present: deleted, future: [] };
      expect(undo(history).present).toBe(before);
      expect(undo(history).present.pages[0].objects).toEqual(before.pages[0].objects);
      expect(redo(undo(history)).present).toBe(deleted);
    }
  });
});

describe("repeat-unit graph-export warnings", () => {
  it.each(["square", "round"] as const)("leaves ordinary %s exports unchanged, writes SRU and warns for SMILES", async kind => {
    const molecule = applySingleBondToolAtPoint(createPhase4Document("Unit"), { x: 140, y: 140 });
    const plain = insertNativeBracket(molecule, { x: 100, y: 100 }, kind, { x: 260, y: 200 });
    const beforeWarnings: string[] = [];
    copyAsMolfile(plain, "v3000", beforeWarnings);
    expect(beforeWarnings).toEqual([]);
    expect(repeatUnitExportWarnings(plain, "SMILES")).toEqual([]);
    const repeat = applyPatch(toggleBracketRepeatUnit(plain), { op: "setSelection", objectIds: [] });
    expect(repeat.pages[0].objects.filter(object => object.type === "molecule")).toEqual(molecule.pages[0].objects);
    for (const flavor of ["v2000", "v3000"] as const) {
      const warnings: string[] = [];
      const contents = copyAsMolfile(repeat, flavor, warnings);
      expect(copyAsMolfile(plain, flavor)).toBe(copyAsMolfile(molecule, flavor));
      expect(warnings).toEqual([]);
      expect(contents).toContain(flavor === "v3000" ? "SRU 0 ATOMS=(2 1 2) LABEL=n CONNECT=EU" : "  1 SRU");
      expect(contents).toContain(flavor === "v3000" ? "BEGIN SGROUP" : "M  SMT   1 n");
    }
    const smilesWarnings: string[] = [];
    expect(await copyAsSmiles(repeat, smilesWarnings)).toBe("CC");
    expect(smilesWarnings).toHaveLength(1);
    expect(smilesWarnings[0]).toContain("SMILES cannot hold the repeat unit n around 2 atoms");
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) {
      const result = await writer(repeat);
      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([expect.objectContaining({ code: "export.repeat_unit_not_represented" })]);
    }
    expect((await exportStructureListSdf(repeat)).contents).toContain("  1 SRU");
    await expect(copyAsSmiles(repeat)).resolves.toBe("CC");
  });

  it.each([false, true])("does not warn for an unrelated selected molecule (pair on another page: %s)", async anotherPage => {
    const repeat = repeatAroundMolecule();
    const withOther = applySingleBondToolAtPoint(repeat, { x: 400, y: 400 });
    const selectedMolecule = withOther.pages[0].objects.find(object => object.type === "molecule" && withOther.selection.objectIds.includes(object.id))!;
    const document = anotherPage ? { ...withOther, pages: [
      { ...withOther.pages[0], objects: [selectedMolecule] },
      { ...repeat.pages[0], id: "other_page" }
    ] } : withOther;
    const warnings: string[] = [];
    expect(copyAsMolfile(document, "v3000", warnings)).toBeDefined();
    expect(await copyAsSmiles(document, warnings)).toBe("CC");
    expect(warnings).toEqual([]);
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) expect((await writer(document)).warnings).toEqual([]);
  });

  it("detects units when only their atoms are selected, and ignores unrelated molecules", () => {
    const repeat = repeatAroundMolecule();
    const molecule = repeat.pages[0].objects.find(object => object.type === "molecule")!;
    // Selecting just the molecule must still report the semantic loss of its repeat brackets.
    expect(repeatUnitExportWarnings(repeat, "SMILES", { molecules: [molecule] })).toHaveLength(1);
    expect(repeatUnitExportWarnings(repeat, "MOL", { molecules: [] })).toEqual([]);
    expect(repeatUnitExportWarnings(repeat, "MOL")).toHaveLength(1);
    const enclosed = { ...repeat, pages: [{ ...repeat.pages[0], objects: repeat.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, containedObjectIds: [] } : object) }] };
    expect(repeatUnitExportWarnings(enclosed, "MOL")).toHaveLength(1);
    const outside = { ...enclosed, pages: [{ ...enclosed.pages[0], objects: enclosed.pages[0].objects.map(object =>
      object.type === "molecule" ? { ...object, x: 400, y: 400, atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + 400, y: atom.y + 400 })) } : object) }] };
    expect(repeatUnitExportWarnings(outside, "MOL")).toEqual([]);
  });

  it("stays quiet when an included pair contains only molecules excluded from the export", async () => {
    const repeat = repeatAroundMolecule();
    const withOther = applySingleBondToolAtPoint(repeat, { x: 400, y: 400 });
    const scoped = applyPatch(withOther, { op: "setSelection", objectIds: [
      ...withOther.selection.objectIds, ...bracketObjects(repeat).map(object => object.id)
    ] });
    const warnings: string[] = [];
    expect(copyAsMolfile(scoped, "v3000", warnings)).toBeDefined();
    expect(await copyAsSmiles(scoped, warnings)).toBe("CC");
    expect(warnings).toEqual([]);
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) expect((await writer(scoped)).warnings).toEqual([]);
  });
});
