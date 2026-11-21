import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import {
  CHEMISTRY_EDIT, PRESERVE_CHEMISTRY, chemistryEditOf, policyChemistryRefusals, structureEditChemistry, type CommitChemistryPolicy
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

// Drawing tools and the commit-time chemistry guard (AGENTS.md section 7). Bond, chain and template
// placement are SCOPED chemistry edits: they may change the molecule they draw onto, never another
// molecule that was already on the page. These cases drive the drawing workflow functions MainWindow
// calls and then the same policy check its commit funnel runs (`policyChemistryRefusals` with commit
// normalization), with the policy each caller passes.

const B_ID = "b_mol";
const B_AT = { x: 420, y: 350 };
// A legacy loose "+" 10 px left of B's first atom: commit normalization attributes it to B.
const STEAL_CENTER = { x: B_AT.x - 10, y: B_AT.y };

/** A neutral ethane at B_AT. */
function withNeutralB(document: ChemDraftDocument): ChemDraftDocument {
  const graph = testMoleculeFromSmiles("CC");
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: B_AT.x + index * 22, y: B_AT.y }));
  const molecule: MoleculeObject = { id: B_ID, type: "molecule", x: B_AT.x, y: B_AT.y, width: 22, height: 0,
    rotation: 0, style: {}, atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: [] };
  return applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule }], { now: phase4Timestamp });
}

const moleculeById = (document: ChemDraftDocument, id: string) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;

/**
 * Molecule A (Boc-glycine) and molecule B charged by a legacy loose "+" as an older file stores it:
 * a point anchor, not anchored to B's atom, unnormalized. Nothing is selected.
 */
function legacyLooseMarkBesideB() {
  const fixture = electronMarkDropFixture({ kind: "charge", charge: 1 });
  const mark = dropMark(fixture.document);
  const withB = withNeutralB(applyPatch(fixture.document, { op: "updateObject", objectId: mark.id, changes: {
    anchor: { kind: "point", point: STEAL_CENTER }, atomAssociation: undefined,
    x: STEAL_CENTER.x - mark.width / 2, y: STEAL_CENTER.y - mark.height / 2
  } }, { now: phase4Timestamp }));
  const document = workflow.selectDocumentObjects(withB, withB.pages[0].id, []);
  expect(workflow.committedElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(mark.id)?.objectId).toBe(B_ID);
  expect(moleculeById(workflow.normalizeCommittedDocument(document), B_ID).atoms[0]).toMatchObject({ formalCharge: 1 });
  return { document, a: dropMolecule(document), nitrogen: fixture.nitrogen, hydroxylOxygen: fixture.hydroxylOxygen };
}

/** What MainWindow's commit funnel decides for `next` committed over `before` under `policy`. */
function commitRefusals(before: ChemDraftDocument, next: ChemDraftDocument, policy: CommitChemistryPolicy): string[] {
  return policyChemistryRefusals(policy, {
    before, next, after: workflow.committedNormalForm(next), normalize: workflow.committedNormalForm,
    markAtoms: workflow.committedElectronMarkAtoms
  });
}

/** The one molecule `next` has that `before` did not. */
function addedMolecule(before: ChemDraftDocument, next: ChemDraftDocument): MoleculeObject {
  const old = new Set(before.pages[0].objects.map(object => object.id));
  const added = next.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule" && !old.has(object.id));
  expect(added).toHaveLength(1);
  return added[0];
}

/**
 * Places a standalone structure with `place` so that one of its atoms sits on `target`: placed once
 * at a probe point, then again shifted by the offset of its first atom (standalone placement is a
 * translation of the press point).
 */
function placeWithAnAtomOn(before: ChemDraftDocument, target: { x: number; y: number },
  place: (document: ChemDraftDocument, point: { x: number; y: number }) => ChemDraftDocument): ChemDraftDocument {
  const probePoint = { x: 300, y: 450 };
  const anchor = addedMolecule(before, place(before, probePoint)).atoms[0];
  const next = place(before, { x: probePoint.x + target.x - anchor.x, y: probePoint.y + target.y - anchor.y });
  const added = addedMolecule(before, next);
  expect(Math.min(...added.atoms.map(atom => Math.hypot(atom.x - target.x, atom.y - target.y)))).toBeLessThan(0.5);
  return next;
}

/** B lost its charge to the new structure under normalization alone: the hole the guard closes. */
function expectNormalizationTakesBsCharge(next: ChemDraftDocument) {
  expect(moleculeById(workflow.normalizeCommittedDocument(next), B_ID).atoms[0]).toMatchObject({ formalCharge: 0 });
}

const refusedFor = (operation: string, moleculeId: string) =>
  expect.stringMatching(new RegExp(`^Cannot ${operation} without changing the chemistry of molecule "${moleculeId}": `));

