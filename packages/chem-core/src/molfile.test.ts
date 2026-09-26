import { describe, expect, it } from "vitest";
import { ensureRdkit, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { isDativeBond, isMetalSymbol } from "./index";
import { moleculeToMolfileV2000, moleculeToMolfileV3000 } from "./molfile";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

type AtomSpec = {
  id: string;
  element: string;
  x: number;
  y: number;
  charge?: number;
  markRadicals?: number;
  labelLiteral?: boolean;
};
type BondSpec = { id: string; from: string; to: string; order?: MoleculeBond["order"]; style?: "wedge" | "hashed" | "dashed" };

function molecule(atoms: AtomSpec[], bonds: BondSpec[]): MoleculeObject {
  return {
    id: "mol_1",
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms: atoms.map(
      ({ id, element, x, y, charge = 0, markRadicals, labelLiteral }): MoleculeAtom => ({
        id,
        element,
        x,
        y,
        formalCharge: charge,
        ...(labelLiteral !== undefined ? { labelLiteral } : {}),
        ...(markRadicals !== undefined ? { markRadicals } : {})
      })
    ),
    bonds: bonds.map(
      ({ id, from, to, order = "single", style }): MoleculeBond => ({
        id,
        fromAtomId: from,
        toAtomId: to,
        order,
        ...(style ? { display: { bondStyle: style } } : {})
      })
    ),
    superatoms: [],
    rGroups: []
  };
}

function atomLines(molfile: string): string[] {
  const lines = molfile.split("\n");
  const counts = lines.findIndex((l) => l.includes("V2000"));
  return lines.slice(counts + 1, counts + 1 + 4); // the 4-atom fixtures below
}

const chiral = molecule(
  [
    { id: "a0", element: "C", x: 0, y: 0 },
    { id: "a1", element: "F", x: 1, y: 1 },
    { id: "a2", element: "Cl", x: -1, y: 1 },
    { id: "a3", element: "Br", x: 0, y: -1 }
  ],
  [
    { id: "b1", from: "a0", to: "a1", style: "wedge" },
    { id: "b2", from: "a0", to: "a2" },
    { id: "b3", from: "a0", to: "a3" }
  ]
);

describe("moleculeToMolfileV2000 — structure", () => {
  it("writes a counts line with atom/bond counts and chiral flag set when wedged", () => {
    const mf = moleculeToMolfileV2000(chiral);
    const counts = mf.split("\n").find((l) => l.includes("V2000")) as string;
    expect(counts).toMatch(/^\s{2}4\s{2}3\s{2}0\s{2}0\s{2}1\s/); // 4 atoms, 3 bonds, chiral=1
    expect(mf.trimEnd().endsWith("M  END")).toBe(true);
  });

  it("clears the chiral flag when there is no wedge/hash", () => {
    const flat = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 0, y: 1 }
      ],
      [{ id: "b1", from: "a0", to: "a1", order: "double" }]
    );
    const counts = moleculeToMolfileV2000(flat).split("\n").find((l) => l.includes("V2000")) as string;
    expect(counts).toMatch(/^\s{2}2\s{2}1\s{2}0\s{2}0\s{2}0\s/); // chiral=0
  });

  it("preserves atom order and element symbols", () => {
    const lines = atomLines(moleculeToMolfileV2000(chiral));
    expect(lines[0]).toContain("C  ");
    expect(lines[1]).toContain("F  ");
    expect(lines[2]).toContain("Cl ");
    expect(lines[3]).toContain("Br ");
  });

  it("encodes the wedge as a bond stereo flag 1 at the narrow end (fromAtomId first)", () => {
    const mf = moleculeToMolfileV2000(chiral);
    // bond b1: a0(1) -> a1(2), single(1), wedge(1)
    expect(mf).toMatch(/\n\s{2}1\s{2}2\s{2}1\s{2}1\s{2}0/);
  });

  it("negates y only under fromDocFrame, leaving x and styles untouched", () => {
    const math = atomLines(moleculeToMolfileV2000(chiral));
    const doc = atomLines(moleculeToMolfileV2000(chiral, { fromDocFrame: true }));
    // a1 is at y=1; math frame writes +1.0000, doc frame writes -1.0000.
    expect(math[1]).toContain("1.0000");
    expect(doc[1]).toContain("-1.0000");
    // x column identical between the two.
    expect(math[1].slice(0, 10)).toBe(doc[1].slice(0, 10));
  });

  it("emits an M  CHG line for nonzero formal charges", () => {
    const ion = molecule(
      [
        { id: "a0", element: "N", x: 0, y: 0, charge: 1 },
        { id: "a1", element: "O", x: 1, y: 0, charge: -1 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    const mf = moleculeToMolfileV2000(ion);
    expect(mf).toMatch(/M {2}CHG {2}2 {3}1 {3}1 {3}2 {2}-1/);
  });

  it("emits an M  RAD line for a drawn radical, using the doublet code for one unpaired electron", () => {
    const radical = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0, markRadicals: 1 },
        { id: "a1", element: "C", x: 1, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    const mf = moleculeToMolfileV2000(radical);
    expect(mf).toMatch(/M {2}RAD {2}1 {3}1 {3}2/);
  });

  it("uses the triplet code for two unpaired electrons on the same atom", () => {
    const carbene = molecule([{ id: "a0", element: "C", x: 0, y: 0, markRadicals: 2 }], []);
    const mf = moleculeToMolfileV2000(carbene);
    expect(mf).toMatch(/M {2}RAD {2}1 {3}1 {3}3/);
  });

  it("omits M  RAD entirely when no atom carries an unpaired electron", () => {
    const flat = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 1, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    expect(moleculeToMolfileV2000(flat)).not.toContain("M  RAD");
  });
});

describe("moleculeToMolfileV3000 — radicals and charges", () => {
  it("appends RAD= to the atom line for a drawn radical", () => {
    const radical = molecule([{ id: "a0", element: "C", x: 0, y: 0, markRadicals: 1 }], []);
    const mf = moleculeToMolfileV3000(radical);
    expect(mf).toContain("RAD=2");
  });

  it("appends both CHG= and RAD= when an atom carries both", () => {
    const radicalCation = molecule([{ id: "a0", element: "N", x: 0, y: 0, charge: 1, markRadicals: 1 }], []);
    const mf = moleculeToMolfileV3000(radicalCation);
    expect(mf).toContain("CHG=1");
    expect(mf).toContain("RAD=2");
  });

  it("omits RAD= for a non-radical atom", () => {
    const flat = molecule([{ id: "a0", element: "C", x: 0, y: 0 }], []);
    expect(moleculeToMolfileV3000(flat)).not.toContain("RAD=");
  });
});

describe("dative (dashed) bonds", () => {
  it.each([false, true])("writes the donor before the metal regardless of drawn direction (reversed: %s)", (reversed) => {
    const amine = molecule(
      [
        { id: "c", element: "C", x: 0, y: 0 },
        { id: "n", element: "N", x: 1.5, y: 0 },
        { id: "zn", element: "Zn", x: 3, y: 0, charge: 2 }
      ],
      [
        { id: "cn", from: "c", to: "n" },
        { id: "nz", from: reversed ? "zn" : "n", to: reversed ? "n" : "zn", style: "dashed" }
      ]
    );
    expect(moleculeToMolfileV3000(amine)).toContain("M  V30 2 9 2 3\n");
  });

  it.each([["N", "O"], ["Zn", "Fe"]])("keeps the drawn order for a dashed %s–%s bond", (first, second) => {
    const graph = molecule(
      [{ id: "a", element: first, x: 0, y: 0 }, { id: "b", element: second, x: 1, y: 0 }],
      [{ id: "b1", from: "b", to: "a", style: "dashed" }]
    );
    expect(moleculeToMolfileV3000(graph)).toContain("M  V30 1 9 2 1\n");
  });

  it("exports the shared single-order dative predicate", () => {
    const bond = { id: "b", fromAtomId: "a", toAtomId: "b", order: "single" as const };
    expect(isDativeBond(bond)).toBe(false);
    expect(isDativeBond({ ...bond, display: { bondStyle: "dashed" } })).toBe(true);
    expect(isDativeBond({ ...bond, order: "double", display: { bondStyle: "dashed" } })).toBe(false);
  });

  const dative = molecule(
    [
      { id: "a0", element: "N", x: 0, y: 0 },
      { id: "a1", element: "Zn", x: 1.5, y: 0 }
    ],
    [{ id: "b1", from: "a0", to: "a1", style: "dashed" }]
  );

  it("V3000 writes them as coordination bond type 9 on the same endpoints, without warning", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV3000(dative, { warnings });
    // Bond line: index 1, type 9, atoms 1-2 — so a CTfile-aware reader restores the dative bond.
    expect(mf).toMatch(/M {2}V30 1 9 1 2\n/);
    expect(warnings).toEqual([]);
  });

  it("V2000 has no coordination type: it flattens to a single bond and says so", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV2000(dative, { warnings });
    // bond b1: atoms 1-2, order code 1 (single) — the loss is announced, not silent (§5.7/§14).
    expect(mf).toMatch(/\n\s{2}1\s{2}2\s{2}1\s{2}0/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("V2000 has no coordination bond type");
  });


  it("preserves a dashed double bond's order in V3000 and warns that its display is omitted", () => {
    const dashedDouble = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 1.5, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1", order: "double", style: "dashed" }]
    );
    const warnings: string[] = [];

    expect(moleculeToMolfileV3000(dashedDouble, { warnings })).toMatch(/M {2}V30 1 2 1 2\n/);
    expect(warnings).toEqual([
      "Dashed display on a double bond is not a coordination bond; written as bond type 2 (double), dashed style not preserved."
    ]);
  });

  it("preserves a dashed double bond's order in V2000 without counting it as dative", () => {
    const dashedDouble = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "O", x: 1.5, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1", order: "double", style: "dashed" }]
    );
    const warnings: string[] = [];

    expect(moleculeToMolfileV2000(dashedDouble, { warnings })).toMatch(/\n\s{2}1\s{2}2\s{2}2\s{2}0/);
    expect(warnings).toEqual([
      "Dashed display on a double bond is not a coordination bond; written as bond type 2 (double), dashed style not preserved."
    ]);
    expect(warnings.join(" ")).not.toContain("V2000 has no coordination bond type");
  });

  it("a plain single bond stays type 1 in V3000 and warns about nothing", () => {
    const plain = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "C", x: 1.5, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    const warnings: string[] = [];
    expect(moleculeToMolfileV3000(plain, { warnings })).toMatch(/M {2}V30 1 1 1 2\n/);
    expect(moleculeToMolfileV2000(plain, { warnings })).toMatch(/\n\s{2}1\s{2}2\s{2}1\s{2}0/);
    expect(warnings).toEqual([]);
  });

  it.each([moleculeToMolfileV2000, moleculeToMolfileV3000])("warns that dashed unknown order is actually written as single", (write) => {
    const unknown = molecule(
      [{ id: "a", element: "C", x: 0, y: 0 }, { id: "b", element: "C", x: 1, y: 0 }],
      [{ id: "b1", from: "a", to: "b", order: "unknown", style: "dashed" }]
    );
    const warnings: string[] = [];
    write(unknown, { warnings });
    expect(warnings).toEqual([
      "Dashed display on an unknown bond is not a coordination bond; written as bond type 1 (single), dashed style not preserved."
    ]);
  });
});

