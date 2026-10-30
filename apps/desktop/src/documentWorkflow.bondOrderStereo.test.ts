import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatches, ChemDraftDocumentSchema } from "@chemdraft/chem-core";
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
