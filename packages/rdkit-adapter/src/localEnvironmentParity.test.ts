/**
 * The 12 in `localEnvironmentFeatures` is a SENTINEL, not a ceiling.
 *
 * `local_environment.py` — the Python that built the training matrix — writes
 * `float(min(polar)) if polar else 12.0`: twelve means "there is no such atom", and a real distance
 * above twelve is reported truthfully. The TypeScript port seeded its accumulator with 12 and took a
 * running minimum, which silently clamped instead. On 12-aminododecanoic acid at the amine, Python
 * emitted 13.0 and TypeScript emitted 12 — from identical 15-atom graphs.
 *
 * Neither parity fixture can catch this. `parity-fixture.json`'s ten entries all have
 * `dist_nearest_polar` of 4 or less (or the bare sentinel), and no fixture molecule is even large
 * enough to reach 13 bonds from its site; `gnn-parity-fixture.json` carries no feature vectors at all.
 * So the invariant is pinned here directly.
 */
import { describe, expect, it } from "vitest";

import { localEnvironmentFeatures, siteContext } from "./pkaAromaticity";
import type { PkaMolecularGraph } from "./pkaModel";

/** A straight chain: atom 0, then `length - 1` carbons, with an optional element at the far end. */
function chain(length: number, tailElement: string): PkaMolecularGraph {
  const atoms = Array.from({ length }, (_, index) => ({
    element: index === length - 1 ? tailElement : "C",
    charge: 0,
    hydrogens: 2
  }));
  const bonds = Array.from({ length: length - 1 }, (_, index) => ({
    atoms: [index, index + 1] as [number, number],
    order: 1
  }));
  return { atoms, bonds, descriptors: {} } as unknown as PkaMolecularGraph;
}

/** The four trailing features are [nearestPolar, nearestCharge, eccentricity, disconnected]. */
function tail(graph: PkaMolecularGraph, site: number): number[] {
  const features = localEnvironmentFeatures(graph, siteContext(graph), site);
  return features.slice(-4);
}

describe("nearest-polar distance", () => {
  it("reports a real distance beyond 12 rather than clamping it to the sentinel", () => {
    // 15 atoms: site at 0, the only N/O/S at the far end, 14 bonds away.
    const [nearestPolar, , eccentricity] = tail(chain(15, "O"), 0);
    expect(nearestPolar).toBe(14);
    expect(eccentricity).toBe(14);
    // The specific incoherence the clamp produced: a vector claiming the molecule reaches 14 bonds
    // while insisting nothing polar is further than 12.
    expect(nearestPolar).toBeLessThanOrEqual(eccentricity);
  });

  it("still reports the sentinel when there is genuinely no polar atom", () => {
    const [nearestPolar, nearestCharge] = tail(chain(15, "C"), 0);
    expect(nearestPolar).toBe(12);
    expect(nearestCharge).toBe(12);
  });

  it("reports a nearby polar atom unchanged", () => {
    const [nearestPolar] = tail(chain(4, "O"), 0);
    expect(nearestPolar).toBe(3);
  });
});