describe("molfile element symbols", () => {
  it.each(["D", "T"])("writes the CTfile isotope symbol %s verbatim in both formats", (element) => {
    const graph = molecule([{ id: "a", element, x: 0, y: 0 }], []);
    const warnings: string[] = [];
    expect(atomLines(moleculeToMolfileV2000(graph, { warnings }))[0].slice(31, 34)).toBe(element.padEnd(3));
    expect(moleculeToMolfileV3000(graph, { warnings })).toContain(`M  V30 1 ${element} `);
    expect(warnings).toEqual([]);
  });

  it("recognizes metal families without treating metalloids or other non-metals as metals", () => {
    for (const symbol of ["Li", "Cs", "Be", "Ra", "Sc", "Zn", "Cn", "La", "Lu", "Ac", "Lr", "Al", "Ga", "In", "Sn", "Tl", "Pb", "Bi", "Po"]) {
      expect(isMetalSymbol(symbol), symbol).toBe(true);
    }
    for (const symbol of ["B", "Si", "Ge", "As", "Sb", "Te", "H", "D", "N", "O", "Xe", "Ph", ""]) {
      expect(isMetalSymbol(symbol), symbol).toBe(false);
    }
  });
});

describe("literal element valence", () => {
  const literalNitrogen = (labelLiteral: boolean, bonded = true) => molecule(
    [
      { id: "n", element: "N", x: 0, y: 0, labelLiteral },
      ...(bonded ? [{ id: "c", element: "C", x: 1.5, y: 0 }] : [])
    ],
    bonded ? [{ id: "b1", from: "n", to: "c" }] : []
  );

  it("writes explicit valence only for a literal element, in the exact V2000 column", () => {
    const literal = atomLines(moleculeToMolfileV2000(literalNitrogen(true)))[0];
    const ordinary = atomLines(moleculeToMolfileV2000(literalNitrogen(false)))[0];
    expect(literal.slice(48, 51)).toBe("  1");
    expect(ordinary.slice(48, 51)).toBe("  0");
    expect(literal.slice(0, 48) + literal.slice(51)).toBe(ordinary.slice(0, 48) + ordinary.slice(51));
    expect(moleculeToMolfileV3000(literalNitrogen(true))).toContain("M  V30 1 N 0 0 0 0 VAL=1\n");
    expect(moleculeToMolfileV3000(literalNitrogen(false))).not.toContain("VAL=");
  });

  it("uses the format's zero-valence sentinel for an unbonded literal element", () => {
    expect(atomLines(moleculeToMolfileV2000(literalNitrogen(true, false)))[0].slice(48, 51)).toBe(" 15");
    expect(moleculeToMolfileV3000(literalNitrogen(true, false))).toContain(" VAL=-1\n");
  });

  it("sums multiple bond orders without counting bonds the writer drops", () => {
    const graph = molecule(
      [
        { id: "n", element: "N", x: 0, y: 0, labelLiteral: true },
        { id: "c", element: "C", x: 1.5, y: 0 },
        { id: "o", element: "O", x: -1.5, y: 0 }
      ],
      [
        { id: "nc", from: "n", to: "c" },
        { id: "on", from: "o", to: "n", order: "double" },
        { id: "missing", from: "n", to: "absent" }
      ]
    );
    expect(atomLines(moleculeToMolfileV2000(graph))[0].slice(48, 51)).toBe("  3");
    expect(moleculeToMolfileV3000(graph)).toContain("M  V30 1 N 0 0 0 0 VAL=3\n");
  });

  it("counts a V3000 dative bond only at its acceptor when setting literal valence", () => {
    const graph = literalNitrogen(true);
    graph.atoms.push({ id: "zn", element: "Zn", x: 3, y: 0, formalCharge: 2, labelLiteral: true });
    graph.bonds.push({ id: "zn", fromAtomId: "zn", toAtomId: "n", order: "single", display: { bondStyle: "dashed" } });
    expect(moleculeToMolfileV3000(graph)).toContain("M  V30 1 N 0 0 0 0 VAL=1\n");
    expect(moleculeToMolfileV3000(graph)).toContain("M  V30 3 Zn 3 0 0 0 CHG=2 VAL=1\n");
    // V2000 has already warned that this becomes a covalent single bond.
    expect(atomLines(moleculeToMolfileV2000(graph))[0].slice(48, 51)).toBe("  2");
  });

  it("omits a fractional literal valence with a warning instead of rounding or aborting", () => {
    const graph = literalNitrogen(true);
    graph.bonds[0].order = "aromatic";
    const warnings: string[] = [];
    expect(atomLines(moleculeToMolfileV2000(graph, { warnings }))[0].slice(48, 51)).toBe("  0");
    expect(moleculeToMolfileV3000(graph, { warnings })).not.toContain("VAL=");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Literal atom "N" has a bond-order sum of 1.5');
    expect(warnings[1]).toContain("V3000 valence field cannot hold");
  });

  it("leaves non-element literal labels on the dummy and R-group paths", () => {
    const graph = molecule([{ id: "label", element: "SO3", x: 0, y: 0, labelLiteral: true }], []);
    for (const abbreviations of ["dummy", "rgroup"] as const) {
      const warnings: string[] = [];
      expect(atomLines(moleculeToMolfileV2000(graph, { abbreviations, warnings }))[0].slice(48, 51)).toBe("  0");
      expect(moleculeToMolfileV3000(graph, { abbreviations, warnings })).not.toContain("VAL=");
      expect(warnings).toHaveLength(2);
    }
  });

  it("does not add hydrogens to literal N when RDKit reads either format", async () => {
    installRealRdkitModuleLoader();
    try {
      const rdkit = await ensureRdkit();
      for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
        const parsed = rdkit.get_mol(write(literalNitrogen(true)));
        try {
          expect(parsed?.get_smiles?.()).toBe("C[N]");
        } finally {
          parsed?.delete();
        }
      }
    } finally {
      resetRdkitForTesting();
    }
  });
});

