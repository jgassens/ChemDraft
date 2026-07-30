/**
 * One parse, many named interpretations (PLANS.md §1).
 *
 * Parsing and sanitising once through RDKit is right; applying **one** normalised representation to
 * every calculation is not. Formula, charge, and isotope composition must describe what the user
 * *drew*. logP may legitimately want a neutralised largest organic fragment. pKa requires tautomer and
 * protomer enumeration. **Sodium benzoate must never silently become benzoic acid because a predictor
 * prefers neutrals.**
 *
 * So: parse once → preserve the source representation → derive explicitly named interpretations →
 * calculate against a specified interpretation.
 *
 * This module is engine-neutral. It holds the ledger types, the atom-mapping algebra, and the hashing
 * that makes cache keys — no RDKit, no OpenChemLib. The adapters build interpretations; everything
 * downstream consumes them.
 */
import { z } from "zod";

// --- atom mapping ----------------------------------------------------------------------------

/**
 * Ordered `[sourceAtomIndex, derivedAtomIndex]` pairs.
 *
 * **This is load-bearing, not bookkeeping.** Per-atom results — a pKa site, an NMR shift, a
 * highlighted substructure — must map back to the atoms the user actually drew. Without the mapping,
 * every per-atom feature silently breaks the moment an interpretation reindexes, and it breaks
 * *quietly*: the highlight lands on the wrong atom rather than failing.
 *
 * A source atom with no derived counterpart (a stripped counterion) simply has no pair. A derived atom
 * with no source counterpart (an added hydrogen) likewise.
 */
export type AtomMapping = ReadonlyArray<readonly [sourceIdx: number, derivedIdx: number]>;

export const AtomMappingSchema: z.ZodType<AtomMapping> = z.array(
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
);

/**
 * Compose two mappings: source → intermediate, then intermediate → derived, giving source → derived.
 *
 * The ledger is *ordered*, so a result computed on the final representation is several transformations
 * away from the atoms on screen. Composition is how a shift on atom 3 of a hydrogenated, neutralised,
 * largest-organic-fragment molecule becomes a highlight on atom 11 of the drawing. Atoms dropped by
 * either step drop from the composition — which is the correct answer, not an error.
 */
export function composeAtomMappings(first: AtomMapping, second: AtomMapping): AtomMapping {
  const intermediateToDerived = new Map<number, number>();
  for (const [intermediateIdx, derivedIdx] of second) intermediateToDerived.set(intermediateIdx, derivedIdx);

  const composed: [number, number][] = [];
  for (const [sourceIdx, intermediateIdx] of first) {
    const derivedIdx = intermediateToDerived.get(intermediateIdx);
    if (derivedIdx !== undefined) composed.push([sourceIdx, derivedIdx]);
  }
  return composed;
}

/** Compose a whole ledger, in order, into one source → final-representation mapping. */
export function composeTransformationChain(transformations: readonly Transformation[]): AtomMapping {
  if (transformations.length === 0) return [];
  return transformations
    .map((transformation) => transformation.atomMapping)
    .reduce((accumulated, next) => composeAtomMappings(accumulated, next));
}

/** Identity mapping over `atomCount` atoms — the ledger entry for a transformation that reindexes nothing. */
export function identityAtomMapping(atomCount: number): AtomMapping {
  return Array.from({ length: atomCount }, (_unused, index) => [index, index] as const);
}

export function mapSourceToDerived(mapping: AtomMapping, sourceIdx: number): number | undefined {
  return mapping.find(([source]) => source === sourceIdx)?.[1];
}

export function mapDerivedToSource(mapping: AtomMapping, derivedIdx: number): number | undefined {
  return mapping.find(([, derived]) => derived === derivedIdx)?.[0];
}

/** Invert a mapping. Used to carry a derived-space result back to source space in bulk. */
export function invertAtomMapping(mapping: AtomMapping): AtomMapping {
  return mapping.map(([source, derived]) => [derived, source] as const);
}

// --- transformations -------------------------------------------------------------------------

