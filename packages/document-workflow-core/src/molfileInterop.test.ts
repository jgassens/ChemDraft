import { beforeAll, expect, it } from "vitest";
import { moleculeToMolfileV2000, moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { molfileCoordinateScale } from "@chemdraft/layout-engine";
import { installNodeRdkitModuleLoader } from "../../rdkit-adapter/src/node";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { ensureRdkit } from "../../rdkit-adapter/src/conformer";
import { compositionFromRdkitJson } from "../../rdkit-adapter/src/composition";
import { readAtomStates } from "../test/radicalExportFixtures";
import { moleculeToInteropMolfile } from "./molfileInterop";
import { sourceBondSemantics } from "./sourceBondSemantics";

beforeAll(() => installNodeRdkitModuleLoader());

const molecule: MoleculeObject = {
  id: "mol", type: "molecule", x: 0, y: 0, width: 400, height: 100, rotation: 0, style: {},
  structureFormat: "unknown", structure: "", superatoms: [], rGroups: [],
  atoms: [
    ["C", 0, 0], ["F", 1, 1], ["Cl", -1, 1], ["Br", 0, -1],
    ["C", 4, 0], ["O", 5, 0], ["N", 7, 0],
    ["F", 9, 1], ["C", 10, 0], ["C", 11, 0], ["F", 12, -1],
    ["F", 14, 1], ["C", 15, 0], ["C", 16, 0], ["F", 17, -1]
  ].map(([element, x, y], i) => ({ id: `a${i}`, element: String(element), x: Number(x) * 22, y: Number(y) * 22,
    formalCharge: i === 6 ? 1 : 0, ...(i === 0 ? { isotope: 13 } : {}), ...(i === 5 ? { markRadicals: 1 } : {}) })),
  bonds: [
    [0, 1], [0, 2], [0, 3], [4, 5], [7, 8], [8, 9], [9, 10], [11, 12], [12, 13], [13, 14]
  ].map(([from, to], i) => ({ id: `b${i}`, fromAtomId: `a${from}`, toAtomId: `a${to}`,
    order: i === 5 || i === 8 ? "double" : "single",
    ...(i === 8 ? { stereo: "either" as const } : {}),
    ...(i === 0 ? { display: { bondStyle: "wedge" as const } } : {}) }))
};

async function composition(contents: string) {
  const rdkit = await ensureRdkit();
  const mol = rdkit.get_mol(contents)!;
  expect(mol).toBeTruthy();
  try {
    return compositionFromRdkitJson(JSON.parse((mol as unknown as { get_json(): string }).get_json()));
  } finally { mol.delete(); }
}

it.each(["v2000", "v3000"] as const)("normalizes %s while preserving chemistry, directed displays, E/Z and S-groups", async flavor => {
  const before = structuredClone(molecule);
  const options = { fromDocFrame: true, kekuleBondOrders: new Map<string, number>(),
    superatomGroups: [{ label: "MeO", atomIds: ["a4", "a5"] }],
    repeatUnitGroups: [{ objectId: "bracket", label: "n", atomIds: ["a8", "a9"] }] };
  const write = flavor === "v2000" ? moleculeToMolfileV2000 : moleculeToMolfileV3000;
  for (const bondStyle of ["wedge", "hashed", "wavy"] as const) {
    const source = { ...molecule, bonds: molecule.bonds.map((bond, i) => i === 0 ? { ...bond, display: { bondStyle } } : bond) };
    const raw = write(source, options).contents;
    const scaled = moleculeToInteropMolfile(source, flavor, 22, options).contents;
    const original = parseMolfileGraph(raw), graph = parseMolfileGraph(scaled);
    // Four-decimal coordinate rounding can perturb a diagonal distance by over 0.00005.
    expect(molfileCoordinateScale(graph.atoms, graph.bonds, 1.5, 22).medianBondLength).toBeCloseTo(1.5, 3);
    expect(graph.atoms.map(({ x, y, ...atom }) => atom)).toEqual(original.atoms.map(({ x, y, ...atom }) => atom));
    expect(graph.bonds).toEqual(original.bonds);
    expect(graph.bonds[0]!.bondStyle).toBe(bondStyle);
    expect(sourceBondSemantics(scaled)).toEqual(sourceBondSemantics(raw));
    expect(sourceBondSemantics(scaled).unspecifiedDoubleBondIndices).toEqual([8]);
    expect(scaled.split("\n").filter(line => /^(M  S|M  V30 .* (SUP|SRU) )/.test(line)))
      .toEqual(raw.split("\n").filter(line => /^(M  S|M  V30 .* (SUP|SRU) )/.test(line)));
    const rawIds = await computeStructureIdentifiers(raw), scaledIds = await computeStructureIdentifiers(scaled);
    expect(rawIds?.smiles).toBeTruthy();
    if (bondStyle !== "wavy") expect(rawIds!.smiles).toContain("@");
    expect(rawIds!.smiles).toContain("/");
    expect(scaledIds?.smiles).toBe(rawIds!.smiles);
    expect(await composition(scaled)).toEqual(await composition(raw));
    const states = await readAtomStates(raw);
    expect(states.some(atom => atom.radicals > 0)).toBe(true);
    expect(states.some(atom => atom.isotope === 13)).toBe(true);
    expect(states.some(atom => atom.charge === 1)).toBe(true);
    expect(await readAtomStates(scaled)).toEqual(states);
  }
  expect(molecule).toEqual(before);
});

it("scales disconnected bondless atom positions using the supplied nominal length", () => {
  const source = { ...molecule, bonds: [], atoms: molecule.atoms.slice(0, 2) };
  const graph = parseMolfileGraph(moleculeToInteropMolfile(source, "v2000", 22, { kekuleBondOrders: new Map() }).contents);
  expect(graph.atoms[1]!.x - graph.atoms[0]!.x).toBe(1.5);
});

it.each(["v2000", "v3000"] as const)("rejects non-finite coordinates in external %s output", flavor => {
  const source = { ...molecule, atoms: molecule.atoms.map((atom, i) => i === 0 ? { ...atom, x: Infinity } : atom) };
  expect(() => moleculeToInteropMolfile(source, flavor, 22, { kekuleBondOrders: new Map() }))
    .toThrow("atom a0 has non-finite coordinates");
});
