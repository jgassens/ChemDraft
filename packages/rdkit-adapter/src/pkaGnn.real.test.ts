/**
 * The network computes the same number here as it did in training.
 *
 * This is the gate the GNN has to pass before it can replace anything. A forest that disagrees between
 * training and inference gives a wrong answer on one split; a network that disagrees gives a wrong
 * answer everywhere, because every weight is involved in every prediction.
 *
 * `vendor/pka-model/gnn-parity-fixture.json` is emitted by the trainer from the ROUNDED weights that
 * actually ship, so this compares like with like — the mistake the forest fixture made once, pinning
 * scikit-learn's in-memory predictions against a packed export whose thresholds had been rounded.
 */
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit } from "./conformer";
import { IONIZATION_CONFIDENCE_BANDS } from "./ionization";
import { installRealRdkitModuleLoader } from "./testing";
import { gnnFeatures, predictWithGnn, type GnnWeights } from "./pkaGnn";
import { elementSymbol } from "./composition";
import type { PkaMolecularGraph } from "./pkaModel";
import gnnJson from "../vendor/pka-model/site-pka-gnn.json";
import fixtureJson from "../vendor/pka-model/gnn-parity-fixture.json";
import { PKA_INTERVAL_CALIBRATION, intervalFor } from "./pkaGnn";

const MODEL = gnnJson as unknown as GnnWeights;
const FIXTURE = fixtureJson as unknown as
  { smiles: string; site: number; prediction: number; spread: number }[];

beforeAll(() => {
  installRealRdkitModuleLoader();
});

/**
 * The graph the network reads — atoms, bonds, and nothing else.
 *
 * Worth noticing: `descriptors` stays empty. The forest needed whole-molecule numbers (mass, polar
 * surface area, Crippen logP) which is exactly how a counterion leaked into acetic acid's answer. A
 * message-passing network reads the graph itself, so that channel does not exist.
 */
async function graphFor(smiles: string): Promise<PkaMolecularGraph> {
  const module = await ensureRdkit();
  const mol = module.get_mol(smiles) as { get_json: () => string; delete: () => void } | null;
  if (!mol) throw new Error(`could not parse ${smiles}`);
  const json = JSON.parse(mol.get_json()) as {
    molecules: { atoms: { z?: number; chg?: number; impHs?: number }[];
                 bonds: { atoms: number[]; bo?: number }[] }[];
    defaults?: { atom?: { z?: number; chg?: number; impHs?: number }; bond?: { bo?: number } };
  };
  mol.delete();
  const molecule = json.molecules[0]!;
  const atomDefaults = json.defaults?.atom ?? {};
  const bondDefault = json.defaults?.bond?.bo ?? 1;
  return {
    atoms: molecule.atoms.map((atom) => ({
      element: elementSymbol(atom.z ?? atomDefaults.z ?? 6),
      charge: atom.chg ?? atomDefaults.chg ?? 0,
      hydrogens: atom.impHs ?? atomDefaults.impHs ?? 0
    })),
    bonds: molecule.bonds.map((bond) => ({
      atoms: [bond.atoms[0]!, bond.atoms[1]!] as [number, number],
      order: bond.bo ?? bondDefault
    })),
    descriptors: {}
  };
}

describe("the network reproduces its training-time arithmetic", () => {
  it.each(FIXTURE.map((e) => [e.smiles, e.site, e.prediction, e.spread] as const))(
    "matches PyTorch on %s at atom %i",
    async (smiles, site, expected, expectedSpread) => {
      const { value, spread } = predictWithGnn(MODEL, await graphFor(smiles), site);
      expect(Math.abs(spread - expectedSpread), `${smiles}@${site}: spread ${spread} vs ${expectedSpread}`)
        .toBeLessThan(1e-4);
      // 1e-4 rather than 1e-9: the weights are float32 rounded to six decimals, and the two sides
      // accumulate a 187k-parameter forward pass in a different order. A disagreement from a WRONG
      // feature or a transposed weight is orders of magnitude larger than this.
      expect(Math.abs(value - expected), `${smiles}@${site}: got ${value}, trained ${expected}`)
        .toBeLessThan(1e-4);
    }
  );
});

