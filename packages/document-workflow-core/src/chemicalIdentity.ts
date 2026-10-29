import type { MoleculeObject } from "@chemdraft/chem-core";
import type { RdkitJsMol, RdkitJson, RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { stereoPerceptionMolfile } from "./molecule";
import { markV2000UnspecifiedDoubleBonds, sourceBondSemantics } from "./sourceBondSemantics";

/** With stereoReference, compare on that input's specified stereo; ignore additional output stereo. */
export type InspectChemicalIdentity = (
  format: "smiles" | "molfile", value: string, stereoReference?: string
) => Promise<
  { valid: true; canonicalSmiles: string; facts?: ChemicalIdentityFacts } | { valid: false; reason: string }
>;

export interface ChemicalIdentityFacts {
  withoutStereo: string;
  isotopeAtoms: string;
  chargedAtoms: string;
}

const withoutStereo = (smiles: string) => smiles.replace(/@(?:TH|AL|SP|TB|OH)\d*|@+|[\\/]/g, "");

/** Inspect tags before RDKit's stereo cleanup can erase unsupported input stereo. */
export function unverifiableStereoReason(
  module: Pick<RdkitMinimalModule, "get_mol">, value: string
): string | undefined {
  const raw = module.get_mol(value, JSON.stringify({
    removeHs: false, sanitize: false, assignStereo: false
  }));
  try {
    if (!raw?.get_json) throw new Error("RDKit could not inspect the input stereochemistry.");
    const graph = JSON.parse(raw.get_json()) as RdkitJson;
    // RDKit discards explicit allene classes even when stereo assignment is disabled.
    if (/\[[^\]]*@AL\d*/.test(value)) {
      return "allene (axial) stereochemistry cannot be verified or drawn.";
    }
    for (const molecule of graph.molecules) {
      const neighbors = molecule.atoms.map<number[]>(() => []);
      const doubles = molecule.atoms.map<number[]>(() => []);
      for (const bond of molecule.bonds) {
        const [a, b] = bond.atoms;
        neighbors[a]!.push(b); neighbors[b]!.push(a);
        if ((bond.bo ?? graph.defaults?.bond?.bo ?? 1) === 2) {
          doubles[a]!.push(b); doubles[b]!.push(a);
        }
      }
      for (const [start, attached] of doubles.entries()) {
        if (attached.length !== 1) continue;
        const chain = [start];
        let previous = start, current = attached[0]!;
        while (!chain.includes(current)) {
          chain.push(current);
          if (doubles[current]!.length !== 2 || neighbors[current]!.length !== 2) break;
          const next = doubles[current]!.find(index => index !== previous)!;
          previous = current; current = next;
        }
        if (chain.length < 3) continue;
        if (chain.length >= 4 && /[\\/]/.test(value)) {
          return "cumulene cis/trans stereochemistry cannot be verified or drawn.";
        }
        // An unsubstituted end (e.g. ketene oxygen) cannot define an axis. A degree-four
        // tagged atom is tetrahedral, even when one bond leads into a cumulated chain.
        const ends = [start, chain[chain.length - 1]!];
        if (ends.some(index => neighbors[index]!.length === 1 &&
          !(molecule.atoms[index]!.impHs ?? graph.defaults?.atom?.impHs ?? 0))) continue;
        if (chain.some(index => neighbors[index]!.length < 4 &&
          (molecule.atoms[index]!.stereo ?? graph.defaults?.atom?.stereo ?? "unspecified") !==
            "unspecified")) return "allene (axial) stereochemistry cannot be verified or drawn.";
      }
    }
    // RDKit JSON omits non-tetrahedral tags; retain both input and parsed SMILES evidence.
    const parsedSmiles = raw.get_smiles?.();
    if (!parsedSmiles) throw new Error("RDKit did not return a canonical SMILES.");
    const kinds = [
      /\[[^\]]*@SP\d*/.test(value) || parsedSmiles.includes("@SP") ? "square-planar" : undefined,
      /\[[^\]]*@TB\d*/.test(value) || parsedSmiles.includes("@TB") ? "trigonal-bipyramidal" : undefined,
      /\[[^\]]*@OH\d*/.test(value) || parsedSmiles.includes("@OH") ? "octahedral" : undefined
    ].filter(Boolean);
    return kinds.length ? `${kinds.join("/")} stereochemistry cannot be verified or drawn.` : undefined;
  } finally { raw?.delete(); }
}

function chemicalIdentityFacts(
  module: Pick<RdkitMinimalModule, "get_mol">, molecule: RdkitJsMol, smiles: string
): ChemicalIdentityFacts {
  if (!molecule.get_json) throw new Error("RDKit could not inspect the structure's atoms.");
  const graph = JSON.parse(molecule.get_json()) as RdkitJson;
  const atomProperties = (property: "isotope" | "chg") => graph.molecules.flatMap(mol =>
    mol.atoms.flatMap(atom => {
      const value = atom[property] ?? graph.defaults?.atom?.[property] ?? 0;
      return value ? [`${atom.z ?? graph.defaults?.atom?.z ?? 6}:${value}`] : [];
    })).sort().join(",");
  const plain = module.get_mol(withoutStereo(smiles), JSON.stringify({ removeHs: true }));
  try {
    const canonical = plain?.get_smiles?.();
    if (!canonical) throw new Error("RDKit could not verify the structure without stereo.");
    return { withoutStereo: canonical, isotopeAtoms: atomProperties("isotope"),
      chargedAtoms: atomProperties("chg") };
  } finally { plain?.delete(); }
}

/** Remove ordinary explicit H equally on both sides; RDKit retains isotope-labelled hydrogens. */
export function inspectHydrogenNormalizedIdentity(
  module: Pick<RdkitMinimalModule, "get_mol">, value: string, stereoReference?: string
): Awaited<ReturnType<InspectChemicalIdentity>> {
  const molecule = module.get_mol(value, JSON.stringify({ removeHs: true }));
  if (!molecule) return { valid: false, reason: "RDKit could not verify the structure." };
  try {
    const refusal = unverifiableStereoReason(module, stereoReference ?? value);
    if (refusal) return { valid: false, reason: refusal };
    const canonicalSmiles = molecule.get_smiles?.();
    if (!canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
    const facts = chemicalIdentityFacts(module, molecule, canonicalSmiles);
    return { valid: true, facts, canonicalSmiles: stereoReference && canonicalSmiles !== stereoReference
      ? identityOnSpecifiedStereo(module, molecule, canonicalSmiles, stereoReference) : canonicalSmiles };
  } finally { molecule.delete(); }
}

/** Match whole graphs with RDKit, including every stereo element the source specifies. Neither
 * atom order nor bond order in a depiction is assumed to be the same as the source SMILES. */
function identityOnSpecifiedStereo(
  module: Pick<RdkitMinimalModule, "get_mol">, output: RdkitJsMol, actual: string, reference: string
): string {
  const parse = (value: string) => module.get_mol(value, JSON.stringify({ removeHs: true }));
  const source = parse(reference);
  const sourcePlain = parse(withoutStereo(reference));
  const outputPlain = parse(withoutStereo(actual));
  try {
    // This equality requires atoms, H counts, radicals, isotopes, charges, connectivity and orders
    // to match exactly. Substructure matching alone would also accept proper subgraphs.
    if (!source || !sourcePlain || !outputPlain) throw new Error("RDKit could not verify the structure.");
    const sourceIdentity = sourcePlain.get_smiles?.(), outputIdentity = outputPlain.get_smiles?.();
    if (!sourceIdentity || !outputIdentity) throw new Error("RDKit did not return a canonical SMILES.");
    if (sourceIdentity !== outputIdentity) return actual;
    const matcher = output as RdkitJsMol & {
      get_substruct_matches?(query: RdkitJsMol, options: string): string;
    };
    if (!matcher.get_substruct_matches || !source.get_molblock || !output.get_molblock) {
      throw new Error("RDKit could not establish atom/bond correspondence for stereo verification.");
    }
    // Chirality-aware full-graph matches allow extra output stereo only where the source has none.
    // RDKit checks tetrahedral and E/Z stereo, and handles symmetry without an atom-order guess.
    const matches = JSON.parse(matcher.get_substruct_matches(source,
      JSON.stringify({ useChirality: true, maxMatches: 1 }))) as { atoms: number[]; bonds: number[] }[];
    const match = matches[0];
    if (!match) return actual;
    if (!Array.isArray(match.atoms) || !Array.isArray(match.bonds) ||
      [...match.atoms, ...match.bonds].some(index => !Number.isInteger(index) || index < 0)) {
      throw new Error("RDKit could not establish atom/bond correspondence for stereo verification.");
    }
    const semantics = sourceBondSemantics(source.get_molblock());
    const unspecified = new Set(semantics.unspecifiedDoubleBondIndices.map(index => {
      const mapped = match.bonds[index];
      if (!Number.isInteger(mapped)) {
        throw new Error("RDKit could not establish bond correspondence for unspecified E/Z.");
      }
      return mapped!;
    }));
    // Keep the same unknown-E/Z CTAB policy as the CLI, including native 'either' bonds.
    const masked = parse(markV2000UnspecifiedDoubleBonds(output.get_molblock(), unspecified));
    try {
      if (!masked) throw new Error("RDKit could not verify the stereo-masked structure.");
      const maskedMatcher = masked as typeof matcher;
      const verified = JSON.parse(maskedMatcher.get_substruct_matches!(source,
        JSON.stringify({ useChirality: true, maxMatches: 1 }))) as unknown[];
      // Extra tetrahedral stereo is also unspecified in the source and must not become a mismatch.
      return verified.length ? reference : actual;
    } finally { masked?.delete(); }
  } finally {
    source?.delete(); sourcePlain?.delete(); outputPlain?.delete();
  }
}

export class ChemicalIdentityMismatchError extends Error {
  readonly difference: string;

  constructor(
    moleculeId: string, source: string, output: string,
    sourceFacts?: ChemicalIdentityFacts, outputFacts?: ChemicalIdentityFacts
  ) {
    const stereoOnly = (sourceFacts?.withoutStereo ?? withoutStereo(source)) ===
      (outputFacts?.withoutStereo ?? withoutStereo(output));
    const differences = stereoOnly ? ["stereochemistry"] : [
      sourceFacts && outputFacts && sourceFacts.isotopeAtoms !== outputFacts.isotopeAtoms
        ? "isotope labels or their positions" : undefined,
      sourceFacts && outputFacts && sourceFacts.chargedAtoms !== outputFacts.chargedAtoms
        ? "charges" : undefined
    ].filter(Boolean);
    const difference = differences.join(", ") || "chemical identity";
    super(`Canonical SMILES mismatch for ${moleculeId}; refusing a change to chemical identity ` +
      `(${difference}): ${source} -> ${output}.`);
    this.name = "ChemicalIdentityMismatchError";
    this.difference = difference;
  }
}

/** Verify the actual native graph, including stereo and isotope positions, with the caller's engine. */
export async function assertMoleculeMatchesSmiles(
  molecule: MoleculeObject,
  input: string,
  inspect: InspectChemicalIdentity
): Promise<void> {
  const source = await inspect("smiles", input);
  if (!source.valid) throw new Error(source.reason);
  if (!source.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  const warnings: string[] = [];
  const molfile = stereoPerceptionMolfile(molecule, warnings);
  if (warnings.length) throw new Error(warnings.join(" "));
  const output = await inspect("molfile", molfile, source.canonicalSmiles);
  if (!output.valid) throw new Error(output.reason);
  if (!output.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  if (source.canonicalSmiles !== output.canonicalSmiles) {
    throw new ChemicalIdentityMismatchError(molecule.id, source.canonicalSmiles, output.canonicalSmiles,
      source.facts, output.facts);
  }
}
