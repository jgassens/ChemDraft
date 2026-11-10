import type { ChemDraftDocument, ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import type * as Workflow from "../documentWorkflow";

type MainWorkflow = Pick<typeof Workflow,
  "createPhase4Document" | "insertNativeSingleBondMolecule" | "applyChargeToolAtNativeAtom" |
  "normalizeCommittedDocument" | "selectDocumentObjects" | "moveDocumentObject" | "moveDocumentObjects" |
  "translateInsertedDocumentObjects" | "rotateDocumentObjectsAroundPoint" | "scaleDocumentObjectsAroundPoint" |
  "flipDocumentObjectsAroundPoint" | "alignSelectedDocumentObjects" | "duplicateSelectedDocumentObjects" |
  "createSelectionClipboardPayload" | "pasteSelectionClipboardPayload" | "groupSelectedDocumentObjects" |
  "rotateDocumentObject"
>;

export const associationSpecs: Workflow.NativeElectronMarkSpec[] = [
  { kind: "charge", charge: 1 }, { kind: "charge", charge: -1 },
  { kind: "charge", charge: 1, radical: true }, { kind: "charge", charge: -1, radical: true },
  { kind: "radical-dot" }, { kind: "lone-pair" }
];
export const markIn = (document: ChemDraftDocument) =>
  document.pages[0].objects.find(o => o.type === "electron-mark") as ElectronMarkObject;
export const moleculesIn = (document: ChemDraftDocument) =>
  document.pages[0].objects.filter((o): o is MoleculeObject => o.type === "molecule");

export function associationFixture(w: MainWorkflow, spec: Workflow.NativeElectronMarkSpec, crowded = false) {
  let document = w.insertNativeSingleBondMolecule(w.createPhase4Document("Mark association"), { x: 300, y: 300 });
  document = w.insertNativeSingleBondMolecule(document, { x: crowded ? 310 : 450, y: 300 });
  const molecule = moleculesIn(document)[0];
  const atom = molecule.atoms[0];
  document = w.applyChargeToolAtNativeAtom(document, spec,
    { objectId: molecule.id, kind: "atom", atomId: atom.id, distanceToPointer: 0 });
  const mark = markIn(document);
  // In the crowded fixture B is directly under the mark, which is still sticky to A.
  const center = crowded ? moleculesIn(document)[1].atoms[0] : atom;
  document = w.normalizeCommittedDocument({ ...document, pages: [{ ...document.pages[0], objects:
    document.pages[0].objects.map(o => o.id === mark.id ? { ...mark,
      x: center.x - mark.width / 2, y: center.y - mark.height / 2 } : o) }] });
  return { document, mark: markIn(document), molecule: moleculesIn(document)[0] };
}

/** The same scenarios can run against the current workflow or the pinned main implementation. */
export function mainAssociationCases(w: MainWorkflow, spec: Workflow.NativeElectronMarkSpec) {
  const { document, mark, molecule } = associationFixture(w, spec);
  const ids = [molecule.id, mark.id];
  const selected = w.selectDocumentObjects(document, document.pages[0].id, ids);
  const pivot = { x: 240, y: 260 };
  const moveMark = (to: { x: number; y: number }) => w.moveDocumentObject(document, mark.id,
    { x: to.x - mark.width / 2, y: to.y - mark.height / 2 });
  const payload = w.createSelectionClipboardPayload(selected)!;
  payload.objects.reverse(); // The mark precedes its molecule in both clipboard paths.
  const stalePayload = structuredClone(payload);
  for (const object of stalePayload.objects) if (object.type === "molecule") {
    object.atoms = object.atoms.filter(atom => atom.id !== mark.anchor.atomId);
    object.bonds = object.bonds.filter(bond =>
      object.atoms.some(atom => atom.id === bond.fromAtomId) && object.atoms.some(atom => atom.id === bond.toAtomId));
  }
  const orphanPayload = { ...payload, objects: payload.objects.filter(o => o.type === "electron-mark") };
  const empty = w.createPhase4Document("Paste target");
  const cases = [
    { name: "nearby move", before: document, patched: moveMark({ x: molecule.atoms[0].x + 4, y: molecule.atoms[0].y }) },
    { name: "onto neighbour", before: document, patched: moveMark(molecule.atoms[1]) },
    { name: "onto other molecule", before: document, patched: moveMark(moleculesIn(document)[1].atoms[0]) },
    { name: "away", before: document, patched: moveMark({ x: 650, y: 650 }) },
    { name: "group move", before: selected, patched: w.moveDocumentObjects(selected, ids, 80, 100) },
    { name: "molecule carry", before: selected, patched: w.moveDocumentObject(selected, molecule.id,
      { x: molecule.x + 80, y: molecule.y + 100 }) },
    { name: "insert translation", before: selected, patched: w.translateInsertedDocumentObjects(selected, ids, 80, 100) },
    { name: "alignment", before: document, patched: w.alignSelectedDocumentObjects(w.selectDocumentObjects(document,
      document.pages[0].id, moleculesIn(document).map(m => m.id)), "right") },
    { name: "duplicate small offset", before: selected, patched: w.duplicateSelectedDocumentObjects(selected, { x: 4, y: 4 }) },
    { name: "duplicate large offset", before: selected, patched: w.duplicateSelectedDocumentObjects(selected, { x: 80, y: 100 }) },
    { name: "duplicate mark only", before: document, patched: w.duplicateSelectedDocumentObjects(document, { x: 4, y: 4 }) },
    { name: "paste", before: empty, patched: w.pasteSelectionClipboardPayload(empty, payload,
      { x: payload.bounds.centerX + 4, y: payload.bounds.centerY + 4 }) },
    { name: "stale paste missing atom", before: empty, patched: w.pasteSelectionClipboardPayload(empty, stalePayload,
      { x: payload.bounds.centerX + 4, y: payload.bounds.centerY + 4 }) },
    { name: "stale paste missing molecule", before: empty, patched: w.pasteSelectionClipboardPayload(empty, orphanPayload,
      { x: payload.bounds.centerX + 4, y: payload.bounds.centerY + 4 }) }
  ];
  for (const [name, transformIds] of [["mark", [mark.id]], ["molecule and mark", ids]] as const) {
    cases.push(
      { name: `rotate ${name}`, before: selected, patched: w.rotateDocumentObjectsAroundPoint(selected, transformIds, pivot, 90) },
      { name: `scale ${name}`, before: selected, patched: w.scaleDocumentObjectsAroundPoint(selected, transformIds, pivot, 1.5, 1.5) },
      ...(["horizontal", "vertical"] as const).map(axis => ({
        name: `flip ${axis} ${name}`, before: selected,
        patched: w.flipDocumentObjectsAroundPoint(selected, transformIds, pivot, axis)
      }))
    );
  }
  const crowded = associationFixture(w, spec, true);
  const crowdedCenter = { x: crowded.mark.x + crowded.mark.width / 2, y: crowded.mark.y + crowded.mark.height / 2 };
  const grouped = w.groupSelectedDocumentObjects(w.selectDocumentObjects(crowded.document, crowded.document.pages[0].id,
    [...moleculesIn(crowded.document).map(m => m.id), crowded.mark.id]));
  const withTarget = w.insertNativeSingleBondMolecule(grouped, { x: 500, y: 300 });
  const alignedGroup = w.selectDocumentObjects(withTarget, withTarget.pages[0].id,
    withTarget.pages[0].objects.filter(o => o.type === "group" || (o.type === "molecule" && o.id !== crowded.molecule.id &&
      o.id !== moleculesIn(crowded.document)[1].id)).map(o => o.id));
  cases.push(
    { name: "crowded two molecule group", before: crowded.document, patched: w.moveDocumentObjects(crowded.document,
      [...moleculesIn(crowded.document).map(m => m.id), crowded.mark.id], 80, 100) },
    { name: "crowded alignment", before: crowded.document, patched: w.alignSelectedDocumentObjects(w.selectDocumentObjects(
      crowded.document, crowded.document.pages[0].id, moleculesIn(crowded.document).map(m => m.id)), "right") },
    { name: "crowded multi molecule group alignment", before: alignedGroup,
      patched: w.alignSelectedDocumentObjects(alignedGroup, "right") },
    { name: "crowded centered transform", before: crowded.document,
      patched: w.rotateDocumentObjectsAroundPoint(crowded.document, [crowded.mark.id], crowdedCenter, 73) },
    { name: "crowded frame rotation", before: crowded.document,
      patched: w.rotateDocumentObject(crowded.document, crowded.mark.id, 73) }
  );
  return cases;
}

/** Compact fixed oracle: anchors before/after reconciliation, all atom fields, and H-bearing formula. */
export function associationState(patched: ChemDraftDocument, committed: ChemDraftDocument) {
  const anchors = (document: ChemDraftDocument) => document.pages.flatMap(page => page.objects
    .filter((o): o is ElectronMarkObject => o.type === "electron-mark").map(mark => [mark.id, mark.anchor]));
  return {
    stored: anchors(patched), committed: anchors(committed),
    molecules: moleculesIn(committed).map(m => [m.id, m.atoms, m.bonds, m.chemistry])
  };
}
