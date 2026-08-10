import { describe, expect, it } from "vitest";

import {
  checkAtomIndexedInvariance,
  checkInvariance,
  describeInvarianceFailure,
  type RepresentationVariant
} from "./invariance";

const reference: RepresentationVariant = {
  id: "aspirin-canonical",
  kind: "canonical",
  value: "CC(=O)Oc1ccccc1C(=O)O",
  format: "smiles",
  atomToReferenceAtom: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
};

const variants: RepresentationVariant[] = [
  {
    id: "aspirin-rooted-elsewhere",
    kind: "smiles-permutation",
    value: "O=C(O)c1ccccc1OC(C)=O",
    format: "smiles",
    atomToReferenceAtom: [11, 12, 10, 9, 8, 7, 6, 5, 4, 3, 0, 1, 2]
  },
  {
    id: "aspirin-kekule",
    kind: "kekule",
    value: "CC(=O)OC1=CC=CC=C1C(=O)O",
    format: "smiles",
    atomToReferenceAtom: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  },
  {
    id: "aspirin-explicit-h",
    kind: "explicit-hydrogens",
    value: "[CH3][C](=O)O[c]1[cH][cH][cH][cH][c]1[C](=O)[OH]",
    format: "smiles",
    atomToReferenceAtom: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  }
];

describe("checkInvariance", () => {
  it("passes when every representation gives the same number", () => {
    const report = checkInvariance(reference, variants, () => 63.6);
    expect(report.invariant).toBe(true);
    expect(report.reference).toBe(63.6);
    expect(report.variantCount).toBe(3);
    expect(describeInvarianceFailure(report)).toBe("invariant");
  });

  it("reports every disagreement rather than throwing on the first", () => {
    // Which variant kinds fail is the diagnostic: only-Kekulé points at aromaticity perception,
    // only-renumbering points at atom order.
    const report = checkInvariance(reference, variants, (variant) =>
      variant.kind === "kekule" ? 61.2 : 63.6
    );

    expect(report.invariant).toBe(false);
    expect(report.deviations).toHaveLength(1);
    expect(report.deviations[0]?.kind).toBe("kekule");
    expect(report.deviations[0]?.delta).toBeCloseTo(2.4, 10);
    expect(describeInvarianceFailure(report)).toMatch(/kekule: 1\/3 disagreed/);
  });

  it("defaults to exact equality so floating-point drift is not silently excused", () => {
    const report = checkInvariance(reference, variants, (variant) =>
      variant.kind === "canonical" ? 63.6 : 63.6 + 1e-12
    );
    expect(report.invariant).toBe(false);

    const tolerant = checkInvariance(
      reference,
      variants,
      (variant) => (variant.kind === "canonical" ? 63.6 : 63.6 + 1e-12),
      { tolerance: 1e-9 }
    );
    expect(tolerant.invariant).toBe(true);
  });

  it("separates a thrown computation from a disagreeing one", () => {
    const report = checkInvariance(reference, variants, (variant) => {
      if (variant.kind === "explicit-hydrogens") throw new Error("sanitisation failed");
      return 63.6;
    });

    expect(report.deviations).toHaveLength(0);
    expect(report.errors).toEqual([
      { variantId: "aspirin-explicit-h", kind: "explicit-hydrogens", message: "sanitisation failed" }
    ]);
    expect(report.invariant).toBe(false);
  });

  it("compares array payloads elementwise", () => {
    const report = checkInvariance(reference, variants, () => [1, 2, 3] as number[]);
    expect(report.invariant).toBe(true);

    const differing = checkInvariance(reference, variants, (variant) =>
      variant.kind === "canonical" ? [1, 2, 3] : [1, 2, 4]
    );
    expect(differing.invariant).toBe(false);
  });

  it("honours a custom equality function", () => {
    const report = checkInvariance(
      reference,
      variants,
      (variant) => ({ tpsa: variant.kind === "kekule" ? 63.60001 : 63.6 }),
      { equals: (a, b) => Math.abs(a.tpsa - b.tpsa) < 0.001 }
    );
    expect(report.invariant).toBe(true);
  });
});