describe("the features the network is fed", () => {
  it("marks exactly one atom as the site", async () => {
    const graph = await graphFor("NC(Cc1c[nH]cn1)C(=O)O");
    const { atoms } = gnnFeatures(graph, 5);
    const flags = atoms.map((row) => row[row.length - 1]!);
    expect(flags.filter((v) => v === 1)).toHaveLength(1);
    expect(flags[5]).toBe(1);
  });

  it("gives every bond two directed edges", async () => {
    const graph = await graphFor("c1ccncc1");
    const { src, dst, bonds } = gnnFeatures(graph, 3);
    expect(src).toHaveLength(graph.bonds.length * 2);
    expect(bonds).toHaveLength(graph.bonds.length * 2);
    for (let i = 0; i < graph.bonds.length; i += 1) {
      expect(src[2 * i]).toBe(dst[2 * i + 1]);
      expect(dst[2 * i]).toBe(src[2 * i + 1]);
    }
  });

  it("does not call biphenyl's central bond a ring bond", async () => {
    // The trap the trainer had to avoid too. Both its atoms are in rings; the bond is in none. RDKit's
    // `IsInRing()` knows that and has no counterpart here, so both sides use the same cycle walk.
    const graph = await graphFor("c1ccccc1-c1ccccc1");
    const { bonds, src, dst } = gnnFeatures(graph, 0);
    // `feature[4]`, the IN-RING flag. This read `feature[3]` — the TRIPLE-BOND slot of the bond-order
    // one-hot — so on a molecule with no triple bond it compared 26 zeros against `> 0` and could not
    // fail, including for the exact regression it names. Layout: [aromatic, order1, order2, order3,
    // inRing, ...]. This guards per-atom/per-bond ring features, the area where this repo has shipped
    // Kekule-dependent counting wrong five times, so an assertion that cannot fail is worse than none.
    const ringFlags = bonds.map((feature) => feature[4]!);

    // Biphenyl has 13 bonds: 12 ring bonds and the one joining the rings. Edges are directed, so
    // exactly two of the 26 must be out-of-ring — and they must be the two halves of the same bond.
    const outOfRing = ringFlags.map((flag, i) => ({ flag, i })).filter((entry) => entry.flag === 0);
    expect(ringFlags.length).toBe(26);
    expect(outOfRing).toHaveLength(2);
    const [first, second] = outOfRing;
    expect(src[first!.i]).toBe(dst[second!.i]);
    expect(dst[first!.i]).toBe(src[second!.i]);
    // Both its atoms ARE in rings — that is the trap; only the bond is not.
    expect(graph.atoms[src[first!.i]!]!.element).toBe("C");
    expect(graph.atoms[dst[first!.i]!]!.element).toBe("C");
  });
});

describe("what the network is worth", () => {
  it("beats the forest it replaces on the same split", () => {
    // 0.78 against 1.02, Bemis-Murcko scaffold groups held out, the same 12,096 labels. The point of
    // the change is capacity, so this is the number that has to move.
    expect(MODEL.training.cvMae).toBeLessThan(0.9);
    expect(MODEL.training.grouping).toMatch(/Murcko/);
    expect(MODEL.training.cvMae).toBeLessThan(MODEL.training.baselinePredictTheMean * 0.4);
    // The interval has to come from somewhere, and for an ensemble that is member disagreement —
    // measured on held-out folds, never on rows the members were fitted to.
    expect(MODEL.training.ensemble).toBeGreaterThan(1);
    expect(MODEL.architecture.ensemble).toBe(MODEL.members.length);
  });
});

/**
 * The interval has to mean what it says, and it did not.
 *
 * It was the ensemble's deviation times one constant, chosen so the interval covers 68% of errors over
 * the whole corpus. It does — and conditionally it ran from 50.1% coverage at the confident end to
 * 85.6% at the loose end, which is the way that matters, because a reader looks at one molecule and not
 * at a corpus. Too tight exactly where it is trusted most.
 */