describe("non-element atom labels", () => {
  const condensed = molecule(
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "CH3", x: 1.5, y: 0 },
      { id: "a2", element: "CO2H", x: 3, y: 0 }
    ],
    [
      { id: "b1", from: "a0", to: "a1" },
      { id: "b2", from: "a1", to: "a2" }
    ]
  );

  it("writes a label spellLabel spells as its element, with a valence carrying the stated hydrogens", () => {
    const warnings: string[] = [];
    const spellLabel = (label: string) => (label === "CH3" ? { element: "C", hydrogens: 3 } : undefined);
    const lines = moleculeToMolfileV2000(condensed, { warnings, spellLabel }).split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    const [, methyl, acid] = lines.slice(countsLine + 1, countsLine + 4);
    // Two bonds plus three hydrogens: a valence of 5, in the vvv columns 49–51.
    expect(methyl!.slice(31, 34).trim()).toBe("C");
    expect(methyl!.slice(48, 51).trim()).toBe("5");
    // A label spellLabel does not spell still falls back, with its warning.
    expect(acid!.slice(31, 34).trim()).toBe("*");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"CO2H"');

    const v3000 = moleculeToMolfileV3000(condensed, { spellLabel });
    expect(v3000).toMatch(/M {2}V30 2 C [^\n]* VAL=5/);
  });

  it("V2000 writes a dummy atom with a warning instead of an invalid element symbol", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV2000(condensed, { warnings });
    const countsLine = mf.split("\n").findIndex((l) => l.includes("V2000"));
    const atomLines = mf.split("\n").slice(countsLine + 1, countsLine + 4);
    expect(atomLines[0]).toContain("C  ");
    expect(atomLines[1]).toContain("*  ");
    expect(atomLines[2]).toContain("*  ");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"CH3"');
    expect(warnings[1]).toContain('"CO2H"');
  });

  it("V2000 atom lines stay fixed-width when a four-character label is replaced", () => {
    // "CO2H".padEnd(3) would have overflowed the 3-char element column and shifted every field.
    const mf = moleculeToMolfileV2000(condensed);
    const countsLine = mf.split("\n").findIndex((l) => l.includes("V2000"));
    const atomLines = mf.split("\n").slice(countsLine + 1, countsLine + 4);
    const widths = new Set(atomLines.map((line) => line.length));
    expect(widths.size).toBe(1);
  });

  it("V3000 writes the dummy atom and warns the same way", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV3000(condensed, { warnings });
    expect(mf).toContain("M  V30 2 * ");
    expect(mf).toContain("M  V30 3 * ");
    expect(warnings).toHaveLength(2);
  });

  // Two "CH3" labels and one "CO2H": equal labels share an R-group number, different labels get
  // their own, so a reader that ranks atoms (CIP perception) keeps them apart from each other and
  // from every element — where the dummy "*" reads as a carbon and collapses them all.
  const repeated = molecule(
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "CH3", x: 1.5, y: 0 },
      { id: "a2", element: "CO2H", x: 3, y: 0 },
      { id: "a3", element: "CH3", x: 4.5, y: 0 }
    ],
    [
      { id: "b1", from: "a0", to: "a1" },
      { id: "b2", from: "a1", to: "a2" },
      { id: "b3", from: "a2", to: "a3" }
    ]
  );

  it("V2000 rgroup mode writes R# atoms with an M  RGP table numbered per distinct label", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV2000(repeated, { warnings, abbreviations: "rgroup" });
    const lines = mf.split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    const atomLines = lines.slice(countsLine + 1, countsLine + 5);
    expect(atomLines[0]).toContain(" C  ");
    expect(atomLines[1]).toContain(" R# ");
    expect(atomLines[2]).toContain(" R# ");
    expect(atomLines[3]).toContain(" R# ");
    expect(new Set(atomLines.map((line) => line.length)).size).toBe(1);
    expect(mf).not.toContain("*");
    expect(lines).toContain("M  RGP  3   2   1   3   2   4   1");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("R1");
    expect(warnings[1]).toContain("R2");
    expect(warnings[2]).toContain("R1");
  });

  it("V3000 rgroup mode writes RGROUPS= on the R# atoms", () => {
    const mf = moleculeToMolfileV3000(repeated, { abbreviations: "rgroup" });
    expect(mf).toContain("M  V30 2 R# 1.5 0 0 0 RGROUPS=(1 1)");
    expect(mf).toContain("M  V30 3 R# 3 0 0 0 RGROUPS=(1 2)");
    expect(mf).toContain("M  V30 4 R# 4.5 0 0 0 RGROUPS=(1 1)");
    expect(mf).not.toContain("*");
  });

  it("rgroup mode also turns a literal \"*\" label into an R-group — a pasted dummy atom must not read as a carbon", () => {
    const starred = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "*", x: 1.5, y: 0 },
        { id: "a2", element: "Ph", x: 3, y: 0 }
      ],
      [
        { id: "b1", from: "a0", to: "a1" },
        { id: "b2", from: "a1", to: "a2" }
      ]
    );
    const mf = moleculeToMolfileV2000(starred, { abbreviations: "rgroup" });
    expect(mf).not.toContain(" *  ");
    expect(mf.split("\n")).toContain("M  RGP  2   2   1   3   2");
    // Default (export) mode still writes the dummy as itself.
    expect(moleculeToMolfileV2000(starred)).toContain(" *  ");
  });

  it("writes no RGP table when every label is an element, in either mode", () => {
    const plain = molecule(
      [{ id: "a0", element: "C", x: 0, y: 0 }, { id: "a1", element: "N", x: 1.5, y: 0 }],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    expect(moleculeToMolfileV2000(plain, { abbreviations: "rgroup" })).toBe(moleculeToMolfileV2000(plain));
    expect(moleculeToMolfileV2000(plain)).not.toContain("RGP");
  });
});
