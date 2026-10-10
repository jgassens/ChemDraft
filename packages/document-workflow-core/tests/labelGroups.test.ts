import { beforeAll, describe, expect, it } from "vitest";
import {
  moleculeToMolfileV2000,
  moleculeToMolfileV3000,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject
} from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { abbreviationDefinitions } from "@chemdraft/template-library";

import {
  expandNativeLabelGroups,
  expandNativeMoleculeLabelGroups,
  moleculeSmiles,
  nativeAtomLabelReading,
  nativeAtomValidationState,
  nativeMoleculeUnspellableLabels,
  nativeSingleBondGraphMetadata,
  nativeSingleBondGraphSmiles
} from "../src/index";

const bondLength = 30;

interface RdkitMol {
  get_smiles(): string;
  get_json(): string;
  delete(): void;
}

let rdkit: { get_mol(input: string): RdkitMol | null };

beforeAll(async () => {
  installNodeRdkitModuleLoader();
  rdkit = (await ensureRdkit()) as unknown as typeof rdkit;
}, 60_000);

function withMol<T>(input: string, read: (mol: RdkitMol) => T): T {
  const mol = rdkit.get_mol(input);
  if (!mol) throw new Error(`RDKit could not parse ${input}`);
  try {
    return read(mol);
  } finally {
    mol.delete();
  }
}

const canonical = (input: string): string => withMol(input, (mol) => mol.get_smiles());
const rdkitFormula = (input: string): string =>
  withMol(input, (mol) => compositionFromRdkitJson(JSON.parse(mol.get_json()) as RdkitJson).formula);

function atom(id: string, element: string, x: number, y: number, extra: Partial<MoleculeAtom> = {}): MoleculeAtom {
  return { id, element, x, y, formalCharge: 0, ...extra };
}

function bond(id: string, fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single"): MoleculeBond {
  return { id, fromAtomId, toAtomId, order };
}

function molecule(atoms: MoleculeAtom[], bonds: MoleculeBond[]): MoleculeObject {
  return {
    id: "m1", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
  };
}

/** A carbon bonded to `label`: the simplest molecule that gives a group its one bond. */
function methylWith(label: string, extra: Partial<MoleculeAtom> = {}): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } {
  return {
    atoms: [atom("c1", "C", 0, 0), atom("g1", label, bondLength, 0, extra)],
    bonds: [bond("b1", "c1", "g1")]
  };
}

/** Cyclohexane with `label` in place of ring atom r1: the label carries two ring bonds. */
function ringWith(label: string, extra: Partial<MoleculeAtom> = {}): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } {
  const atoms = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return atom(`r${index + 1}`, index === 0 ? label : "C", bondLength * Math.cos(angle), bondLength * Math.sin(angle),
      index === 0 ? extra : {});
  });
  const bonds = atoms.map((_, index) => bond(`rb${index + 1}`, `r${index + 1}`, `r${((index + 1) % 6) + 1}`));
  return { atoms, bonds };
}

function stateOf(graph: { atoms: MoleculeAtom[]; bonds: MoleculeBond[] }, atomId: string) {
  const target = graph.atoms.find((candidate) => candidate.id === atomId)!;
  return nativeAtomValidationState(target, graph.bonds, target.formalCharge, graph.atoms);
}

/** The group's own SMILES with its "*" made a carbon: the molecule `methylWith` draws. */
const methylSmiles = (smiles: string): string => `C${smiles.slice(1)}`;

// The table's data against the element table and RDKit: tests/abbreviationTable.test.ts.

describe("native formula and RDKit agree on every table entry", () => {
  it.each(abbreviationDefinitions.map((definition) => [definition.label, definition] as const))(
    "C–%s",
    async (_label, definition) => {
      const graph = methylWith(definition.label);
      const expected = methylSmiles(definition.smiles);
      const metadata = nativeSingleBondGraphMetadata(graph.atoms, graph.bonds);
      expect(metadata.warnings).toEqual([]);
      // The formula comes from counting the expanded atoms, and RDKit reads the group's own SMILES.
      expect(metadata.formula).toBe(rdkitFormula(expected));
      // Every export route says the same molecule: the native writer, and RDKit over the molfile.
      expect(canonical(nativeSingleBondGraphSmiles(graph.atoms, graph.bonds))).toBe(canonical(expected));
      const expanded = expandNativeMoleculeLabelGroups(molecule(graph.atoms, graph.bonds)).molecule;
      const molfile = moleculeToMolfileV2000(expanded, {
        fromDocFrame: true,
        kekuleBondOrders: nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders
      }).contents;
      expect((await computeStructureIdentifiers(molfile))?.smiles).toBe(canonical(expected));
    }
  );
});

