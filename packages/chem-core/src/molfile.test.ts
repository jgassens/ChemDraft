import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { describe, expect, it } from "vitest";
import { ensureRdkit, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { isDativeBond, isMetalSymbol, UnknownBondOrderError } from "./index";
import { moleculeToMolfileV2000, moleculeToMolfileV3000 } from "./molfile";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";
import { nativeBondOrderResolution } from "../../layout-engine/src/index";
import { testMoleculeFromSmiles } from "../../layout-engine/src/testing";

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
    const mf = moleculeToMolfileV2000(chiral, { kekuleBondOrders: new Map() }).contents;
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
    const counts = moleculeToMolfileV2000(flat, { kekuleBondOrders: new Map() }).contents.split("\n").find((l) => l.includes("V2000")) as string;
    expect(counts).toMatch(/^\s{2}2\s{2}1\s{2}0\s{2}0\s{2}0\s/); // chiral=0
  });

  it("preserves atom order and element symbols", () => {
    const lines = atomLines(moleculeToMolfileV2000(chiral, { kekuleBondOrders: new Map() }).contents);
    expect(lines[0]).toContain("C  ");
    expect(lines[1]).toContain("F  ");
    expect(lines[2]).toContain("Cl ");
    expect(lines[3]).toContain("Br ");
  });

  it("encodes the wedge as a bond stereo flag 1 at the narrow end (fromAtomId first)", () => {
    const mf = moleculeToMolfileV2000(chiral, { kekuleBondOrders: new Map() }).contents;
    // bond b1: a0(1) -> a1(2), single(1), wedge(1)
    expect(mf).toMatch(/\n\s{2}1\s{2}2\s{2}1\s{2}1\s{2}0/);
  });

  it("negates y only under fromDocFrame, leaving x and styles untouched", () => {
    const math = atomLines(moleculeToMolfileV2000(chiral, { kekuleBondOrders: new Map() }).contents);
    const doc = atomLines(moleculeToMolfileV2000(chiral, { kekuleBondOrders: new Map(), fromDocFrame: true }).contents);
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
    const mf = moleculeToMolfileV2000(ion, { kekuleBondOrders: new Map() }).contents;
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
    const mf = moleculeToMolfileV2000(radical, { kekuleBondOrders: new Map() }).contents;
    expect(mf).toMatch(/M {2}RAD {2}1 {3}1 {3}2/);
  });

  it("uses the triplet code for two unpaired electrons on the same atom", () => {
    const carbene = molecule([{ id: "a0", element: "C", x: 0, y: 0, markRadicals: 2 }], []);
    const mf = moleculeToMolfileV2000(carbene, { kekuleBondOrders: new Map() }).contents;
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
    expect(moleculeToMolfileV2000(flat, { kekuleBondOrders: new Map() }).contents).not.toContain("M  RAD");
  });
});

