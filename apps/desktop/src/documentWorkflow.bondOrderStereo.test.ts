import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatches, ChemDraftDocumentSchema, moleculeToMolfileV3000, type ChemDraftDocument } from "@chemdraft/chem-core";
import { depictSmiles2D, perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import {
  applyNativeBondDisplayStyleTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget,
  applyNativeRingFuseAtBondTarget,
  createPhase4Document,
  getSelectedMolecule,
  insertNativeMolfileMolecule,
  insertNativeTemplateMolecule
} from "./documentWorkflow";

const openMolfile = readFileSync(new URL(
  "../../../packages/fixtures/open-double-bonds/open.v2000.mol", import.meta.url
), "utf8");

function openDoubleBondDocument() {
  const document = insertNativeMolfileMolecule(
    createPhase4Document(), { x: 200, y: 200 }, openMolfile, "molfile-v2000"
  );
  const molecule = getSelectedMolecule(document)!;
  const bond = molecule.bonds.find(candidate => candidate.order === "double")!;
  const target = {
    objectId: molecule.id,
    kind: "bond" as const,
    bondId: bond.id,
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    distanceToPointer: 0
  };
  return { document, target, bond };
}

describe("desktop bond order changes with E/Z-unspecified stereo", () => {
  it("keeps V2000 double-bond stereo 3 through the desktop MOL insertion path", () => {
    expect(openMolfile).toContain("  2  3  2  3  0  0  0");
    const { document, bond } = openDoubleBondDocument();
    expect(bond).toMatchObject({ order: "double", stereo: "either" });
    expect(ChemDraftDocumentSchema.safeParse(document).success).toBe(true);
  });

  it.each(["single", "triple"] as const)("removes the stereo key when the order command sets %s", order => {
    const { document, target, bond } = openDoubleBondDocument();
    expect(bond.stereo).toBe("either");
    const changed = applyNativeMoleculeBondOrderValueTarget(document, target, order);
    const result = getSelectedMolecule(changed)!.bonds.find(candidate => candidate.id === bond.id)!;
    expect(result.order).toBe(order);
    expect(result).not.toHaveProperty("stereo");
    expect(ChemDraftDocumentSchema.safeParse(changed).success).toBe(true);

    const restored = applyNativeMoleculeBondOrderValueTarget(changed, target, "double");
    const restoredBond = getSelectedMolecule(restored)!.bonds.find(candidate => candidate.id === bond.id)!;
    expect(restoredBond.order).toBe("double");
    expect(restoredBond).not.toHaveProperty("stereo");
    expect(ChemDraftDocumentSchema.safeParse(restored).success).toBe(true);
  });

  it("clears stereo through bond cycling", () => {
    const { document, target } = openDoubleBondDocument();
    let changed = document;
    for (const order of ["triple", "single", "double"]) {
      changed = applyNativeMoleculeBondOrderTarget(changed, target);
      const bond = getSelectedMolecule(changed)!.bonds.find(candidate => candidate.id === target.bondId)!;
      expect(bond.order).toBe(order);
      expect(bond).not.toHaveProperty("stereo");
      expect(ChemDraftDocumentSchema.safeParse(changed).success).toBe(true);
    }
  });

  it("keeps stereo when only the double bond display changes", () => {
    const { document, target } = openDoubleBondDocument();
    const changed = applyNativeBondDisplayStyleTarget(document, target, "bold");
    const bond = getSelectedMolecule(changed)!.bonds.find(candidate => candidate.id === target.bondId)!;
    expect(bond).toMatchObject({ order: "double", stereo: "either", display: { bondStyle: "bold" } });
    expect(ChemDraftDocumentSchema.safeParse(changed).success).toBe(true);
  });

  it("clears stereo when aromatic ring fusion reassigns a shared double bond to single", () => {
    const seed = insertNativeTemplateMolecule(createPhase4Document(), { x: 300, y: 300 }, "benzene");
    const original = getSelectedMolecule(seed)!;
    const bond = original.bonds.find(candidate => candidate.order === "double")!;
    const document = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: {
      bonds: original.bonds.map(candidate => candidate.id === bond.id ? { ...candidate, stereo: "either" as const } : candidate)
    } }]);
    const changed = applyNativeRingFuseAtBondTarget(document, {
      objectId: original.id, kind: "bond", bondId: bond.id,
      fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0
    }, "benzene");
    const molecule = getSelectedMolecule(changed)!;
    expect(molecule.atoms).toHaveLength(10);
    const shared = molecule.bonds.find(candidate => candidate.id === bond.id)!;
    expect(shared.order).toBe("single");
    expect(shared).not.toHaveProperty("stereo");
    expect(ChemDraftDocumentSchema.safeParse(changed).success).toBe(true);
  });
});

