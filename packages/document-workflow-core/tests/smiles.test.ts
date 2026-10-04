import { describe, expect, it, vi } from "vitest";
import { MoleculeBondSchema, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import {
  moleculeSmiles,
  nativeSingleBondGraphSmiles,
  nativeSmilesBondOrderResolution,
  nativeSmilesWritableBonds
} from "../src/index";

const atoms: MoleculeAtom[] = [
  { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
  { id: "a2", element: "C", x: 10, y: 0, formalCharge: 0 },
  { id: "a3", element: "C", x: 20, y: 0, formalCharge: 0 }
];
const unknownBond: MoleculeBond = {
  id: "b12", fromAtomId: "a1", toAtomId: "a2", order: "unknown"
};
const singleBond: MoleculeBond = {
  id: "b23", fromAtomId: "a2", toAtomId: "a3", order: "single"
};
const unknownOrderError = "Cannot write SMILES: bond b12 has an unknown bond order.";

describe("unknown bond orders in SMILES", () => {
  it("refuses a schema-valid unknown bond preserved by the real aromatic resolver", () => {
    const bonds = [MoleculeBondSchema.parse(unknownBond), singleBond];
    const before = structuredClone(bonds);
    const resolution = nativeBondOrderResolution(atoms, bonds);
    expect(resolution.bonds).toBe(bonds);
    expect(resolution.bonds[0].order).toBe("unknown");
    const warnings: string[] = [];

    expect(() => nativeSingleBondGraphSmiles(atoms, bonds, warnings)).toThrow(unknownOrderError);
    expect(warnings).toEqual([]);
    expect(bonds).toEqual(before);
  });

  it("refuses unknown bonds even when aromatic bonds are also resolved", () => {
    const bonds: MoleculeBond[] = [unknownBond, { ...singleBond, order: "aromatic" }];
    const resolution = nativeBondOrderResolution(atoms, bonds);
    expect(resolution.bonds.map((bond) => bond.order)).toEqual(["unknown", "single"]);
    expect(resolution.nonRingAromaticBondCount).toBe(1);

    expect(() => nativeSingleBondGraphSmiles(atoms, bonds)).toThrow(unknownOrderError);
  });

  it("names every unknown bond and omits known bonds", () => {
    const bonds: MoleculeBond[] = [
      unknownBond,
      { ...singleBond, order: "unknown" },
      { id: "b13", fromAtomId: "a1", toAtomId: "a3", order: "single" }
    ];
    expect(() => nativeSmilesBondOrderResolution(atoms, bonds)).toThrow(
      "Cannot write SMILES: bonds b12, b23 have an unknown bond order."
    );
  });

  it("refuses through the exported writable-bonds helper", () => {
    expect(() => nativeSmilesWritableBonds(atoms, [unknownBond])).toThrow(unknownOrderError);
  });

  const molecule: MoleculeObject = {
    id: "m1", type: "molecule", x: 0, y: 0, width: 20, height: 10,
    rotation: 0, style: {}, structureFormat: "unknown", structure: "",
    atoms, bonds: [unknownBond, singleBond], superatoms: [], rGroups: []
  };

  it("rejects the native export route", async () => {
    const warnings: ExportWarning[] = [];
    await expect(moleculeSmiles(molecule, 0, warnings, undefined)).rejects.toThrow(unknownOrderError);
    expect(warnings).toEqual([]);
  });

  it("rejects before calling the engine, including with a supplied molfile", async () => {
    const compute = vi.fn().mockResolvedValue({ smiles: "CCC" });
    await expect(moleculeSmiles(molecule, 0, [], compute, "supplied molfile")).rejects.toThrow(unknownOrderError);
    expect(compute).not.toHaveBeenCalled();
  });

  it("rejects before returning stored SMILES", async () => {
    await expect(moleculeSmiles(
      { ...molecule, structureFormat: "smiles", structure: "CCC" }, 0, [], undefined
    )).rejects.toThrow(unknownOrderError);
  });
});

describe("supported SMILES bond orders", () => {
  it.each([
    ["single", "CCC"], ["double", "C=CC"], ["triple", "C#CC"]
  ] as const)("preserves %s chain bonds", (order, expected) => {
    const warnings: string[] = [];
    expect(nativeSingleBondGraphSmiles(atoms, [{ ...unknownBond, order }, singleBond], warnings)).toBe(expected);
    expect(warnings).toEqual([]);
  });

  it("preserves the existing non-ring aromatic warning and output", () => {
    const warnings: string[] = [];
    expect(nativeSingleBondGraphSmiles(atoms, [{ ...unknownBond, order: "aromatic" }, singleBond], warnings)).toBe("CCC");
    expect(warnings).toEqual(["1 aromatic bond outside any aromatic ring written to SMILES as single."]);
  });

  it("still kekulizes a benzene ring without warnings", () => {
    const ringAtoms: MoleculeAtom[] = Array.from({ length: 6 }, (_, index) => ({
      id: `r${index}`, element: "C", x: index, y: 0, formalCharge: 0
    }));
    const ringBonds: MoleculeBond[] = ringAtoms.map((atom, index) => ({
      id: `rb${index}`, fromAtomId: atom.id, toAtomId: ringAtoms[(index + 1) % 6].id, order: "aromatic"
    }));
    const warnings: string[] = [];
    const smiles = nativeSingleBondGraphSmiles(ringAtoms, ringBonds, warnings);
    expect(smiles.match(/=/g)).toHaveLength(3);
    expect(smiles.match(/1/g)).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});
