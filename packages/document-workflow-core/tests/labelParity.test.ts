// Native chemistry against RDKit for every label the reading turns into atoms: each table entry, the
// composites, the bonded element spellings and charged forms. The native formula must equal RDKit's
// exactly, and so must the canonical SMILES of every export route. Masses agree within the gaps the
// app has for ANY molecule (its atomic-weight table and its unadjusted electron mass), which the last
// block shows on molecules drawn atom by atom, with no labels at all.

import { beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { abbreviationDefinitions } from "@chemdraft/template-library";

import {
  expandNativeMoleculeLabelGroups,
  nativeAtomValidationState,
  nativeSingleBondGraphMetadata,
  nativeSingleBondGraphSmiles
} from "../src/index";

interface RdkitMol {
  get_smiles(): string;
  get_json(): string;
  get_descriptors(): string;
  delete(): void;
}

let rdkit: { get_mol(input: string): RdkitMol | null };

beforeAll(async () => {
  installNodeRdkitModuleLoader();
  rdkit = (await ensureRdkit()) as unknown as typeof rdkit;
}, 60_000);

const L = 30;

function atom(id: string, element: string, x: number, y: number, extra: Partial<MoleculeAtom> = {}): MoleculeAtom {
  return { id, element, x, y, formalCharge: 0, ...extra };
}

function bond(id: string, fromAtomId: string, toAtomId: string): MoleculeBond {
  return { id, fromAtomId, toAtomId, order: "single" };
}

function molecule(atoms: MoleculeAtom[], bonds: MoleculeBond[]): MoleculeObject {
  return {
    id: "m1", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
  };
}

/** What RDKit reads from the expanded molfile: canonical SMILES, formula, average and exact mass. */
function rdkitReading(drawn: MoleculeObject) {
  const { molecule: expanded } = expandNativeMoleculeLabelGroups(drawn);
  const molfile = moleculeToMolfileV2000(expanded, {
    fromDocFrame: true,
    kekuleBondOrders: nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders
  }).contents;
  const mol = rdkit.get_mol(molfile);
  if (!mol) throw new Error("RDKit could not read the expanded molfile");
  try {
    const descriptors = JSON.parse(mol.get_descriptors()) as { amw: number; exactmw: number };
    return {
      smiles: mol.get_smiles(),
      formula: compositionFromRdkitJson(JSON.parse(mol.get_json()) as RdkitJson).formula,
      averageMass: descriptors.amw,
      exactMass: descriptors.exactmw
    };
  } finally {
    mol.delete();
  }
}

function canonical(smiles: string): string {
  const mol = rdkit.get_mol(smiles);
  if (!mol) throw new Error(`RDKit could not parse ${smiles}`);
  try {
    return mol.get_smiles();
  } finally {
    mol.delete();
  }
}

/** Every case must be a valid drawing: parity is about what a valid label means. */
function expectValid(drawn: MoleculeObject): void {
  for (const target of drawn.atoms) {
    const state = nativeAtomValidationState(target, drawn.bonds, target.formalCharge, drawn.atoms);
    expect(state.valid, `${target.element}: ${state.invalidReason}`).toBe(true);
  }
}

function expectParity(drawn: MoleculeObject): void {
  expectValid(drawn);
  const native = nativeSingleBondGraphMetadata(drawn.atoms, drawn.bonds);
  const engine = rdkitReading(drawn);
  expect(native.formula).toBe(engine.formula);
  expect(canonical(nativeSingleBondGraphSmiles(drawn.atoms, drawn.bonds))).toBe(canonical(engine.smiles));
  // The label costs nothing: its masses are exactly those of the same molecule drawn atom by atom.
  const { molecule: atomByAtom } = expandNativeMoleculeLabelGroups(drawn);
  const plain = nativeSingleBondGraphMetadata(atomByAtom.atoms, atomByAtom.bonds);
  expect(native.formula).toBe(plain.formula);
  expect(native.averageMass).toBe(plain.averageMass);
  expect(native.exactMass).toBe(plain.exactMass);
  // What remains against RDKit is the app's atomic-weight table and its unadjusted electron mass,
  // the same for any molecule (see "mass gaps belong to the app" below): small, never a hydrogen.
  expect(Math.abs((native.averageMass ?? 0) - engine.averageMass)).toBeLessThan(0.05);
  expect(Math.abs((native.exactMass ?? 0) - engine.exactMass)).toBeLessThan(0.01);
}

/** A methyl carbon bonded to `label`. */
const cappedBy = (label: string, extra: Partial<MoleculeAtom> = {}) =>
  molecule([atom("c1", "C", 0, 0), atom("g1", label, L, 0, extra)], [bond("b1", "c1", "g1")]);

/** `label` between two carbons. */
const between = (label: string, extra: Partial<MoleculeAtom> = {}) =>
  molecule(
    [atom("c1", "C", 0, 0), atom("g1", label, L, 0, extra), atom("c2", "C", 2 * L, 0)],
    [bond("b1", "c1", "g1"), bond("b2", "g1", "c2")]
  );

/** `label` alone. */
const lone = (label: string, extra: Partial<MoleculeAtom> = {}) => molecule([atom("g1", label, 0, 0, extra)], []);

describe("native chemistry equals RDKit's", () => {
  it.each(abbreviationDefinitions.map((definition) => [definition.label]))("for C–%s", (label) => {
    expectParity(cappedBy(label));
  });

  it.each([["NMe2"], ["Me2N"], ["NHBoc"], ["CH2Ph"], ["SiMe3"], ["NTf2"], ["OTBS"], ["NHAc"], ["OTs"], ["NPr2"], ["SnBu3"], ["NiPr2"], ["PtBu2"], ["OtBu"]])(
    "for the composite C–%s",
    (label) => {
      expectParity(cappedBy(label));
    }
  );

  it.each([["NMe"], ["NTs"], ["CMe2"], ["SiMe2"]])("for the two-bond composite C–%s–C", (label) => {
    expectParity(between(label));
  });

  it("for C–SHMe–C, the S(IV) composite whose stated H the octet count would drop", () => {
    // The head states one H. Written out as an ordinary S with three carbon bonds, the valence model
    // gives it none while a molfile reader gives it one; the expansion makes it explicit.
    const drawn = between("SHMe");
    expect(nativeSingleBondGraphMetadata(drawn.atoms, drawn.bonds).formula).toBe("C3H10S");
    expectParity(drawn);
  });

  it.each([["Ac"], ["Pr"], ["Ts"]])("for the typed, bonded element spelling C–%s", (label) => {
    expectParity(cappedBy(label, { labelLiteral: true }));
  });

  it("for heads that state hydrogens: every stated H is counted, never eaten by an implicit slot", () => {
    // P(V) with three stated H: the model alone gives one implicit H, so all three go explicit.
    const phosphorane = cappedBy("PH3Me");
    expect(nativeSingleBondGraphMetadata(phosphorane.atoms, phosphorane.bonds).formula).toBe("C2H9P");
    expectParity(phosphorane);
    // Ordinary octet heads: the model's implicit count already equals the stated one.
    expectParity(cappedBy("SiH2Me"));
    expectParity(cappedBy("CH2Ph"));
    expectParity(lone("NH2Me"));
    expect(nativeSingleBondGraphMetadata(lone("NH2Me").atoms, []).formula).toBe("CH5N");
  });

  it("for charged forms", () => {
    expectParity(lone("OMe", { formalCharge: -1 }));
    expectParity(lone("NBu4", { formalCharge: 1 }));
    expectParity(cappedBy("NMe3", { formalCharge: 1 }));
    expectParity(cappedBy("NO2"));
    expectParity(cappedBy("N3"));
  });
});

describe("mass gaps belong to the app, not to labels", () => {
  it("shows the sulfur gap for dimethyl sulfone drawn atom by atom, as for C–Ms", () => {
    const drawn = molecule(
      [atom("c1", "C", 0, 0), atom("s1", "S", L, 0), atom("c2", "C", 2 * L, 0), atom("o1", "O", L, L), atom("o2", "O", L, -L)],
      [bond("b1", "c1", "s1"), bond("b2", "s1", "c2"), { id: "b3", fromAtomId: "s1", toAtomId: "o1", order: "double" },
        { id: "b4", fromAtomId: "s1", toAtomId: "o2", order: "double" }]
    );
    const gap = (target: MoleculeObject) =>
      (nativeSingleBondGraphMetadata(target.atoms, target.bonds).averageMass ?? 0) - rdkitReading(target).averageMass;
    expect(gap(cappedBy("Ms"))).toBeCloseTo(gap(drawn), 6);
    // The app weighs S at 32.06, RDKit at 32.067.
    expect(gap(drawn)).toBeCloseTo(-0.007, 3);
  });

  it("shows the same average-mass gap for tetramethylsilane drawn atom by atom as for C–TMS", () => {
    const drawn = molecule(
      [atom("si", "Si", 0, 0), atom("c1", "C", L, 0), atom("c2", "C", -L, 0), atom("c3", "C", 0, L), atom("c4", "C", 0, -L)],
      [bond("b1", "si", "c1"), bond("b2", "si", "c2"), bond("b3", "si", "c3"), bond("b4", "si", "c4")]
    );
    const gap = (target: MoleculeObject) =>
      (nativeSingleBondGraphMetadata(target.atoms, target.bonds).averageMass ?? 0) - rdkitReading(target).averageMass;
    expect(nativeSingleBondGraphMetadata(drawn.atoms, drawn.bonds).formula).toBe("C4H12Si");
    expect(gap(cappedBy("TMS"))).toBeCloseTo(gap(drawn), 6);
  });

  it("shows the same exact-mass gap (one electron) for methoxide drawn atom by atom as for OMe⁻", () => {
    const drawn = molecule([atom("c1", "C", 0, 0), atom("o1", "O", L, 0, { formalCharge: -1 })], [bond("b1", "c1", "o1")]);
    const gap = (target: MoleculeObject) =>
      (nativeSingleBondGraphMetadata(target.atoms, target.bonds).exactMass ?? 0) - rdkitReading(target).exactMass;
    expect(gap(lone("OMe", { formalCharge: -1 }))).toBeCloseTo(gap(drawn), 6);
    // The gap is the electron mass RDKit adds for the anion, which the native mass leaves out.
    expect(Math.abs(gap(drawn))).toBeCloseTo(0.00055, 4);
  });
});
