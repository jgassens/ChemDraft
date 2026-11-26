import { beforeAll, describe, expect, it } from "vitest";
import {
  moleculeToMolfileV2000, moleculeToMolfileV3000, type MoleculeAtom, type MoleculeObject
} from "@chemdraft/chem-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { nativeSingleBondGraphMetadata } from "../../document-workflow-core/src/atoms";
import { parseMolfileGraph, type ParsedMolfileGraph } from "./index";

// MOL says -> drawn after paste, from the 1.2.4 audit. Each row is hand-written below as V2000
// and V3000, and pasted through the reader the app uses.
interface Spec {
  atoms: { symbol: string; mass?: number; charge?: number; valence?: number; rad?: number }[];
  bonds: [number, number, number][];
  /** Extra V2000 property lines (M  ISO, M  RAD, ...). */
  v2000Props?: string[];
}
interface Row {
  name: string; spec: Spec; smiles: string; formula: string;
  /** RDKit ignores atom-block charge code 4, so it is no oracle for that row's V2000 text. */
  engineIgnoresV2000?: boolean;
}

const C = (extra: Partial<Spec["atoms"][number]> = {}): Spec["atoms"][number] => ({ symbol: "C", ...extra });
const rows: Row[] = [
  {
    name: "nitroxide CC1(C)CCCC(C)(C)N1[O]",
    smiles: "CC1(C)CCCC(C)(C)N1[O]", formula: "C9H18NO",
    spec: {
      atoms: [C(), C(), C(), C(), C(), C(), C(), C(), C(), { symbol: "N" }, { symbol: "O", rad: 2 }],
      bonds: [[1, 2, 1], [2, 3, 1], [2, 4, 1], [4, 5, 1], [5, 6, 1], [6, 7, 1], [7, 8, 1], [7, 9, 1], [7, 10, 1],
        [10, 2, 1], [10, 11, 1]]
    }
  },
  {
    name: "benzyl [CH2]c1ccccc1",
    smiles: "[CH2]c1ccccc1", formula: "C7H7",
    spec: {
      atoms: [C({ rad: 2 }), C(), C(), C(), C(), C(), C()],
      bonds: [[1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 6, 1], [6, 7, 2], [7, 2, 1]]
    }
  },
  {
    name: "ethyl radical [CH2]C by atom-block charge code 4",
    smiles: "[CH2]C", formula: "C2H5", engineIgnoresV2000: true,
    spec: { atoms: [C(), C({ charge: 4 })], bonds: [[1, 2, 1]] }
  },
  {
    name: "typed N [N]CO by valence field",
    smiles: "[N]CO", formula: "CH3NO",
    spec: { atoms: [{ symbol: "N", valence: 1 }, C(), { symbol: "O" }], bonds: [[1, 2, 1], [2, 3, 1]] }
  },
  {
    name: "[13C] by zero valence",
    smiles: "[13C]", formula: "[13C]",
    spec: { atoms: [{ symbol: "C", mass: 1, valence: 15 }], bonds: [] }
  }
];

function v2000(spec: Spec): string {
  const fmt = (n: number) => n.toFixed(4).padStart(10);
  const props = [...(spec.v2000Props ?? [])];
  const rad = spec.atoms.flatMap((atom, i) => atom.rad ? [`${String(i + 1).padStart(3)} ${String(atom.rad).padStart(3)}`] : []);
  if (rad.length) props.push(`M  RAD${String(rad.length).padStart(3)} ${rad.join(" ")}`);
  spec.atoms.forEach((atom, i) => {
    if (atom.mass !== undefined && atom.mass > 0 && atom.symbol === "C" && atom.mass === 1) {
      props.push(`M  ISO  1 ${String(i + 1).padStart(3)} ${String(13).padStart(3)}`);
    }
  });
  return [
    "audit", "  hand-written", "",
    `${String(spec.atoms.length).padStart(3)}${String(spec.bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`,
    ...spec.atoms.map((atom, i) =>
      `${fmt(i * 1.5)}${fmt(0)}${fmt(0)} ${atom.symbol.padEnd(3)} 0${String(atom.charge ?? 0).padStart(3)}` +
      `  0  0  0${String(atom.valence ?? 0).padStart(3)}  0  0  0  0  0  0`),
    ...spec.bonds.map(([a, b, order]) => `${String(a).padStart(3)}${String(b).padStart(3)}${String(order).padStart(3)}  0  0  0  0`),
    ...props, "M  END"
  ].join("\n");
}

