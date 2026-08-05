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
import { beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit } from "./conformer";
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
    const central = bonds.findIndex((_, i) => {
      const a = src[i]!;
      const b = dst[i]!;
      return graph.bonds.some(
        (bond) =>
          ((bond.atoms[0] === a && bond.atoms[1] === b) || (bond.atoms[0] === b && bond.atoms[1] === a)) &&
          bond.order === 1 &&
          graph.atoms[a]!.element === "C" &&
          graph.atoms[b]!.element === "C"
      );
    });
    expect(central).toBeGreaterThanOrEqual(0);
    // Every ring bond in benzene is aromatic and in a ring; the one joining the rings is not.
    const ringFlags = bonds.map((feature) => feature[3]!);
    expect(ringFlags.filter((v) => v === 0).length).toBeGreaterThan(0);
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
    for (const point of PKA_INTERVAL_CALIBRATION.points) {
      expect(
        Math.abs(point.coverage - PKA_INTERVAL_CALIBRATION.targetCoverage),
        `bin at spread ${point.spread} covers ${point.coverage}`
      ).toBeLessThan(0.01);
    }
    expect(PKA_INTERVAL_CALIBRATION.worstBinDeviation).toBeLessThan(0.01);
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
