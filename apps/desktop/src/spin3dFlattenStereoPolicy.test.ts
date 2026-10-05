import { describe, expect, it, vi } from "vitest";
import { UnknownBondOrderError, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { buildSpin3dFlattenStereoOptions } from "./spin3dFlattenStereoPolicy";

function wedgedMolecule(): MoleculeObject {
  const graph = testMoleculeFromSmiles("FC(Cl)CCCC");
  return {
    id: "wedged", type: "molecule", x: 0, y: 0, width: 100, height: 100,
    rotation: 0, style: {}, structure: "", structureFormat: "molfile-v2000",
    superatoms: [], rGroups: [], ...graph,
    bonds: graph.bonds.map((bond, index) => index === 0
      ? { ...bond, display: { bondStyle: "wedge" } }
      : bond)
  };
}

describe("Spin 3D flatten stereo policy", () => {
  it.each(["wedge", "hashed"] as const)("refuses unknown bonds with a %s instead of dropping the guard", (bondStyle) => {
    const molecule = wedgedMolecule();
    molecule.bonds[0]!.display = { bondStyle };
    molecule.bonds[molecule.bonds.length - 1]!.order = "unknown";
    const perceive = vi.fn(perceiveStereoCentersFromMolfile);
    const warnings: string[] = [];
    const before = JSON.stringify(molecule);
    const molfile = vi.fn(() => stereoPerceptionMolfile(molecule, warnings));
    const options = () => buildSpin3dFlattenStereoOptions(molecule, perceive, molfile);
    expect(options).toThrow(UnknownBondOrderError);
    expect(options).toThrow(`Bond ${molecule.bonds.at(-1)!.id} has an unknown bond order.`);
    expect(perceive).not.toHaveBeenCalled();
    expect(molfile).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(JSON.stringify(molecule)).toBe(before);
    expect(() => buildSpin3dFlattenStereoOptions(molecule, undefined, molfile)).toThrow(UnknownBondOrderError);
  });

  it.each(["writer", "perceiver"] as const)("rethrows an unknown-order error from the %s, preserving the error and bond ids", (source) => {
    const error = new UnknownBondOrderError(["b3", "b7"]);
    const molecule = wedgedMolecule();
    const perceive = source === "perceiver" ? () => { throw error; } : perceiveStereoCentersFromMolfile;
    const molfile = source === "writer" ? () => { throw error; } : () => stereoPerceptionMolfile(molecule);
    try {
      buildSpin3dFlattenStereoOptions(molecule, perceive, molfile);
      expect.fail("rotation must refuse unknown chemistry");
    } catch (caught) {
      expect(caught).toBe(error);
      expect((caught as UnknownBondOrderError).bondIds).toEqual(["b3", "b7"]);
    }
  });

  it("keeps the same guard, atom ids and perception input for known-order molecules", () => {
    const molecule = wedgedMolecule();
    const perceive = vi.fn(perceiveStereoCentersFromMolfile);
    const molfile = stereoPerceptionMolfile(molecule);
    const expected = perceiveStereoCentersFromMolfile(molfile);
    const options = buildSpin3dFlattenStereoOptions(molecule, perceive, () => stereoPerceptionMolfile(molecule));
    expect(perceive).toHaveBeenCalledExactlyOnceWith(molfile);
    expect(options.perceiveStereo).toBe(perceive);
    expect(options.stereoCenterAtomIds).toEqual(new Set(molecule.atoms
      .filter((_, index) => expected[index]?.isStereoCenter).map((atom) => atom.id)));
  });

  it("keeps the optional-engine fallback for known-order molecules", () => {
    const molecule = wedgedMolecule();
    const molfile = () => stereoPerceptionMolfile(molecule);
    expect(buildSpin3dFlattenStereoOptions(molecule, undefined, molfile)).toEqual({});
    expect(buildSpin3dFlattenStereoOptions(molecule, () => { throw new Error("optional engine unavailable"); }, molfile)).toEqual({});
    const perceive = () => [];
    expect(buildSpin3dFlattenStereoOptions(molecule, perceive, molfile)).toEqual({
      stereoCenterAtomIds: undefined, perceiveStereo: perceive
    });
  });
});