describe("abbreviation valence", () => {
  it("flags OMe on a ring carbon: the O would carry three bonds with no + charge (owner's report)", () => {
    for (const labelLiteral of [false, true]) {
      const graph = ringWith("OMe", labelLiteral ? { labelLiteral: true } : {});
      const state = stateOf(graph, "r1");
      expect(state.valid).toBe(false);
      expect(state.invalidReason).toContain("\"OMe\" attaches by 1 bond; atom r1 has 2.");
      // An oxonium is the charge that would make the drawing valid.
      expect(state.expectedFormalCharge).toBe(1);
    }
    // ...and the + charge does make it valid.
    expect(stateOf(ringWith("OMe", { formalCharge: 1 }), "r1").valid).toBe(true);
  });

  it("flags every table abbreviation on a ring carbon, and accepts it on a chain end", () => {
    for (const definition of abbreviationDefinitions) {
      const chain = methylWith(definition.label);
      expect(stateOf(chain, "g1").valid, definition.label).toBe(true);
      const ring = ringWith(definition.label);
      expect(stateOf(ring, "r1").valid, definition.label).toBe(false);
    }
  });

  it("flags an abbreviation with two attachments in a chain", () => {
    const graph = {
      atoms: [atom("c1", "C", 0, 0), atom("o1", "OMe", bondLength, 0), atom("c2", "C", 2 * bondLength, 0)],
      bonds: [bond("b1", "c1", "o1"), bond("b2", "o1", "c2")]
    };
    expect(stateOf(graph, "o1").valid).toBe(false);
  });

  it("flags a lone abbreviation as an open fragment unless a charge closes it", () => {
    const lone = { atoms: [atom("a1", "OMe", 0, 0)], bonds: [] };
    const state = stateOf(lone, "a1");
    expect(state.valid).toBe(false);
    expect(state.invalidReason).toContain("\"OMe\" attaches by 1 bond; atom a1 has 0.");
    expect(state.expectedFormalCharge).toBe(-1);
    // Methoxide: valid, and counted as the real CH3O⁻.
    const methoxide = { atoms: [atom("a1", "OMe", 0, 0, { formalCharge: -1 })], bonds: [] };
    expect(stateOf(methoxide, "a1").valid).toBe(true);
    const metadata = nativeSingleBondGraphMetadata(methoxide.atoms, methoxide.bonds);
    expect(metadata.formula).toBe("CH3O");
    expect(metadata.totalCharge).toBe(-1);
  });

  it("judges hypervalent and metal attachments by their own rules", () => {
    // Mesyl's sulfur is S(VI): one bond completes it.
    expect(stateOf(methylWith("Ms"), "g1").valid).toBe(true);
    // A metal is never hypovalent, but MgBr still attaches by one bond only.
    expect(stateOf({ atoms: [atom("a1", "MgBr", 0, 0)], bonds: [] }, "a1").valid).toBe(true);
    const twoBonds = {
      atoms: [atom("c1", "C", 0, 0), atom("m1", "MgBr", bondLength, 0), atom("c2", "C", 2 * bondLength, 0)],
      bonds: [bond("b1", "c1", "m1"), bond("b2", "m1", "c2")]
    };
    const state = stateOf(twoBonds, "m1");
    expect(state.valid).toBe(false);
    expect(state.invalidReason).toContain("\"MgBr\" attaches by 1 bond; atom m1 has 2.");
  });

  it("reads composite labels: an element carrying abbreviations", () => {
    for (const label of ["NMe2", "Me2N", "NHBoc", "BocHN", "OTBS", "TBSO", "CH2Ph", "PhCH2", "SiMe3", "CH2OMe", "MeOCH2", "OTf", "NTf2"]) {
      expect(nativeAtomLabelReading(label).kind, label).toBe("group");
      expect(stateOf(methylWith(label), "g1").valid, label).toBe(true);
    }
    // A ring "NMe" (N-methyl) takes its two ring bonds.
    expect(stateOf(ringWith("NMe"), "r1").valid).toBe(true);
    // A terminal "NMe" is short a bond, and says by how many.
    expect(stateOf(methylWith("NMe"), "g1").invalidReason).toContain("\"NMe\" attaches by 2 bonds; atom g1 has 1.");
    // A trimethylammonium needs its + charge.
    const neutral = stateOf(methylWith("NMe3"), "g1");
    expect(neutral.invalidReason).toContain("\"NMe3\" is complete by itself and takes no bonds; atom g1 has 1.");
    expect(neutral.expectedFormalCharge).toBe(1);
    expect(stateOf(methylWith("NMe3", { formalCharge: 1 }), "g1").valid).toBe(true);
  });

  it("does not read a head written before O as C–O: COEt is an acyl it cannot model", () => {
    for (const label of ["COEt", "SOMe", "SO2Ph"]) {
      expect(nativeAtomLabelReading(label).kind, label).toBe("unrecognized");
    }
  });
});

