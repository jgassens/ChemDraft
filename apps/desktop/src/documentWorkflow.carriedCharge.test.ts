import { describe, expect, it } from "vitest";
import { applyPatches, serializeDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import * as workflow from "./documentWorkflow";
import { dropElectronMark } from "./electronMarkDrop";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

function distantAttachedCharge() {
  const fixture = electronMarkDropFixture();
  const mark = dropMark(fixture.document);
  const dropped = dropElectronMark(fixture.document, mark.id,
    { x: 600 - mark.width / 2, y: 500 - mark.height / 2 }, { x: 600, y: 500 });
  expect(dropped.refused).toBeUndefined();
  expect(dropMark(dropped.document)).toMatchObject({ atomAssociation: "explicit",
    anchor: { kind: "atom", objectId: dropMolecule(dropped.document).id, atomId: fixture.nitrogen.id } });
  expect(dropMolecule(dropped.document).atoms.find(atom => atom.id === fixture.nitrogen.id)?.formalCharge).toBe(1);
  return workflow.selectDocumentObjects(dropped.document, dropped.document.pages[0].id,
    [dropMolecule(dropped.document).id, mark.id]);
}

function expectCarriedCharges(document: ChemDraftDocument, expected: number[]) {
  const molecules = document.pages[0].objects.filter(object => object.type === "molecule");
  expect(molecules.map(molecule => molecule.atoms.find(atom => atom.element === "N")?.formalCharge)).toEqual(expected);
  for (const molecule of molecules) {
    const nitrogen = molecule.atoms.find(atom => atom.element === "N")!;
    expect(nitrogen.markCharge).toBe(1);
    expect(document.pages[0].objects.find(object => object.type === "electron-mark" &&
      object.anchor.objectId === molecule.id)).toMatchObject({ atomAssociation: "explicit",
      anchor: { kind: "atom", objectId: molecule.id, atomId: nitrogen.id } });
  }
}

function groupedChargeForLayout(grouped = true) {
  let document = distantAttachedCharge();
  if (grouped) document = workflow.groupSelectedDocumentObjects(document);
  const selectedIds = document.selection.objectIds;
  const boxes: GraphicObject[] = [
    { id: "layout-first", type: "graphic", graphicKind: "rect", x: 10, y: 10, width: 20, height: 20, rotation: 0, style: {}, data: {} },
    { id: "layout-last", type: "graphic", graphicKind: "rect", x: 700, y: 560, width: 20, height: 20, rotation: 0, style: {}, data: {} }
  ];
  document = applyPatches(document, boxes.map(object => ({ op: "addObject", pageId: document.pages[0].id, object })));
  return workflow.selectDocumentObjects(document, document.pages[0].id, [...selectedIds, ...boxes.map(box => box.id)]);
}

const chargeLayoutOperations = [
  ...(["left", "center", "right", "top", "middle", "bottom"] as const).map(mode => ({
    name: `align ${mode}`, apply: (document: ChemDraftDocument) => workflow.alignSelectedDocumentObjects(document, mode)
  })),
  ...(["horizontal", "vertical"] as const).flatMap(axis => (["centers", "spacing"] as const).map(mode => ({
    name: `distribute ${axis} ${mode}`,
    apply: (document: ChemDraftDocument) => workflow.distributeSelectedDocumentObjects(document, axis, mode)
  })))
];

describe("complete molecule carried with its distant explicit charge", () => {
  it.each(["mark only", "different deltas"])("keeps the existing align policy when the pair does not travel together: %s", selection => {
    let document = groupedChargeForLayout(false);
    if (selection === "mark only") document = workflow.selectDocumentObjects(document, document.pages[0].id,
      [dropMark(document).id, "layout-first"]);
    const edited = workflow.alignSelectedDocumentObjects(document, "left");
    const committed = workflow.normalizeCommittedDocument(edited);
    expect(dropMark(edited).atomAssociation).toBeUndefined();
    expect(dropMark(committed).anchor.kind).toBe("point");
    expect(dropMolecule(committed).atoms.find(atom => atom.element === "N")?.formalCharge).toBe(0);
  });

  it.each(["align", "distribute"] as const)("warns when %s cannot carry an explicit pair with a missing atom, or fails without a sink", operation => {
    let document = groupedChargeForLayout();
    const mark = dropMark(document);
    document = applyPatches(document, [{ op: "updateObject", objectId: mark.id,
      changes: { anchor: { ...mark.anchor, atomId: "missing_atom" } } }]);
    const apply = (warnings?: string[]) => operation === "align"
      ? workflow.alignSelectedDocumentObjects(document, "left", warnings)
      : workflow.distributeSelectedDocumentObjects(document, "horizontal", "spacing", warnings);
    const warnings: string[] = [];
    apply(warnings);
    expect(warnings).toEqual([
      `Cannot preserve explicit electron mark "${mark.id}" association: atom "missing_atom" in molecule "${dropMolecule(document).id}" is missing.`
    ]);
    expect(() => apply()).toThrow(warnings[0]);
  });

  it.each(chargeLayoutOperations)("preserves the grouped pair through $name, commit and save/reopen", ({ apply }) => {
    const document = groupedChargeForLayout(), original = dropMolecule(document), mark = dropMark(document);
    const originalJson = serializeDocument(document);
    const edited = apply(document);
    const moved = dropMolecule(edited), movedMark = dropMark(edited);
    const dx = moved.x - original.x, dy = moved.y - original.y;
    expect(Math.abs(dx) + Math.abs(dy)).toBeGreaterThan(1);
    expect(movedMark.x).toBeCloseTo(mark.x + dx);
    expect(movedMark.y).toBeCloseTo(mark.y + dy);
    expectCarriedCharges(edited, [1]);
    const committed = workflow.normalizeCommittedDocument(edited);
    expectCarriedCharges(committed, [1]);
    expect(dropMolecule(committed).atoms).toEqual(original.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy })));
    expect(dropMolecule(committed).bonds).toEqual(original.bonds);
    expect(dropMolecule(committed).structure).toBe(original.structure);
    expect(dropMolecule(committed).chemistry).toEqual(original.chemistry);
    expect(serializeDocument(document)).toBe(originalJson);
    const reopened = workflow.openNativeDocument(serializeDocument(committed));
    expect(reopened.document).toBeDefined();
    expectCarriedCharges(workflow.normalizeCommittedDocument(reopened.document!), [1]);
  });

  it.each(["move", "duplicate", "copy/paste"] as const)("preserves nitrogen charge through %s, commit and save/reopen", operation => {
    const document = distantAttachedCharge();
    const original = dropMolecule(document);
    const originalJson = serializeDocument(document);
    let edited: ChemDraftDocument;
    if (operation === "move") {
      edited = workflow.moveDocumentObjects(document, document.selection.objectIds, 24, 24);
    } else if (operation === "duplicate") {
      edited = workflow.duplicateSelectedDocumentObjects(document);
    } else {
      const payload = workflow.parseSelectionClipboardPayload(workflow.serializeSelectionClipboardPayload(
        workflow.createSelectionClipboardPayload(document)!))!;
      payload.objects.reverse(); // Forward anchor references must work when the mark comes first.
      edited = workflow.pasteSelectionClipboardPayload(workflow.createPhase4Document("Blank paste"), payload,
        { x: payload.bounds.centerX + 24, y: payload.bounds.centerY + 24 });
    }
    const committed = workflow.normalizeCommittedDocument(edited);
    const expected = operation === "duplicate" ? [1, 1] : [1];
    expectCarriedCharges(edited, expected);
    expectCarriedCharges(committed, expected);
    for (const molecule of committed.pages[0].objects.filter(object => object.type === "molecule")) {
      const delta = operation === "duplicate" && molecule.id === original.id ? 0 : 24;
      expect(molecule.atoms).toEqual(original.atoms.map(atom => ({ ...atom, x: atom.x + delta, y: atom.y + delta })));
      expect(molecule.bonds).toEqual(original.bonds);
      expect(molecule.structure).toBe(original.structure);
      expect(molecule.chemistry).toEqual(original.chemistry);
    }
    expect(serializeDocument(document)).toBe(originalJson);
    const reopened = workflow.openNativeDocument(serializeDocument(committed));
    expect(reopened.document).toBeDefined();
    expectCarriedCharges(workflow.normalizeCommittedDocument(reopened.document!), expected);
  });

  it("keeps the existing mark-only move and molecule-only duplicate policies", () => {
    const document = distantAttachedCharge(), mark = dropMark(document), molecule = dropMolecule(document);
    const moved = workflow.normalizeCommittedDocument(workflow.moveDocumentObjects(document, [mark.id], 24, 24));
    expect(dropMolecule(moved).atoms.find(atom => atom.element === "N")?.formalCharge).toBe(0);
    expect(dropMark(moved).anchor.kind).toBe("point");
    expect(dropMark(moved).atomAssociation).toBeUndefined();
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id]);
    const duplicated = workflow.normalizeCommittedDocument(workflow.duplicateSelectedDocumentObjects(selected));
    expect(duplicated.pages[0].objects.filter(object => object.type === "molecule")
      .map(object => object.atoms.find(atom => atom.element === "N")?.formalCharge)).toEqual([1, 0]);
    expect(dropMark(duplicated)).toEqual(mark);
    const carried = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(document, molecule.id,
      { x: molecule.x + 24, y: molecule.y + 24 }));
    expectCarriedCharges(carried, [1]);
  });

  it("warns about an explicit copied pair with a missing atom, or fails without a warning sink", () => {
    const document = distantAttachedCharge();
    const payload = workflow.createSelectionClipboardPayload(document)!;
    const mark = payload.objects.find(object => object.type === "electron-mark")!;
    if (mark.type !== "electron-mark") throw new Error("Expected copied charge");
    mark.anchor.atomId = "missing_atom";
    const warnings: string[] = [];
    workflow.pasteSelectionClipboardPayload(workflow.createPhase4Document("Blank"), payload,
      { x: payload.bounds.centerX, y: payload.bounds.centerY }, warnings);
    expect(warnings).toEqual([
      `Cannot preserve explicit electron mark "${mark.id}" association: copied atom "missing_atom" in molecule "${dropMolecule(document).id}" is missing.`
    ]);
    expect(() => workflow.pasteSelectionClipboardPayload(workflow.createPhase4Document("Blank"), payload,
      { x: payload.bounds.centerX, y: payload.bounds.centerY })).toThrow(warnings[0]);
  });
});
