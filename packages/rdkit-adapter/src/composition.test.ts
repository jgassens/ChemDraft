import { describe, expect, it } from "vitest";

import {
  compositionFromRdkitJson,
  connectedComponents,
  elementSymbol,
  hillFormula,
  type RdkitJson
} from "./composition";

/** RDKit writes atom fields only where they differ from `defaults`, so the fixtures below do too. */
function json(atoms: RdkitJson["molecules"][number]["atoms"], bonds: RdkitJson["molecules"][number]["bonds"] = []): RdkitJson {
  return {
    defaults: { atom: { z: 6, impHs: 0, chg: 0, nRad: 0, isotope: 0 }, bond: { bo: 1 } },
    molecules: [{ atoms, bonds }]
  };
}

describe("elementSymbol", () => {
  it("maps atomic numbers to IUPAC symbols", () => {
    expect(elementSymbol(1)).toBe("H");
    expect(elementSymbol(6)).toBe("C");
    expect(elementSymbol(11)).toBe("Na");
    expect(elementSymbol(78)).toBe("Pt");
    expect(elementSymbol(118)).toBe("Og");
  });

  it("throws rather than inventing a symbol", () => {
    // Atomic number 0 is deliberately NOT in here any more: it is a dummy atom, not a missing
    // element, and throwing on it rejected every method in the run. See the dummy-atom test below.
    expect(() => elementSymbol(500)).toThrowError(/No element symbol/);
  });
});

describe("hillFormula", () => {
  it("puts carbon first, hydrogen second, then everything alphabetically", () => {
    expect(
      hillFormula([
        { symbol: "O", count: 4 },
        { symbol: "H", count: 8 },
        { symbol: "C", count: 9 }
      ])
    ).toBe("C9H8O4");
  });

  it("sorts every element alphabetically when there is no carbon", () => {
    // Hydrogen loses its privileged second place the moment carbon is absent — that is the rule, and
    // it is why cisplatin reads Cl2H6N2Pt rather than H6Cl2N2Pt.
    expect(
      hillFormula([
        { symbol: "Pt", count: 1 },
        { symbol: "N", count: 2 },
        { symbol: "H", count: 6 },
        { symbol: "Cl", count: 2 }
      ])
    ).toBe("Cl2H6N2Pt");
  });

  it("omits the count for a single atom", () => {
    expect(hillFormula([{ symbol: "Na", count: 1 }])).toBe("Na");
  });

  it("writes isotope labels before the natural-abundance atoms of the same element", () => {
    expect(
      hillFormula([
        { symbol: "C", count: 1 },
        { symbol: "C", count: 1, isotope: 13 },
        { symbol: "H", count: 4 },
        { symbol: "O", count: 2 }
      ])
    ).toBe("[13C]CH4O2");
  });

  it("orders several labels of one element by ascending mass number", () => {
    expect(
      hillFormula([
        { symbol: "H", count: 1 },
        { symbol: "H", count: 2, isotope: 3 },
        { symbol: "H", count: 3, isotope: 2 }
      ])
    ).toBe("[2H]3[3H]2H");
  });

  it("returns an empty string for an empty tally", () => {
    expect(hillFormula([])).toBe("");
  });
});

describe("connectedComponents", () => {
  it("groups atoms by RDKit's own bond list", () => {
    expect(connectedComponents(4, [{ atoms: [1, 2] }, { atoms: [2, 3] }])).toEqual([[0], [1, 2, 3]]);
  });

  it("treats an unbonded atom as its own component", () => {
    expect(connectedComponents(3, [])).toEqual([[0], [1], [2]]);
  });

  it("orders components by their first atom, so component order follows the drawing", () => {
    const groups = connectedComponents(4, [{ atoms: [0, 3] }, { atoms: [1, 2] }]);
    expect(groups).toEqual([
      [0, 3],
      [1, 2]
    ]);
  });

  it("ignores a bond that references an atom outside the molecule", () => {
    expect(connectedComponents(2, [{ atoms: [0, 9] }])).toEqual([[0], [1]]);
  });
});

