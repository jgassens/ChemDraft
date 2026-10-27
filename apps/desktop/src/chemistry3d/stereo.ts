/** Stereo intent uses the signed input's atom order, with RDKit-added Hs last.
 * Compare local parity: unspecified neighbours can change CIP labels without changing parity. */
import type { Plugin3DModel } from "@chemdraft/plugin-api";
import type { RdkitJsMol, RdkitMinimalModule, RdkitJson } from "@chemdraft/rdkit-adapter";
import { modelMolblock, readGraph } from "./model";

type StereoGraph = Omit<RdkitJson["molecules"][number], "bonds"> & {
  bonds: { atoms: [number, number]; bo?: number; stereo?: string; stereoAtoms?: number[] }[];
};

export function inputWithHydrogens(rdkit: RdkitMinimalModule, smiles: string): RdkitJsMol {
  const input = rdkit.get_mol(smiles, JSON.stringify({ removeHs: false }));
  if (!input) throw new Error("RDKit could not read the signed component SMILES.");
  try {
    const addHs = (input as RdkitJsMol & { add_hs?: () => string }).add_hs;
    if (!addHs) throw new Error("RDKit explicit-hydrogen generation is unavailable.");
    const explicit = rdkit.get_mol(addHs.call(input), JSON.stringify({ removeHs: false }));
    if (!explicit) throw new Error("RDKit could not read the explicit-hydrogen input.");
    return explicit;
  } finally { input.delete(); }
}

export function stereoGraph(mol: RdkitJsMol): StereoGraph {
  return readGraph(mol).molecules[0] as StereoGraph;
}

export function specifiedCenters(graph: StereoGraph): Set<number> {
  return new Set(graph.atoms.flatMap((atom, i) => atom.stereo === "cw" || atom.stereo === "ccw" ? [i] : []));
}

/** MinimalLib exposes assigned stereo, but not findPotentialStereo. Probe each open double
 * bond with a temporary CXSMILES cis tag: RDKit's own stereo cleanup retains it only if the
 * bond can carry E/Z (including symmetry, aromaticity and small-ring constraints). This is
 * perception only; no coordinates, depiction, or changes to the signed input are involved.
 * CX bond indices follow SMILES traversal, not RDKit's input bond order at ring closures. */
export function unspecifiedStereoDoubleBonds(rdkit: RdkitMinimalModule, smiles: string): number[] {
  const input = rdkit.get_mol(smiles, JSON.stringify({ removeHs: false }));
  if (!input) throw new Error("RDKit could not read the signed component SMILES.");
  try {
    const graph = stereoGraph(input);
    const aromatic = new Set((graph.extensions as { aromaticBonds?: number[] }[] | undefined)
      ?.flatMap(extension => extension.aromaticBonds ?? []) ?? []);
    const candidates = graph.bonds.flatMap((bond, i) => bond.bo === 2 && !aromatic.has(i) &&
      bond.stereo !== "cis" && bond.stereo !== "trans" ? [i] : []);
    if (!candidates.length) return [];
    const mol = input as RdkitJsMol & { get_smiles(details: string): string; get_prop(name: string): string };
    const traversal = mol.get_smiles(JSON.stringify({ canonical: false }));
    const atomOrder = JSON.parse(mol.get_prop("_smilesAtomOutputOrder")) as number[];
    const bondOrder = JSON.parse(mol.get_prop("_smilesBondOutputOrder")) as number[];
    const heavyOrder = atomOrder.filter(atom => graph.atoms[atom].z !== 1);
    return candidates.filter(index => {
      // RDKit's CX cis/trans cleanup requires removeHs:true. Match endpoints by heavy-atom
      // traversal order, so explicit input Hs cannot shift the reported input bond index.
      const probe = rdkit.get_mol(`${traversal} |c:${bondOrder.indexOf(index)}|`, JSON.stringify({ removeHs: true }));
      if (!probe) throw new Error("RDKit could not perceive potential double-bond stereochemistry.");
      try {
        const perceived = stereoGraph(probe);
        const heavyAtoms = perceived.atoms.flatMap((atom, i) => atom.z !== 1 ? [i] : []);
        const [a, b] = graph.bonds[index].atoms.map(atom => heavyAtoms[heavyOrder.indexOf(atom)]);
        return perceived.bonds.some(bond => bond.bo === 2 && bond.atoms.includes(a) &&
          bond.atoms.includes(b) && (bond.stereo === "cis" || bond.stereo === "trans"));
      } finally { probe.delete(); }
    }).map(index => index + 1);
  } finally { input.delete(); }
}

/** Normalize parity against sorted neighbours, independent of bond traversal order. */
function parity(graph: StereoGraph, center: number): number {
  const neighbors = graph.bonds.flatMap(b => b.atoms[0] === center ? [b.atoms[1]] : b.atoms[1] === center ? [b.atoms[0]] : []);
  let sign = graph.atoms[center]?.stereo === "cw" ? 1 : graph.atoms[center]?.stereo === "ccw" ? -1 : 0;
  for (let i = 0; i < neighbors.length; i++) for (let j = i + 1; j < neighbors.length; j++) if (neighbors[i] > neighbors[j]) sign = -sign;
  return sign;
}

export function assertComponentStereo(rdkit: RdkitMinimalModule, model: Plugin3DModel, index: number, phase: string): void {
  const component = model.components[index];
  const input = inputWithHydrogens(rdkit, component.smiles);
  let geometry: RdkitJsMol | null = null;
  try {
    geometry = rdkit.get_mol(modelMolblock(model, index), JSON.stringify({ removeHs: false }));
    if (!geometry) throw new Error(`Component ${index + 1}: RDKit could not read back ${phase} stereochemistry.`);
    const expected = stereoGraph(input);
    const actual = stereoGraph(geometry);
    for (const center of specifiedCenters(expected)) {
      if (parity(expected, center) !== parity(actual, center)) {
        throw new Error(`Component ${index + 1}: ${phase} would change specified tetrahedral stereo at centre ${center + 1}; restore the input geometry.`);
      }
    }
    for (const bond of expected.bonds) {
      if (bond.stereo !== "cis" && bond.stereo !== "trans") continue;
      const [a, b] = bond.atoms;
      const found = actual.bonds.find(candidate => candidate.atoms.includes(a) && candidate.atoms.includes(b));
      let sign = found?.stereo === "cis" ? 1 : found?.stereo === "trans" ? -1 : 0;
      // RDKit can choose the other ligand at either end when assigning from geometry.
      for (const endpoint of [a, b]) {
        const expectedLigand = bond.stereoAtoms?.[bond.atoms.indexOf(endpoint)];
        const actualLigand = found?.stereoAtoms?.[found.atoms.indexOf(endpoint)];
        if (expectedLigand !== actualLigand) sign = -sign;
      }
      if (sign !== (bond.stereo === "cis" ? 1 : -1)) {
        throw new Error(`Component ${index + 1}: ${phase} would change specified E/Z stereo at bond ${a + 1}-${b + 1}; restore the input geometry.`);
      }
    }
  } finally { geometry?.delete(); input.delete(); }
}
