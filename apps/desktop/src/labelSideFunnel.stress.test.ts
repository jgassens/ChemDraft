// The commit funnel on a large drawing: what recording label bond sides adds to every commit.
// Logs its numbers in the repo's stress format; it asserts correctness, never a time threshold.

import { describe, expect, it } from "vitest";
import { applyPatch, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import {
  applyNativeAtomElementTarget,
  createPhase4Document,
  normalizeCommittedDocument,
  reconcileNativeChargeMarks
} from "./documentWorkflow";

const chainLength = 464;
const labels = ["OMe", "SCN", "CN", "NHBoc", "Ph", "CO2Me"];

/** A 464-carbon zigzag chain carrying 36 labelled branches: 500 heavy atoms. */
function largeLabelledMolecule(): { molecule: MoleculeObject; labelAtomIds: string[] } {
  const atoms: MoleculeAtom[] = [];
  const bonds: MoleculeBond[] = [];
  for (let index = 0; index < chainLength; index += 1) {
    atoms.push({ id: `c${index}`, element: "C", x: 40 + index * 26, y: 300 + (index % 2 === 0 ? 0 : 15), formalCharge: 0 });
    if (index > 0) bonds.push({ id: `cb${index}`, fromAtomId: `c${index - 1}`, toAtomId: `c${index}`, order: "single" });
  }
  const labelAtomIds: string[] = [];
  for (let branch = 0; branch < 36; branch += 1) {
    const anchor = atoms[6 + branch * 12]!;
    const id = `l${branch}`;
    // Alternate sides, so half the cyano labels are written with their bond on the right.
    atoms.push({
      id,
      element: labels[branch % labels.length]!,
      x: anchor.x + (branch % 2 === 0 ? 20 : -20),
      y: anchor.y - 26,
      formalCharge: 0,
      labelLiteral: true
    });
    bonds.push({ id: `lb${branch}`, fromAtomId: anchor.id, toAtomId: id, order: "single" });
    labelAtomIds.push(id);
  }
  return {
    molecule: {
      id: "large", type: "molecule", x: 0, y: 0, width: 13000, height: 400, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
    },
    labelAtomIds
  };
}

describe("the commit funnel on a large drawing", () => {
  it("records label sides on every commit at little cost: 500 heavy atoms, 36 labels, 100 edits", () => {
    const { molecule, labelAtomIds } = largeLabelledMolecule();
    const start = createPhase4Document("Funnel Timing");
    let current = normalizeCommittedDocument(applyPatch(start, { op: "addObject", pageId: start.pages[0]!.id, object: molecule }));
    const edited: ChemDraftDocument[] = [];
    let editMs = 0;
    for (let index = 0; index < 100; index += 1) {
      const atomId = labelAtomIds[index % labelAtomIds.length]!;
      const now = current.pages[0]!.objects.find((object): object is MoleculeObject => object.id === "large")!
        .atoms.find((atom) => atom.id === atomId)!.element;
      const startedEdit = performance.now();
      // Toggle the label, so every one of the 100 edits really changes it.
      const next = applyNativeAtomElementTarget(current, { objectId: "large", kind: "atom", atomId, distanceToPointer: 0 },
        now === "SCN" ? "OMe" : "SCN", { literal: true });
      editMs += performance.now() - startedEdit;
      expect(next).not.toBe(current);
      edited.push(next);
      current = normalizeCommittedDocument(next);
    }
    // Time each normalization over the same 100 edited documents, after a warm-up pass of each.
    const time = (normalize: (document: ChemDraftDocument) => ChemDraftDocument): number => {
      const started = performance.now();
      for (const document of edited) normalize(document);
      return performance.now() - started;
    };
    time(reconcileNativeChargeMarks);
    time(normalizeCommittedDocument);
    const chargeMarksOnly = time(reconcileNativeChargeMarks);
    const funnel = time(normalizeCommittedDocument);

    // Correct after 100 edits: every label is still there, and each cyano label carries a record.
    const final = current.pages[0]!.objects.find((object): object is MoleculeObject => object.id === "large")!;
    expect(final.atoms.filter((atom) => atom.id.startsWith("l"))).toHaveLength(36);
    expect(final.atoms.filter((atom) => ["SCN", "CN"].includes(atom.element)).every((atom) => atom.labelBondSide !== undefined)).toBe(true);
    expect(normalizeCommittedDocument(current)).toBe(current);
    console.info(
      `[stress label funnel] heavyAtoms=500 labels=36 commits=100 editMs=${editMs.toFixed(1)} ` +
      `chargeMarksOnlyMs=${chargeMarksOnly.toFixed(1)} funnelMs=${funnel.toFixed(1)} ` +
      `addedPerCommitMs=${((funnel - chargeMarksOnly) / 100).toFixed(3)} PASS`
    );
  }, 120000);
});
