import { parseV2000AtomBlock } from "@chemdraft/chemistry-adapter";
import { ensureRdkit, type RdkitJsMol, type RdkitMinimalModule } from "./conformer";

interface AlignmentMol extends RdkitJsMol {
  get_molblock(): string;
  get_smiles(): string;
  get_substruct_match(query: RdkitJsMol): string;
  generate_aligned_coords(template: RdkitJsMol, options: string): string;
}
interface MolList { append(molecule: RdkitJsMol): void; delete(): void }
interface AlignmentModule extends RdkitMinimalModule {
  MolList: new () => MolList;
  get_qmol(smarts: string): AlignmentMol | null;
  get_mcs_as_json(molecules: MolList, options: string): string;
}

export interface ReactionProductAlignment {
  molfile: string;
  matchedAtomCount: number;
}
export type ReactionProductAligner = (reactants: readonly string[], product: string) => ReactionProductAlignment | undefined;

/** Existing MinimalLib FMCS + constrained depiction. Coordinates and directed stereo stay in
 * molfile order and its y-UP frame. No document types or host loading policy enter this adapter. */
export async function createReactionProductAligner(): Promise<ReactionProductAligner> {
  const rdkit = await ensureRdkit() as AlignmentModule;
  if (!rdkit.MolList || !rdkit.get_mcs_as_json || !rdkit.get_qmol) {
    throw new Error("The RDKit build has no maximum-common-substructure depiction support.");
  }
  return (reactants, product) => {
    const target = rdkit.get_mol(product, JSON.stringify({ removeHs: false })) as AlignmentMol | null;
    if (!target) throw new Error("RDKit could not parse a reaction product for orientation matching.");
    let template: AlignmentMol | null = null;
    let bestCount = 0;
    try {
      if (!target.generate_aligned_coords) throw new Error("The RDKit build has no aligned-coordinate function.");
      for (const reactant of reactants) {
        const reference = rdkit.get_mol(reactant, JSON.stringify({ removeHs: false })) as AlignmentMol | null;
        if (!reference) continue;
        const list = new rdkit.MolList();
        let query: AlignmentMol | null = null;
        try {
          list.append(reference); list.append(target);
          // Bond-order changes are allowed in a reaction core; ring atoms may only match rings.
          // A timed-out search is not presented as a maximum common substructure.
          const common = JSON.parse(rdkit.get_mcs_as_json(list, JSON.stringify({
            Timeout: 1, RingMatchesRingOnly: true, CompleteRingsOnly: true, BondCompare: "CompareAny"
          }))) as { smarts?: string; canceled?: boolean; numAtoms: number; numBonds: number };
          if (common.canceled) throw new Error("Reaction core search exceeded its one-second limit.");
          if (!common.smarts || common.numAtoms <= bestCount) continue;
          query = rdkit.get_qmol(common.smarts);
          if (!query) continue;
          const referenceMatch = JSON.parse(reference.get_substruct_match(query)) as { atoms?: number[] };
          if (!referenceMatch.atoms?.length) continue;
          const referenceAtoms = parseV2000AtomBlock(reference.get_molblock());
          if (!referenceAtoms) continue;
          const heavyAtoms = referenceMatch.atoms.filter(i => !["H", "D", "T"].includes(referenceAtoms[i].element)).length;
          if (heavyAtoms < 6 && !(heavyAtoms >= 3 && common.numBonds >= common.numAtoms)) continue;
          const block = query.get_molblock().split(/\r?\n/);
          const referenceBlock = reference.get_molblock().split(/\r?\n/);
          referenceMatch.atoms.forEach((atom, index) => {
            block[4 + index] = referenceBlock[4 + atom].slice(0, 30) + block[4 + index].slice(30);
          });
          const candidate = rdkit.get_mol(block.join("\n"), JSON.stringify({ removeHs: false })) as AlignmentMol | null;
          if (!candidate) continue;
          template?.delete(); template = candidate; bestCount = common.numAtoms;
        } finally { query?.delete(); list.delete(); reference.delete(); }
      }
      if (!template) return undefined;
      const before = target.get_smiles();
      const atomsBefore = parseV2000AtomBlock(product);
      // Rigid alignment retains the existing depiction and bond lengths. RDKit adjusts directed
      // wedge/hash spelling when a reflection is needed; callers must retain the returned bonds.
      const match = JSON.parse(target.generate_aligned_coords(template,
        JSON.stringify({ alignOnly: true, acceptFailure: false }))) as { atoms?: number[] };
      if (!match.atoms?.length) return undefined;
      const molfile = target.get_molblock();
      const atomsAfter = parseV2000AtomBlock(molfile);
      const check = rdkit.get_mol(molfile, JSON.stringify({ removeHs: false })) as AlignmentMol | null;
      try {
        if (!check || check.get_smiles() !== before || !atomsBefore || !atomsAfter ||
            atomsBefore.length !== atomsAfter.length || atomsBefore.some((atom, i) => atom.element !== atomsAfter[i].element)) {
          throw new Error("Reaction alignment refused: atom order or canonical isomeric SMILES changed.");
        }
      } finally { check?.delete(); }
      return { molfile, matchedAtomCount: bestCount };
    } finally { template?.delete(); target.delete(); }
  };
}
