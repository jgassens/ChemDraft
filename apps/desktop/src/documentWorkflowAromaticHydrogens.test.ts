import { describe, expect, it } from "vitest";
import { DefaultNativeDrawingStyle, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import {
  porphyrinoid,
  testMoleculeFromSmiles,
  type TestMolecule
} from "@chemdraft/layout-engine/testing";

import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";

// Aromatic bonds do not say which ring nitrogen carries a hydrogen. Owner decision (2026-09-27):
// honour whatever the source states — explicit H atoms, a stated hydrogen count, charges, dative
// bonds — and only where real ambiguity remains, pick one tautomer and badge it
// (`chemistry.aromatic_tautomer_guessed`). Never drop or place an N–H silently.
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

describe("ring N–H when the source states nothing: guessed only where the ring allows more than one", () => {
  it("guanine keeps both ring N–H (C5H5N5O, not the deprotonated C5H3N5O) and badges the guess", () => {
    const guanine = testMoleculeFromSmiles("Nc1nc2ncnc2c(=O)n1");
    const reading = read(guanine);
    expect(reading.formula).toBe("C5H5N5O");
    expect(reading.drawnHydrogens).toBe(5);
    expect(reading.ringNH).toHaveLength(2);
    // 1H or 3H in the six-ring, 7H or 9H in the five-ring: all four ring N are a guess.
    expect(reading.guessed).toEqual(ringNitrogens(guanine));
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

  it("porphine keeps two N–H (C20H14N4, not C20H12N4), trans, and badges all four N", () => {
    const porphine = porphyrinoid("C", false);
    const reading = read(porphine);
    expect(reading.formula).toBe("C20H14N4");
    expect(reading.drawnHydrogens).toBe(14);
    expect([["n0", "n2"], ["n1", "n3"]]).toContainEqual(reading.ringNH);
    expect(reading.guessed).toEqual(["n0", "n1", "n2", "n3"]);
  });

  it("phthalocyanine keeps two N–H (C32H18N8, not C32H16N8) on opposite isoindoles, and badges the guess", () => {
    const phthalocyanine = porphyrinoid("N", true);
    const reading = read(phthalocyanine);
    expect(reading.formula).toBe("C32H18N8");
    expect(reading.drawnHydrogens).toBe(18);
    expect([["n0", "n2"], ["n1", "n3"]]).toContainEqual(reading.ringNH);
    for (const nitrogen of ["n0", "n1", "n2", "n3"]) expect(reading.guessed).toContain(nitrogen);
  });

  it("pyrrolo[3,2-b]pyrrole keeps both N–H (C6H6N2): the only aromatic arrangement, so nothing is guessed", () => {
    // The all-N= pattern (C6H4N2) is a Kekulé structure too, but an 8π one; Hückel leaves one answer.
    const reading = read(testMoleculeFromSmiles("c1cc2nccc2n1"));
    expect(reading.formula).toBe("C6H6N2");
    expect(reading.drawnHydrogens).toBe(6);
    expect(reading.ringNH).toHaveLength(2);
    expect(reading.guessed).toEqual([]);
    expect(reading.codes).toEqual([]);
  });

  it("imidazo[4,5-d]imidazole keeps two N–H (C4H4N4), one per ring, and badges all four N", () => {
    const molecule = testMoleculeFromSmiles("c1nc2ncnc2n1");
    const reading = read(molecule);
    expect(reading.formula).toBe("C4H4N4");
    expect(reading.drawnHydrogens).toBe(4);
    expect(reading.ringNH).toHaveLength(2);
    expect(reading.guessed).toEqual(ringNitrogens(molecule));
  });

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

  it("imidazole dative to zinc: the donor N is the bare one, whichever atom id is higher", () => {
    for (const reverseIds of [false, true]) {
      const molecule = testMoleculeFromSmiles("c1cn(->[Zn])cn1", { reverseIds });
      const donor = molecule.atoms[2]!.id;
      const other = molecule.atoms[5]!.id;
      const reading = read(molecule);
      expect(reading.formula).toBe("C3H4N2Zn");
      expect(reading.ringNH).toEqual([other]);
      expect(reading.ringNH).not.toContain(donor);
      expect(reading.codes).toEqual([]);
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
      "The aromatic bonds do not say which ring nitrogens carry hydrogen (a2, a4); one tautomer was guessed and written to SMILES."
    ]);
  });
});
