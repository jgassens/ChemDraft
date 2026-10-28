// The package boundary scans tests too; use the same local runner path as structureName.test.ts.
import { describe, expect, it } from "../../../node_modules/vitest";
import { createEmptyDocument, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata } from "./atoms";
import { createSmilesMolecule, pastedStructureDepictionFromMolfile } from "./molecule";
import { nativeSingleBondGraphSmiles } from "./smiles";
import { moleculeSmiles } from "./moleculeSmiles";

const atom = (id: string, element: string, isotope?: number): MoleculeAtom => ({
  id, element, ...(isotope === undefined ? {} : { isotope }), x: 0, y: 0, formalCharge: 0
});
const bond = (
  fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single"
): MoleculeBond => ({
  id: `${fromAtomId}_${toAtomId}`, fromAtomId, toAtomId, order
});

describe("native isotope chemistry", () => {
  it.each(["D", "T"])("a bonded %s consumes one carbon valence and has no implicit H", (element) => {
    const atoms = [atom("c", "C"), atom("h", element)];
    const bonds = [bond("c", "h")];
    const metadata = nativeSingleBondGraphMetadata(atoms, bonds);
    expect(metadata.formula).toBe(`CH3${element}`);
    expect(metadata.exactMass).toBe(element === "D" ? 17.03758 : 18.03952);
    expect(nativeSingleBondGraphSmiles(atoms, bonds)).toContain(element === "D" ? "[2H]" : "[3H]");
    expect(nativeSingleBondGraphMetadata([atom("c", "C")], []).formula).toBe("CH4");
  });

  it("keeps heavy-atom implicit hydrogens inside the isotope bracket", () => {
    const atoms = [atom("c", "C", 13), atom("o", "O", 18)];
    const bonds = [bond("c", "o")];
    const smiles = nativeSingleBondGraphSmiles(atoms, bonds);
    expect(smiles).toContain("[13CH3]");
    expect(smiles).toContain("[18OH]");
    expect(nativeSingleBondGraphMetadata(atoms, bonds)).toMatchObject({
      formula: "[13C]H4[18O]", isotopeLabels: ["13C", "18O"], exactMass: 35.03381
    });
    atoms[1]!.formalCharge = -1;
    expect(nativeSingleBondGraphSmiles(atoms, bonds)).toContain("[18O-]");
  });

  it("writes the hydrogen on an isotopic pyrrole nitrogen", () => {
    const atoms = [atom("n", "N", 15), ...["a", "b", "c", "d"].map((id) => atom(id, "C"))];
    const bonds = [bond("n", "a"), bond("a", "b", "double"), bond("b", "c"),
      bond("c", "d", "double"), bond("d", "n")];
    expect(nativeSingleBondGraphSmiles(atoms, bonds)).toContain("[15NH]");
    expect(nativeSingleBondGraphMetadata(atoms, bonds).formula).toBe("C4H5[15N]");
  });

  it("orders isotope groups by Hill element then mass, and abbreviates hydrogen-2/3", () => {
    const atoms = [atom("t", "T"), atom("d", "D"), atom("h", "H", 1), atom("c", "C", 13),
      atom("c2", "C", 14), atom("h0", "H"), atom("o", "O", 18)];
    atoms.forEach((entry) => { entry.labelLiteral = true; });
    expect(nativeSingleBondGraphMetadata(atoms, []).formula).toBe("[13C][14C]H[1H]DT[18O]");
    expect(nativeSingleBondGraphMetadata([
      { ...atom("o", "O"), labelLiteral: true }, { ...atom("n", "N", 15), labelLiteral: true }
    ], []).formula).toBe("O[15N]");
  });

  it("declines both masses for an unlisted nuclide while preserving its formula and SMILES", () => {
    const atoms = [atom("c", "C", 99)];
    const metadata = nativeSingleBondGraphMetadata(atoms, []);
    expect(metadata.formula).toBe("[99C]H4");
    expect(metadata.averageMass).toBeUndefined();
    expect(metadata.exactMass).toBeUndefined();
    expect(metadata.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "native.isotope_mass_unknown", message: expect.stringContaining("99C")
      })
    ]));
    expect(nativeSingleBondGraphSmiles(atoms, [])).toBe("[99CH4]");
  });

  it.each([
    ["C", 11, 11.011432597], ["C", 13, 13.00335483534], ["C", 14, 14.00324198862],
    ["N", 15, 15.00010889827], ["O", 17, 16.99913175595], ["O", 18, 17.99915961214],
    ["F", 18, 18.000937324], ["P", 32, 31.973907643], ["P", 33, 32.971725692],
    ["S", 34, 33.967867011], ["S", 35, 34.969032321], ["Cl", 36, 35.968306822],
    ["Cl", 37, 36.965902573], ["Br", 79, 78.918337574], ["Br", 81, 80.916288197],
    ["I", 123, 122.905589753], ["I", 124, 123.906210297], ["I", 125, 124.904630610],
    ["I", 131, 130.906126375], ["H", 1, 1.007825031898]
  ] as const)("uses the nuclide mass for both masses of %s-%s", (element, isotope, mass) => {
    const atoms = [{ ...atom("a", element, isotope), labelLiteral: true }];
    const metadata = nativeSingleBondGraphMetadata(atoms, []);
    expect(metadata.exactMass).toBe(Number(mass.toFixed(5)));
    expect(metadata.averageMass).toBe(Number(mass.toFixed(3)));
  });

  it("carries isotope through the MOL depiction and SMILES molecule builders", () => {
    const molfile = ["Isotope", "", "", "  0  0  0  0  0  0            999 V3000",
      "M  V30 BEGIN CTAB", "M  V30 COUNTS 2 1 0 0 0", "M  V30 BEGIN ATOM",
      "M  V30 1 C 0 0 0 0 MASS=13", "M  V30 2 H 1 0 0 0 MASS=2", "M  V30 END ATOM",
      "M  V30 BEGIN BOND", "M  V30 1 1 1 2", "M  V30 END BOND", "M  V30 END CTAB", "M  END"].join("\n");
    const depiction = pastedStructureDepictionFromMolfile(molfile);
    expect(depiction.atoms).toMatchObject([{ element: "C", isotope: 13 }, { element: "D" }]);
    const molecule = createSmilesMolecule(
      createEmptyDocument(), { x: 100, y: 100 }, depiction, "[13CH3][2H]"
    );
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    expect(molecule.atoms).toMatchObject([{ element: "C", isotope: 13 }, { element: "D" }]);
    expect(molecule.chemistry?.formula).toBe("[13C]H3D");
  });

  it("exports current isotope atoms instead of stale stored SMILES without an engine", async () => {
    const molecule = createSmilesMolecule(createEmptyDocument(), { x: 100, y: 100 }, {
      atoms: [{ element: "C", isotope: 13, x: 0, y: 0, charge: 0 }], bonds: []
    }, "C");
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    expect(await moleculeSmiles({ ...molecule, structureFormat: "smiles", structure: "C" }, 0, [], undefined))
      .toBe("[13CH4]");
  });
});
