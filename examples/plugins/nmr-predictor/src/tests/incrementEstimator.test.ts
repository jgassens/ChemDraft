import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import {
  estimateProtonIncrement,
  PROTON_INCREMENT_ESTIMATOR_ID,
  type ProtonIncrementEstimate
} from "../providers/ocl/incrementEstimator";

function molecule(smiles: string): OCL.Molecule {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return mol;
}

function ppm(estimate: ProtonIncrementEstimate): number {
  if (!estimate.applicable) throw new Error(`expected applicable estimate, got ${estimate.reason}`);
  return estimate.ppm;
}

function aromaticShifts(smiles: string): number[] {
  const mol = molecule(smiles);
  const shifts: number[] = [];
  for (let atom = 0; atom < mol.getAllAtoms(); atom += 1) {
    if (mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0) {
      shifts.push(ppm(estimateProtonIncrement(mol, atom)));
    }
  }
  return shifts.sort((a, b) => a - b);
}

describe("estimateProtonIncrement", () => {
  it("returns an explicit applicable result with method identity", () => {
    const estimate = estimateProtonIncrement(molecule("CCc1ccccc1"), 1);
    expect(estimate).toMatchObject({
      applicable: true,
      estimator: {
        id: PROTON_INCREMENT_ESTIMATOR_ID,
        version: "1.3.0",
        method: "shoolery-alpha-beta-gamma"
      }
    });
  });

  it("uses source-backed methane, methyl, methylene, and methine hydrocarbon baselines", () => {
    expect(ppm(estimateProtonIncrement(molecule("C"), 0))).toBe(0.23);
    expect(ppm(estimateProtonIncrement(molecule("CC"), 0))).toBe(0.9);
    expect(ppm(estimateProtonIncrement(molecule("CCC"), 1))).toBe(1.2);
    expect(ppm(estimateProtonIncrement(molecule("CC(C)C"), 1))).toBe(1.5);
  });

  it("applies alpha, beta, and gamma corrections through a saturated carbon chain", () => {
    const propanol = molecule("CCCO");
    expect(ppm(estimateProtonIncrement(propanol, 2))).toBe(3.5);
    expect(ppm(estimateProtonIncrement(propanol, 1))).toBe(1.5);
    expect(ppm(estimateProtonIncrement(propanol, 0))).toBe(1.0);
  });

  it("distinguishes aryl, aryloxy, acyloxy, and carbonyl alpha/beta corrections", () => {
    const ethylbenzene = molecule("CCc1ccccc1");
    expect(ppm(estimateProtonIncrement(ethylbenzene, 1))).toBe(2.6);
    expect(ppm(estimateProtonIncrement(ethylbenzene, 0))).toBe(1.3);

    expect(ppm(estimateProtonIncrement(molecule("COc1ccccc1"), 0))).toBe(3.7);
    expect(ppm(estimateProtonIncrement(molecule("COC(=O)C"), 0))).toBe(3.7);
    expect(ppm(estimateProtonIncrement(molecule("COC(=O)c1ccccc1"), 0))).toBe(4.0);
    expect(ppm(estimateProtonIncrement(molecule("CC(=O)C"), 0))).toBe(2.1);
    expect(ppm(estimateProtonIncrement(molecule("CC(=O)c1ccccc1"), 0))).toBe(2.6);
    expect(ppm(estimateProtonIncrement(molecule("CC(=O)Cl"), 0))).toBe(2.7);
    expect(ppm(estimateProtonIncrement(molecule("CN"), 0))).toBe(2.4);
    expect(ppm(estimateProtonIncrement(molecule("CNC(=O)C"), 0))).toBe(3.0);
    expect(ppm(estimateProtonIncrement(molecule("CC(=O)N"), 0))).toBe(1.9);
  });

  it("is invariant to equivalent SMILES direction and molfile transport", () => {
    const forward = molecule("CCCO");
    const reverse = molecule("OCCC");
    const molfile = OCL.Molecule.fromMolfile(forward.toMolfile());
    molfile.ensureHelperArrays(OCL.Molecule.cHelperRings);

    const shifts = (mol: OCL.Molecule) =>
      [...Array(mol.getAllAtoms()).keys()]
        .filter((atom) => mol.getAtomicNo(atom) === 6 && mol.getAllHydrogens(atom) > 0)
        .map((atom) => ppm(estimateProtonIncrement(mol, atom)))
        .sort((a, b) => a - b);

    expect(shifts(reverse)).toEqual(shifts(forward));
    expect(shifts(molfile)).toEqual(shifts(forward));
  });

  it("applies aromatic ortho/meta/para increments (nitrobenzene: ortho downfield, meta up)", () => {
    const shifts = aromaticShifts("O=[N+]([O-])c1ccccc1");
    expect(Math.max(...shifts)).toBeGreaterThan(8.0);
    expect(Math.min(...shifts)).toBeLessThan(7.5);
  });

  it("keeps electron-rich rings upfield of benzene (anisole ortho-H < 7.26)", () => {
    expect(Math.min(...aromaticShifts("COc1ccccc1"))).toBeLessThan(7.0);
  });

  it("uses distinct aromatic increments for carboxylic acids and esters", () => {
    const acid = aromaticShifts("O=C(O)c1ccccc1");
    const ester = aromaticShifts("COC(=O)c1ccccc1");
    expect(acid).not.toEqual(ester);
    expect(Math.max(...acid)).toBeGreaterThan(Math.max(...ester));
  });

  it("applies Shoolery aliphatic increments (ethylbenzene CH₂ ≈ 2.5)", () => {
    const estimate = estimateProtonIncrement(molecule("CCc1ccccc1"), 1);
    expect(ppm(estimate)).toBeGreaterThan(2.2);
    expect(ppm(estimate)).toBeLessThan(2.9);
  });

  it("uses an explicitly identified functional-class value for an aldehyde CHO", () => {
    const mol = molecule("O=Cc1ccccc1");
    const cho = [...Array(mol.getAllAtoms()).keys()].find(
      (atom) => mol.getAtomicNo(atom) === 6 && mol.getAllHydrogens(atom) === 1 && !mol.isAromaticAtom(atom)
    );
    if (cho === undefined) throw new Error("aldehyde carbon not found");
    expect(estimateProtonIncrement(mol, cho)).toMatchObject({
      applicable: true,
      ppm: 9.7,
      estimator: { method: "functional-class-aldehyde" }
    });
  });

  it("rejects heteroaromatic benzene increments for pyrimidine", () => {
    const mol = molecule("n1ccncc1");
    const hosts = [...Array(mol.getAllAtoms()).keys()].filter(
      (atom) => mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0
    );
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.map((atom) => estimateProtonIncrement(mol, atom))).toEqual(
      hosts.map(() => expect.objectContaining({ applicable: false, reason: "heteroaromatic-ring" }))
    );
  });

  it("keeps the accepted approximate increment comparison for fused carbocyclic PAHs", () => {
    const mol = molecule("c1ccc2ccccc2c1");
    const host = [...Array(mol.getAllAtoms()).keys()].find(
      (atom) => mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0
    );
    if (host === undefined) throw new Error("aromatic proton host not found");
    expect(estimateProtonIncrement(mol, host)).toMatchObject({
      applicable: true,
      estimator: { method: "aromatic-substituent-increment" }
    });
  });

  it("checks the full fused aromatic component for heteroatoms", () => {
    const mol = molecule("c1ccc2ncccc2c1");
    const carbocyclicRingHost = [...Array(mol.getAllAtoms()).keys()].find(
      (atom) => mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0
    );
    if (carbocyclicRingHost === undefined) throw new Error("quinoline proton host not found");
    expect(estimateProtonIncrement(mol, carbocyclicRingHost)).toMatchObject({
      applicable: false,
      reason: "heteroaromatic-ring"
    });
  });

  it("does not silently classify sulfur or silicon substituents as alkyl", () => {
    for (const smiles of ["CSC", "C[Si](C)(C)C"]) {
      const mol = molecule(smiles);
      const host = [...Array(mol.getAllAtoms()).keys()].find(
        (atom) => mol.getAtomicNo(atom) === 6 && mol.getAllHydrogens(atom) > 0
      );
      if (host === undefined) throw new Error("proton host not found");
      expect(estimateProtonIncrement(mol, host)).toMatchObject({
        applicable: false,
        reason: "unsupported-substituent"
      });
    }
  });

  it.each([
    ["siloxy", "CO[Si](C)(C)C", 0],
    ["sulfonate", "COS(=O)(=O)c1ccccc1", 0],
    ["peroxide", "COOC", 0],
    ["carbonate", "COC(=O)OC", 0],
    ["anhydride", "CC(=O)OC(=O)C", 0],
    ["sulfonamide", "CNS(=O)(=O)C", 0],
    ["secondary amine extrapolation", "CNC", 0],
    ["tertiary amide extrapolation", "CN(C)C=O", 0],
    ["thioester collapsed to ketone", "CC(=O)SC", 0],
    ["silyl acyl compound collapsed to ketone", "CC(=O)[Si](C)(C)C", 0],
    ["alkynyl ether collapsed to ether", "COC#C", 0],
    ["carbamate collapsed to amide", "CNC(=O)OC", 0]
  ])("rejects an out-of-table %s environment", (_name, smiles, host) => {
    expect(estimateProtonIncrement(molecule(smiles), host)).toMatchObject({
      applicable: false,
      reason: "unsupported-substituent"
    });
  });

  it.each([
    ["sulfonamide", "c1ccccc1NS(=O)(=O)C"],
    ["carbamate", "c1ccccc1NC(=O)OC"],
    ["alkynyl ether", "C#COc1ccccc1"]
  ])("rejects an out-of-table aromatic %s substituent", (_name, smiles) => {
    const mol = molecule(smiles);
    const hosts = [...Array(mol.getAllAtoms()).keys()].filter(
      (atom) => mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0
    );
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.map((host) => estimateProtonIncrement(mol, host))).toEqual(
      hosts.map(() => expect.objectContaining({ applicable: false, reason: "unsupported-substituent" }))
    );
  });

  it("rejects saturated rings and cyclic ethers outside the acyclic correction model", () => {
    expect(estimateProtonIncrement(molecule("C1CC1"), 0)).toMatchObject({
      applicable: false,
      reason: "unsupported-aliphatic-ring"
    });
    expect(estimateProtonIncrement(molecule("CC1CO1"), 1)).toMatchObject({
      applicable: false,
      reason: "unsupported-aliphatic-ring"
    });
  });

  it("does not apply the sp3 scheme to an imine carbon", () => {
    const mol = molecule("CC=N");
    const imine = [...Array(mol.getAllAtoms()).keys()].find(
      (atom) =>
        mol.getAtomicNo(atom) === 6 &&
        mol.getAllHydrogens(atom) === 1 &&
        [...Array(mol.getConnAtoms(atom)).keys()].some(
          (index) =>
            mol.getAtomicNo(mol.getConnAtom(atom, index)) === 7 &&
            mol.getBondOrder(mol.getConnBond(atom, index)) === 2
        )
    );
    if (imine === undefined) throw new Error("imine carbon not found");
    expect(estimateProtonIncrement(mol, imine)).toMatchObject({
      applicable: false,
      reason: "unsupported-bonding-environment"
    });
  });

  it("does not treat an imine nitrogen attached to an sp3 carbon as an amine substituent", () => {
    const mol = molecule("CN=CC");
    expect(estimateProtonIncrement(mol, 0)).toMatchObject({
      applicable: false,
      reason: "unsupported-substituent"
    });
  });

  it("rejects charged and isotopically labeled structures", () => {
    expect(estimateProtonIncrement(molecule("C[N+](C)(C)C"), 0)).toMatchObject({
      applicable: false,
      reason: "charged-structure"
    });
    expect(estimateProtonIncrement(molecule("[13CH3]C"), 0)).toMatchObject({
      applicable: false,
      reason: "isotopically-labeled-structure"
    });
  });

  it("does not exempt a noncanonical charged N/O group as an ordinary nitro substituent", () => {
    const mol = molecule("[O-][N+](=O)(O)c1ccccc1");
    const host = [...Array(mol.getAllAtoms()).keys()].find(
      (atom) => mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0
    );
    if (host === undefined) throw new Error("aromatic proton host not found");
    expect(estimateProtonIncrement(mol, host)).toMatchObject({
      applicable: false,
      reason: "charged-structure"
    });
  });
});