/**
 * One step in the ledger: what a derivation did, in auditable terms.
 *
 * The counters are not statistics for their own sake — they are what a UI turns into "counterion
 * removed", "1 charge neutralised", "tautomer changed". `unrepresentableFeatures` is the escape hatch
 * that keeps a lossy step honest: whatever the engine could not carry across is named, not dropped.
 */
export interface Transformation {
  name: string;
  version: string;
  atomMapping: AtomMapping;
  componentsRemoved: string[];
  componentsRetained: string[];
  componentsNeutralized: string[];
  bondOrderChanges: number;
  aromaticityChanges: number;
  hydrogenChanges: number;
  tautomerChanged: boolean;
  chargeChanges: number;
  unrepresentableFeatures: string[];
}

export const TransformationSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    atomMapping: AtomMappingSchema,
    componentsRemoved: z.array(z.string()).default([]),
    componentsRetained: z.array(z.string()).default([]),
    componentsNeutralized: z.array(z.string()).default([]),
    bondOrderChanges: z.number().int().nonnegative().default(0),
    aromaticityChanges: z.number().int().nonnegative().default(0),
    hydrogenChanges: z.number().int().default(0),
    tautomerChanged: z.boolean().default(false),
    chargeChanges: z.number().int().default(0),
    unrepresentableFeatures: z.array(z.string()).default([])
  })
  .strict();

/** True when the step altered chemical identity as a user would judge it. Drives the UI disclosure. */
export function changesChemicalIdentity(transformation: Transformation): boolean {
  return (
    transformation.componentsRemoved.length > 0 ||
    transformation.componentsNeutralized.length > 0 ||
    transformation.tautomerChanged ||
    transformation.chargeChanges !== 0 ||
    transformation.bondOrderChanges > 0
  );
}

// --- policies --------------------------------------------------------------------------------

export type ComponentPolicy =
  | "whole-input"
  | "largest-organic-fragment"
  | "per-component"
  | "reject-multicomponent";

export const ComponentPolicySchema = z.enum([
  "whole-input",
  "largest-organic-fragment",
  "per-component",
  "reject-multicomponent"
]);

// --- the interpretation ----------------------------------------------------------------------

export interface MolecularInterpretation {
  /** "source", "largest-organic-fragment", "neutralized", … — stable, referenced by every result. */
  id: string;
  /** Shown in the UI: "largest organic fragment · counterion removed". */
  label: string;
  sourceHash: string;
  interpretationHash: string;
  componentPolicy: ComponentPolicy;
  explicitHydrogenPolicy: string;
  isotopePolicy: string;
  aromaticityModel: string;
  /**
   * REQUIRED for tautomer-sensitive methods. Wrong-tautomer NMR prediction is the classic
   * silent-wrong-answer case, so `assertTautomerPolicy` below is called at method-registration time
   * for anything that declares tautomer sensitivity.
   */
  tautomerPolicy?: string;
  protomerPolicy?: string;
  conformerId?: string;
  /** Ordered. Compose with `composeTransformationChain` to reach source atom indices. */
  transformations: Transformation[];
}

export const MolecularInterpretationSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    sourceHash: z.string().min(1),
    interpretationHash: z.string().min(1),
    componentPolicy: ComponentPolicySchema,
    explicitHydrogenPolicy: z.string().min(1),
    isotopePolicy: z.string().min(1),
    aromaticityModel: z.string().min(1),
    tautomerPolicy: z.string().min(1).optional(),
    protomerPolicy: z.string().min(1).optional(),
    conformerId: z.string().min(1).optional(),
    transformations: z.array(TransformationSchema).default([])
  })
  .strict();

/** The id every source-preserving interpretation uses. Composition and mass are computed against it. */
export const SOURCE_INTERPRETATION_ID = "source";

/**
 * Enforce §1's non-optional rule at the point where a tautomer-sensitive method meets an
 * interpretation. The type system cannot express "optional except for these methods", so this is the
 * registration-time check the plan calls for.
 */
