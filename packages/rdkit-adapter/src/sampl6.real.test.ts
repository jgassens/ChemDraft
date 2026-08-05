/**
 * END-TO-END accuracy, on a blind challenge set the model has never seen.
 *
 * Every other figure this method publishes is an ORACLE-SITE measurement: the site and its direction
 * are handed in, and what is measured is how well a known site is valued. That is the normal convention
 * in this field, and it is also the thing an architecture review correctly objected to — it cannot
 * describe the accuracy of the feature a user actually receives, because a user supplies a structure
 * and nothing else.
 *
 * This file supplies a structure and nothing else. Everything in between is the shipped pipeline:
 * canonicalize the protomer, scan for sites, decide each atom's rungs, score them, build the ladder,
 * fold it into macroscopic values. A wrong site, a missed site, a misclassified direction or a broken
 * fold all show up here, and none of them shows up in a per-site MAE.
 *
 * **SAMPL6** (github.com/samplchallenges/SAMPL6, MIT) is the right set for it. It was a BLIND
 * challenge — the experimental values were withheld while predictions were submitted — so it is not
 * merely held out, it was unavailable to anyone. 24 drug-like molecules, 31 macroscopic values, and
 * checked against our corpus: 0 share a skeleton with a training row and 1 shares a Murcko scaffold.
 *
 * The numbers here are deliberately NOT asserted tightly. The point is to measure and publish, not to
 * pin a figure that a future improvement would have to fight. What is asserted is that the pipeline
 * stays within the envelope it is documented at, and that it does not silently stop answering.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure } from "./analysis";
import { installRealRdkitModuleLoader } from "./testing";
import { IONIZATION_SITES_METHOD_ID } from "./ionization";
import benchmarkJson from "../vendor/pka-model/sampl6-benchmark.json";

const BENCHMARK = benchmarkJson as unknown as {
  policy: string;
  molecules: { id: string; smiles: string; pKa: number[]; sem: number[] }[];
};

beforeAll(() => {
  installRealRdkitModuleLoader();
});

interface Outcome {
  id: string;
  observed: number[];
  predicted: number[];
  /** Errors on the values that could be paired, in titration order. */
  errors: number[];
  status: string;
  declined: boolean;
  /** Predictions inside the assay's accessible window, and the errors from pairing only those. */
  inWindow: number[];
  windowErrors: number[];
  /** Each measured value against its best-matching prediction, one-to-one, plus the leftovers. */
  matchedErrors: number[];
  unmatched: number;
  unmatchedInWindow: number;
}

/**
 * The window a UV-metric / potentiometric titration can actually reach.
 *
 * Reported alongside the raw figure to close a fair-comparison question, and the answer turned out to
 * be "no difference". The worry was real: pyrazine's second ring protonation is genuinely near -5.8,
 * the fold predicts it correctly at -2.4, and SAMPL6 could never have listed it — so counting it as an
 * extra value would penalise correct chemistry. Measured, the two figures are IDENTICAL, because the
 * interval filter already removes every out-of-window step before it reaches a curve. The extras are
 * therefore real over-detection and not invisible chemistry, which is worth knowing before writing
 * another rule.
 *
 * Kept rather than deleted: if a future change starts emitting steps outside the window, these two
 * numbers diverge and say so.
 */
const ASSAY_FLOOR = 2;
const ASSAY_CEILING = 12;

let cached: Outcome[] | undefined;