function v3000(spec: Spec): string {
  return [
    "audit", "  hand-written", "", "  0  0  0  0  0  0            999 V3000",
    "M  V30 BEGIN CTAB", `M  V30 COUNTS ${spec.atoms.length} ${spec.bonds.length} 0 0 0`, "M  V30 BEGIN ATOM",
    ...spec.atoms.map((atom, i) => {
      const extras = [
        atom.mass === 1 && atom.symbol === "C" ? "MASS=13" : "",
        atom.charge && atom.charge !== 4 ? `CHG=${atom.charge}` : "",
        atom.rad ? `RAD=${atom.rad}` : atom.charge === 4 ? "RAD=2" : "",
        atom.valence === 15 ? "VAL=-1" : atom.valence ? `VAL=${atom.valence}` : ""
      ].filter(Boolean).join(" ");
      return `M  V30 ${i + 1} ${atom.symbol} ${i * 1.5} 0 0 0${extras ? ` ${extras}` : ""}`;
    }),
    "M  V30 END ATOM", "M  V30 BEGIN BOND",
    ...spec.bonds.map(([a, b, order], i) => `M  V30 ${i + 1} ${order} ${a} ${b}`),
    "M  V30 END BOND", "M  V30 END CTAB", "M  END"
  ].join("\n");
}

/** What the app builds from a parsed graph: native atoms and bonds carrying the fields the reader read. */
function moleculeFromGraph(graph: ParsedMolfileGraph): MoleculeObject {
  return {
    id: "pasted", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structureFormat: graph.format, structure: "", superatoms: [], rGroups: [],
    atoms: graph.atoms.map((atom): MoleculeAtom => ({
      id: atom.id, element: atom.element, x: atom.x * 30, y: -atom.y * 30, formalCharge: atom.formalCharge,
      ...(atom.isotope === undefined ? {} : { isotope: atom.isotope }),
      ...(atom.markRadicals ? { markRadicals: atom.markRadicals } : {}),
      ...(atom.hydrogenCount === undefined ? {} : { hydrogenCount: atom.hydrogenCount })
    })),
    bonds: graph.bonds.map((bond) => ({
      id: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, order: bond.order,
      ...(bond.bondStyle ? { display: { bondStyle: bond.bondStyle } } : {})
    }))
  } as MoleculeObject;
}

async function canonicalSmiles(molfile: string): Promise<string | undefined> {
  return (await computeStructureIdentifiers(molfile))?.smiles;
}
function formulaOf(molecule: MoleculeObject): string | undefined {
  return nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula;
}

beforeAll(() => { installNodeRdkitModuleLoader(); });

describe("the engine's own reading of each audit row (the oracle)", () => {
  it.each(rows)("$name: both formats canonicalise to the expected SMILES", async ({ spec, smiles, engineIgnoresV2000 }) => {
    if (!engineIgnoresV2000) expect(await canonicalSmiles(v2000(spec))).toBe(smiles);
    expect(await canonicalSmiles(v3000(spec))).toBe(smiles);
  });
});

describe("pasted MOL keeps radicals and stated hydrogens", () => {
  it.each(rows.flatMap((row) => [
    { label: `${row.name} as V2000`, row, write: v2000 }, { label: `${row.name} as V3000`, row, write: v3000 }
  ]))(
    "$label survives paste -> Copy As MOL", async ({ label, row, write }) => {
      const graph = parseMolfileGraph(write(row.spec));
      const molecule = moleculeFromGraph(graph);
      expect(formulaOf(molecule)).toBe(row.formula);
      const copied = [
        moleculeToMolfileV2000(molecule, { fromDocFrame: true }).contents,
        moleculeToMolfileV3000(molecule, { fromDocFrame: true }).contents
      ];
      for (const molfile of copied) expect(await canonicalSmiles(molfile), label).toBe(row.smiles);
      expect(graph.warnings.map((warning) => warning.code)).toEqual([]);
    }
  );
});

