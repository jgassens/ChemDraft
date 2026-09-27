import { describe, expect, it } from "vitest";
import { DefaultNativeDrawingStyle, moleculeToMolfileV2000, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { Molecule } from "openchemlib";
import { atomDisplayLabel, nativeBondOrderResolution, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import {
  porphyrinoid,
  testMoleculeFromSmiles,
  type TestMolecule
} from "@chemdraft/layout-engine/testing";

import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";

// Aromatic bonds do not say which ring nitrogen carries a hydrogen. Owner decision (2026-09-27):
// honour whatever the source states — explicit H atoms, a stated hydrogen count, charges, dative
// bonds and literal labels. For each N with no H information, add N–H only in FIVE-membered rings
// needing it for aromaticity; six- and larger rings never justify extra H. Otherwise keep the
// maximum-matching reading. Closed shell wins any conflict, with a badge. Every N whose H was
// inferred by this rule carries chemistry.aromatic_tautomer_guessed, even a unique placement.
//
// Where the source states nothing, these tests assert the formula, that the drawn labels carry the
// formula's hydrogens, how MANY ring N–H there are, and which atoms are badged — never WHICH
// nitrogen got the H, because that is a deterministic pick, not chemistry.

const hydrogensInLabel = (label: string | undefined): number => {
  const match = label?.match(/H(\d*)/);
  return match ? (match[1] ? Number(match[1]) : 1) : 0;
};

const formulaHydrogens = (formula: string): number => {
  const match = formula.match(/H(\d*)/);
  return match ? (match[1] ? Number(match[1]) : 1) : 0;
};

interface Reading {
  formula: string;
  drawnHydrogens: number;
  /** Ring nitrogens drawn with an H. */
  ringNH: string[];
  guessed: string[];
  codes: string[];
}

function read({ atoms, bonds }: { atoms: readonly MoleculeAtom[]; bonds: readonly MoleculeBond[] }): Reading {
  const metadata = nativeSingleBondGraphMetadata(atoms, bonds);
  const visible = atoms.map((atom) => (atom.element === "C" ? { ...atom, labelVisible: true } : atom));
  const labels = new Map(visible.map((atom) => [atom.id, atomDisplayLabel(atom, bonds, DefaultNativeDrawingStyle, visible)]));
  const ringAtomIds = new Set(bonds.filter((bond) => bond.order === "aromatic").flatMap((bond) => [bond.fromAtomId, bond.toAtomId]));
  return {
    formula: metadata.formula ?? "",
    drawnHydrogens: [...labels.values()].reduce((sum, label) => sum + hydrogensInLabel(label), 0),
    ringNH: atoms
      .filter((atom) => atom.element === "N" && ringAtomIds.has(atom.id) && hydrogensInLabel(labels.get(atom.id)) > 0)
      .map((atom) => atom.id)
      .sort(),
    guessed: metadata.warnings
      .filter((warning) => warning.code === "chemistry.aromatic_tautomer_guessed")
      .map((warning) => warning.objectId ?? "")
      .sort(),
    codes: [...new Set(metadata.warnings.map((warning) => warning.code))].sort()
  };
}

const ringNitrogens = (molecule: TestMolecule): string[] =>
  molecule.atoms
    .filter((atom) => atom.element === "N" && molecule.bonds.some((bond) =>
      bond.order === "aromatic" && (bond.fromAtomId === atom.id || bond.toAtomId === atom.id)))
    .map((atom) => atom.id)
    .sort();

describe("ring N–H when the source states nothing: five-ring inference is always badged", () => {
  it.each([
    ["pyrrole", "c1ccnc1", "C4H5N", 1],
    ["pyrrolopyrrole-like", "c1cc2nccc2n1", "C6H6N2", 2],
    ["imidazoimidazole-like", "c1nc2ncnc2n1", "C4H4N4", 2]
  ] as const)("%s: only five-ring N–H are inferred, and every placement is badged", (_name, smiles, formula, count) => {
    const reading = read(testMoleculeFromSmiles(smiles));
    expect(reading.formula).toBe(formula);
    expect(reading.drawnHydrogens).toBe(formulaHydrogens(formula));
    expect(reading.ringNH).toHaveLength(count);
    expect(reading.guessed).toEqual(expect.arrayContaining(reading.ringNH));
    expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
  });

  it.each([
    ["guanine", "Nc1nc2ncnc2c(=O)n1", "C5H3N5O", [], ["a4", "a6"]],
    ["hypoxanthine", "O=c1ncnc2ncnc12", "C5H2N4O", [], ["a6", "a8"]],
    ["xanthine", "O=c1nc(=O)c2ncnc2n1", "C5H2N4O2", ["a2"], ["a2", "a6", "a8"]]
  ] as const)("unhinted %s skeleton: closed shell wins conflicts with the five-ring rule", (_name, smiles, formula, ringNH, guessed) => {
    const graph = testMoleculeFromSmiles(smiles);
    const reading = read(graph);
    // The named neutral natural products have two additional H, including six-ring amide N–H.
    // This deliberately restricted inference rule cannot supply those unstated hydrogens.
    // Xanthine's N between two C=O groups cannot take a double bond: its six-ring N–H (a2) is
    // required by closure, so the exception retains it and badges it. Guanine keeps both five-ring
    // N bare: either extra N–H would also need a six-ring H, beyond maximum matching.
    expect(reading.formula).toBe(formula);
    expect(reading.drawnHydrogens).toBe(formulaHydrogens(formula));
    expect(reading.ringNH).toEqual(ringNH);
    expect(reading.guessed).toEqual(guessed);
    expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
  });

  it("adenine keeps one ring N–H in the five-ring (C5H5N5) and badges N7 and N9 only", () => {
    // SMILES order: a0 NH2, a1 C6, a2 N1, a3 C2, a4 N3, a5 C4, a6 N9, a7 C8, a8 N7, a9 C5.
    const adenine = testMoleculeFromSmiles("Nc1ncnc2ncnc12");
    const reading = read(adenine);
    expect(reading.formula).toBe("C5H5N5");
    expect(reading.drawnHydrogens).toBe(5);
    expect(reading.ringNH).toHaveLength(1);
    expect(["a6", "a8"]).toContain(reading.ringNH[0]);
    expect(reading.guessed).toEqual(["a6", "a8"]);
  });

  it.each([["C", false, "C20H14N4"], ["N", true, "C32H18N8"]] as const)(
    "%s-bridged unhinted macrocycle has two five-ring N–H and badges all four tautomer sites",
    (meso, benzo, formula) => {
      const reading = read(porphyrinoid(meso, benzo));
      expect(reading.formula).toBe(formula);
      expect(reading.drawnHydrogens).toBe(formulaHydrogens(formula));
      expect(reading.ringNH).toHaveLength(2);
      expect(reading.guessed).toEqual(["n0", "n1", "n2", "n3"]);
      expect(reading.guessed).toEqual(expect.arrayContaining(reading.ringNH));
      // Trans rather than cis is the deterministic tie-break; every placement is still a guess.
      expect(reading.ringNH).toEqual(["n0", "n2"]);
    }
  );

  it("4-methylimidazole with no H stated: one N–H, both nitrogens badged, whichever way the ids run", () => {
    for (const reverseIds of [false, true]) {
      const molecule = testMoleculeFromSmiles("Cc1cncn1", { reverseIds });
      const reading = read(molecule);
      expect(reading.formula).toBe("C4H6N2");
      expect(reading.drawnHydrogens).toBe(6);
      expect(reading.ringNH).toHaveLength(1);
      expect(reading.guessed).toEqual(ringNitrogens(molecule));
    }
  });
});

describe("aromatic review regressions", () => {
  it("stated carbon H does not suppress N–H inference in the fused five-rings", () => {
    const graph = testMoleculeFromSmiles("[cH]1cc2nccc2n1");
    const reading = read(graph);
    expect(reading.formula).toBe("C6H6N2");
    expect(reading.drawnHydrogens).toBe(6);
    expect(reading.ringNH).toEqual(["a3", "a7"]);
    expect(reading.guessed).toEqual(["a3", "a7"]);
    expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
  });

  it.each(["meso hydrogenCount", "meso literal CH", "explicit beta H"])(
    "porphine with %s still infers two inner N–H and badges all four sites", (stated) => {
      const graph = porphyrinoid("C", false);
      if (stated === "explicit beta H") {
        graph.atoms.push({ id: "betaH", element: "H", x: 0, y: 0, formalCharge: 0 });
        graph.bonds.push({ id: "betaCH", fromAtomId: "u0c", toAtomId: "betaH", order: "single" });
      } else {
        const meso = graph.atoms.find((atom) => atom.id === "m0")!;
        if (stated === "meso hydrogenCount") meso.hydrogenCount = 1;
        else Object.assign(meso, { element: "CH", labelLiteral: true });
      }
      const reading = read(graph);
      expect(reading.formula).toBe("C20H14N4");
      expect(reading.drawnHydrogens).toBe(14);
      expect(reading.ringNH).toEqual(["n0", "n2"]);
      expect(reading.guessed).toEqual(["n0", "n1", "n2", "n3"]);
      expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
    }
  );

  it("an N-oxide constrains its own N but leaves the pyrrole N–H inferred and badged", () => {
    const reading = read(testMoleculeFromSmiles("c1cc2ccnc2[n+]([O-])c1"));
    expect(reading.formula).toBe("C7H6N2O");
    expect(reading.drawnHydrogens).toBe(6);
    expect(reading.ringNH).toEqual(["a5"]);
    expect(reading.guessed).toEqual(["a5"]);
    expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
  });

  it("a stated bare imidazole N settles only itself; the other N–H is still inferred and badged", () => {
    const reading = read(testMoleculeFromSmiles("c1c[n]cn1"));
    expect(reading.formula).toBe("C3H4N2");
    expect(reading.ringNH).toEqual(["a4"]);
    expect(reading.guessed).toEqual(["a4"]);
  });

  it("retains the documented 4n+2 preference cost for dipyrrolo-biphenylene", () => {
    const reading = read(testMoleculeFromSmiles("c1c5cncc5c2c3cc5cncc5cc3c2c1"));
    expect(reading.formula).toBe("C16H8N2");
    expect(reading.ringNH).toEqual([]);
    expect(reading.guessed).toEqual(["a11", "a3"]);
    expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
  });

  it("every inferred or conflicting reading writes a closed-shell molecule with the same formula", () => {
    const graphs = [
      porphyrinoid("C", false), porphyrinoid("N", true),
      ...["c1ccnc1", "c1cncn1", "c1cc2nccc2n1", "c1nc2ncnc2n1",
        "Nc1nc2ncnc2c(=O)n1", "O=c1nc(=O)c2ncnc2n1", "O=c1ncccc1"].map((s) => testMoleculeFromSmiles(s))
    ];
    for (const graph of graphs) {
      const molecule: MoleculeObject = { id: "closed-shell", type: "molecule", x: 0, y: 0, width: 100,
        height: 100, rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
        superatoms: [], rGroups: [], ...graph };
      const resolution = nativeBondOrderResolution(graph.atoms, graph.bonds);
      expect(resolution.unresolvedAtomIds.size).toBe(0);
      const parsed = Molecule.fromMolfile(moleculeToMolfileV2000(molecule, {
        kekuleBondOrders: resolution.kekuleOrders
      }).contents);
      expect(parsed.getMolecularFormula().formula).toBe(read(graph).formula);
      for (let i = 0; i < parsed.getAllAtoms(); i += 1) expect(parsed.getAtomRadical(i)).toBe(0);
    }
  });

  it("a six-ring N–H required for closed shell is retained and badged (pyridone)", () => {
    const reading = read(testMoleculeFromSmiles("O=c1ncccc1"));
    expect(reading.formula).toBe("C5H5NO");
    expect(reading.ringNH).toEqual(["a2"]);
    expect(reading.guessed).toEqual(["a2"]);
  });

  it("unresolvable Cp counts single for formula/SMILES and badges all five atoms", () => {
    const graph = testMoleculeFromSmiles("c1cccc1");
    const metadata = nativeSingleBondGraphMetadata(graph.atoms, graph.bonds);
    expect(metadata.formula).toBe("C5H10");
    expect(metadata.warnings.map((warning) => [warning.code, warning.objectId])).toEqual(
      graph.atoms.map((atom) => ["chemistry.unresolved_aromatic", atom.id])
    );
    const warnings: string[] = [];
    expect(nativeSingleBondGraphSmiles(graph.atoms, graph.bonds, warnings)).not.toContain("=");
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ["eight-membered diaza ring", "c1cnccccn1", "C6H6N2"],
    ["diazadibenzocyclooctene", "n1ncc2c(c1)ccc1ccccc1cc2", "C14H10N2"],
    ["pyrene", "c1cc2ccc3cccc4ccc(c1)c2c34", "C16H10"],
    ["azapyrene", "n1cc2ccc3cccc4ccc(c1)c2c34", "C15H9N"],
    ["diazapyrene", "n1nc2ccc3cccc4ccc(c1)c2c34", "C14H8N2"],
    ["tetraazapyrene", "n1nc2cnc3nccc4ccc(c1)c2c34", "C12H6N4"]
  ])("%s: a fused 4n core does not acquire H2 to satisfy a whole-system 4n+2 count", (_name, smiles, formula) => {
    const reading = read(testMoleculeFromSmiles(smiles));
    expect(reading.formula).toBe(formula);
    expect(reading.ringNH).toEqual([]);
    expect(reading.codes).toEqual([]);
  });

  it("all 66 peripheral diaza placements on dibenzo[a,e]cyclooctene preserve C14H10N2", () => {
    const scaffold = testMoleculeFromSmiles("c1ccc2c(c1)ccc1ccccc1cc2");
    const peripheral = scaffold.atoms.filter((atom) => scaffold.bonds.filter((bond) =>
      bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 2);
    expect(peripheral).toHaveLength(12);
    let checked = 0;
    for (let i = 0; i < peripheral.length; i += 1) {
      for (let j = i + 1; j < peripheral.length; j += 1) {
        const diaza = new Set([peripheral[i]!.id, peripheral[j]!.id]);
        const atoms = scaffold.atoms.map((atom) => diaza.has(atom.id) ? { ...atom, element: "N" } : atom);
        const reading = read({ atoms, bonds: scaffold.bonds });
        expect(reading.formula, [...diaza].join(", ")).toBe("C14H10N2");
        expect(reading.drawnHydrogens).toBe(10);
        expect(reading.ringNH).toEqual([]);
        expect(reading.codes).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(66);
  });

  it("xanthine with its amide hydrogens stated preserves them in mixed ring representations", () => {
    const aromatic = testMoleculeFromSmiles("O=c1[nH]c(=O)c2ncnc2[nH]1");
    const mixed = testMoleculeFromSmiles("O=c1-[nH]-c(=O)c2ncnc2[nH]1");
    const kekule = testMoleculeFromSmiles("O=C1NC(=O)C2=C(N1)N=CN2");
    for (const graph of [aromatic, mixed, kekule]) {
      const reading = read(graph);
      expect(reading.formula).toBe("C5H4N4O2");
      expect(reading.drawnHydrogens).toBe(4);
      expect(reading.codes).not.toContain("chemistry.unresolved_aromatic");
    }
  });

  it.each([
    ["neutral pyrrole N", "c1cc[nH2]c1", "a3", 2],
    ["pyridinium N+", "c1cc[n+]cc1", "a3", 0]
  ] as const)("warns with the atom id and stated count for impossible %s hydrogens", (_name, smiles, id, count) => {
    const { atoms, bonds } = testMoleculeFromSmiles(smiles);
    const warnings = nativeSingleBondGraphMetadata(atoms, bonds).warnings;
    expect(warnings).toContainEqual(expect.objectContaining({
      code: "chemistry.invalid_valence", objectId: id,
      message: expect.stringContaining(`atom ${id} states ${count} hydrogens`)
    }));
  });

  it("saturated cyclohexane with six aromatic-marked bonds counts single and warns for all six carbons", () => {
    const { atoms, bonds } = testMoleculeFromSmiles("[cH2]1[cH2][cH2][cH2][cH2][cH2]1", { bracketHydrogens: "atoms" });
    const resolution = nativeBondOrderResolution(atoms, bonds);
    expect(resolution.bonds.every((bond) => bond.order === "single")).toBe(true);
    const metadata = nativeSingleBondGraphMetadata(atoms, bonds);
    expect(metadata.formula).toBe("C6H12");
    expect(metadata.warnings.map((warning) => [warning.code, warning.objectId]).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((index) => ["chemistry.unresolved_aromatic", `a${index}`])
    );
  });

  it("label and metadata batches read the graph linearly, including cache validation and neighbor lookup", () => {
    const work = (rings: number): number => {
      let reads = 0;
      const count = <T extends object>(value: T): T => new Proxy(value, {
        get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver); }
      });
      const graph = testMoleculeFromSmiles(Array(rings).fill("c1cncn1").join("."));
      const atoms = graph.atoms.map((atom) => count({ ...atom, labelVisible: true }));
      const bonds = graph.bonds.map(count);
      const molecule = { ...graph, atoms, bonds, style: {} } as MoleculeObject;
      // Resolve first, as the canvas does. Include every subsequent graph read, not just searches.
      nativeBondOrderResolution(atoms, bonds);
      reads = 0;
      expect(planMoleculeAtomLabels(molecule)).toHaveLength(atoms.length);
      expect(nativeSingleBondGraphMetadata(atoms, bonds).formula).toBe(`C${3 * rings}H${4 * rings}N${2 * rings}`);
      return reads;
    };
    const small = work(512);
    const large = work(1024);
    expect(large).toBeLessThan(small * 2.1);
    expect(large).toBeLessThan(1_000_000);
  });
});

describe("ring N–H the source states is honoured and never badged", () => {
  it("guanine with its N–H stated keeps them where they were stated", () => {
    // a4 is N9, a10 is N1.
    const reading = read(testMoleculeFromSmiles("Nc1nc2[nH]cnc2c(=O)[nH]1"));
    expect(reading.formula).toBe("C5H5N5O");
    expect(reading.ringNH).toEqual(["a10", "a4"]);
    expect(reading.codes).toEqual([]);
  });

  it("adenine with N9–H stated", () => {
    const reading = read(testMoleculeFromSmiles("Nc1ncnc2[nH]cnc12"));
    expect(reading.formula).toBe("C5H5N5");
    expect(reading.ringNH).toEqual(["a6"]);
    expect(reading.codes).toEqual([]);
  });

  it("porphine and phthalocyanine with their N–H stated", () => {
    for (const [meso, benzo, formula] of [["C", false, "C20H14N4"], ["N", true, "C32H18N8"]] as const) {
      const reading = read(porphyrinoid(meso, benzo, [1, 3]));
      expect(reading.formula).toBe(formula);
      expect(reading.ringNH).toEqual(["n1", "n3"]);
      expect(reading.codes).toEqual([]);
    }
  });

  it("4-methylimidazole: a stated count or an explicit H atom puts the H where the source says, both id orders", () => {
    for (const reverseIds of [false, true]) {
      // The 4-methyl tautomer: the H on the nitrogen away from the methyl (SMILES atom 3).
      const stated = testMoleculeFromSmiles("Cc1c[nH]cn1", { reverseIds });
      const nh = stated.atoms[3]!.id;
      const reading = read(stated);
      expect(reading.formula).toBe("C4H6N2");
      expect(reading.ringNH).toEqual([nh]);
      expect(reading.codes).toEqual([]);

      const explicit = testMoleculeFromSmiles("Cc1c[nH]cn1", { reverseIds, bracketHydrogens: "atoms" });
      const explicitReading = read(explicit);
      expect(explicitReading.formula).toBe("C4H6N2");
      // The H is its own atom, bonded to that nitrogen, so neither ring N label draws one.
      expect(explicitReading.ringNH).toEqual([]);
      expect(explicitReading.drawnHydrogens).toBe(6);
      expect(explicitReading.codes).toEqual([]);
    }
  });

  it("imidazole dative to zinc: only the other N's inferred H is badged, whichever atom id is higher", () => {
    for (const reverseIds of [false, true]) {
      const molecule = testMoleculeFromSmiles("c1cn(->[Zn])cn1", { reverseIds });
      const donor = molecule.atoms[2]!.id;
      const other = molecule.atoms[5]!.id;
      const reading = read(molecule);
      expect(reading.formula).toBe("C3H4N2Zn");
      expect(reading.ringNH).toEqual([other]);
      expect(reading.ringNH).not.toContain(donor);
      expect(reading.guessed).toEqual([other]);
      expect(reading.codes).toEqual(["chemistry.aromatic_tautomer_guessed"]);
    }
  });

  it("a typed literal N carries no H, so a pyridine drawn with one is unambiguous", () => {
    const pyridine = testMoleculeFromSmiles("c1ccncc1");
    const atoms = pyridine.atoms.map((atom) => (atom.element === "N" ? { ...atom, labelLiteral: true } : atom));
    const reading = read({ atoms, bonds: pyridine.bonds });
    expect(reading.formula).toBe("C5H5N");
    expect(reading.codes).toEqual([]);
  });
});

describe("an aromatic bond in a ring that is otherwise saturated", () => {
  it("counts single and is flagged, never promoted to a double bond (cyclohexane stays C6H12)", () => {
    const molecule = testMoleculeFromSmiles("C1CC:CCC1");
    const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    expect(metadata.formula).toBe("C6H12");
    const unresolved = metadata.warnings.filter((warning) => warning.code === "chemistry.unresolved_aromatic");
    expect(unresolved.map((warning) => warning.objectId).sort()).toEqual(["a2", "a3"]);
    const warnings: string[] = [];
    expect(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds, warnings)).not.toContain("=");
    expect(warnings).toEqual(["1 aromatic bond outside any aromatic ring written to SMILES as single."]);
  });
});

describe("the SMILES writer reports a guessed tautomer", () => {
  it("names the guessed nitrogens", () => {
    const molecule = testMoleculeFromSmiles("c1cncn1");
    const warnings: string[] = [];
    nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds, warnings);
    expect(warnings).toEqual([
      "Hydrogen counts at aromatic atoms a2, a4 were guessed using a closed-shell reading and written to SMILES."
    ]);
  });

  it("says inferred, not guessed, for a unique placement (pyrrole's one N)", () => {
    const molecule = testMoleculeFromSmiles("c1ccnc1");
    const resolution = nativeBondOrderResolution(molecule.atoms, molecule.bonds);
    expect([...resolution.inferredHydrogenAtomIds]).toEqual(["a3"]);
    expect(resolution.guessedHydrogenAtomIds.size).toBe(0);
    const warnings: string[] = [];
    nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds, warnings);
    expect(warnings).toEqual([
      "Hydrogen count at aromatic atom a3 was inferred (not stated in the source; the only closed-shell reading) and written to SMILES."
    ]);
    expect(warnings.join(" ")).not.toContain("guessed");
  });
});