describe("unrecognized labels", () => {
  it.each([["Ome"], ["OME"], ["ome"]])("%s is text, not methoxy, and says so", (label) => {
    const graph = methylWith(label);
    const state = stateOf(graph, "g1");
    expect(state.valid).toBe(false);
    expect(state.unrecognizedLabel).toBe(true);
    expect(state.invalidReason).toContain(`Label "${label}" on atom g1 is not an element, a condensed formula or a known abbreviation`);
    expect(state.invalidReason).toContain("did you mean \"OMe\"?");
    const metadata = nativeSingleBondGraphMetadata(graph.atoms, graph.bonds);
    // The carbon keeps its three hydrogens; the text counts nothing.
    expect(metadata.formula).toBe("CH3");
    expect(metadata.warnings).toEqual([expect.objectContaining({ code: "chemistry.unrecognized_label", objectId: "g1" })]);
    expect(nativeMoleculeUnspellableLabels(molecule(graph.atoms, graph.bonds))).toEqual([label]);
  });

  it("leaves placeholders, condensed formulas and heavy hydrogen unflagged", () => {
    for (const label of ["R", "X", "?", "CONH2", "SO3H", "D", "NH2"]) {
      expect(stateOf(methylWith(label), "g1").valid, label).toBe(true);
    }
  });
});

describe("formula through expansion", () => {
  it("counts anisole drawn as Ph–OMe as C7H8O, the formula RDKit gives", () => {
    const graph = {
      atoms: [atom("p1", "Ph", 0, 0), atom("o1", "OMe", bondLength, 0)],
      bonds: [bond("b1", "p1", "o1")]
    };
    const metadata = nativeSingleBondGraphMetadata(graph.atoms, graph.bonds);
    expect(metadata.formula).toBe("C7H8O");
    expect(metadata.formula).toBe(rdkitFormula("COc1ccccc1"));
    expect(metadata.averageMass).toBeCloseTo(108.14, 2);
    expect(metadata.atomCount).toBe(2);
    expect(canonical(nativeSingleBondGraphSmiles(graph.atoms, graph.bonds))).toBe(canonical("COc1ccccc1"));
  });

  it("counts OAc as acetoxy, never O + actinium", () => {
    expect(nativeSingleBondGraphMetadata(methylWith("OAc").atoms, methylWith("OAc").bonds).formula).toBe("C3H6O2");
  });

  it("counts nothing for a flagged group: no output claims the structure the badge calls wrong", () => {
    const ring = ringWith("OMe");
    const metadata = nativeSingleBondGraphMetadata(ring.atoms, ring.bonds);
    expect(metadata.formula).toBe("C5H10");
    expect(metadata.warnings).toEqual([expect.objectContaining({ code: "chemistry.invalid_valence", objectId: "r1" })]);
    expect(nativeMoleculeUnspellableLabels(molecule(ring.atoms, ring.bonds))).toEqual(["OMe"]);
    expect(nativeSingleBondGraphSmiles(ring.atoms, ring.bonds)).toContain("[*]");
  });
});