describe("standalone bond, chain and template placement beside a legacy loose charge mark", () => {
  it("refuses a standalone template that would take B's legacy loose +, naming B", () => {
    const { document } = legacyLooseMarkBesideB();
    const next = placeWithAnAtomOn(document, STEAL_CENTER, (before, point) => {
      const { plan } = workflow.nativeTemplatePlacementResult(before, { point }, "cyclohexane");
      expect(plan?.kind).toBe("standalone");
      return workflow.applyNativeTemplatePlacementPlan(before, plan!);
    });
    expectNormalizationTakesBsCharge(next);
    // The old document-wide exemption let B silently lose its charge.
    expect(commitRefusals(document, next, CHEMISTRY_EDIT)).toEqual([]);
    expect(commitRefusals(document, next, structureEditChemistry("place this template")))
      .toEqual([refusedFor("place this template", B_ID)]);
  });

  it("refuses a standalone bond that would take B's legacy loose +, naming B", () => {
    const { document } = legacyLooseMarkBesideB();
    const next = placeWithAnAtomOn(document, STEAL_CENTER, (before, point) => {
      const result = workflow.nativeSingleBondToolAtPoint(before, point);
      expect(result.refusal).toBeUndefined();
      return result.document;
    });
    expectNormalizationTakesBsCharge(next);
    expect(commitRefusals(document, next, structureEditChemistry("draw this bond"))).toEqual([refusedFor("draw this bond", B_ID)]);
  });

  it("refuses a standalone chain that would take B's legacy loose +, naming B", () => {
    const { document } = legacyLooseMarkBesideB();
    const next = placeWithAnAtomOn(document, STEAL_CENTER, (before, point) => workflow.applyNativeChainTool(before, point));
    expectNormalizationTakesBsCharge(next);
    expect(commitRefusals(document, next, structureEditChemistry("draw this chain"))).toEqual([refusedFor("draw this chain", B_ID)]);
  });

  it("commits a standalone template placed away from every mark", () => {
    const { document } = legacyLooseMarkBesideB();
    const { plan } = workflow.nativeTemplatePlacementResult(document, { point: { x: 300, y: 500 } }, "cyclohexane");
    expect(plan?.kind).toBe("standalone");
    const next = workflow.applyNativeTemplatePlacementPlan(document, plan!);
    expect(commitRefusals(document, next, structureEditChemistry("place this template"))).toEqual([]);
  });
});

describe("scoped chemistry edits still commit their own molecule", () => {
  it("commits a ring fused onto molecule A, and leaves B's charge alone", () => {
    const { document, a, nitrogen } = legacyLooseMarkBesideB();
    // Boc-glycine's N–CH2 bond (N at 228,250; CH2 at 250,250), with the ring below it where A has no atoms.
    const methylene = a.atoms[8];
    const bond = a.bonds.find(candidate =>
      (candidate.fromAtomId === nitrogen.id && candidate.toAtomId === methylene.id) ||
      (candidate.toAtomId === nitrogen.id && candidate.fromAtomId === methylene.id))!;
    expect(bond).toBeDefined();
    const target = { kind: "bond" as const, objectId: a.id, bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId,
      distanceToPointer: 0 };
    const { plan } = workflow.nativeTemplatePlacementResult(document, { point: { x: 239, y: 280 }, target }, "cyclohexane");
    expect(plan?.kind).toBeDefined();
    expect(plan?.kind).not.toBe("standalone");
    const next = workflow.applyNativeTemplatePlacementPlan(document, plan!);
    expect(moleculeById(next, a.id).atoms.length).toBeGreaterThan(a.atoms.length);
    expect(commitRefusals(document, next, structureEditChemistry("place this template"))).toEqual([]);
    expect(moleculeById(workflow.normalizeCommittedDocument(next), B_ID).atoms[0]).toMatchObject({ formalCharge: 1 });
  });

  it("commits a charge-tool click on an atom of A, scoped to A", () => {
    const { document, a, hydroxylOxygen } = legacyLooseMarkBesideB();
    const next = workflow.applyChargeToolAtNativeAtom(document, -1,
      { kind: "atom", objectId: a.id, atomId: hydroxylOxygen.id, distanceToPointer: 0 });
    expect(next).not.toBe(document);
    expect(moleculeById(workflow.normalizeCommittedDocument(next), a.id).atoms.find(atom => atom.id === hydroxylOxygen.id))
      .toMatchObject({ formalCharge: -1 });
    expect(commitRefusals(document, next, chemistryEditOf([a.id]))).toEqual([]);
    // The scope is what accepts it: the same commit is refused, naming A, for any other scope.
    expect(commitRefusals(document, next, chemistryEditOf([B_ID]))).toEqual([expect.stringMatching(
      new RegExp(`^Cannot complete this edit without changing the chemistry of molecule "${a.id}": `))]);
    expect(commitRefusals(document, next, PRESERVE_CHEMISTRY)).toHaveLength(1);
    expect(moleculeById(workflow.normalizeCommittedDocument(next), B_ID).atoms[0]).toMatchObject({ formalCharge: 1 });
  });
});