describe("a same-tool click reverses a wedge or hashed wedge", () => {
  // CC(Cl)C(Cl)C: atoms 1 and 2 (zero-based) are both stereocentres, so moving the narrow end of
  // the bond between them moves the specified centre from one to the other.
  function dichlorobutane() {
    const document = insertNativeMolfileMolecule(
      createPhase4Document(), { x: 220, y: 220 }, depictSmiles2D("CC(Cl)C(Cl)C").molfile, "molfile-v2000"
    );
    const molecule = getSelectedMolecule(document)!;
    const centres = molecule.atoms.filter(atom => atom.element === "C" &&
      molecule.bonds.filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 3);
    const bond = molecule.bonds.find(candidate =>
      centres.some(atom => atom.id === candidate.fromAtomId) && centres.some(atom => atom.id === candidate.toAtomId))!;
    const target = {
      objectId: molecule.id, kind: "bond" as const, bondId: bond.id,
      fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0
    };
    return { document, target, bond };
  }

  function descriptors(document: ChemDraftDocument, atomIds: readonly string[]) {
    const molecule = getSelectedMolecule(document)!;
    const perceived = perceiveStereoCentersFromMolfile(
      moleculeToMolfileV3000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents
    );
    return atomIds.map(id => perceived[molecule.atoms.findIndex(atom => atom.id === id)]!.descriptor);
  }

  function bondById(document: ChemDraftDocument, id: string) {
    return getSelectedMolecule(document)!.bonds.find(candidate => candidate.id === id)!;
  }

  it.each(["wedge", "hashed"] as const)("moves the %s's narrow end and with it the specified stereocentre", style => {
    const { document, target, bond } = dichlorobutane();
    const styled = applyNativeBondDisplayStyleTarget(document, target, style);
    const first = bondById(styled, bond.id);
    expect(first.display?.bondStyle).toBe(style);
    const [narrow, wide] = [first.fromAtomId, first.toAtomId];
    const [before] = [descriptors(styled, [narrow, wide])];
    expect(before[0]).toMatch(/^[RS]$/);
    expect(before[1]).toBe("unspecified");

    const reversed = applyNativeBondDisplayStyleTarget(styled, target, style);
    const flipped = bondById(reversed, bond.id);
    expect(flipped).toMatchObject({ fromAtomId: wide, toAtomId: narrow, order: first.order, display: first.display });
    const after = descriptors(reversed, [narrow, wide]);
    expect(after[0]).toBe("unspecified");
    expect(after[1]).toMatch(/^[RS]$/);
    // The same document change records one undo step: one updateObject on the one molecule, its
    // atoms and every other bond untouched.
    const beforeMolecule = getSelectedMolecule(styled)!;
    const afterMolecule = getSelectedMolecule(reversed)!;
    expect(afterMolecule.atoms).toEqual(beforeMolecule.atoms);
    expect(afterMolecule.bonds.filter(candidate => candidate.id !== bond.id))
      .toEqual(beforeMolecule.bonds.filter(candidate => candidate.id !== bond.id));
    expect(afterMolecule.chemistry?.formula).toBe(beforeMolecule.chemistry?.formula);

    // Reversing again restores the first drawing exactly, descriptor included.
    const restored = applyNativeBondDisplayStyleTarget(reversed, target, style);
    expect(bondById(restored, bond.id)).toEqual(first);
    expect(descriptors(restored, [narrow, wide])).toEqual(before);
  });

  it("gives a wedge and a hashed wedge on the same narrow end opposite descriptors", () => {
    const { document, target, bond } = dichlorobutane();
    const wedge = applyNativeBondDisplayStyleTarget(document, target, "wedge");
    const hashed = applyNativeBondDisplayStyleTarget(wedge, target, "hashed");
    const narrow = bondById(wedge, bond.id).fromAtomId;
    expect(bondById(hashed, bond.id).fromAtomId).toBe(narrow);
    const [wedgeDescriptor] = descriptors(wedge, [narrow]);
    const [hashedDescriptor] = descriptors(hashed, [narrow]);
    expect(new Set([wedgeDescriptor, hashedDescriptor])).toEqual(new Set(["R", "S"]));
  });

  it.each(["bold", "dashed"] as const)("leaves a %s bond alone when its own style is applied again", style => {
    const { document, target } = dichlorobutane();
    const styled = applyNativeBondDisplayStyleTarget(document, target, style);
    expect(applyNativeBondDisplayStyleTarget(styled, target, style)).toBe(styled);
  });
});