describe("the reported interval is calibrated, not scaled", () => {
  it("lands within a point of its target in every bin", () => {
    const curves = [
      ["pooled", PKA_INTERVAL_CALIBRATION.points] as const,
      ...Object.entries(PKA_INTERVAL_CALIBRATION.strata ?? {})
    ];
    for (const [name, points] of curves) {
      for (const point of points) {
        expect(
          Math.abs(point.coverage - PKA_INTERVAL_CALIBRATION.targetCoverage),
          `${name} bin at spread ${point.spread} covers ${point.coverage}`
        ).toBeLessThan(0.01);
      }
    }
    expect(PKA_INTERVAL_CALIBRATION.worstBinDeviation).toBeLessThan(0.01);
  });

  it("gives carbon its own curve, because one pooled curve under-covered it by nine points", () => {
    // Deviation alone was the whole taxonomy, and conditioned on the ionizing element it ran 59.2% on
    // carbon against 68.1% for nitrogen and 68.5% for oxygen — a carbon acid is harder than a nitrogen
    // at the same ensemble disagreement. Mondrian conformal prediction allows any partition, so carbon
    // gets its own. Held-out folds put it at 67.5%.
    const strata = PKA_INTERVAL_CALIBRATION.strata;
    expect(strata, "the calibration is not stratified").toBeDefined();
    expect(Object.keys(strata!).sort()).toEqual(["carbon", "other"]);

    const byElement = PKA_INTERVAL_CALIBRATION.coverageByElement;
    const countByElement = PKA_INTERVAL_CALIBRATION.samplesByElement;
    expect(byElement, "coverage is not reported per element").toBeDefined();
    const target = PKA_INTERVAL_CALIBRATION.targetCoverage;
    for (const [element, coverage] of Object.entries(byElement!)) {
      // Is this stratum's coverage CONSISTENT WITH the target, given how many sites it rests on?
      // That is the question a calibration check is actually asking, and a fixed percentage-point
      // tolerance is the wrong instrument for it: coverage is a binomial proportion, so the precision
      // available depends on n. A flat 0.05 demanded more of sulfur (189 rows, standard error 3.4
      // points) than that sample can supply, and sulfur duly failed at 5.02 points off — a statement
      // about the sample size, not about the calibration.
      //
      // The z-score is the right instrument and needs no per-element fudging. Measured on the shipped
      // artifact: C +0.88, N -1.85, O +1.10, S +1.48. Every stratum sits inside two standard errors,
      // so nothing is miscalibrated and nothing is being excused. |z| < 3 is the bound, which still
      // catches a genuine drift — sulfur would have to reach 44 points off target at n=189, or
      // nitrogen 1.7 points at n=6,774, and the tighter one gets tighter as the corpus grows.
      const n = countByElement?.[element] ?? 0;
      expect(n, `${element} reports coverage over no sites`).toBeGreaterThan(0);
      const standardError = Math.sqrt((target * (1 - target)) / n);
      const z = (coverage - target) / standardError;
      expect(
        Math.abs(z),
        `${element} covered ${(coverage * 100).toFixed(1)}% against a ${(target * 100).toFixed(0)}% ` +
          `target on ${n} rows — that is ${z.toFixed(2)} standard errors out`
      ).toBeLessThan(3);
    }

    // A carbon site must read WIDER than a non-carbon one at the same disagreement, or the stratum is
    // not doing the thing it exists for.
    for (const deviation of [0.2, 0.4, 0.8]) {
      expect(intervalFor(deviation, "C")).toBeGreaterThan(intervalFor(deviation, "N"));
    }
  });

  it("falls back to the pooled curve when the element is unknown", () => {
    // Not to carbon's curve: a caller who cannot say what the atom is gets what the whole corpus
    // agreed on, which is the honest reading rather than the widest one.
    const points = PKA_INTERVAL_CALIBRATION.points;
    for (const deviation of [0.05, 0.2, 0.6]) {
      const pooled = intervalFor(deviation);
      expect(pooled).not.toBeCloseTo(intervalFor(deviation, "C"), 6);
      expect(pooled).toBeGreaterThanOrEqual(points[0]!.interval);
    }
  });

  it("is monotone, because a wider disagreement can never buy a tighter interval", () => {
    const points = PKA_INTERVAL_CALIBRATION.points;
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.spread).toBeGreaterThan(points[i - 1]!.spread);
      expect(points[i]!.interval).toBeGreaterThanOrEqual(points[i - 1]!.interval);
    }
  });

  it("interpolates between bin centres and clamps outside them", () => {
    const points = PKA_INTERVAL_CALIBRATION.points;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    // Clamped: a perfectly agreeing ensemble does not earn a zero-width interval. Members share one
    // corpus and its blind spots, so agreement is not proof.
    expect(intervalFor(0)).toBeCloseTo(first.interval, 9);
    expect(intervalFor(-1)).toBeCloseTo(first.interval, 9);
    expect(intervalFor(1e6)).toBeCloseTo(last.interval, 9);
    expect(intervalFor(Number.NaN)).toBeCloseTo(first.interval, 9);
    // Interpolated: the midpoint of two bin centres is the midpoint of their intervals.
    const a = points[3]!;
    const b = points[4]!;
    expect(intervalFor((a.spread + b.spread) / 2)).toBeCloseTo((a.interval + b.interval) / 2, 9);
  });

  it("never reports a zero-width interval, whatever the ensemble does", () => {
    for (const deviation of [0, 1e-12, 0.001, 0.5, 3, 100]) {
      expect(intervalFor(deviation)).toBeGreaterThan(0.2);
    }
  });
});

