import type { PluginHandoffGraphResult } from "@chemdraft/plugin-api";
import { ensureRdkit, type RdkitJsMol } from "@chemdraft/rdkit-adapter";
import { canonicalGraphSmiles, moleculeFromHandoffStructure, readHandoffStructure } from "./graph";
import { rdkitRepresentation, readGraph } from "./model";
import { unspecifiedDoubleBondIndices } from "./stereo";

export interface HandoffGraphWork extends Omit<PluginHandoffGraphResult,
  "graph" | "canonicalSmiles" | "unspecifiedStereocenters" | "unspecifiedDoubleBonds"> {
  molfile: string;
  atoms: { atomId: string; drawnLabel?: string; isConnectionPoint: boolean; element: string; charge: number;
    isotope?: number; radical?: number; statedHydrogens?: number }[];
  bonds: { id: string; a: number; b: number; order: "single" | "double" | "triple" | "aromatic" | "unknown";
    either: boolean; style?: "wedge" | "hashed" | "wavy" }[];
  /** Host-only gates for the original and product of a connection-point edit. */
  connectionPointEdit?: { stage: "original" } | { stage: "marked"; anchors: readonly string[] };
}

const bondKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function assertConnectionPointTopology(
  bonds: PluginHandoffGraphResult["graph"]["bonds"], rings: readonly number[][], stage: string
): void {
  const aromaticBonds = new Set(bonds.flatMap(({ a, b, order }) => order === "aromatic" ? [bondKey(a, b)] : []));
  // RDKit supplies the ordered ring membership and aromatic bond flags.
  if (rings.some(ring => ring.some((a, i) => !aromaticBonds.has(bondKey(a, ring[(i + 1) % ring.length]!))))) {
    throw new Error(`${stage} has a non-aromatic ring. Draw X by hand.`);
  }
  const doubleBondAtoms = new Set<number>();
  for (const { a, b, order } of bonds) {
    if (order !== 2) continue;
    if (doubleBondAtoms.has(a) || doubleBondAtoms.has(b)) {
      throw new Error(`${stage} has cumulated double bonds. Draw X by hand.`);
    }
    doubleBondAtoms.add(a);
    doubleBondAtoms.add(b);
  }
}