describe("radical codes", () => {
  const ethyl = (props: string[], charge = 0) => v2000({
    atoms: [C(), C({ charge })], bonds: [[1, 2, 1]], v2000Props: props
  });
  it("reads doublet as one drawn radical electron and triplet as two", () => {
    expect(parseMolfileGraph(ethyl(["M  RAD  1   2   2"])).atoms.map((a) => a.markRadicals ?? 0)).toEqual([0, 1]);
    expect(parseMolfileGraph(ethyl(["M  RAD  1   2   3"])).atoms.map((a) => a.markRadicals ?? 0)).toEqual([0, 2]);
    expect(parseMolfileGraph(ethyl([], 4)).atoms.map((a) => a.markRadicals ?? 0)).toEqual([0, 1]);
  });
  it("lets an M  RAD entry replace the atom-block code and keeps charge code 4 from reading as a charge", () => {
    const graph = parseMolfileGraph(ethyl(["M  RAD  1   2   3"], 4));
    expect(graph.atoms.map((a) => [a.markRadicals ?? 0, a.formalCharge])).toEqual([[0, 0], [2, 0]]);
    expect(parseMolfileGraph(ethyl(["M  RAD  1   2   0"], 4)).atoms[1]!.markRadicals ?? 0).toBe(0);
  });
  it("keeps charge code 4 as a radical when an M  CHG line charges another atom", () => {
    const graph = parseMolfileGraph(ethyl(["M  CHG  1   1   1"], 4));
    expect(graph.atoms.map((a) => [a.markRadicals ?? 0, a.formalCharge])).toEqual([[0, 1], [1, 0]]);
  });
  it("reads a V3000 RAD= doublet and triplet", () => {
    const text = v3000({ atoms: [C({ rad: 2 }), C({ rad: 3 }), C()], bonds: [[1, 2, 1], [2, 3, 1]] });
    expect(parseMolfileGraph(text).atoms.map((a) => a.markRadicals ?? 0)).toEqual([1, 2, 0]);
  });
  it("warns, never drops silently, on a singlet", () => {
    for (const text of [ethyl(["M  RAD  1   2   1"]), v3000({ atoms: [C(), C({ rad: 1 })], bonds: [[1, 2, 1]] })]) {
      const graph = parseMolfileGraph(text);
      expect(graph.atoms[1]!.markRadicals ?? 0).toBe(0);
      expect(graph.warnings).toEqual([expect.objectContaining({ code: "clipboard.radical_singlet_unsupported" })]);
      expect(graph.warnings[0]!.message).toMatch(/atom 2/i);
    }
  });
  it("rejects an unreadable M  RAD line rather than ignoring it", () => {
    expect(() => parseMolfileGraph(ethyl(["M  RAD  1   9   2"]))).toThrow(/RAD/);
    expect(() => parseMolfileGraph(ethyl(["M  RAD  1   2   7"]))).toThrow(/RAD/);
  });
});