describe("moleculeToMolfileV3000 — radicals and charges", () => {
  it("appends RAD= to the atom line for a drawn radical", () => {
    const radical = molecule([{ id: "a0", element: "C", x: 0, y: 0, markRadicals: 1 }], []);
    const mf = moleculeToMolfileV3000(radical, { kekuleBondOrders: new Map() }).contents;
    expect(mf).toContain("RAD=2");
  });

  it("appends both CHG= and RAD= when an atom carries both", () => {
    const radicalCation = molecule([{ id: "a0", element: "N", x: 0, y: 0, charge: 1, markRadicals: 1 }], []);
    const mf = moleculeToMolfileV3000(radicalCation, { kekuleBondOrders: new Map() }).contents;
    expect(mf).toContain("CHG=1");
    expect(mf).toContain("RAD=2");
  });

  it("omits RAD= for a non-radical atom", () => {
    const flat = molecule([{ id: "a0", element: "C", x: 0, y: 0 }], []);
    expect(moleculeToMolfileV3000(flat, { kekuleBondOrders: new Map() }).contents).not.toContain("RAD=");
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
    expect(moleculeToMolfileV3000(amine, { kekuleBondOrders: new Map() }).contents).toContain("M  V30 2 9 2 3\n");
  });

  it.each([["N", "O"], ["Zn", "Fe"]])("keeps the drawn order for a dashed %s–%s bond", (first, second) => {
    const graph = molecule(
      [{ id: "a", element: first, x: 0, y: 0 }, { id: "b", element: second, x: 1, y: 0 }],
      [{ id: "b1", from: "b", to: "a", style: "dashed" }]
    );
    expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map() }).contents).toContain("M  V30 1 9 2 1\n");
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
    const mf = moleculeToMolfileV3000(dative, { kekuleBondOrders: new Map(), warnings }).contents;
    // Bond line: index 1, type 9, atoms 1-2 — so a CTfile-aware reader restores the dative bond.
    expect(mf).toMatch(/M {2}V30 1 9 1 2\n/);
    expect(warnings).toEqual([]);
  });

  it("V2000 has no coordination type: it flattens to a single bond and says so", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV2000(dative, { kekuleBondOrders: new Map(), warnings }).contents;
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

    expect(moleculeToMolfileV3000(dashedDouble, { kekuleBondOrders: new Map(), warnings }).contents).toMatch(/M {2}V30 1 2 1 2\n/);
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

    expect(moleculeToMolfileV2000(dashedDouble, { kekuleBondOrders: new Map(), warnings }).contents).toMatch(/\n\s{2}1\s{2}2\s{2}2\s{2}0/);
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
    expect(moleculeToMolfileV3000(plain, { kekuleBondOrders: new Map(), warnings }).contents).toMatch(/M {2}V30 1 1 1 2\n/);
    expect(moleculeToMolfileV2000(plain, { kekuleBondOrders: new Map(), warnings }).contents).toMatch(/\n\s{2}1\s{2}2\s{2}1\s{2}0/);
    expect(warnings).toEqual([]);
  });

  it.each([moleculeToMolfileV2000, moleculeToMolfileV3000])("names any-bond encoding for dashed unknown order", (write) => {
    const unknown = molecule(
      [{ id: "a", element: "C", x: 0, y: 0 }, { id: "b", element: "C", x: 1, y: 0 }],
      [{ id: "b1", from: "a", to: "b", order: "unknown", style: "dashed" }]
    );
    const warnings: string[] = [];
    write(unknown, { warnings, kekuleBondOrders: new Map() });
    expect(warnings).toEqual([
      "Bond b1 has an unknown bond order; written as bond type 8 (any), which readers treat as a query bond with no chemical order.",
      "Dashed display on an unknown bond is not a coordination bond; written as bond type 8 (any), dashed style not preserved."
    ]);
  });
});

