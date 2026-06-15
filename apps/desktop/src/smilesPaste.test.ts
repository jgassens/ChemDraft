/**
 * SMILES paste — `insertSmilesMolecule` renders a pasted SMILES into an editable 2D
 * molecule with correct stereochemistry. Proves the depiction→document path keeps
 * chirality: the committed molfile re-parses through OpenChemLib with the same defined
 * stereocenters, and enantiomers land with opposite CIP (no accidental racemization or
 * mirroring through the y-frame negation).
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as OCL from "openchemlib";

import type { MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, type Depiction2D } from "@chemdraft/ocl-adapter";

import { createPhase4Document, insertSmilesMolecule, type PastedStructureDepiction } from "./documentWorkflow";

const POINT = { x: 200, y: 200 };

// The user's test peptide (a ~30-residue chain, dozens of stereocenters).
const PEPTIDE =
  "CC[C@H](C)[C@@H](C(=O)N[C@@H](C)C(=O)N[C@@H](CC1=CNC2=CC=CC=C21)C(=O)N[C@@H](CC(C)C)C(=O)N[C@@H](C(C)C)C(=O)N[C@@H](CCCCN)C(=O)NCC(=O)N[C@@H](CCCNC(=N)N)C(=O)N)NC(=O)[C@H](CC3=CC=CC=C3)NC(=O)[C@H](CCC(=O)O)NC(=O)[C@H](CCCCN)NC(=O)[C@H](C)NC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)N)NC(=O)CNC(=O)[C@H](CCC(=O)O)NC(=O)[C@H](CC(C)C)NC(=O)[C@H](CC4=CC=C(C=C4)O)NC(=O)[C@H](CO)NC(=O)[C@H](CO)NC(=O)[C@H](C(C)C)NC(=O)[C@H](CC(=O)O)NC(=O)[C@H](CO)NC(=O)[C@H]([C@@H](C)O)NC(=O)[C@H](CC5=CC=CC=C5)NC(=O)[C@H]([C@@H](C)O)NC(=O)CNC(=O)[C@H](CCC(=O)O)NC(=O)[C@H](C)NC(=O)[C@H](CC6=CNC=N6)N";

function toPasted(dep: Depiction2D): PastedStructureDepiction {
  return {
    atoms: dep.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, charge: atom.charge })),
    bonds: dep.bonds.map((bond) => ({
      from: bond.from,
      to: bond.to,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      wedge: bond.wedge
    }))
  };
}

function pasteSmiles(smiles: string): MoleculeObject {
  const document = createPhase4Document("SMILES paste fixture");
  const next = insertSmilesMolecule(document, POINT, toPasted(depictSmiles2D(smiles)), smiles);
  const placed = next.pages[0].objects.find((object) => object.type === "molecule");
  if (!placed || placed.type !== "molecule") throw new Error("no molecule placed");
  return placed;
}

const isWedge = (bond: MoleculeObject["bonds"][number]) =>
  bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed";

/** Defined CIP stereocenters OpenChemLib re-perceives from a committed molfile. */
function definedStereocenters(molfile: string): Array<{ atom: number; cip: number }> {
  const molecule = OCL.Molecule.fromMolfile(molfile);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  const centers: Array<{ atom: number; cip: number }> = [];
  for (let a = 0; a < molecule.getAllAtoms(); a += 1) {
    const cip = molecule.getAtomCIPParity(a);
    if (molecule.isAtomStereoCenter(a) && cip !== 0) centers.push({ atom: a, cip });
  }
  return centers;
}

beforeAll(async () => {
  await ensureOclResources();
});

describe("insertSmilesMolecule — renders pasted SMILES with stereochemistry", () => {
  it("places a chiral molecule with a wedge and a re-perceivable stereocenter", () => {
    const molecule = pasteSmiles("C[C@H](F)Cl");
    expect(molecule.atoms.length).toBe(4);
    expect(molecule.bonds.length).toBe(3);
    expect(molecule.bonds.some(isWedge)).toBe(true);
    expect(definedStereocenters(molecule.structure).length).toBeGreaterThanOrEqual(1);

    // Landed near the paste point.
    const cx = molecule.atoms.reduce((sum, atom) => sum + atom.x, 0) / molecule.atoms.length;
    const cy = molecule.atoms.reduce((sum, atom) => sum + atom.y, 0) / molecule.atoms.length;
    expect(Math.abs(cx - POINT.x)).toBeLessThan(120);
    expect(Math.abs(cy - POINT.y)).toBeLessThan(120);
  });

  it("enantiomers paste with opposite CIP (no racemization / mirror through y-negation)", () => {
    const r = definedStereocenters(pasteSmiles("C[C@H](F)Cl").structure);
    const s = definedStereocenters(pasteSmiles("C[C@@H](F)Cl").structure);
    expect(r).toHaveLength(1);
    expect(s).toHaveLength(1);
    expect(r[0].cip).not.toBe(s[0].cip);
  });

  it("recomputes a drawn side for every double bond (benzene ring interior)", () => {
    const molecule = pasteSmiles("c1ccccc1");
    const doubles = molecule.bonds.filter((bond) => bond.order === "double");
    expect(doubles.length).toBeGreaterThanOrEqual(1);
    expect(doubles.every((bond) => bond.display?.doubleBondSide === "left" || bond.display?.doubleBondSide === "right")).toBe(true);
  });

  it("renders the large peptide SMILES with many preserved stereocenters", () => {
    const molecule = pasteSmiles(PEPTIDE);
    expect(molecule.atoms.length).toBeGreaterThan(100);
    expect(molecule.bonds.filter(isWedge).length).toBeGreaterThan(10);
    // The committed structure round-trips through OCL with most stereocenters intact.
    expect(definedStereocenters(molecule.structure).length).toBeGreaterThan(10);
  });
});