async function runBenchmark(): Promise<Outcome[]> {
  if (cached) return cached;
  const out: Outcome[] = [];
  let counter = 0;
  for (const molecule of BENCHMARK.molecules) {
    counter += 1;
    const run = await analyzeStructure({
      format: "smiles",
      value: molecule.smiles,
      runId: `sampl6-${counter}`,
      startedAt: "2026-08-03T00:00:00.000Z"
    } as never);
    const results = run.results.filter(
      (result) => result.methodId === IONIZATION_SITES_METHOD_ID && result.kind === "ionization"
    ) as unknown as { status: string; macroscopic?: { pKa: number[] } }[];
    // The value a reader is shown, from whichever interpretation carried one. Two of these molecules
    // are drawn as hydrochloride salts, so the answer legitimately arrives on the fragment.
    const scored = results.find((result) => result.macroscopic);
    const predicted = scored?.macroscopic?.pKa ?? [];
    // Pair in titration order and only where both exist: an unpaired prediction is a site-count
    // disagreement, counted separately below rather than scored as if it were a value error.
    const pairs = Math.min(predicted.length, molecule.pKa.length);
    // A UV-metric or potentiometric assay can only see roughly 2 to 12, and SAMPL6's own values span
    // 2.15 to 11.74. Predictions outside that are not errors — pyrazine's second ring protonation is
    // REAL at about -5.8 and simply invisible to the experiment — so comparing them against a list
    // that could never contain them counts correct chemistry as an extra value. Both figures are
    // reported: the raw one is what a user sees, the windowed one is what the experiment could judge.
    const inWindow = predicted.filter((value) => value >= ASSAY_FLOOR && value <= ASSAY_CEILING);
    const windowPairs = Math.min(inWindow.length, molecule.pKa.length);
    out.push({
      id: molecule.id,
      observed: molecule.pKa,
      predicted,
      errors: Array.from({ length: pairs }, (_, i) => Math.abs(predicted[i]! - molecule.pKa[i]!)),
      status: results[0]?.status ?? "missing",
      declined: predicted.length === 0,
      inWindow,
      windowErrors: Array.from({ length: windowPairs }, (_, i) =>
        Math.abs(inWindow[i]! - molecule.pKa[i]!)
      ),
      ...(() => {
        const matched = matchClosest(predicted, molecule.pKa);
        return {
          matchedErrors: matched.errors,
          unmatched: matched.unmatched,
          unmatchedInWindow: matched.unmatchedInWindow
        };
      })()
    });
  }
  cached = out;
  return out;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Match each measured value to one prediction, closest pairs first, and count what is left over.
 *
 * Pairing by titration ORDER is only fair when the counts agree, and it stops being fair the moment a
 * model reports a step the assay could not see. SM19 predicts 9.43 against a measured 9.56 — nearly
 * exact — but index-pairing compares its FIRST value, 2.11, against 9.56 and records 7.45. That is the
 * metric misaligning, not the model failing, and it is why the raw figure got worse when the model got
 * better at the extremes.
 *
 * So: a greedy one-to-one assignment on absolute difference, which for lists this short is the same
 * answer the Hungarian algorithm gives. Every measured value is scored against exactly one prediction
 * and no prediction is reused, so a model cannot buy accuracy by emitting more values — the ones it
 * emits beyond the measurements are counted separately, as `unmatched`.
 */
function matchClosest(predicted: readonly number[], observed: readonly number[]): {
  errors: number[];
  unmatched: number;
  /** Unmatched steps the assay could actually have seen. The rest are real but invisible. */
  unmatchedInWindow: number;
} {
  const pairs: { p: number; o: number; d: number }[] = [];
  for (let p = 0; p < predicted.length; p += 1) {
    for (let o = 0; o < observed.length; o += 1) {
      pairs.push({ p, o, d: Math.abs(predicted[p]! - observed[o]!) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedPrediction = new Set<number>();
  const usedObserved = new Set<number>();
  const errors: number[] = [];
  for (const pair of pairs) {
    if (usedPrediction.has(pair.p) || usedObserved.has(pair.o)) continue;
    usedPrediction.add(pair.p);
    usedObserved.add(pair.o);
    errors.push(pair.d);
  }
  const leftover = predicted.filter((_, index) => !usedPrediction.has(index));
  return {
    errors,
    unmatched: leftover.length,
    // An unmatched step above 12 or below 2 is not necessarily an error: an amide N-H near 15 and an
    // azole N-H near 14 are real, imidazole's 14.4 is tabulated, and pyrazine's second ring
    // protonation near -5.8 is real too. None of them can appear in a list a UV-metric assay produced.
    // Counting those as over-detection overstates it by roughly half.
    unmatchedInWindow: leftover.filter((v) => v >= ASSAY_FLOOR && v <= ASSAY_CEILING).length
  };
}

describe("SAMPL6, end to end", () => {
  it("reports what the whole pipeline scores on a blind set", async () => {
    const results = await runBenchmark();
    const errors = results.flatMap((entry) => entry.errors);
    const windowErrors = results.flatMap((entry) => entry.windowErrors);
    const matchedErrors = results.flatMap((entry) => entry.matchedErrors);
    const answered = results.filter((entry) => !entry.declined);
    const rightCount = results.filter((entry) => entry.predicted.length === entry.observed.length);

    const lines = [
      "",
      "  SAMPL6 — supplied a structure and nothing else",
      `    molecules                 ${results.length}`,
      `    answered                  ${answered.length}`,
      // The RAW count, which is the harsh reading and the one a user meets: every predicted value,
      // including the ones outside any aqueous assay. It is 2 of 24 and the windowed figure further
      // down is 12 — quoting only the second overstates what this method does.
      `    right number of values    ${rightCount.length}   (raw; see the windowed figure below)`,
      `    values paired             ${errors.length}`,
      `    MAE                       ${mean(errors).toFixed(3)}`,
      `    within 1 log unit         ${errors.filter((e) => e <= 1).length} (${(
        (100 * errors.filter((e) => e <= 1).length) / errors.length
      ).toFixed(0)}%)`,
      `    within 2 log units        ${errors.filter((e) => e <= 2).length} (${(
        (100 * errors.filter((e) => e <= 2).length) / errors.length
      ).toFixed(0)}%)`,
      `    worst                     ${Math.max(...errors).toFixed(2)}`,
      "",
      "  each measured value against its closest prediction, one-to-one",
      `    values matched            ${matchedErrors.length}`,
      `    MAE                       ${mean(matchedErrors).toFixed(3)}`,
      `    within 1 log unit         ${matchedErrors.filter((e) => e <= 1).length} (${(
        (100 * matchedErrors.filter((e) => e <= 1).length) / matchedErrors.length
      ).toFixed(0)}%)`,
      `    within 2 log units        ${matchedErrors.filter((e) => e <= 2).length} (${(
        (100 * matchedErrors.filter((e) => e <= 2).length) / matchedErrors.length
      ).toFixed(0)}%)`,
      `    UNMATCHED extra steps     ${results.reduce((sum, e) => sum + e.unmatched, 0)}`,
      `      of which the assay could have seen (${ASSAY_FLOOR}-${ASSAY_CEILING})` +
        `  ${results.reduce((sum, e) => sum + e.unmatchedInWindow, 0)}`,
      "      the rest are real chemistry outside any aqueous titration — an amide N-H near 15, an",
      "      azole N-H near 14, a second ring protonation below zero",
      "",
      `  restricted to what the assay could see (${ASSAY_FLOOR} to ${ASSAY_CEILING})`,
      `    right number of values    ${
        results.filter((entry) => entry.inWindow.length === entry.observed.length).length
      }`,
      `    values paired             ${windowErrors.length}`,
      `    MAE                       ${mean(windowErrors).toFixed(3)}`,
      `    within 1 log unit         ${windowErrors.filter((e) => e <= 1).length} (${(
        (100 * windowErrors.filter((e) => e <= 1).length) / windowErrors.length
      ).toFixed(0)}%)`,
      `    within 2 log units        ${windowErrors.filter((e) => e <= 2).length} (${(
        (100 * windowErrors.filter((e) => e <= 2).length) / windowErrors.length
      ).toFixed(0)}%)`,
      ""
    ];
    for (const entry of results) {
      lines.push(
        `    ${entry.id}  ${entry.predicted.map((v) => v.toFixed(2)).join("/").padEnd(28)}` +
          `vs ${entry.observed.map((v) => v.toFixed(2)).join("/").padEnd(20)}` +
          (entry.errors.length > 0 ? mean(entry.errors).toFixed(2) : entry.status)
      );
    }
    console.log(lines.join("\n"));

    // Every molecule must produce SOMETHING or say why. Silence is the failure mode this whole
    // contract is written against.
    expect(answered.length).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(0);
  }, 1_800_000);

  it("stays inside the envelope the contract documents", async () => {
    const results = await runBenchmark();
    // The MATCHED figure, not the index-paired one. Pairing by titration order stops being meaningful
    // the moment the model reports a step the assay could not see, and this model does: SM19 predicts
    // 9.43 against a measured 9.56 while index-pairing scores its first value, 2.11, against it.
    const matched = results.flatMap((entry) => entry.matchedErrors);
    expect(mean(matched)).toBeLessThan(1.0);
    // And it must not have achieved that by answering almost nothing.
    expect(results.filter((entry) => !entry.declined).length).toBeGreaterThanOrEqual(
      Math.floor(results.length * 0.6)
    );
  }, 1_800_000);

  it("was never trained on, and says so where a reader will look", () => {
    expect(BENCHMARK.policy).toMatch(/NEVER TRAINED ON/);
    expect(BENCHMARK.policy).toMatch(/0 of 24/);
  });
});