describe.each([moleculeToMolfileV2000, moleculeToMolfileV3000])("unknown bond orders: %s", (write) => {
  const graph = molecule(
    [{ id: "a1", element: "C", x: 0, y: 0 }, { id: "a2", element: "C", x: 1.5, y: 0 }, { id: "a3", element: "O", x: 3, y: 0 }],
    [{ id: "b3", from: "a1", to: "a2", order: "unknown" }, { id: "b7", from: "a2", to: "a3", order: "unknown" }]
  );
  it("writes type 8, warns once with all ids, and round-trips unknown orders", () => {
    const collector: string[] = [];
    const result = write(graph, { kekuleBondOrders: new Map(), warnings: collector });
    expect(result.warnings).toEqual([
      "Bonds b3, b7 have an unknown bond order; written as bond type 8 (any), which readers treat as a query bond with no chemical order."
    ]);
    expect(collector).toEqual(result.warnings);
    if (write === moleculeToMolfileV2000) {
      expect(result.contents).toContain("  1  2  8  0");
      expect(result.contents).toContain("  2  3  8  0");
    } else {
      expect(result.contents).toContain("M  V30 1 8 1 2\n");
      expect(result.contents).toContain("M  V30 2 8 2 3\n");
    }
    expect(parseMolfileGraph(result.contents).bonds.map((bond) => bond.order)).toEqual(["unknown", "unknown"]);
  });

  it.each([false, true])("omits literal valence on unknown contact, including a known single bond (%s)", (withSingle) => {
    const graph = molecule(
      [
        { id: "n", element: "N", x: 0, y: 0, labelLiteral: true },
        { id: "c", element: "C", x: 1.5, y: 0, labelLiteral: true },
        { id: "o", element: "O", x: -1.5, y: 0, labelLiteral: true },
        { id: "h", element: "H", x: -3, y: 0, labelLiteral: true }
      ],
      [
        { id: "unknown", from: "n", to: "c", order: "unknown" },
        ...(withSingle ? [{ id: "single", from: "n", to: "o" }] : []),
        { id: "oh", from: "o", to: "h" }
      ]
    );
    const options = { kekuleBondOrders: new Map<string, number>() };
    const result = write(graph, options);
    const known = write({ ...graph, bonds: graph.bonds.map((bond) => ({ ...bond, order: "single" })) }, options);
    const lines = (contents: string) => write === moleculeToMolfileV2000
      ? atomLines(contents)
      : contents.split("M  V30 BEGIN ATOM\n")[1]!.split("M  V30 END ATOM")[0]!.trimEnd().split("\n");
    const emitted = lines(result.contents);
    for (const index of [0, 1]) {
      if (write === moleculeToMolfileV2000) expect(emitted[index]!.slice(48, 51)).toBe("  0");
      else expect(emitted[index]).not.toContain("VAL=");
    }
    // Literal O and H do not touch the query bond, so their complete atom records stay identical.
    expect(emitted.slice(2)).toEqual(lines(known.contents).slice(2));
    if (write === moleculeToMolfileV2000) {
      expect(emitted[2]!.slice(48, 51)).toBe(withSingle ? "  2" : "  1");
      expect(emitted[3]!.slice(48, 51)).toBe("  1");
    } else {
      expect(emitted[2]).toContain(withSingle ? "VAL=2" : "VAL=1");
      expect(emitted[3]).toContain("VAL=1");
    }
    expect(result.warnings).toContain(
      "Literal atoms c, n have an unknown-order bond; written without a valence field, so a reader may add hydrogens."
    );
  });

  it.each(["dummy", "rgroup"] as const)("keeps CH3 on an unknown bond on the %s placeholder path with a reason", (abbreviations) => {
    const graph = molecule(
      [{ id: "label", element: "CH3", x: 0, y: 0 }, { id: "c", element: "C", x: 1.5, y: 0 }],
      [{ id: "unknown", from: "label", to: "c", order: "unknown" }]
    );
    const result = write(graph, {
      kekuleBondOrders: new Map(), abbreviations,
      spellLabel: (label) => label === "CH3" ? { element: "C", hydrogens: 3 } : undefined
    });
    const placeholder = abbreviations === "dummy" ? "*" : "R#";
    if (write === moleculeToMolfileV2000) {
      expect(atomLines(result.contents)[0]!.slice(31, 34).trim()).toBe(placeholder);
      expect(atomLines(result.contents)[0]!.slice(48, 51)).toBe("  0");
    } else {
      expect(result.contents).toContain(`M  V30 1 ${placeholder} `);
      expect(result.contents).not.toContain("VAL=");
    }
    expect(result.warnings).toContainEqual(expect.stringContaining(
      'Atom label "CH3" is not an element symbol; it cannot be written as C because it has an unknown-order bond, so the hydrogen count it states cannot be carried by an explicit valence'
    ));
    expect(result.warnings).toContainEqual(expect.stringContaining(
      abbreviations === "dummy" ? "written as a dummy atom (*)" : "written as R-group placeholder R1"
    ));
  });
  it.each([["b3"], ["b3", "b7"]])("refuses before emitting output or warnings: %j", (...ids) => {
    const target = { ...graph, bonds: graph.bonds.filter((bond) => ids.includes(bond.id)) };
    const warnings: string[] = [];
    const call = () => write(target, { kekuleBondOrders: new Map(), unknownBondOrders: "refuse", warnings });
    expect(call).toThrow(UnknownBondOrderError);
    expect(call).toThrow(ids.length === 1 ? "Bond b3 has an unknown bond order." : "Bonds b3, b7 have an unknown bond order.");
    try { call(); } catch (error) { expect((error as UnknownBondOrderError).bondIds).toEqual(ids); }
    expect(warnings).toEqual([]);
  });
  it("does not warn or refuse a known-order molecule", () => {
    expect(write(chiral, { kekuleBondOrders: new Map(), unknownBondOrders: "refuse" }).warnings).toEqual([]);
  });
});

