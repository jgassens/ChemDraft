import type { MoleculeObject } from "@chemdraft/chem-core";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import type { StereoEngine } from "./stereoReadout";

/**
 * Clean Up 2D stereo guard (1.2.4 stopgap; a stereo-aware layout is the 1.3 fix).
 *
 * The polygon-and-tree layout behind Clean Up 2D keeps wedges but lays rings out with a fixed
 * winding, so a molecule can come back as a different stereoisomer. This guard reads the CIP
 * descriptors of the molecule before and after that layout with the app's existing OpenChemLib
 * perceivers (the same ones the stereo readout uses, on the same `stereoPerceptionMolfile`). If
 * any stereocenter or stereo double bond reads differently, or gains or loses a definition, the
 * caller keeps that molecule exactly as drawn.
 *
 * Comparison is by drawn identity, not by a SMILES string: centers are keyed by atom id and
 * double bonds by bond id. `stereoPerceptionMolfile` writes atoms in document order and the
 * perceivers report in that input order, so index i is `molecule.atoms[i]`.
 */

/** Why the guard kept a molecule as drawn. */
export type CleanUpStereoRefusal = "changed" | "unchecked";

export interface CleanUpStereoSignature {
  /** Every atom the engine calls a stereocenter, with its CIP descriptor or "unspecified". */
  centers: ReadonlyMap<string, "R" | "S" | "unspecified">;
  /** Every double bond with a defined geometry, with its CIP descriptor. */
  doubleBonds: ReadonlyMap<string, "E" | "Z" | "unspecified">;
}

/** CIP stereo of a drawn molecule, keyed by atom and bond id. Throws when it cannot be read. */
export function cleanUpStereoSignature(molecule: MoleculeObject, engine: StereoEngine): CleanUpStereoSignature {
  const molfile = stereoPerceptionMolfile(molecule);
  const centers = new Map<string, "R" | "S" | "unspecified">();
  const perceivedCenters = engine.perceiveStereoCentersFromMolfile(molfile);
  if (perceivedCenters.length !== molecule.atoms.length) {
    throw new Error("Stereo perception did not align with the drawn atoms.");
  }
  perceivedCenters.forEach((center, index) => {
    if (center.isStereoCenter) centers.set(molecule.atoms[index]!.id, center.descriptor);
  });
  const bondIdByPair = new Map<string, string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const bond of molecule.bonds) bondIdByPair.set(pairKey(bond.fromAtomId, bond.toAtomId), bond.id);
  const doubleBonds = new Map<string, "E" | "Z" | "unspecified">();
  for (const entry of engine.perceiveDoubleBondStereoFromMolfile(molfile)) {
    const from = molecule.atoms[entry.from]?.id;
    const to = molecule.atoms[entry.to]?.id;
    const bondId = from && to ? bondIdByPair.get(pairKey(from, to)) : undefined;
    if (!bondId) throw new Error("Stereo perception reported a double bond that is not drawn.");
    doubleBonds.set(bondId, entry.descriptor);
  }
  return { centers, doubleBonds };
}

function sameEntries<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

/** True when two signatures describe the same stereoisomer, center by center and bond by bond. */
export function sameCleanUpStereo(before: CleanUpStereoSignature, after: CleanUpStereoSignature): boolean {
  return sameEntries(before.centers, after.centers) && sameEntries(before.doubleBonds, after.doubleBonds);
}

/** Pairs of atom ids the layout puts on top of each other (the app's layout-quality check). */
export type CoincidentAtomPairs = (molecule: MoleculeObject) => readonly (readonly [string, string])[];

/**
 * Decide whether a cleaned-up molecule may replace the drawn one. Returns undefined when its
 * stereo reads the same, "changed" when any descriptor flipped or was gained or lost, and
 * "unchecked" when the drawing's stereo could not be read at all (an engine failure). The caller
 * keeps the drawn molecule for either refusal. Pure apart from the injected engine.
 *
 * `coincidentAtoms`, when given, also refuses a layout that newly puts an atom of a stereocenter
 * or stereo double bond, or one of their neighbors, on top of another atom. The perceivers do not
 * agree on such a drawing (OpenChemLib may still read R where RDKit reads no stereo at all, and
 * Copy As SMILES then drops it), so it cannot be trusted to carry the stereo.
 */
export function cleanUpStereoRefusal(
  before: MoleculeObject, after: MoleculeObject, engine: StereoEngine, coincidentAtoms?: CoincidentAtomPairs
): CleanUpStereoRefusal | undefined {
  let reference: CleanUpStereoSignature;
  try {
    reference = cleanUpStereoSignature(before, engine);
  } catch {
    return "unchecked";
  }
  try {
    if (!sameCleanUpStereo(reference, cleanUpStereoSignature(after, engine))) return "changed";
  } catch {
    // The drawing read fine before the layout and not after: do not trust the layout.
    return "changed";
  }
  if (!coincidentAtoms) return undefined;
  const stereoAtoms = new Set(reference.centers.keys());
  for (const bond of after.bonds) {
    if (reference.doubleBonds.has(bond.id)) stereoAtoms.add(bond.fromAtomId).add(bond.toAtomId);
  }
  const watched = new Set(stereoAtoms);
  for (const bond of after.bonds) {
    if (stereoAtoms.has(bond.fromAtomId)) watched.add(bond.toAtomId);
    if (stereoAtoms.has(bond.toAtomId)) watched.add(bond.fromAtomId);
  }
  const pairKey = ([a, b]: readonly [string, string]) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const existing = new Set(coincidentAtoms(before).map(pairKey));
  return coincidentAtoms(after).some(pair => !existing.has(pairKey(pair)) && (watched.has(pair[0]) || watched.has(pair[1])))
    ? "changed" : undefined;
}

/** Plain-words status for molecules the guard kept as drawn; undefined when none were. */
export function cleanUpStereoSkipStatus(
  skipped: readonly { reason: CleanUpStereoRefusal }[]
): string | undefined {
  if (skipped.length === 0) return undefined;
  const changed = skipped.filter(entry => entry.reason === "changed").length;
  const unchecked = skipped.length - changed;
  const count = (n: number) => `${n} ${n === 1 ? "structure" : "structures"}`;
  const parts: string[] = [];
  if (changed > 0) {
    parts.push(`Clean Up skipped ${count(changed)}: tidying ${changed === 1 ? "it" : "them"} would have changed ${changed === 1 ? "its" : "their"} stereochemistry.`);
  }
  if (unchecked > 0) {
    parts.push(`Clean Up skipped ${count(unchecked)}: ${unchecked === 1 ? "its" : "their"} stereochemistry couldn't be checked.`);
  }
  return parts.join(" ");
}