describe("a bonded Ar is aryl, not argon", () => {
  // Typed as a label (`labelLiteral`): that is what makes a bonded "Ar" aryl.
  const arylAlcohol = {
    atoms: [atom("ar", "Ar", 0, 0, { labelLiteral: true }), atom("o1", "O", bondLength, 0)],
    bonds: [bond("b1", "ar", "o1")]
  };

  it("counts nothing for Ar–OH and exports it as a placeholder, not argon", async () => {
    const metadata = nativeSingleBondGraphMetadata(arylAlcohol.atoms, arylAlcohol.bonds);
    expect(metadata.formula).toBe("HO");
    expect(metadata.warnings).toEqual([]);
    expect(nativeSingleBondGraphSmiles(arylAlcohol.atoms, arylAlcohol.bonds)).toBe("[*]O");
    expect(nativeMoleculeUnspellableLabels(molecule(arylAlcohol.atoms, arylAlcohol.bonds))).toEqual(["Ar"]);

    const { molecule: expanded, placeholderAtoms } = expandNativeMoleculeLabelGroups(molecule(arylAlcohol.atoms, arylAlcohol.bonds));
    const warnings: string[] = [];
    const molfile = moleculeToMolfileV2000(expanded, {
      fromDocFrame: true, warnings, placeholderAtoms,
      kekuleBondOrders: nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders
    }).contents;
    expect(molfile).not.toMatch(/ Ar /);
    expect(molfile.split("\n")[4]!.slice(31, 34).trim()).toBe("*");
    expect(warnings).toEqual([
      "Atom label \"Ar\" stands for a group here (a bonded \"Ar\" is aryl, not the element Ar); written as a dummy atom (*) — the label's group is not represented in the molfile."
    ]);
    const exportWarnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule(arylAlcohol.atoms, arylAlcohol.bonds), 0, exportWarnings, computeStructureIdentifiers);
    expect(smiles).not.toContain("Ar");
    expect(canonical(smiles)).toBe(canonical("*O"));
    expect(exportWarnings).toContainEqual(expect.objectContaining({ code: "export.smiles_atom_label" }));
  });

  it("leaves an unbonded Ar as argon", () => {
    const lone = [atom("ar", "Ar", 0, 0)];
    expect(nativeSingleBondGraphMetadata(lone, []).formula).toBe("Ar");
    expect(nativeSingleBondGraphSmiles(lone, [])).toBe("[Ar]");
  });

  it("never exports a stale stored [Ar]O for it when no engine is available", async () => {
    const stale = { ...molecule(arylAlcohol.atoms, arylAlcohol.bonds), structure: "[Ar]O" };
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(stale, 0, warnings, undefined);
    expect(smiles).toBe("[*]O");
    expect(warnings).toContainEqual(expect.objectContaining({ code: "export.smiles_atom_label" }));
  });

  it("leaves a bonded Ar that came from a structure as argon: only a typed label is aryl", () => {
    const fromFile = {
      atoms: [atom("ar", "Ar", 0, 0), atom("o1", "O", bondLength, 0)],
      bonds: [bond("b1", "ar", "o1")]
    };
    expect(nativeSingleBondGraphMetadata(fromFile.atoms, fromFile.bonds).formula).toBe("ArHO");
    expect(nativeSingleBondGraphSmiles(fromFile.atoms, fromFile.bonds)).toBe("[Ar]O");
    expect(nativeMoleculeUnspellableLabels(molecule(fromFile.atoms, fromFile.bonds))).toEqual([]);
  });

  it.each([["R"], ["X"], ["Ome"]])("never exports a stale stored string for a C–%s drawing", async (label) => {
    const graph = methylWith(label);
    const stale = { ...molecule(graph.atoms, graph.bonds), structure: "CO" };
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(stale, 0, warnings, undefined)).toBe("C[*]");
    expect(warnings).toContainEqual(expect.objectContaining({ code: "export.smiles_atom_label" }));
  });
});

describe("typed, bonded Ac, Pr and Ts are groups", () => {
  const typed = { labelLiteral: true } as const;

  it("counts and writes a bonded Ts as tosyl when its bond fits", () => {
    const sulfone = methylWith("Ts", typed);
    expect(stateOf(sulfone, "g1").valid).toBe(true);
    // Methyl p-tolyl sulfone.
    expect(nativeSingleBondGraphMetadata(sulfone.atoms, sulfone.bonds).formula).toBe("C8H10O2S");
    expect(canonical(nativeSingleBondGraphSmiles(sulfone.atoms, sulfone.bonds))).toBe(canonical("CS(=O)(=O)c1ccc(C)cc1"));
    expect(nativeMoleculeUnspellableLabels(molecule(sulfone.atoms, sulfone.bonds))).toEqual([]);
  });

  it("badges a Ts with two bonds and counts it as nothing, never tennessine", () => {
    const graph = {
      atoms: [atom("c1", "C", 0, 0), atom("t1", "Ts", bondLength, 0, typed), atom("c2", "C", 2 * bondLength, 0)],
      bonds: [bond("b1", "c1", "t1"), bond("b2", "t1", "c2")]
    };
    const state = stateOf(graph, "t1");
    expect(state.valid).toBe(false);
    expect(state.invalidReason).toContain("\"Ts\" attaches by 1 bond; atom t1 has 2.");
    const metadata = nativeSingleBondGraphMetadata(graph.atoms, graph.bonds);
    expect(metadata.formula).toBe("C2H6");
    expect(nativeSingleBondGraphSmiles(graph.atoms, graph.bonds)).toBe("C[*]C");
    expect(nativeMoleculeUnspellableLabels(molecule(graph.atoms, graph.bonds))).toEqual(["Ts"]);
  });

  it("reads acetyl and propyl the same way, and leaves the unbonded symbols as elements", () => {
    const acetone = methylWith("Ac", typed);
    expect(nativeSingleBondGraphMetadata(acetone.atoms, acetone.bonds).formula).toBe("C3H6O");
    const butane = methylWith("Pr", typed);
    expect(nativeSingleBondGraphMetadata(butane.atoms, butane.bonds).formula).toBe("C4H10");
    for (const element of ["Ac", "Pr", "Ts"]) {
      const lone = [atom("x", element, 0, 0, typed)];
      expect(nativeSingleBondGraphMetadata(lone, []).formula).toBe(element);
      expect(stateOf({ atoms: lone, bonds: [] }, "x").valid).toBe(true);
    }
  });

  it("leaves an element from a structure as the element on a bond: a real Ac–Cl is actinium chloride", () => {
    // No labelLiteral: this Ac came from a molfile, a SMILES or a numeric CDXML Element.
    const graph = {
      atoms: [atom("ac", "Ac", 0, 0), atom("cl", "Cl", bondLength, 0)],
      bonds: [bond("b1", "ac", "cl")]
    };
    expect(nativeSingleBondGraphMetadata(graph.atoms, graph.bonds).formula).toBe("AcCl");
    expect(stateOf(graph, "ac").valid).toBe(true);
    expect(expandNativeLabelGroups(graph.atoms, graph.bonds).expansions).toEqual([]);
    expect(nativeSingleBondGraphSmiles(graph.atoms, graph.bonds)).toBe("[Ac]Cl");
  });
});

