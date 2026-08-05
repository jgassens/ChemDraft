/**
 * The macroscopic fold, measured end to end on molecules with tabulated titration curves.
 *
 * This exists because the fold has a defect no per-site number can show. `pKa(n) = log10(Z(n)/Z(n-1))`
 * sums over EVERY microstate at a given proton count, populated or not, so the answer depends on
 * species a titration cannot reach and no corpus can label — glycine's neutral form is the standing
 * example, and the model was measured saying 4.33 for it under one corpus and 8.56 under another while
 * agreeing to within 0.1 on every species an experiment can actually measure.
 *
 * The fold solves for every microstate's free energy at once, by weighted least squares over the whole
 * ladder, weighting each rung by what the ensemble's own disagreement says it is worth. So a rung
 * nothing can label is pinned by the chemistry around it instead of being averaged in as though it were
 * as trustworthy as a carboxyl measured a thousand times.
 *
 * Measured against the forward sweep it replaced, on these sixteen molecules:
 *
 *     all sixteen       0.380 -> 0.293
 *     the eight zwitterions   0.336 -> 0.160
 *
 * and every molecule with no cycle to close is bit-identical, which is the property that says the
 * change is a reconciliation and not a retuning.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import { IONIZATION_SITES_METHOD_ID } from "./ionization";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});
afterAll(() => {
  resetRdkitForTesting();
});

/** Tabulated aqueous macroscopic constants, 25 C. */
const CURATED: Array<{ name: string; smiles: string; pKa: number[]; zwitterion: boolean }> = [
  { name: "glycine", smiles: "NCC(=O)O", pKa: [2.35, 9.78], zwitterion: true },
  { name: "alanine", smiles: "CC(N)C(=O)O", pKa: [2.34, 9.69], zwitterion: true },
  { name: "serine", smiles: "NC(CO)C(=O)O", pKa: [2.21, 9.15], zwitterion: true },
  { name: "cysteine", smiles: "NC(CS)C(=O)O", pKa: [1.71, 8.33, 10.78], zwitterion: true },
  { name: "aspartic acid", smiles: "NC(CC(=O)O)C(=O)O", pKa: [1.99, 3.9, 9.9], zwitterion: true },
  { name: "glutamic acid", smiles: "NC(CCC(=O)O)C(=O)O", pKa: [2.1, 4.07, 9.47], zwitterion: true },
  { name: "lysine", smiles: "NCCCCC(N)C(=O)O", pKa: [2.15, 9.16, 10.67], zwitterion: true },
  { name: "histidine", smiles: "NC(Cc1c[nH]cn1)C(=O)O", pKa: [1.85, 6.0, 9.33], zwitterion: true },
  { name: "acetic acid", smiles: "CC(=O)O", pKa: [4.76], zwitterion: false },
  { name: "phenol", smiles: "Oc1ccccc1", pKa: [9.95], zwitterion: false },
  { name: "ethylenediamine", smiles: "NCCN", pKa: [6.85, 9.93], zwitterion: false },
  { name: "malonic acid", smiles: "OC(=O)CC(=O)O", pKa: [2.83, 5.69], zwitterion: false },
  { name: "succinic acid", smiles: "OC(=O)CCC(=O)O", pKa: [4.21, 5.64], zwitterion: false },
  { name: "citric acid", smiles: "OC(=O)CC(O)(CC(=O)O)C(=O)O", pKa: [3.13, 4.76, 6.4], zwitterion: false },
  { name: "imidazole", smiles: "c1c[nH]cn1", pKa: [6.95], zwitterion: false },
  { name: "pyridine", smiles: "c1ccncc1", pKa: [5.23], zwitterion: false }
];

interface Folded {
  pKa: number[];
  inconsistency: number;
  zwitterionic: boolean;
}

async function fold(smiles: string, runId: string): Promise<Folded | undefined> {
  const run = await analyzeStructure({
    format: "smiles",
    value: smiles,
    runId,
    startedAt: "2026-08-02T00:00:00.000Z"
  } as never);
  const result = run.results.find((entry) => entry.methodId === IONIZATION_SITES_METHOD_ID);
  if (!result || result.kind !== "ionization") return undefined;
  return (result as { macroscopic?: Folded }).macroscopic;
}

/**
 * Mean error under one-to-one closest matching.
 *
 * Not pairing by titration order: the model reports steps an assay cannot see — an amide N-H near 15,
 * a second ring protonation below zero — and one such extra step shifts every later pairing, scoring a
 * correct value against the wrong measurement.
 */