export function assertTautomerPolicy(
  interpretation: MolecularInterpretation,
  methodId: string
): asserts interpretation is MolecularInterpretation & { tautomerPolicy: string } {
  if (!interpretation.tautomerPolicy) {
    throw new Error(
      `Method "${methodId}" is tautomer-sensitive but interpretation "${interpretation.id}" declares no ` +
        "tautomerPolicy. Declare one (even \"as-drawn\") rather than leaving it implicit."
    );
  }
}

/** Whether any step in the ledger altered chemical identity — the trigger for the UI's "— change" affordance. */
export function interpretationChangesIdentity(interpretation: MolecularInterpretation): boolean {
  return interpretation.transformations.some(changesChemicalIdentity);
}

/** Source atom indices for a result computed in this interpretation's atom space. */
export function sourceAtomsFor(
  interpretation: MolecularInterpretation,
  derivedAtomIndices: readonly number[]
): number[] {
  const composed = composeTransformationChain(interpretation.transformations);
  const derivedToSource = new Map<number, number>();
  for (const [source, derived] of composed) derivedToSource.set(derived, source);
  return derivedAtomIndices
    .map((derived) => derivedToSource.get(derived))
    .filter((source): source is number => source !== undefined);
}

// --- hashing ---------------------------------------------------------------------------------

/**
 * FNV-1a, 64-bit, hex, algorithm-tagged.
 *
 * These hashes are **identity and cache keys, not digests**: they answer "have I already computed this
 * exact thing?" and nothing else. The tag is in the string so a later move to a real digest is a
 * visible format change rather than a silent one, and so a reader never mistakes one for a checksum.
 *
 * Synchronous on purpose — SubtleCrypto is async and would make every cache lookup a promise, in a
 * package whose whole job is to be cheap enough to call on every keystroke.
 */
export function analysisHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash ^ BigInt(input.charCodeAt(index))) & mask;
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/** Hash of the structure exactly as it entered — format included, because the same text in two formats is two inputs. */
export function hashSource(format: string, value: string): string {
  return analysisHash(`${format} ${value}`);
}

/**
 * Hash of an interpretation's *policy*, not its transient fields.
 *
 * Deliberately excludes `label` (display text can change without changing the chemistry) and the
 * transformation counters (outputs of applying the policy, not inputs to it). Two interpretations with
 * the same source and the same policy must produce the same key, or the session cache never hits.
 */
export function hashInterpretation(
  interpretation: Omit<MolecularInterpretation, "interpretationHash" | "label">
): string {
  return analysisHash(
    [
      interpretation.sourceHash,
      interpretation.id,
      interpretation.componentPolicy,
      interpretation.explicitHydrogenPolicy,
      interpretation.isotopePolicy,
      interpretation.aromaticityModel,
      interpretation.tautomerPolicy ?? "",
      interpretation.protomerPolicy ?? "",
      interpretation.conformerId ?? "",
      interpretation.transformations.map((step) => `${step.name}@${step.version}`).join(">")
    ].join(" ")
  );
}

/**
 * The §1 cache key: source hash + interpretation hash + method + parameters + engine/model/data hashes.
 *
 * Parameters are serialised with sorted keys so `{a:1,b:2}` and `{b:2,a:1}` are one key. Getting that
 * wrong halves the hit rate without ever being wrong enough to notice.
 */
export function analysisCacheKey(input: {
  sourceHash: string;
  interpretationHash: string;
  methodId: string;
  methodVersion: string;
  parameters?: Record<string, unknown>;
  engineHashes?: readonly string[];
}): string {
  const parameters = input.parameters ?? {};
  const serialisedParameters = Object.keys(parameters)
    .sort()
    .map((key) => `${key}=${JSON.stringify(parameters[key])}`)
    .join(",");
  return analysisHash(
    [
      input.sourceHash,
      input.interpretationHash,
      input.methodId,
      input.methodVersion,
      serialisedParameters,
      [...(input.engineHashes ?? [])].sort().join(",")
    ].join(" ")
  );
}
