/**
 * Phase 1C — stereo oracle boundary (dev-only).
 *
 * The plan's hard requirement: a second, INDEPENDENT engine (RDKit) cross-checks
 * that a flatten preserved chemical identity — but it must do so without ever
 * corrupting the molecule under test. RDKit's `AssignStereochemistryFrom3D` has a
 * footgun: called with `replaceExistingTags=True` it OVERWRITES the molecule's
 * existing stereo tags in place. If the oracle ran that on the live product
 * molecule, it would mutate the very thing it is supposed to validate — a silent
 * correlated failure.
 *
 * This module is the DISCIPLINE BARRIER that makes that impossible by construction:
 * the oracle deep-clones every input before handing it to an engine, so an engine
 * may freely mutate what it receives (a throwaway copy) and the caller's molecule
 * and coordinates are guaranteed untouched. The contract is enforced by a hard
 * test (`oracle.test.ts`) using a deliberately-mutating mock engine.
 *
 * WHAT IS AND ISN'T HERE — honesty:
 *   • Here, fully tested: the clone barrier + the engine contract + a mock engine.
 *   • NOT here: a concrete RDKit-backed engine. This environment has no RDKit
 *     (python or native) and shipping an UNTESTED chemistry bridge would defeat the
 *     purpose. A real engine is a drop-in `StereoPerceptionEngine` implementation
 *     that, internally, builds an RWMol on a copy and calls
 *     `AssignStereochemistryFrom3D(replaceExistingTags=False)`. It must pass the
 *     exact same non-mutation contract test as the mock.
 */

import type { MoleculeObject } from "./schemas";

/** Perceived configuration at one center, in engine-neutral terms. */
export interface PerceivedStereoCenter {
  atomId: string;
  /** CIP descriptor when the engine perceives one; `"unspecified"` if none; `"unknown"` if not perceivable. */
  descriptor: "R" | "S" | "unspecified" | "unknown";
}

export interface StereoPerception {
  centers: PerceivedStereoCenter[];
  /** Engine-reported notes (e.g. "AssignStereochemistryFrom3D replaceExistingTags=false"). */
  notes: string[];
}

/**
 * The engine contract. An implementation receives a PRIVATE COPY of the molecule
 * and coordinates and MAY mutate them freely — the oracle guarantees they are
 * throwaway. A real RDKit engine builds its own RWMol from this copy.
 */
export interface StereoPerceptionEngine {
  readonly name: string;
  perceiveFrom3D(molCopy: MoleculeObject, coords3dCopy: number[]): StereoPerception;
}

/** Structured-clone deep copy (Node ≥17 / modern browsers provide `structuredClone`). */
function deepCloneMolecule(mol: MoleculeObject): MoleculeObject {
  if (typeof structuredClone === "function") return structuredClone(mol);
  return JSON.parse(JSON.stringify(mol)) as MoleculeObject;
}

export interface OraclePerceptionResult {
  engine: string;
  perception: StereoPerception;
}

/**
 * Run an engine through the clone barrier. The caller's `mol` and `coords3d` are
 * NEVER passed to the engine directly, so the engine cannot mutate them. This is
 * the "works on copies / never overwrites the product molecule's stereo" guarantee.
 */
export function perceiveStereoWithOracle(
  engine: StereoPerceptionEngine,
  mol: MoleculeObject,
  coords3d: ArrayLike<number>
): OraclePerceptionResult {
  const molCopy = deepCloneMolecule(mol);
  const coordsCopy = Array.from(coords3d);
  const perception = engine.perceiveFrom3D(molCopy, coordsCopy);
  return { engine: engine.name, perception };
}

/** Compare two perceptions center-by-center; used by the corpus oracle cross-check. */
export interface PerceptionDiff {
  identical: boolean;
  invertedCenters: string[];
  lostCenters: string[]; // specified → unspecified/unknown
  gainedCenters: string[]; // unspecified/unknown → specified
}

function descriptorIsSpecified(d: PerceivedStereoCenter["descriptor"]): boolean {
  return d === "R" || d === "S";
}

export function diffPerceptions(before: StereoPerception, after: StereoPerception): PerceptionDiff {
  const beforeById = new Map(before.centers.map((c) => [c.atomId, c.descriptor]));
  const afterById = new Map(after.centers.map((c) => [c.atomId, c.descriptor]));
  const atomIds = new Set<string>([...beforeById.keys(), ...afterById.keys()]);

  const invertedCenters: string[] = [];
  const lostCenters: string[] = [];
  const gainedCenters: string[] = [];

  for (const atomId of atomIds) {
    const b = beforeById.get(atomId) ?? "unknown";
    const a = afterById.get(atomId) ?? "unknown";
    const bSpec = descriptorIsSpecified(b);
    const aSpec = descriptorIsSpecified(a);
    if (bSpec && aSpec && b !== a) invertedCenters.push(atomId);
    else if (bSpec && !aSpec) lostCenters.push(atomId);
    else if (!bSpec && aSpec) gainedCenters.push(atomId);
  }

  const identical =
    invertedCenters.length === 0 && lostCenters.length === 0 && gainedCenters.length === 0;
  return { identical, invertedCenters, lostCenters, gainedCenters };
}