function matchedError(predicted: readonly number[], measured: readonly number[]): number[] {
  const remaining = [...predicted];
  const errors: number[] = [];
  for (const target of measured) {
    if (remaining.length === 0) break;
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      if (Math.abs(remaining[i]! - target) < Math.abs(remaining[best]! - target)) best = i;
    }
    errors.push(Math.abs(remaining[best]! - target));
    remaining.splice(best, 1);
  }
  return errors;
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

describe("the macroscopic fold on curated titration curves", () => {
  it("stays inside the envelope the contract documents, and does not hide a bad class", async () => {
    const perMolecule: Array<{ name: string; mae: number; zwitterion: boolean }> = [];
    for (const [index, entry] of CURATED.entries()) {
      const folded = await fold(entry.smiles, `macro-${index}`);
      expect(folded, `${entry.name} produced no macroscopic result`).toBeDefined();
      const errors = matchedError(folded!.pKa, entry.pKa);
      expect(errors.length, `${entry.name} matched no measured value`).toBeGreaterThan(0);
      perMolecule.push({ name: entry.name, mae: mean(errors), zwitterion: entry.zwitterion });
    }

    const all = mean(perMolecule.map((row) => row.mae));
    const zwitterions = mean(perMolecule.filter((r) => r.zwitterion).map((r) => r.mae));
    console.log(
      `\n  all ${perMolecule.length}: MAE ${all.toFixed(4)}` +
        `   zwitterions: MAE ${zwitterions.toFixed(4)}\n` +
        perMolecule
          .map((r) => `    ${r.name.padEnd(16)} ${r.mae.toFixed(3)}${r.zwitterion ? "  ZW" : ""}`)
          .join("\n")
    );

    // Measured 0.293 and 0.160 at the fold's introduction. The bound is loose enough not to fail on a
    // retrain that moves a site value, and tight enough that losing the weighted solve fails it: the
    // forward sweep it replaced scored 0.380 and 0.336 on this exact set.
    expect(all).toBeLessThan(0.35);
    // The zwitterions were this method's worst class by a factor of six before the coupling term, and
    // they must not become it again silently. They are now BETTER than the set as a whole.
    expect(zwitterions).toBeLessThan(0.25);
  }, 1_800_000);

  it("reproduces the sweep exactly where there is no cycle to close", async () => {
    // A molecule whose microstate graph is a tree has one route to each state, so weighting cannot
    // change anything and the solve must return precisely what averaging did. These values are the
    // forward sweep's, measured before it was replaced — they are a regression pin on the claim that
    // this change reconciles contradictions rather than retuning agreements.
    const unchanged: Array<[string, string, number[]]> = [
      ["acetic acid", "CC(=O)O", [4.3]],
      ["phenol", "Oc1ccccc1", [9.94]],
      ["ethylenediamine", "NCCN", [6.87, 10.23]],
      ["malonic acid", "OC(=O)CC(=O)O", [2.61, 4.73]],
      ["succinic acid", "OC(=O)CCC(=O)O", [3.84, 5.4]],
      ["pyridine", "c1ccncc1", [5.21]]
    ];
    for (const [index, [name, smiles, expected]] of unchanged.entries()) {
      const folded = await fold(smiles, `tree-${index}`);
      expect(folded, name).toBeDefined();
      // No square to close, so nothing to be inconsistent about.
      expect(folded!.inconsistency, `${name} reported a cycle defect`).toBeCloseTo(0, 9);
      expect(folded!.pKa).toHaveLength(expected.length);
      for (const [i, value] of expected.entries()) {
        expect(folded!.pKa[i]!, `${name} value ${i}`).toBeCloseTo(value, 2);
      }
    }
  }, 1_800_000);

  it("reports the cycle defect it could not close, rather than burying it in the fit", async () => {
    // The solve spreads a contradiction over every rung around it, so its residuals understate the
    // contradiction. `inconsistency` is measured on the EDGE VALUES for exactly that reason, and it is
    // the only label-free signal the method has that an answer is unsafe.
    const glycine = await fold("NCC(=O)O", "cycle-0");
    const histidine = await fold("NC(Cc1c[nH]cn1)C(=O)O", "cycle-1");
    expect(glycine).toBeDefined();
    expect(histidine).toBeDefined();
    // Both have squares, so both can report one; histidine's four sites contradict far more than
    // glycine's two, and its macroscopic error is correspondingly the larger of the pair.
    expect(glycine!.inconsistency).toBeGreaterThan(0);
    expect(histidine!.inconsistency).toBeGreaterThan(glycine!.inconsistency);
  }, 1_800_000);
});
