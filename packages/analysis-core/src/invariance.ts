/**
 * Representation-invariance property testing (PLANS.md §10, verification layer 5).
 *
 * "Implemented as property-based testing over SMILES permutations, atom renumberings, Kekulé vs
 * aromatic forms, and hydrogen styles. → Phase 1, because this harness is what actually validates the
 * interpretation ledger."
 *
 * The property: **a descriptor of a molecule may not depend on how the molecule was written down.**
 * If TPSA changes when the SMILES is rooted at a different atom, something in the pipeline is reading
 * input order rather than structure — and that class of bug is invisible to fixture tests, because a
 * fixture only ever exercises one spelling.
 *
 * The harness is engine-neutral on purpose. It takes variants and a compute function; Phase 2 supplies
 * the RDKit-backed variant generator. That keeps `analysis-core` free of engine imports and makes the
 * same harness reusable for the OpenChemLib comparison path.
 *
 * Per-atom results get `checkAtomIndexedInvariance`, which is the stricter and more useful test:
 * values must not merely agree as a multiset, they must land on the *same atoms* once mapped back
 * through the ledger. That is the check that fails when an interpretation reindexes without updating
 * its mapping.
 */

export type VariantKind =
  | "canonical"
  | "atom-renumbering"
  | "smiles-permutation"
  | "kekule"
  | "aromatic"
  | "explicit-hydrogens"
  | "implicit-hydrogens";

export interface RepresentationVariant {
  id: string;
  kind: VariantKind;
  /** The structure text in `format`. */
  value: string;
  format: "smiles" | "molfile-v2000" | "molfile-v3000";
  /**
   * variant atom index → reference atom index. Required for atom-indexed checks, because a renumbered
   * variant's atom 0 is not the reference's atom 0 — that is the entire point of the variant.
   */
  atomToReferenceAtom?: readonly number[];
}

export interface InvarianceDeviation<T> {
  variantId: string;
  kind: VariantKind;
  expected: T;
  actual: T;
  /** Absolute difference, for numeric comparisons. */
  delta?: number;
}

export interface InvarianceReport<T> {
  /** The value every variant is compared against — the reference representation's result. */
  reference: T;
  variantCount: number;
  deviations: InvarianceDeviation<T>[];
  /** Variants whose computation threw or returned nothing. Distinct from disagreeing. */
  errors: { variantId: string; kind: VariantKind; message: string }[];
  invariant: boolean;
}

export interface InvarianceOptions<T> {
  /**
   * Absolute tolerance for numeric comparison. Defaults to exact equality, which is the right default:
   * a descriptor computed twice on the same engine from equivalent inputs should be bit-identical, and
   * a loose default hides real order-dependence behind floating-point excuses. Widen deliberately, per
   * method, when an engine documents a nondeterministic path.
   */
  tolerance?: number;
  /** Override for non-numeric payloads. Defaults to `Object.is` for primitives, deep-equal for arrays. */
  equals?: (a: T, b: T) => boolean;
}

function defaultEquals<T>(a: T, b: T, tolerance: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= tolerance;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => defaultEquals(item, b[index], tolerance));
  }
  return Object.is(a, b);
}

/**
 * Compute `value` for the reference and every variant, and report every disagreement.
 *
 * Deliberately reports *all* deviations rather than throwing on the first. Which variant kinds fail is
 * the diagnostic: only-Kekulé points at aromaticity perception, only-renumbering points at atom order,
 * everything-fails points at the method.
 */
