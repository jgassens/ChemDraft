import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import {
  applyMoleculeBondStereo, createPhase4Document, flattenSpunMolecule, getSelectedMolecule,
  insertNativeMolfileMolecule, nativeBondStereoAvailability, nativeBondStereoFlipDisabledReason
} from "./documentWorkflow";
import { createBondStereoActions } from "./commands";
import { quatToViewMatrix } from "./interaction/rotation3d";

const fixture = readFileSync(new URL(
  "../../../packages/fixtures/open-double-bonds/deuterated-open-alkene.mol", import.meta.url), "utf8");
const reader = perceiveDoubleBondStereoFromMolfile;
const isotopeAtoms = (atoms: readonly { element: string; isotope?: number }[]) =>
  atoms.map(({ element, isotope }) => ({ element, isotope }));
const canonical = (molfile: string) => Molecule.fromMolfile(molfile).toIsomericSmiles();

function imported(contents = fixture) {
  const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 220, y: 220 }, contents, "molfile-v2000");
  const molecule = getSelectedMolecule(document)!;
  const bond = molecule.bonds.find(b => b.order === "double")!;
  return { document, molecule, target: { objectId: molecule.id, bondId: bond.id } };
}

describe("open double-bond isotope preservation", () => {
  it.each(["geometry", "flipped"] as const)("keeps imported D/T exactly when applying %s", choice => {
    const { document, molecule, target } = imported();
    expect(molecule.structure).toBe(fixture);
    expect(molecule.bonds.find(b => b.id === target.bondId)?.stereo).toBe("either");
    expect(isotopeAtoms(molecule.atoms)).toEqual([
      ...Array.from({ length: 4 }, () => ({ element: "C", isotope: undefined })),
      { element: "D", isotope: undefined }, { element: "T", isotope: undefined }
    ]);
    const state = nativeBondStereoAvailability(document, [target], reader);
    expect(state.geometryDisabledReason).toBeUndefined();
    expect(state.descriptor).toBe("E");
    expect(createBondStereoActions(state)[1].enabled).toBe(true);
    expect(nativeBondStereoFlipDisabledReason(document, [target], reader)).toBeUndefined();

    const result = applyMoleculeBondStereo(document, [target], choice, reader);
    expect(result).not.toBe(document);
    const next = getSelectedMolecule(result)!;
    expect(next.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
    expect(parseMolfileGraph(next.structure).bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(reader(next.structure)[0].descriptor).toBe(choice === "geometry" ? "E" : "Z");
    expect(isotopeAtoms(next.atoms)).toEqual(isotopeAtoms(molecule.atoms));
    expect(isotopeAtoms(parseMolfileGraph(next.structure).atoms)).toEqual(isotopeAtoms(molecule.atoms));
    // D/T symbols encode both masses: copying the old M ISO would duplicate them.
    expect(next.structure).not.toContain("M  ISO");
    expect(canonical(next.structure)).toBe(Molecule.fromSmiles(
      choice === "geometry" ? "C/C([2H])=C([3H])/C" : "C/C([2H])=C([3H])\\C"
    ).toIsomericSmiles());
    // Restoring the open marker removes only E/Z and recovers the original identity.
    const reopened = getSelectedMolecule(applyMoleculeBondStereo(result, [target], "either", reader))!;
    expect(canonical(reopened.structure)).toBe(canonical(fixture));
    expect(isotopeAtoms(parseMolfileGraph(reopened.structure).atoms)).toEqual(isotopeAtoms(molecule.atoms));
  });

  it.each(["M ISO", "mass difference"])("writes native carbon isotope once from %s alongside D/T", encoding => {
    const lines = fixture.split("\n");
    if (encoding === "M ISO") lines.splice(lines.indexOf("M  END"), 0, "M  ISO  1   1  13");
    else lines[4] = lines[4].slice(0, 34) + " 1" + lines[4].slice(36);
    const { document, molecule, target } = imported(lines.join("\n"));
    expect(molecule.atoms[0].isotope).toBe(13);
    for (const choice of ["geometry", "flipped"] as const) {
      const next = getSelectedMolecule(applyMoleculeBondStereo(document, [target], choice, reader))!;
      expect(next).not.toBe(molecule);
      expect(isotopeAtoms(next.atoms)).toEqual(isotopeAtoms(molecule.atoms));
      expect(isotopeAtoms(parseMolfileGraph(next.structure).atoms)).toEqual(isotopeAtoms(molecule.atoms));
      expect(next.structure.split("\n").filter(line => line.startsWith("M  ISO")))
        .toEqual(["M  ISO  1   1  13"]);
      const atomStart = next.structure.split("\n").findIndex(line => line.includes("V2000")) + 1;
      expect(Number(next.structure.split("\n")[atomStart].slice(34, 36))).toBe(0);
    }
  });

  it.each(["element", "isotope"])("refuses a genuine %s mapping mismatch", property => {
    const { document, molecule, target } = imported();
    const atoms = molecule.atoms.map((atom, i) => i !== 4 ? atom : {
      ...atom, element: property === "element" ? "F" : "T"
    });
    const mismatched = applyPatches(document, [{ op: "updateObject", objectId: molecule.id,
      changes: { atoms } satisfies Partial<MoleculeObject> }]);
    const state = nativeBondStereoAvailability(mismatched, [target], reader);
    expect(state.geometryDisabledReason).toMatch(/Cannot preserve isotope\/radical atom mapping.*atom 5/);
    expect(nativeBondStereoFlipDisabledReason(mismatched, [target], reader)).toBe(state.geometryDisabledReason);
    for (const choice of ["geometry", "either", "flipped"] as const) {
      expect(applyMoleculeBondStereo(mismatched, [target], choice, reader)).toBe(mismatched);
    }
  });

  it.each([
    { name: "numeric isotope", isotopeRecord: "M  ISO  3   5   2   6   3   1  13",
      atomIndex: 0, replacement: { isotope: 12 }, sourceIdentity: "13C", generatedIdentity: "12C" },
    { name: "H versus D at another index", isotopeRecord: "M  ISO  1   5   2",
      atomIndex: 5, replacement: { element: "D" }, sourceIdentity: "H", generatedIdentity: "D" }
  ])("refuses a $name mapping mismatch with its specific reason", ({
    isotopeRecord, atomIndex, replacement, sourceIdentity, generatedIdentity
  }) => {
    const { document, molecule, target } = imported(fixture.replace(/^M  ISO.*$/m, isotopeRecord));
    const atoms = molecule.atoms.map((atom, i) => i === atomIndex ? { ...atom, ...replacement } : atom);
    const mismatched = applyPatches(document, [{ op: "updateObject", objectId: molecule.id,
      changes: { atoms } satisfies Partial<MoleculeObject> }]);
    const reason = `Cannot preserve isotope/radical atom mapping while changing double-bond geometry: atom ${atomIndex + 1} ` +
      `is ${sourceIdentity} in the source but ${generatedIdentity} in the regenerated structure`;
    const state = nativeBondStereoAvailability(mismatched, [target], reader);
    expect(state.geometryDisabledReason).toBe(reason);
    expect(state.eitherDisabledReason).toBe(reason);
    expect(nativeBondStereoFlipDisabledReason(mismatched, [target], reader)).toBe(reason);
    for (const choice of ["geometry", "either", "flipped"] as const) {
      expect(applyMoleculeBondStereo(mismatched, [target], choice, reader)).toBe(mismatched);
    }
  });

  it.each(["geometry", "flipped"] as const)("keeps flattened D/T and expands an abbreviation when applying %s", choice => {
    const { document, molecule, target } = imported();
    const atoms = molecule.atoms.map((atom, i) => i === 0 ? { ...atom, element: "Et" } : atom);
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: { atoms } }]);
    const flattened = flattenSpunMolecule(labelled, molecule.id, atoms.flatMap(atom => [atom.x, -atom.y, 0]),
      quatToViewMatrix({ x: 0, y: 0, z: 0, w: 1 }));
    expect(flattened.status, flattened.refusalReasons.join("; ")).toBe("committed");
    const source = getSelectedMolecule(flattened.document)!;
    const stored = parseMolfileGraph(source.structure);
    expect(stored.atoms).toHaveLength(6);
    expect(stored.atoms[0].element).toBe("*");
    expect(isotopeAtoms(source.atoms)).toEqual(isotopeAtoms(atoms));
    expect(source.structure).not.toMatch(/M  (?:ISO|RAD)/);
    const lines = source.structure.split("\n");
    const atomStart = lines.findIndex(line => line.includes("V2000")) + 1;
    expect(lines.slice(atomStart, atomStart + stored.atoms.length).every(line =>
      Number(line.slice(34, 36)) === 0 && Number(line.slice(36, 39)) !== 4)).toBe(true);

    const state = nativeBondStereoAvailability(flattened.document, [target], reader);
    expect(state.geometryDisabledReason).toBeUndefined();
    expect(state.descriptor).toBe("E");
    expect(createBondStereoActions(state)[1].enabled).toBe(true);
    expect(nativeBondStereoFlipDisabledReason(flattened.document, [target], reader)).toBeUndefined();
    const result = applyMoleculeBondStereo(flattened.document, [target], choice, reader);
    expect(result).not.toBe(flattened.document);
    const next = getSelectedMolecule(result)!;
    const regenerated = parseMolfileGraph(next.structure);
    expect(regenerated.atoms).toHaveLength(7);
    expect(isotopeAtoms(next.atoms)).toEqual(isotopeAtoms(source.atoms));
    expect(isotopeAtoms(regenerated.atoms)).toEqual([
      ...Array.from({ length: 4 }, () => ({ element: "C", isotope: undefined })),
      { element: "D", isotope: undefined }, { element: "T", isotope: undefined },
      { element: "C", isotope: undefined }
    ]);
    expect(next.structure).not.toContain("M  ISO");
    expect(next.bonds.find(b => b.id === target.bondId)?.stereo).toBeUndefined();
    expect(regenerated.bonds.every(b => b.stereo === undefined)).toBe(true);
    expect(reader(next.structure)[0].descriptor).toBe(choice === "geometry" ? "E" : "Z");
    expect(canonical(next.structure)).toBe(Molecule.fromSmiles(
      choice === "geometry" ? "CC/C([2H])=C([3H])/C" : "CC/C([2H])=C([3H])\\C"
    ).toIsomericSmiles());
  });
});