describe("compositionFromRdkitJson", () => {
  it("counts implicit hydrogens as protium, never inheriting the heavy atom's label", () => {
    // [13CH3]C(=O)O — the labelled carbon carries three implicit hydrogens, and those hydrogens are
    // ordinary protium. Applying the label to the element's whole tally would invent [13C]H3.
    const composition = compositionFromRdkitJson(
      json(
        [{ impHs: 3, isotope: 13 }, {}, { z: 8 }, { z: 8, impHs: 1 }],
        [{ atoms: [0, 1] }, { bo: 2, atoms: [1, 2] }, { atoms: [1, 3] }]
      )
    );

    expect(composition.formula).toBe("[13C]CH4O2");
    expect(composition.hasExplicitIsotopes).toBe(true);
    expect(composition.elements).toContainEqual({ symbol: "H", count: 4 });
    expect(composition.elements).toContainEqual({ symbol: "C", count: 1, isotope: 13 });
    expect(composition.elements).toContainEqual({ symbol: "C", count: 1 });
  });

  it("keeps a salt's components apart and sums charge across them", () => {
    const composition = compositionFromRdkitJson(
      json(
        [
          { z: 11, chg: 1 },
          { z: 8, chg: -1 },
          {},
          { z: 8 },
          {},
          { impHs: 1 },
          { impHs: 1 },
          { impHs: 1 },
          { impHs: 1 },
          { impHs: 1 }
        ],
        [
          { atoms: [1, 2] },
          { bo: 2, atoms: [2, 3] },
          { atoms: [2, 4] },
          { bo: 2, atoms: [4, 5] },
          { atoms: [5, 6] },
          { bo: 2, atoms: [6, 7] },
          { atoms: [7, 8] },
          { bo: 2, atoms: [8, 9] },
          { atoms: [9, 4] }
        ]
      )
    );

    expect(composition.formula).toBe("C7H5NaO2");
    expect(composition.formalCharge).toBe(0);
    expect(composition.components).toHaveLength(2);
    expect(composition.components[0]).toMatchObject({ formula: "Na", charge: 1, multiplicity: 1, sourceAtomIndices: [0] });
    expect(composition.components[1]).toMatchObject({ formula: "C7H5O2", charge: -1, multiplicity: 1 });
  });

  it("collapses identical components into a multiplicity spanning every copy", () => {
    // N.N.Cl[Pt]Cl reads as "2 × H3N + Cl2Pt", and clicking the ammine row highlights both.
    const composition = compositionFromRdkitJson(
      json(
        [
          { z: 7, impHs: 3 },
          { z: 7, impHs: 3 },
          { z: 17 },
          { z: 78 },
          { z: 17 }
        ],
        [{ atoms: [2, 3] }, { atoms: [3, 4] }]
      )
    );

    expect(composition.formula).toBe("Cl2H6N2Pt");
    expect(composition.components).toHaveLength(2);
    const ammine = composition.components.find((component) => component.formula === "H3N");
    expect(ammine).toMatchObject({ multiplicity: 2, charge: 0, sourceAtomIndices: [0, 1] });
    expect(composition.components.find((component) => component.formula === "Cl2Pt")).toMatchObject({
      multiplicity: 1,
      sourceAtomIndices: [2, 3, 4]
    });
  });

  it("does not collapse components that differ only in charge", () => {
    const composition = compositionFromRdkitJson(json([{ z: 17 }, { z: 17, chg: -1 }], []));
    expect(composition.components).toHaveLength(2);
    expect(composition.formalCharge).toBe(-1);
  });

  it("sums radical electrons and keeps the zwitterion's charges visible per component", () => {
    const zwitterion = compositionFromRdkitJson(
      json(
        [{ z: 7, chg: 1, impHs: 3 }, { impHs: 2 }, {}, { z: 8 }, { z: 8, chg: -1 }],
        [{ atoms: [0, 1] }, { atoms: [1, 2] }, { bo: 2, atoms: [2, 3] }, { atoms: [2, 4] }]
      )
    );
    expect(zwitterion.formula).toBe("C2H5NO2");
    expect(zwitterion.formalCharge).toBe(0);
    // One connected component whose net charge is zero — but the atoms carrying ±1 are still there,
    // which is what separates a zwitterion from a neutral molecule.
    expect(zwitterion.components).toHaveLength(1);

    const radical = compositionFromRdkitJson(json([{ z: 8, nRad: 1 }], []));
    expect(radical.radicalElectronCount).toBe(1);
  });

  it("reports the distinct elements present, for the method element-coverage check", () => {
    const composition = compositionFromRdkitJson(json([{ z: 5 }, { z: 8, impHs: 1 }, { z: 8, impHs: 1 }], [{ atoms: [0, 1] }, { atoms: [0, 2] }]));
    expect(composition.presentElements).toEqual(["B", "H", "O"]);
  });

  it("applies the file-level defaults to atoms that omit every field", () => {
    const composition = compositionFromRdkitJson(json([{}, {}], [{ atoms: [0, 1] }]));
    expect(composition.formula).toBe("C2");
    expect(composition.atomCount).toBe(2);
    expect(composition.bondCount).toBe(1);
  });

  it("throws when the JSON carries no molecule", () => {
    expect(() => compositionFromRdkitJson({ molecules: [] })).toThrowError(/no molecule/);
  });
});

describe("machine-independent ordering and dummy atoms", () => {
  it("orders elements by code unit, not by the reader's OS language", () => {
    // `localeCompare` with no locale argument resolves its collator from the host language. Under
    // Estonian, Z sorts between S and T; under Lithuanian, Y follows I. That made the same molecule
    // render a different formula on different machines, in a string the method contract names as a
    // stated convention. These are the exact pairs that reorder.
    // Estonian: Z between S and T.
    expect(hillFormula([{ symbol: "O", count: 3 }, { symbol: "Ti", count: 1 }, { symbol: "Zn", count: 1 }])).toBe(
      "O3TiZn"
    );
    // Lithuanian: Y directly after I.
    expect(
      hillFormula([
        { symbol: "Ba", count: 2 },
        { symbol: "Cu", count: 3 },
        { symbol: "O", count: 7 },
        { symbol: "Y", count: 1 }
      ])
    ).toBe("Ba2Cu3O7Y");
    // Hungarian: "cs" is a single letter sorting after "c".
    expect(hillFormula([{ symbol: "Cs", count: 2 }, { symbol: "Cu", count: 1 }, { symbol: "Cl", count: 4 }])).toBe(
      "Cl4Cs2Cu"
    );
  });

  it("names a dummy atom instead of rejecting the whole run", () => {
    // Atomic number 0 is an R-group or attachment point, not a missing element. This used to throw,
    // and because composition is built before any method runs, one drawn `*` failed all ~62 methods
    // with "No element symbol for atomic number 0" — including every method that ignores elements.
    expect(elementSymbol(0)).toBe("*");
    const composition = compositionFromRdkitJson(json([{ z: 0 }, { z: 6, impHs: 3 }], [{ atoms: [0, 1] }]));
    expect(composition.formula).toBe("CH3*");
    expect(composition.presentElements).toContain("*");
  });

  it("still refuses an atomic number that is not an element at all", () => {
    expect(() => elementSymbol(119)).toThrowError(/No element symbol/);
    expect(() => elementSymbol(-1)).toThrowError(/No element symbol/);
  });
});