export async function auditHandoffGraph(work: HandoffGraphWork): Promise<PluginHandoffGraphResult> {
  const { molfile, atoms, bonds, connectionPointEdit, ...metadata } = work;
  const rdkit = await ensureRdkit();
  const context = `Handoff graph for molecule "${work.objectId}"`;
  const input = rdkit.get_mol(molfile, JSON.stringify({ removeHs: false }));
  if (!input) throw new Error(`${context}: RDKit could not sanitize the drawn structure.`);
  try {
    const json = readGraph(input);
    const graph = readHandoffStructure(json);
    if (graph.atoms.length !== atoms.length || graph.bonds.length !== bonds.length) {
      throw new Error(`${context}: the writer or RDKit changed the drawn atom or bond count.`);
    }
    const explicitNeighbors = atoms.map(() => 0);
    const sourceBonds = new Map(bonds.map(bond => [bondKey(bond.a, bond.b), bond]));
    const bondOrder = { single: 1, double: 2, triple: 3, aromatic: "aromatic", unknown: "unknown" };
    for (const bond of graph.bonds) {
      const source = sourceBonds.get(bondKey(bond.a, bond.b));
      if (!source) throw new Error(`${context}: RDKit returned a bond with different endpoints.`);
      const order = bondOrder[source.order];
      // RDKit normalizes drawn Kekulé single/double bonds on aromatic systems.
      if (bond.order !== order && !(bond.order === "aromatic" && (order === 1 || order === 2))) {
        throw new Error(`${context}: RDKit could not preserve the order of bond "${source.id}" (${source.order}).`);
      }
      if (source.either && bond.stereo !== "either") {
        throw new Error(`${context}: RDKit could not preserve the unspecified stereo of bond "${source.id}".`);
      }
      if (source.style) bond.drawnStereo = { style: source.style, from: source.a };
      if (graph.atoms[bond.a]!.element === "H") explicitNeighbors[bond.b]!++;
      if (graph.atoms[bond.b]!.element === "H") explicitNeighbors[bond.a]!++;
    }
    graph.atoms.forEach((atom, i) => {
      const drawn = atoms[i]!;
      if (atom.element !== drawn.element || atom.charge !== drawn.charge || atom.isotope !== drawn.isotope ||
          (drawn.radical !== undefined && atom.radicalElectrons !== drawn.radical) ||
          (drawn.statedHydrogens !== undefined && atom.hydrogenCount !== drawn.statedHydrogens)) {
        throw new Error(`${context}: RDKit could not preserve element, charge, isotope, radical or stated hydrogens at atom "${drawn.atomId}" (${drawn.drawnLabel ?? drawn.element}).`);
      }
      atom.atomId = drawn.atomId;
      atom.drawnLabel = drawn.drawnLabel;
      atom.isConnectionPoint = drawn.isConnectionPoint;
      atom.explicitHydrogenCount = explicitNeighbors[i]! + (drawn.statedHydrogens ?? 0);
    });
    const representation = connectionPointEdit && rdkitRepresentation(json.molecules[0]!);
    const stage = connectionPointEdit?.stage === "original" ? "The original molecule" : "The marked molecule";
    if (connectionPointEdit) {
      if (!representation) throw new Error("RDKit ring and aromaticity data are unavailable. Draw X by hand.");
      assertConnectionPointTopology(graph.bonds, representation.atomRings ?? [], stage);
    }
    const stereoMol = input as RdkitJsMol & { get_stereo_tags?: () => string };
    if (!stereoMol.get_stereo_tags) throw new Error("RDKit stereocenter perception is unavailable.");
    const tags = JSON.parse(stereoMol.get_stereo_tags()) as { CIP_atoms: [number, string][] };
    if (connectionPointEdit && (tags.CIP_atoms.length || graph.atoms.some(atom => atom.stereo))) {
      throw new Error(`${stage} has assigned or potential tetrahedral stereochemistry. Draw X by hand.`);
    }
    const unspecifiedStereocenters = tags.CIP_atoms.flatMap(([i, tag]) => tag === "(?)" ? [i] : []);
    const openDoubleBonds = new Set(unspecifiedDoubleBondIndices(rdkit, input));
    graph.bonds.forEach((bond, i) => { if (bond.stereo === "either") openDoubleBonds.add(i); });
    if (connectionPointEdit && (openDoubleBonds.size || graph.bonds.some(bond => bond.order === 2 && bond.stereo))) {
      throw new Error(`${stage} has assigned or potential double-bond stereochemistry. Draw X by hand.`);
    }
    if (connectionPointEdit?.stage === "marked") {
      const aromaticAtoms = new Set(representation?.aromaticAtoms);
      const aromaticCarbons = new Set(graph.atoms.flatMap(({ element, atomId }, i) =>
        element === "C" && aromaticAtoms.has(i) ? [atomId] : []));
      const invalid = connectionPointEdit.anchors.find(id => !aromaticCarbons.has(id));
      if (invalid !== undefined) throw new Error(`Atom "${invalid}" is not an RDKit-aromatic carbon. Draw X by hand.`);
    }
    const canonicalSmiles = canonicalGraphSmiles(input);
    const rebuilt = moleculeFromHandoffStructure(rdkit, graph, context);
    try {
      if (canonicalGraphSmiles(rebuilt) !== canonicalSmiles) {
        throw new Error(`${context}: the graph round trip would change the drawn canonical SMILES.`);
      }
    } finally { rebuilt.delete(); }
    return { ...metadata, graph, canonicalSmiles, unspecifiedStereocenters, unspecifiedDoubleBonds: [...openDoubleBonds].sort((a, b) => a - b) };
  } finally { input.delete(); }
}
