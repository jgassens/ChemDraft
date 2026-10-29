import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { applyPatches } from "@chemdraft/chem-core";
import { depictSmiles2D, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import {
  applyMoleculeBondStereo, applyMoleculeDoubleBondPosition, applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget, createPhase4Document, getSelectedMolecule,
  insertNativeMolfileMolecule, moveNativeMoleculeParts, nativeBondStereoAvailability,
  rotateDocumentObject, nativeBondStereoFlipDisabledReason, type NativeBondOrderTarget
} from "./documentWorkflow";
import { createBondStereoActions, moleculeBondStereoCommandId, moleculeBondStereoForCommand } from "./commands";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";

function drawing(smiles: string) {
  const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 220, y: 220 }, depictSmiles2D(smiles).molfile, "molfile-v2000");
  const molecule = getSelectedMolecule(document)!;
  const bond = molecule.bonds.find(b => b.order === "double")!;
  const target: NativeBondOrderTarget = { objectId: molecule.id, kind: "bond", bondId: bond.id,
    fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, distanceToPointer: 0 };
  return { document, molecule, bond, target };
}

describe("bond stereo commands", () => {
  it("has value-encoded factories and specific reasons for every disabled command", () => {
    for (const value of ["either", "geometry", "flipped"] as const) {
      expect(moleculeBondStereoForCommand(moleculeBondStereoCommandId(value))).toEqual({ value });
    }
    expect(moleculeBondStereoForCommand("molecule.bondStereo:set")).toBeUndefined();
    expect(createBondStereoActions(nativeBondStereoAvailability(createPhase4Document(), [])))
      .toEqual(expect.arrayContaining([expect.objectContaining({ enabled: false, disabledReason: "Select one double bond" })]));
    const { document, target } = drawing("C/C=C/C");
    expect(nativeBondStereoAvailability(document, [target]).eitherDisabledReason).toBe("E/Z perception is still loading");
    expect(nativeBondStereoAvailability(document, [target, target], perceiveDoubleBondStereoFromMolfile).eitherDisabledReason).toBe("Select one double bond");
  });

  it.each(["C/C=C/C", "C/C=C\\C", "F/C(Cl)=C(Br)/I"])("uses injected CIP labels for %s, including an open bond", smiles => {
    const { document, target } = drawing(smiles);
    const expected = perceiveDoubleBondStereoFromMolfile(depictSmiles2D(smiles).molfile)[0].descriptor;
    expect(["E", "Z"]).toContain(expected);
    const state = nativeBondStereoAvailability(document, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state.eitherDisabledReason).toBeUndefined();
    expect(createBondStereoActions(state)[1].title).toBe(`Use drawn geometry (${expected})`);
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    expect(nativeBondStereoAvailability(open, [target], perceiveDoubleBondStereoFromMolfile)).toEqual({
      value: "either", eitherDisabledReason: "E/Z is already unspecified", descriptor: expected
    });
    const model = createMoleculeInspectorModel(open, { selectedObjectIds: [], selectedPart: target }, perceiveDoubleBondStereoFromMolfile);
    expect(model.structure.bondStereo?.descriptor).toBe(expected);
  });

  it.each(["CC=O", "CC=C(C)C", "C1=CCCCC1"])("refuses unspecified E/Z on non-stereogenic %s", smiles => {
    const { document, target } = drawing(smiles);
    const state = nativeBondStereoAvailability(document, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state.eitherDisabledReason).toMatch(/carbon–carbon|not stereogenic/);
    expect(applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile)).toBe(document);
  });

  it("recognizes a methyl label and drawn methyl as equivalent substituents", () => {
    const { document, molecule, target } = drawing("CC(C)=CF");
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, i) => i === 0 ? { ...atom, element: "Me" } : atom)
    } }]);
    expect(nativeBondStereoAvailability(labelled, [target], perceiveDoubleBondStereoFromMolfile).eitherDisabledReason).toContain("not stereogenic");
    expect(applyMoleculeBondStereo(labelled, [target], "either", perceiveDoubleBondStereoFromMolfile)).toBe(labelled);
  });

  it("keeps native flags, stored V2000 markers and selection in agreement", () => {
    const { document, target } = drawing("C/C=C/C");
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    const molecule = getSelectedMolecule(open)!;
    expect(open.selection).toEqual(document.selection);
    expect(molecule.bonds.find(b => b.id === target.bondId)?.stereo).toBe("either");
    expect(parseMolfileGraph(molecule.structure).bonds.filter(b => b.stereo === "either")).toHaveLength(1);
    expect(molecule.structure).toMatch(/  2  3  2  3/);
    expect(applyMoleculeBondStereo(open, [target], "either", perceiveDoubleBondStereoFromMolfile)).toBe(open);
    const geometry = applyMoleculeBondStereo(open, [target], "geometry", perceiveDoubleBondStereoFromMolfile);
    const next = getSelectedMolecule(geometry)!;
    expect(geometry.selection).toEqual(document.selection);
    expect(next.bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(parseMolfileGraph(next.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(perceiveDoubleBondStereoFromMolfile(next.structure)[0].descriptor).toBe("E");
  });

  it("redraw and reapplying double order clear the flag; move, rotation and restyling keep it", () => {
    const { document, molecule, target } = drawing("C/C=C/C");
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    const redrawn = getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(open, target, "double"))!;
    expect(redrawn.bonds.find(b => b.id === target.bondId)).toMatchObject({ order: "double" });
    expect(redrawn.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
    expect(parseMolfileGraph(redrawn.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    const cycled = getSelectedMolecule(applyNativeMoleculeBondOrderTarget(open, target))!;
    expect(cycled.bonds.find(b => b.id === target.bondId)).toMatchObject({ order: "triple" });
    expect(cycled.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
    expect(parseMolfileGraph(cycled.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    for (const changed of [
      moveNativeMoleculeParts(open, { objectId: molecule.id, kind: "atom", atomId: molecule.atoms[0].id }, { x: 10, y: 15 }),
      rotateDocumentObject(open, molecule.id, 30),
      applyMoleculeDoubleBondPosition(open, [target], "center")
    ]) expect(getSelectedMolecule(changed)!.bonds.find(b => b.id === target.bondId)?.stereo).toBe("either");
    expect(getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(open, target, "single"))!.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
  });
});


describe("reflecting one double-bond end", () => {
  it.each([
    ["C/C=C/C", "C/C=C\\C"],
    ["[CH2]/C=C/C", "[CH2]/C=C\\C"],
    ["F/C(Cl)=C(Br)/I", "F/C(Cl)=C(Br)\\I"],
    ["CCC/C=C/[C@H](F)Cl", "CCC/C=C\\[C@H](F)Cl"],
    ["CCCC/C=C/C=C/C", "CCCC/C=C\\C=C\\C"],
    ["[13CH3]/C=C/[C@@H]([NH3+])Cl", "[13CH3]/C=C\\[C@@H]([NH3+])Cl"]
  ])("changes only the target E/Z for %s", (smiles, opposite) => {
    const { document, molecule, target } = drawing(smiles);
    const open = applyMoleculeBondStereo(document, [target], "either", perceiveDoubleBondStereoFromMolfile);
    expect(nativeBondStereoFlipDisabledReason(open, [target], perceiveDoubleBondStereoFromMolfile)).toBeUndefined();
    const flipped = applyMoleculeBondStereo(open, [target], "flipped", perceiveDoubleBondStereoFromMolfile);
    const next = getSelectedMolecule(flipped)!;
    const canonical = (molfile: string) => Molecule.fromMolfile(molfile).toIsomericSmiles();
    expect(canonical(next.structure)).toBe(Molecule.fromSmiles(opposite).toIsomericSmiles());
    expect(canonical(next.structure)).not.toBe(canonical(molecule.structure));
    expect(next.atoms.map(({ x, y, ...atom }) => atom)).toEqual(molecule.atoms.map(({ x, y, ...atom }) => atom));
    expect(next.bonds.map(({ display, ...bond }) => bond)).toEqual(molecule.bonds.map(({ display, ...bond }) => bond));
    expect(flipped.selection).toEqual(open.selection);
    for (const bond of next.bonds) {
      const length = (mol: typeof molecule) => {
        const from = mol.atoms.find(a => a.id === bond.fromAtomId)!;
        const to = mol.atoms.find(a => a.id === bond.toAtomId)!;
        return Math.hypot(to.x - from.x, to.y - from.y);
      };
      expect(length(next)).toBeCloseTo(length(molecule), 8);
    }
  });

  it("refuses non-stereogenic and cyclic double bonds without changing the document", () => {
    for (const smiles of ["CC=O", "CC=C(C)C", "C1=CCCCCCCC1"]) {
      const { document, target } = drawing(smiles);
      expect(nativeBondStereoFlipDisabledReason(document, [target], perceiveDoubleBondStereoFromMolfile)).toBeTruthy();
      expect(applyMoleculeBondStereo(document, [target], "flipped", perceiveDoubleBondStereoFromMolfile)).toBe(document);
    }
  });

  it("retains source radicals beside a native radical annotation", () => {
    const { document, molecule, target } = drawing("[CH2]/C=C/CC");
    const annotated = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, i) => i === molecule.atoms.length - 1 ? { ...atom, markRadicals: 1 } : atom)
    } }]);
    const flipped = getSelectedMolecule(applyMoleculeBondStereo(annotated, [target], "flipped", perceiveDoubleBondStereoFromMolfile))!;
    const parsed = Molecule.fromMolfile(flipped.structure);
    expect([...Array(parsed.getAllAtoms()).keys()].filter(i => parsed.getAtomRadical(i) !== 0)).toHaveLength(2);
  });

  it("refuses both choices if label expansion cannot retain the isotope atom mapping", () => {
    const { document, molecule, target } = drawing("[13CH3]/C=C/C");
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, i) => i === molecule.atoms.length - 1 ? { ...atom, element: "Ph" } : atom)
    } }]);
    const state = nativeBondStereoAvailability(labelled, [target], perceiveDoubleBondStereoFromMolfile);
    expect(state.geometryDisabledReason).toBe("Cannot preserve all stored properties while changing E/Z");
    for (const choice of ["geometry", "either", "flipped"] as const) {
      expect(applyMoleculeBondStereo(labelled, [target], choice, perceiveDoubleBondStereoFromMolfile)).toBe(labelled);
    }
  });

  it("refuses geometry edits that would flatten a coordination bond in V2000", () => {
    const { document, molecule, target } = drawing("C/C=C/C");
    const dative = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: {
      bonds: molecule.bonds.map(bond => bond.order === "single" ? { ...bond, display: { bondStyle: "dashed" } } : bond)
    } }]);
    expect(nativeBondStereoAvailability(dative, [target], perceiveDoubleBondStereoFromMolfile).geometryDisabledReason)
      .toBe("Cannot preserve all stored properties while changing E/Z");
    expect(applyMoleculeBondStereo(dative, [target], "flipped", perceiveDoubleBondStereoFromMolfile)).toBe(dative);
  });
});