describe("checkAtomIndexedInvariance", () => {
  const perAtomShifts = [21.0, 169.5, 169.5, 151.0, 124.0, 132.0, 126.0, 134.5, 122.5, 170.5, 0, 0, 0];

  it("passes when values follow the atoms through a renumbering", () => {
    const report = checkAtomIndexedInvariance(reference, variants, (variant) => {
      const mapping = variant.atomToReferenceAtom!;
      return mapping.map((referenceAtom) => perAtomShifts[referenceAtom]!);
    });
    expect(report.invariant).toBe(true);
    expect(report.deviations).toHaveLength(0);
  });

  it("catches values that are individually right but assigned to the wrong atoms", () => {
    // A multiset comparison passes this. That is exactly why the atom-indexed check exists: a
    // pipeline can compute the right thirteen shifts and hang every one of them on the wrong carbon.
    const report = checkAtomIndexedInvariance(reference, variants, (variant) =>
      variant.kind === "canonical" ? perAtomShifts : [...perAtomShifts].reverse()
    );

    expect(report.invariant).toBe(false);
    expect(report.deviations.length).toBeGreaterThan(0);
    expect(report.deviations.every((deviation) => deviation.variantId !== "aspirin-canonical")).toBe(true);
  });

  it("flags a variant that arrived without an atom mapping instead of guessing one", () => {
    const unmapped: RepresentationVariant = {
      id: "no-mapping",
      kind: "atom-renumbering",
      value: "CC(=O)Oc1ccccc1C(=O)O",
      format: "smiles"
    };

    const report = checkAtomIndexedInvariance(reference, [unmapped], () => perAtomShifts);
    expect(report.unmappedVariants).toEqual(["no-mapping"]);
    expect(report.invariant).toBe(false);
  });

  it("reports a missing per-atom value as a deviation with no actual", () => {
    // A variant that returns shifts for only some atoms is not "invariant on the atoms it covered" —
    // the atoms it dropped are exactly the ones worth knowing about.
    const report = checkAtomIndexedInvariance(reference, [variants[1]!], (variant) =>
      variant.kind === "canonical" ? perAtomShifts : perAtomShifts.slice(0, 3)
    );

    expect(report.invariant).toBe(false);
    expect(report.deviations).toHaveLength(perAtomShifts.length - 3);
    expect(report.deviations.every((deviation) => deviation.actual === undefined)).toBe(true);
    expect(report.deviations.every((deviation) => deviation.delta === undefined)).toBe(true);
  });
});

describe("NaN is a deviation, not a pass", () => {
  const ref: RepresentationVariant = {
    id: "ref",
    kind: "canonical",
    value: "CO",
    format: "smiles",
    atomToReferenceAtom: [0, 1]
  };
  const kekule: RepresentationVariant = {
    id: "kekule",
    kind: "kekule",
    value: "CO",
    format: "smiles",
    atomToReferenceAtom: [0, 1]
  };

  it("catches a per-atom pipeline that produced NaN where the reference has a value", () => {
    // Every comparison against NaN is false, so `Math.abs(NaN - 5) > tolerance` was FALSE and this
    // reported `invariant: true` — in the function whose own doc calls it "the test that does not"
    // pass a pipeline that assigned values to the wrong atoms. NaN is precisely what such a pipeline
    // produces. `defaultEquals`, three functions up in the same module, always got this right.
    const report = checkAtomIndexedInvariance(ref, [kekule], (variant) =>
      variant.id === "ref" ? [Number.NaN, 2] : [5, 2]
    );
    expect(report.invariant, "a NaN reference value passed silently").toBe(false);
    expect(report.deviations.length).toBeGreaterThan(0);
  });

  it("treats two NaNs as agreeing, the way defaultEquals does", () => {
    const report = checkAtomIndexedInvariance(ref, [kekule], () => [Number.NaN, 2]);
    expect(report.invariant).toBe(true);
  });
});
