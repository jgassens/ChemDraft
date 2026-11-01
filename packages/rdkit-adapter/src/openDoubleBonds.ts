import type { RdkitJsMol, RdkitMinimalModule } from "./conformer";
import type { RdkitJson } from "./composition";

/** MinimalLib has no findPotentialStereo binding. Ask RDKit's CXSMILES stereo cleanup
 * whether each unassigned carbon double bond can retain a temporary cis assignment.
 * This excludes symmetry, carbonyls, aromatic bonds and constrained small rings, without
 * deriving stereo from coordinates or editing directional SMILES characters. */
export function withOpenUnspecifiedDoubleBonds(rdkit: RdkitMinimalModule, source: RdkitJsMol): RdkitJsMol {
  if (!source.get_json || !source.get_smiles || !source.get_prop) {
    throw new Error("RDKit cannot perceive unspecified double bonds: JSON/SMILES traversal support is unavailable.");
  }
  const json = JSON.parse(source.get_json()) as RdkitJson;
  const graph = json.molecules[0];
  if (!graph) throw new Error("RDKit returned no graph for unspecified double-bond perception.");
  const aromatic = new Set((graph.extensions as { aromaticBonds?: number[] }[] | undefined)
    ?.flatMap((extension) => extension.aromaticBonds ?? []) ?? []);
  const atomicNumber = (index: number) => graph.atoms[index]?.z ?? json.defaults?.atom?.z ?? 6;
  const candidates = graph.bonds.flatMap((bond, index) => bond.bo === 2 && !aromatic.has(index) &&
    bond.atoms.every((atom) => atomicNumber(atom) === 6) &&
    bond.stereo !== "cis" && bond.stereo !== "trans" ? [index] : []);
  if (candidates.length > 0) {
    const traversal = source.get_smiles(JSON.stringify({ canonical: false }));
    const atomOrder = JSON.parse(source.get_prop("_smilesAtomOutputOrder")) as number[];
    const bondOrder = JSON.parse(source.get_prop("_smilesBondOutputOrder")) as number[];
    const heavyOrder = atomOrder.filter((atom) => atomicNumber(atom) !== 1);
    for (const index of candidates) {
      const traversalIndex = bondOrder.indexOf(index);
      if (traversalIndex < 0) throw new Error(`RDKit omitted bond ${index + 1} from its SMILES traversal.`);
      const probe = rdkit.get_mol(`${traversal} |c:${traversalIndex}|`, JSON.stringify({ removeHs: true }));
      if (!probe) throw new Error("RDKit could not perceive potential double-bond stereochemistry.");
      try {
        if (!probe.get_json) throw new Error("RDKit did not return the stereo probe graph.");
        const perceivedJson = JSON.parse(probe.get_json()) as RdkitJson;
        const perceived = perceivedJson.molecules[0]!;
        const heavyAtoms = perceived.atoms.flatMap((atom, i) =>
          (atom.z ?? perceivedJson.defaults?.atom?.z ?? 6) !== 1 ? [i] : []);
        // CX bond indices follow SMILES traversal; H removal also changes input indices.
        // Match both endpoints via the writer's atom traversal, never a ring digit's position.
        const [a, b] = graph.bonds[index]!.atoms.map((atom) => heavyAtoms[heavyOrder.indexOf(atom)]);
        if (a !== undefined && b !== undefined && perceived.bonds.some((bond) =>
          bond.bo === 2 && bond.atoms.includes(a) && bond.atoms.includes(b) &&
          (bond.stereo === "cis" || bond.stereo === "trans"))) {
          graph.bonds[index]!.stereo = "either";
          delete graph.bonds[index]!.stereoAtoms;
        }
      } finally { probe.delete(); }
    }
  }
  // STEREOANY crosses MinimalLib through its documented JSON representation, rather
  // than a native setter the bundled MinimalLib does not expose.
  // JSON already carries assigned cis/trans. Reassigning from missing bond directions
  // at this boundary would erase those assignments before coordinates are invented.
  const marked = rdkit.get_mol(JSON.stringify(json), JSON.stringify({ removeHs: false, assignStereo: false }));
  if (!marked) throw new Error("RDKit could not retain the perceived unspecified double bonds.");
  return marked;
}