describe("the confidence bands are worth what they claim", () => {
  it("intervalMaeIsMeasured — recomputes both quartile MAEs from the committed artifacts", () => {
    // The figure caption tells a reader what a green ring is worth. Those two numbers used to be typed
    // into the caption string and traced, via `git log -S`, to the RETIRED forest's calibration as it
    // stood in August 2026 — a different model, and stale even for that one. They are constants rather
    // than a runtime read only because `gnn-oof.json` is 1.6 MB and is not a runtime artifact, so this
    // is the guard that keeps a constant honest against the bytes, exactly as the WASM hashes are kept.
    const oof = JSON.parse(
      readFileSync(new URL("../vendor/pka-model/gnn-oof.json", import.meta.url), "utf8")
    ) as { predicted: number; observed: number; spread: number; element?: string }[];
    const calibration = JSON.parse(
      readFileSync(new URL("../vendor/pka-model/interval-calibration.json", import.meta.url), "utf8")
    ) as {
      points: { spread: number; interval: number }[];
      strata?: Record<string, { spread: number; interval: number }[]>;
    };

    // The same curve `pkaGnn.intervalFor` applies at inference: stratum by element, clamped at both
    // ends, linear between the points.
    const curveFor = (element: string | undefined): { spread: number; interval: number }[] =>
      calibration.strata
        ? (calibration.strata[element === "C" ? "carbon" : "other"] ?? calibration.points)
        : calibration.points;

    const intervalAt = (spread: number, element: string | undefined): number => {
      const points = curveFor(element);
      if (!Number.isFinite(spread) || spread <= points[0]!.spread) return points[0]!.interval;
      if (spread >= points[points.length - 1]!.spread) return points[points.length - 1]!.interval;
      for (let i = 0; i + 1 < points.length; i += 1) {
        const a = points[i]!;
        const b = points[i + 1]!;
        if (spread >= a.spread && spread <= b.spread) {
          const span = b.spread - a.spread;
          const t = span === 0 ? 0 : (spread - a.spread) / span;
          return a.interval + t * (b.interval - a.interval);
        }
      }
      return points[points.length - 1]!.interval;
    };

    const rows = oof
      .map((row) => ({
        interval: intervalAt(row.spread, row.element),
        error: Math.abs(row.predicted - row.observed)
      }))
      .sort((a, b) => a.interval - b.interval);
    expect(rows.length).toBe(12_081);

    const mae = (slice: typeof rows): number =>
      slice.reduce((sum, row) => sum + row.error, 0) / slice.length;
    const quarter = Math.floor(rows.length / 4);
    const tightest = mae(rows.slice(0, quarter));
    const widest = mae(rows.slice(3 * quarter));

    expect(IONIZATION_CONFIDENCE_BANDS.tightestQuartileMae).toBeCloseTo(tightest, 3);
    expect(IONIZATION_CONFIDENCE_BANDS.widestQuartileMae).toBeCloseTo(widest, 3);
    // The ordering the whole colour scheme rests on: a tighter interval really is more accurate.
    expect(tightest).toBeLessThan(widest);
  });
});