describe("expansion", () => {
  it("keeps every drawn atom at its index and position, and appends the group", () => {
    const graph = methylWith("CO2Me", { labelLiteral: true });
    const expanded = expandNativeLabelGroups(graph.atoms, graph.bonds);
    expect(expanded.atoms.slice(0, 2).map((candidate) => candidate.id)).toEqual(["c1", "g1"]);
    expect(expanded.atoms[1]).toMatchObject({ id: "g1", element: "C", x: bondLength, y: 0 });
    expect(expanded.atoms[1]!.labelLiteral).toBeUndefined();
    expect(expanded.atoms).toHaveLength(5);
    expect(expanded.bonds.slice(0, 1)).toEqual(graph.bonds);
    expect(expanded.expansions).toEqual([{ atomId: "g1", label: "CO2Me", atomIds: expanded.atoms.slice(1).map((candidate) => candidate.id) }]);
    const atomById = new Map(expanded.atoms.map((candidate) => [candidate.id, candidate]));
    for (const added of expanded.bonds.slice(1)) {
      const from = atomById.get(added.fromAtomId)!;
      const to = atomById.get(added.toAtomId)!;
      expect(Math.hypot(from.x - to.x, from.y - to.y)).toBeCloseTo(bondLength, 1);
    }
    // The group grows away from the carbon it is bonded to.
    for (const added of expanded.atoms.slice(2)) {
      expect(added.x).toBeGreaterThan(bondLength - 1);
    }
  });

  it("writes the group's charges and a SUP S-group a reader can contract", async () => {
    const graph = methylWith("NO2");
    const { molecule: expanded, expansions } = expandNativeMoleculeLabelGroups(molecule(graph.atoms, graph.bonds));
    const kekuleBondOrders = nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders;
    const v2000 = moleculeToMolfileV2000(expanded, { fromDocFrame: true, kekuleBondOrders, superatomGroups: expansions }).contents;
    expect(v2000).toContain("M  STY  1   1 SUP");
    expect(v2000).toContain("M  SAL   1  3   2   3   4");
    expect(v2000).toContain("M  SBL   1  1   1");
    expect(v2000).toContain("M  SMT   1 NO2");
    const v3000 = moleculeToMolfileV3000(expanded, { fromDocFrame: true, kekuleBondOrders, superatomGroups: expansions }).contents;
    expect(v3000).toContain("M  V30 COUNTS 4 3 1 0 0");
    expect(v3000).toContain("M  V30 1 SUP 0 ATOMS=(3 2 3 4) XBONDS=(1 1) LABEL=NO2");
    for (const file of [v2000, v3000]) {
      expect((await computeStructureIdentifiers(file))?.smiles).toBe(canonical("C[N+](=O)[O-]"));
    }
  });

  it("reports the expansion on SMILES export and does not use a stale stored [*] string", async () => {
    const graph = methylWith("OMe");
    const stale = { ...molecule(graph.atoms, graph.bonds), structure: "C[*]" };
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(stale, 0, warnings, undefined);
    expect(canonical(smiles)).toBe(canonical("COC"));
    expect(warnings).toEqual([expect.objectContaining({ code: "export.smiles_abbreviation_expanded", severity: "info" })]);
  });
});