export function checkInvariance<T>(
  reference: RepresentationVariant,
  variants: readonly RepresentationVariant[],
  compute: (variant: RepresentationVariant) => T,
  options: InvarianceOptions<T> = {}
): InvarianceReport<T> {
  const tolerance = options.tolerance ?? 0;
  const equals = options.equals ?? ((a: T, b: T) => defaultEquals(a, b, tolerance));

  const referenceValue = compute(reference);
  const deviations: InvarianceDeviation<T>[] = [];
  const errors: InvarianceReport<T>["errors"] = [];

  for (const variant of variants) {
    let actual: T;
    try {
      actual = compute(variant);
    } catch (error) {
      errors.push({
        variantId: variant.id,
        kind: variant.kind,
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (!equals(referenceValue, actual)) {
      const delta =
        typeof referenceValue === "number" && typeof actual === "number"
          ? Math.abs(referenceValue - actual)
          : undefined;
      deviations.push({ variantId: variant.id, kind: variant.kind, expected: referenceValue, actual, ...(delta !== undefined ? { delta } : {}) });
    }
  }

  return {
    reference: referenceValue,
    variantCount: variants.length,
    deviations,
    errors,
    invariant: deviations.length === 0 && errors.length === 0
  };
}

export interface AtomIndexedDeviation {
  variantId: string;
  kind: VariantKind;
  referenceAtom: number;
  expected: number;
  actual: number | undefined;
  delta?: number;
}

export interface AtomIndexedInvarianceReport {
  variantCount: number;
  deviations: AtomIndexedDeviation[];
  /** Variants that arrived without the mapping an atom-indexed check requires. */
  unmappedVariants: string[];
  errors: { variantId: string; kind: VariantKind; message: string }[];
  invariant: boolean;
}

/**
 * The stricter check: per-atom values must land on the *same atoms* after mapping back to the
 * reference numbering.
 *
 * A multiset comparison would pass a pipeline that computed the right thirteen shifts and assigned
 * every one of them to the wrong carbon. This is the test that does not.
 */
export function checkAtomIndexedInvariance(
  reference: RepresentationVariant,
  variants: readonly RepresentationVariant[],
  computePerAtom: (variant: RepresentationVariant) => readonly number[],
  options: { tolerance?: number } = {}
): AtomIndexedInvarianceReport {
  const tolerance = options.tolerance ?? 0;
  const referenceValues = computePerAtom(reference);
  const deviations: AtomIndexedDeviation[] = [];
  const unmappedVariants: string[] = [];
  const errors: AtomIndexedInvarianceReport["errors"] = [];

  for (const variant of variants) {
    if (!variant.atomToReferenceAtom) {
      unmappedVariants.push(variant.id);
      continue;
    }
    let values: readonly number[];
    try {
      values = computePerAtom(variant);
    } catch (error) {
      errors.push({
        variantId: variant.id,
        kind: variant.kind,
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const byReferenceAtom = new Map<number, number>();
    for (const [variantAtom, referenceAtom] of variant.atomToReferenceAtom.entries()) {
      const value = values[variantAtom];
      if (value !== undefined) byReferenceAtom.set(referenceAtom, value);
    }

    for (const [referenceAtom, expected] of referenceValues.entries()) {
      const actual = byReferenceAtom.get(referenceAtom);
      // NaN is a DEVIATION, not a pass. Every comparison against NaN is false, so
      // `Math.abs(NaN - 5) > tolerance` was false and a reference value of NaN beside a variant value
      // of 5 recorded nothing and left `invariant` true — in the function whose own doc calls it "the
      // test that does not" pass a pipeline that assigned values to the wrong atoms. NaN is exactly
      // what a broken per-atom pipeline produces. `defaultEquals` in this same module gets it right
      // with an explicit `Number.isNaN` pair check, so the two halves disagreed about the one input
      // that matters most. Two NaNs still agree, matching `defaultEquals`.
      const bothNaN = Number.isNaN(expected) && actual !== undefined && Number.isNaN(actual);
      const differs =
        actual === undefined ||
        (!bothNaN && !(Math.abs(expected - actual) <= tolerance));
      if (differs) {
        deviations.push({
          variantId: variant.id,
          kind: variant.kind,
          referenceAtom,
          expected,
          actual,
          ...(actual !== undefined ? { delta: Math.abs(expected - actual) } : {})
        });
      }
    }
  }

  return {
    variantCount: variants.length,
    deviations,
    unmappedVariants,
    errors,
    invariant: deviations.length === 0 && unmappedVariants.length === 0 && errors.length === 0
  };
}

/** Human-readable failure text for a test assertion. Groups by variant kind, which is the diagnostic. */
export function describeInvarianceFailure<T>(report: InvarianceReport<T>): string {
  if (report.invariant) return "invariant";
  const lines: string[] = [];
  const byKind = new Map<VariantKind, InvarianceDeviation<T>[]>();
  for (const deviation of report.deviations) {
    const bucket = byKind.get(deviation.kind) ?? [];
    bucket.push(deviation);
    byKind.set(deviation.kind, bucket);
  }
  for (const [kind, deviationsOfKind] of byKind) {
    lines.push(
      `${kind}: ${deviationsOfKind.length}/${report.variantCount} disagreed ` +
        `(e.g. ${deviationsOfKind[0]!.variantId}: expected ${String(deviationsOfKind[0]!.expected)}, got ${String(deviationsOfKind[0]!.actual)})`
    );
  }
  for (const error of report.errors) {
    lines.push(`${error.kind}: ${error.variantId} threw — ${error.message}`);
  }
  return lines.join("\n");
}