describe("molfile element symbols", () => {
  it.each(["D", "T"])("writes the CTfile isotope symbol %s verbatim in both formats", (element) => {
    const graph = molecule([{ id: "a", element, x: 0, y: 0 }], []);
    const warnings: string[] = [];
    expect(atomLines(moleculeToMolfileV2000(graph, { kekuleBondOrders: new Map(), warnings }).contents)[0].slice(31, 34)).toBe(element.padEnd(3));
    expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map(), warnings }).contents).toContain(`M  V30 1 ${element} `);
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
    const literal = atomLines(moleculeToMolfileV2000(literalNitrogen(true), { kekuleBondOrders: new Map() }).contents)[0];
    const ordinary = atomLines(moleculeToMolfileV2000(literalNitrogen(false), { kekuleBondOrders: new Map() }).contents)[0];
    expect(literal.slice(48, 51)).toBe("  1");
    expect(ordinary.slice(48, 51)).toBe("  0");
    expect(literal.slice(0, 48) + literal.slice(51)).toBe(ordinary.slice(0, 48) + ordinary.slice(51));
    expect(moleculeToMolfileV3000(literalNitrogen(true), { kekuleBondOrders: new Map() }).contents).toContain("M  V30 1 N 0 0 0 0 VAL=1\n");
    expect(moleculeToMolfileV3000(literalNitrogen(false), { kekuleBondOrders: new Map() }).contents).not.toContain("VAL=");
  });

  it("uses the format's zero-valence sentinel for an unbonded literal element", () => {
    expect(atomLines(moleculeToMolfileV2000(literalNitrogen(true, false), { kekuleBondOrders: new Map() }).contents)[0].slice(48, 51)).toBe(" 15");
    expect(moleculeToMolfileV3000(literalNitrogen(true, false), { kekuleBondOrders: new Map() }).contents).toContain(" VAL=-1\n");
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
    expect(atomLines(moleculeToMolfileV2000(graph, { kekuleBondOrders: new Map() }).contents)[0].slice(48, 51)).toBe("  3");
    expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map() }).contents).toContain("M  V30 1 N 0 0 0 0 VAL=3\n");
  });

  it("counts a V3000 dative bond only at its acceptor when setting literal valence", () => {
    const graph = literalNitrogen(true);
    graph.atoms.push({ id: "zn", element: "Zn", x: 3, y: 0, formalCharge: 2, labelLiteral: true });
    graph.bonds.push({ id: "zn", fromAtomId: "zn", toAtomId: "n", order: "single", display: { bondStyle: "dashed" } });
    expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map() }).contents).toContain("M  V30 1 N 0 0 0 0 VAL=1\n");
    expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map() }).contents).toContain("M  V30 3 Zn 3 0 0 0 CHG=2 VAL=1\n");
    // V2000 has already warned that this becomes a covalent single bond.
    expect(atomLines(moleculeToMolfileV2000(graph, { kekuleBondOrders: new Map() }).contents)[0].slice(48, 51)).toBe("  2");
  });

  it("omits a literal atom's valence on an aromatic bond with no Kekulé order, and says so", () => {
    // An aromatic bond is single or double depending on its ring's Kekulé pattern, which chem-core
    // cannot work out. It used to count 1.5, which omitted this field only because 1.5 is not an
    // integer — and wrote a wrong integer whenever two aromatic bonds met (a furan O read 3).
    const graph = literalNitrogen(true);
    graph.bonds[0].order = "aromatic";
    const warnings: string[] = [];
    const v2000 = moleculeToMolfileV2000(graph, { kekuleBondOrders: new Map(), warnings }).contents;
    expect(atomLines(v2000)[0].slice(48, 51)).toBe("  0");
    expect(v2000).toContain("  1  2  4  0");
    expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map(), warnings }).contents).not.toContain("VAL=");
    expect(warnings).toEqual(Array(2).fill(
      "Aromatic bonds at atoms c, n have no resolved Kekulé order; preserved as type 4 (aromatic). Literal atoms n are written without a valence field, so a reader may add hydrogens."
    ));
  });

  describe("literal atoms on aromatic rings count the supplied Kekulé orders", () => {
    // Furan drawn with aromatic (type-4) bonds, every atom text-typed: O1 C2 C3 C4 C5.
    const furan = molecule(
      [
        { id: "o1", element: "O", x: 0, y: 0, labelLiteral: true },
        { id: "c2", element: "C", x: 1, y: 0, labelLiteral: true },
        { id: "c3", element: "C", x: 1.3, y: 1, labelLiteral: true },
        { id: "c4", element: "C", x: 0.5, y: 1.6 },
        { id: "c5", element: "C", x: -0.3, y: 1 }
      ],
      [
        { id: "f1", from: "o1", to: "c2", order: "aromatic" },
        { id: "f2", from: "c2", to: "c3", order: "aromatic" },
        { id: "f3", from: "c3", to: "c4", order: "aromatic" },
        { id: "f4", from: "c4", to: "c5", order: "aromatic" },
        { id: "f5", from: "c5", to: "o1", order: "aromatic" }
      ]
    );
    const kekuleBondOrders = new Map([["f1", 1], ["f2", 2], ["f3", 1], ["f4", 2], ["f5", 1]]);

    it("gives the ring oxygen 2 and ring carbon 3, writing the resolved bond orders too", () => {
      const warnings: string[] = [];
      const v2000 = moleculeToMolfileV2000(furan, { warnings, kekuleBondOrders }).contents;
      const lines = atomLines(v2000);
      expect(lines[0].slice(48, 51)).toBe("  2");
      expect(lines[1].slice(48, 51)).toBe("  3");
      expect(lines[2].slice(48, 51)).toBe("  3");
      expect(lines[3].slice(48, 51)).toBe("  0");
      expect(v2000.split("\n").slice(9, 14).map((line) => Number(line.slice(6, 9)))).toEqual([1, 2, 1, 2, 1]);
      const v3000 = moleculeToMolfileV3000(furan, { warnings, kekuleBondOrders }).contents;
      expect(v3000).toContain("M  V30 1 O 0 0 0 0 VAL=2\n");
      expect(v3000).toContain("M  V30 2 C 1 0 0 0 VAL=3\n");
      expect(warnings).toEqual([]);
    });

    it("gives a fused carbon with three aromatic bonds 4, which 1.5 per bond could not write at all", () => {
      const fused = molecule(
        [
          { id: "j", element: "C", x: 0, y: 0, labelLiteral: true },
          { id: "a", element: "C", x: 1, y: 0 },
          { id: "b", element: "C", x: -1, y: 0 },
          { id: "c", element: "C", x: 0, y: 1 }
        ],
        [
          { id: "ja", from: "j", to: "a", order: "aromatic" },
          { id: "jb", from: "j", to: "b", order: "aromatic" },
          { id: "jc", from: "j", to: "c", order: "aromatic" }
        ]
      );
      const warnings: string[] = [];
      const orders = new Map([["ja", 1], ["jb", 2], ["jc", 1]]);
      expect(atomLines(moleculeToMolfileV2000(fused, { warnings, kekuleBondOrders: orders }).contents)[0].slice(48, 51)).toBe("  4");
      expect(warnings).toEqual([]);
    });

    it("drops only the atoms whose aromatic bonds the map leaves out", () => {
      const warnings: string[] = [];
      const partial = new Map([["f2", 2], ["f3", 1], ["f4", 2]]);
      const lines = atomLines(moleculeToMolfileV2000(furan, { warnings, kekuleBondOrders: partial }).contents);
      expect(lines[0].slice(48, 51)).toBe("  0");
      expect(lines[1].slice(48, 51)).toBe("  0");
      expect(lines[2].slice(48, 51)).toBe("  3");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no resolved Kekulé order; preserved as type 4");
      expect(warnings[0]).toContain("Literal atoms c2, o1");
    });
  });

  it("leaves non-element literal labels on the dummy and R-group paths", () => {
    const graph = molecule([{ id: "label", element: "SO3", x: 0, y: 0, labelLiteral: true }], []);
    for (const abbreviations of ["dummy", "rgroup"] as const) {
      const warnings: string[] = [];
      expect(atomLines(moleculeToMolfileV2000(graph, { kekuleBondOrders: new Map(), abbreviations, warnings }).contents)[0].slice(48, 51)).toBe("  0");
      expect(moleculeToMolfileV3000(graph, { kekuleBondOrders: new Map(), abbreviations, warnings }).contents).not.toContain("VAL=");
      expect(warnings).toHaveLength(2);
    }
  });

  it("does not add hydrogens to literal N when RDKit reads either format", async () => {
    installRealRdkitModuleLoader();
    try {
      const rdkit = await ensureRdkit();
      for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
        const parsed = rdkit.get_mol(write(literalNitrogen(true), { kekuleBondOrders: new Map() }).contents);
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

describe("resolved aromatic MOL export", () => {
  it.each([moleculeToMolfileV2000, moleculeToMolfileV3000])("%s reports separate unresolved rings joined by a single bond once each", (write) => {
    const graph = { ...molecule([], []), ...testMoleculeFromSmiles("c1cccc1-c2cccc2") };
    const result = write(graph, { kekuleBondOrders: new Map() });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("atoms a0, a1, a2, a3, a4");
    expect(result.warnings[1]).toContain("atoms a5, a6, a7, a8, a9");
    expect(parseMolfileGraph(result.contents).bonds.filter((bond) => bond.order === "aromatic")).toHaveLength(10);
  });
  it.each([moleculeToMolfileV2000, moleculeToMolfileV3000])("%s is readable by RDKit and preserves the stated methylimidazole tautomer", async (write) => {
    const graph = { ...molecule([], []), ...testMoleculeFromSmiles("Cc1cnc[nH]1") };
    const before = structuredClone(graph);
    const warnings: string[] = [];
    const kekuleBondOrders = nativeBondOrderResolution(graph.atoms, graph.bonds).kekuleOrders;
    const block = write(graph, { warnings, kekuleBondOrders }).contents;
    expect(warnings).toEqual([]);
    expect(graph).toEqual(before);
    installRealRdkitModuleLoader();
    try {
      const rdkit = await ensureRdkit();
      const reference = rdkit.get_mol("Cc1cnc[nH]1");
      const parsed = rdkit.get_mol(block);
      try {
        expect(parsed).toBeTruthy();
        expect(parsed!.get_smiles!()).toBe(reference!.get_smiles!());
      } finally {
        reference?.delete();
        parsed?.delete();
      }
    } finally {
      resetRdkitForTesting();
    }
  });

  it.each([moleculeToMolfileV2000, moleculeToMolfileV3000])("%s warns for unresolved aromatic bonds even without literal atoms", (write) => {
    const graph = { ...molecule([], []), ...testMoleculeFromSmiles("c1cccc1") };
    // No collector argument: the writer must still return the warning.
    const result = write(graph, { kekuleBondOrders: nativeBondOrderResolution(graph.atoms, graph.bonds).kekuleOrders });
    expect(result.warnings).toEqual([
      "Aromatic bonds at atoms a0, a1, a2, a3, a4 have no resolved Kekulé order; preserved as type 4 (aromatic)."
    ]);
    const parsed = parseMolfileGraph(result.contents);
    expect(parsed.bonds.map((bond) => bond.order)).toEqual(Array(5).fill("aromatic"));
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
    const kekuleBondOrders = new Map<string, number>();
    const lines = moleculeToMolfileV2000(condensed, { warnings, spellLabel, kekuleBondOrders }).contents.split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    const [, methyl, acid] = lines.slice(countsLine + 1, countsLine + 4);
    // Two bonds plus three hydrogens: a valence of 5, in the vvv columns 49–51.
    expect(methyl!.slice(31, 34).trim()).toBe("C");
    expect(methyl!.slice(48, 51).trim()).toBe("5");
    // A label spellLabel does not spell still falls back, with its warning.
    expect(acid!.slice(31, 34).trim()).toBe("*");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"CO2H"');

    const v3000 = moleculeToMolfileV3000(condensed, { spellLabel, kekuleBondOrders }).contents;
    expect(v3000).toMatch(/M {2}V30 2 C [^\n]* VAL=5/);
  });

  // The app's condensed-label grammar reduced to what these cases need: one heavy element, then H
  // with an optional count.
  const spellCondensed = (label: string) => {
    const match = /^([A-Z][a-z]?)H(\d*)$/.exec(label);
    return match ? { element: match[1]!, hydrogens: match[2] ? Number(match[2]) : 1 } : undefined;
  };

  const aromaticPyrrole = molecule(
    [
      { id: "n", element: "NH", x: 0, y: 0 },
      { id: "c1", element: "C", x: 1, y: 0.5 },
      { id: "c2", element: "C", x: 1, y: 1.5 },
      { id: "c3", element: "C", x: -1, y: 1.5 },
      { id: "c4", element: "C", x: -1, y: 0.5 }
    ],
    [
      { id: "b1", from: "n", to: "c1", order: "aromatic" },
      { id: "b2", from: "c1", to: "c2", order: "aromatic" },
      { id: "b3", from: "c2", to: "c3", order: "aromatic" },
      { id: "b4", from: "c3", to: "c4", order: "aromatic" },
      { id: "b5", from: "c4", to: "n", order: "aromatic" }
    ]
  );

  it("spells an aromatic pyrrole's NH on its Kekulé orders, with a valence of 3", () => {
    // 1.5 per aromatic bond summed to 4 here, which a reader takes as NH2; the Kekulé orders say 3.
    const kekuleBondOrders = nativeBondOrderResolution(aromaticPyrrole.atoms, aromaticPyrrole.bonds).kekuleOrders;
    const warnings: string[] = [];
    const lines = moleculeToMolfileV2000(aromaticPyrrole, {
      warnings, spellLabel: spellCondensed, abbreviations: "rgroup", kekuleBondOrders
    }).contents.split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    const nitrogen = lines[countsLine + 1]!;
    expect(nitrogen.slice(31, 34).trim()).toBe("N");
    expect(nitrogen.slice(48, 51).trim()).toBe("3");
    expect(warnings).toEqual([]);
    expect(moleculeToMolfileV3000(aromaticPyrrole, { spellLabel: spellCondensed, kekuleBondOrders }).contents)
      .toMatch(/M {2}V30 1 N [^\n]* VAL=3/);
  });

  it("does not spell a label on an aromatic bond with no resolved Kekulé order", () => {
    const warnings: string[] = [];
    const lines = moleculeToMolfileV2000(aromaticPyrrole, {
      warnings, spellLabel: spellCondensed, abbreviations: "rgroup", kekuleBondOrders: new Map()
    }).contents.split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    const nitrogen = lines[countsLine + 1]!;
    expect(nitrogen.slice(31, 34).trim()).toBe("R#");
    expect(nitrogen.slice(48, 51).trim()).toBe("0");
    const labelWarnings = warnings.filter((warning) => warning.includes('"NH"'));
    expect(labelWarnings).toHaveLength(1);
    expect(labelWarnings[0]).toContain("no resolved Kekulé order");

    const v3000Warnings: string[] = [];
    const v3000 = moleculeToMolfileV3000(aromaticPyrrole, {
      warnings: v3000Warnings, spellLabel: spellCondensed, abbreviations: "rgroup", kekuleBondOrders: new Map()
    }).contents;
    expect(v3000).toContain("M  V30 1 R# ");
    expect(v3000).not.toContain("VAL=");
    expect(v3000Warnings.some((warning) => warning.includes('"NH"') && warning.includes("no resolved Kekulé order"))).toBe(true);
  });

  it("does not spell a label whose bond orders and hydrogens pass the valence field's limit of 14", () => {
    const overfull = molecule(
      [
        { id: "a0", element: "C", x: 0, y: 0 },
        { id: "a1", element: "CH20", x: 1.5, y: 0 }
      ],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    const warnings: string[] = [];
    const lines = moleculeToMolfileV2000(overfull, {
      warnings, spellLabel: spellCondensed, abbreviations: "rgroup", kekuleBondOrders: new Map()
    }).contents.split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    expect(lines[countsLine + 2]!.slice(31, 34).trim()).toBe("R#");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("21");
    expect(warnings[0]).toContain("14");
  });

  it("still spells a Kekulé pyrrole's NH, with a valence of 3", () => {
    const kekule = molecule(
      [
        { id: "n", element: "NH", x: 0, y: 0 },
        { id: "c1", element: "C", x: 1, y: 0.5 },
        { id: "c2", element: "C", x: 1, y: 1.5 },
        { id: "c3", element: "C", x: -1, y: 1.5 },
        { id: "c4", element: "C", x: -1, y: 0.5 }
      ],
      [
        { id: "b1", from: "n", to: "c1" },
        { id: "b2", from: "c1", to: "c2", order: "double" },
        { id: "b3", from: "c2", to: "c3" },
        { id: "b4", from: "c3", to: "c4", order: "double" },
        { id: "b5", from: "c4", to: "n" }
      ]
    );
    const warnings: string[] = [];
    const kekuleBondOrders = new Map<string, number>();
    const lines = moleculeToMolfileV2000(kekule, {
      warnings, spellLabel: spellCondensed, abbreviations: "rgroup", kekuleBondOrders
    }).contents.split("\n");
    const countsLine = lines.findIndex((l) => l.includes("V2000"));
    const nitrogen = lines[countsLine + 1]!;
    expect(nitrogen.slice(31, 34).trim()).toBe("N");
    expect(nitrogen.slice(48, 51).trim()).toBe("3");
    expect(warnings).toEqual([]);
    expect(moleculeToMolfileV3000(kekule, { spellLabel: spellCondensed, kekuleBondOrders }).contents)
      .toMatch(/M {2}V30 1 N [^\n]* VAL=3/);
  });

  it("V2000 writes a dummy atom with a warning instead of an invalid element symbol", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV2000(condensed, { kekuleBondOrders: new Map(), warnings }).contents;
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
    const mf = moleculeToMolfileV2000(condensed, { kekuleBondOrders: new Map() }).contents;
    const countsLine = mf.split("\n").findIndex((l) => l.includes("V2000"));
    const atomLines = mf.split("\n").slice(countsLine + 1, countsLine + 4);
    const widths = new Set(atomLines.map((line) => line.length));
    expect(widths.size).toBe(1);
  });

  it("V3000 writes the dummy atom and warns the same way", () => {
    const warnings: string[] = [];
    const mf = moleculeToMolfileV3000(condensed, { kekuleBondOrders: new Map(), warnings }).contents;
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
    const mf = moleculeToMolfileV2000(repeated, { kekuleBondOrders: new Map(), warnings, abbreviations: "rgroup" }).contents;
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
    const mf = moleculeToMolfileV3000(repeated, { kekuleBondOrders: new Map(), abbreviations: "rgroup" }).contents;
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
    const mf = moleculeToMolfileV2000(starred, { kekuleBondOrders: new Map(), abbreviations: "rgroup" }).contents;
    expect(mf).not.toContain(" *  ");
    expect(mf.split("\n")).toContain("M  RGP  2   2   1   3   2");
    // Default (export) mode still writes the dummy as itself.
    expect(moleculeToMolfileV2000(starred, { kekuleBondOrders: new Map() }).contents).toContain(" *  ");
  });

  it("writes no RGP table when every label is an element, in either mode", () => {
    const plain = molecule(
      [{ id: "a0", element: "C", x: 0, y: 0 }, { id: "a1", element: "N", x: 1.5, y: 0 }],
      [{ id: "b1", from: "a0", to: "a1" }]
    );
    expect(moleculeToMolfileV2000(plain, { kekuleBondOrders: new Map(), abbreviations: "rgroup" }).contents).toBe(moleculeToMolfileV2000(plain, { kekuleBondOrders: new Map() }).contents);
    expect(moleculeToMolfileV2000(plain, { kekuleBondOrders: new Map() }).contents).not.toContain("RGP");
  });
});