describe("valence field", () => {
  it("reads V2000 valence minus the bond-order sum as the stated hydrogen count", () => {
    const graph = parseMolfileGraph(v2000({
      atoms: [C({ valence: 4 }), C({ valence: 4 }), { symbol: "O", valence: 2 }, C()],
      bonds: [[1, 2, 1], [2, 3, 2]]
    }));
    expect(graph.atoms.map((a) => a.hydrogenCount)).toEqual([3, 1, 0, undefined]);
  });
  it("reads V3000 VAL= alike, with -1 as zero valence", () => {
    const graph = parseMolfileGraph(v3000({
      atoms: [C({ valence: 4 }), C({ valence: 4 }), { symbol: "O", valence: 2 }, C()],
      bonds: [[1, 2, 1], [2, 3, 2]]
    }));
    expect(graph.atoms.map((a) => a.hydrogenCount)).toEqual([3, 1, 0, undefined]);
  });
  it.each([["V2000", v2000], ["V3000", v3000]] as const)("%s: leaves a lone zero-valence H to the app's H-radical reading", (_, write) => {
    const graph = parseMolfileGraph(write({ atoms: [{ symbol: "H", valence: 15 }], bonds: [] }));
    expect(graph.atoms[0]!.hydrogenCount).toBeUndefined();
    expect(graph.warnings).toEqual([]);
  });
  it.each([["V2000", v2000], ["V3000", v3000]] as const)("%s: warns on the zero-valence sentinel of a bonded atom", (_, write) => {
    const graph = parseMolfileGraph(write({ atoms: [{ symbol: "O", valence: 15 }, C()], bonds: [[1, 2, 1]] }));
    expect(graph.atoms[0]!.hydrogenCount).toBeUndefined();
    expect(graph.warnings).toEqual([expect.objectContaining({ code: "clipboard.valence_not_read" })]);
  });
  it.each([["V2000", v2000], ["V3000", v3000]] as const)("%s: warns where the count cannot be read", (_, write) => {
    const aromatic = parseMolfileGraph(write({ atoms: [{ symbol: "N", valence: 3 }, C()], bonds: [[1, 2, 4]] }));
    expect(aromatic.atoms[0]!.hydrogenCount).toBeUndefined();
    expect(aromatic.warnings).toEqual([expect.objectContaining({ code: "clipboard.valence_not_read" })]);
    const short = parseMolfileGraph(write({ atoms: [{ symbol: "C", valence: 2 }, C()], bonds: [[1, 2, 3]] }));
    expect(short.atoms[0]!.hydrogenCount).toBeUndefined();
    expect(short.warnings).toEqual([expect.objectContaining({ code: "clipboard.valence_not_read" })]);
    expect(short.warnings[0]!.message).toMatch(/atom 1/i);
  });
});

describe("Copy As MOL -> paste round trips keep radicals and stated counts", () => {
  const atom = (id: string, element: string, extra: Partial<MoleculeAtom> = {}): MoleculeAtom =>
    ({ id, element, x: Number(id.slice(1)) * 30, y: 0, formalCharge: 0, ...extra });
  const bond = (a: number, b: number, order: "single" | "double" = "single") =>
    ({ id: `b${a}${b}`, fromAtomId: `a${a}`, toAtomId: `a${b}`, order });
  const native = (atoms: MoleculeAtom[], bonds: ReturnType<typeof bond>[]) => ({
    id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
    structureFormat: "unknown", structure: "", superatoms: [], rGroups: [], atoms, bonds
  }) as MoleculeObject;
  const cases: [string, MoleculeObject][] = [
    ["doublet on O", native([atom("a1", "C"), atom("a2", "N"), atom("a3", "O", { markRadicals: 1 })], [bond(1, 2), bond(2, 3)])],
    ["doublet on C", native([atom("a1", "C", { markRadicals: 1 }), atom("a2", "C")], [bond(1, 2)])],
    ["triplet on C", native([atom("a1", "C", { markRadicals: 2 }), atom("a2", "C")], [bond(1, 2)])],
    ["typed N", native([atom("a1", "N", { labelLiteral: true }), atom("a2", "C"), atom("a3", "O")], [bond(1, 2), bond(2, 3)])],
    ["13C stated 0 H", native([atom("a1", "C", { isotope: 13, hydrogenCount: 0 })], [])]
  ];
  it.each(cases)("%s", async (_name, original) => {
    const expected = await canonicalSmiles(moleculeToMolfileV2000(original, { fromDocFrame: true }).contents);
    expect(expected).toBeTruthy();
    for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      const pasted = moleculeFromGraph(parseMolfileGraph(write(original, { fromDocFrame: true }).contents));
      const again = [moleculeToMolfileV2000, moleculeToMolfileV3000].map((w) => w(pasted, { fromDocFrame: true }).contents);
      for (const molfile of again) expect(await canonicalSmiles(molfile)).toBe(expected);
      expect(formulaOf(pasted)).toBe(formulaOf(original));
    }
  });
});
