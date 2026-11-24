import type { PluginHandoffGraphResult } from "@chemdraft/plugin-api";
import { ensureRdkit, type RdkitJsMol } from "@chemdraft/rdkit-adapter";
import { canonicalGraphSmiles, moleculeFromHandoffStructure, readHandoffStructure } from "./graph";
import { unspecifiedDoubleBondIndices } from "./stereo";

export interface HandoffGraphWork extends Omit<PluginHandoffGraphResult,
  "graph" | "canonicalSmiles" | "unspecifiedStereocenters" | "unspecifiedDoubleBonds"> {
  molfile: string;
  atoms: { atomId: string; drawnLabel?: string; isConnectionPoint: boolean; element: string; charge: number;
    isotope?: number; radical?: number; statedHydrogens?: number }[];
  bonds: { id: string; a: number; b: number; order: "single" | "double" | "triple" | "aromatic" | "unknown";
    either: boolean; style?: "wedge" | "hashed" | "wavy" }[];
}

export async function auditHandoffGraph(work: HandoffGraphWork): Promise<PluginHandoffGraphResult> {
  const { molfile, atoms, bonds, ...metadata } = work;
  const rdkit = await ensureRdkit();
  const context = `Handoff graph for molecule "${work.objectId}"`;
  const input = rdkit.get_mol(molfile, JSON.stringify({ removeHs: false }));
  if (!input) throw new Error(`${context}: RDKit could not sanitize the drawn structure.`);
  try {
    const graph = readHandoffStructure(input);
    if (graph.atoms.length !== atoms.length || graph.bonds.length !== bonds.length) {
      throw new Error(`${context}: the writer or RDKit changed the drawn atom or bond count.`);
    }
    const explicitNeighbors = atoms.map(() => 0);
    const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
    const sourceBonds = new Map(bonds.map(bond => [key(bond.a, bond.b), bond]));
    const bondOrder = { single: 1, double: 2, triple: 3, aromatic: "aromatic", unknown: "unknown" };
    for (const bond of graph.bonds) {
      const source = sourceBonds.get(key(bond.a, bond.b));
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
    const canonicalSmiles = canonicalGraphSmiles(input);
    const rebuilt = moleculeFromHandoffStructure(rdkit, graph, context);
    try {
      if (canonicalGraphSmiles(rebuilt) !== canonicalSmiles) {
        throw new Error(`${context}: the graph round trip would change the drawn canonical SMILES.`);
      }
    } finally { rebuilt.delete(); }
    const stereoMol = input as RdkitJsMol & { get_stereo_tags?: () => string };
    if (!stereoMol.get_stereo_tags) throw new Error("RDKit stereocenter perception is unavailable.");
    const tags = JSON.parse(stereoMol.get_stereo_tags()) as { CIP_atoms: [number, string][] };
    const unspecifiedStereocenters = tags.CIP_atoms.flatMap(([i, tag]) => tag === "(?)" ? [i] : []);
    const openDoubleBonds = new Set(unspecifiedDoubleBondIndices(rdkit, input));
    graph.bonds.forEach((bond, i) => { if (bond.stereo === "either") openDoubleBonds.add(i); });
    return { ...metadata, graph, canonicalSmiles, unspecifiedStereocenters, unspecifiedDoubleBonds: [...openDoubleBonds].sort((a, b) => a - b) };
  } finally { input.delete(); }
}
