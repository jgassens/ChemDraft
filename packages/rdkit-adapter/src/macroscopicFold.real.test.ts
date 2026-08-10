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
 *     all sixteen       0.380 -> 0.302
 *     the eight zwitterions   0.336 -> 0.178
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
  const { result } = await ionizationOf(smiles, runId);
  return (result as unknown as { macroscopic?: Folded }).macroscopic;
}

/** The whole ionization result, for the gates that read per-SITE values rather than the folded ladder. */
async function ionizationOf(smiles: string, runId: string) {
  const run = await analyzeStructure({
    format: "smiles",
    value: smiles,
    runId,
    startedAt: "2026-08-02T00:00:00.000Z"
  } as never);
  const result = run.results.find((entry) => entry.methodId === IONIZATION_SITES_METHOD_ID);
  if (!result || result.kind !== "ionization") throw new Error(`no ionization result for ${smiles}`);
  return { run, result };
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

    // Measured 0.302 and 0.178 at the fold's introduction. The bound is loose enough not to fail on a
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
    //
    // THEY TRACK THE MODEL, so a retrain moves them and they must be re-derived rather than assumed.
    // The 2026-08-10 retrain moved acetic acid 4.30 -> 4.52 (measured 4.76, so toward it) and left the
    // other five inside 0.005 — which is itself the useful signal: the FOLD did not change, one
    // microscopic prediction did. What this test proves is the relationship between the two, and that
    // survives a retrain; the constants do not.
    const unchanged: Array<[string, string, number[]]> = [
      ["acetic acid", "CC(=O)O", [4.52]],
      ["phenol", "Oc1ccccc1", [9.94]],
      ["ethylenediamine", "NCCN", [6.78, 10.23]],
      ["malonic acid", "OC(=O)CC(=O)O", [2.56, 4.83]],
      ["succinic acid", "OC(=O)CCC(=O)O", [3.79, 5.32]],
      ["pyridine", "c1ccncc1", [5.2]]
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

/**
 * The gate that would have stopped a corpus three separate measurements did not.
 *
 * The IUPAC weak-base ingest was rejected twice on macroscopic accuracy, then retrained a third time
 * once the fold solved its ladders by weighted least squares — on the hypothesis that the fold was what
 * made those rows unshippable. It was not. Every species an experiment can measure got BETTER:
 *
 *     species                                  shipped   +IUPAC   measured
 *     glycine COOH next to NH3+                   2.29     2.29       2.35
 *     glycine NH3+ next to COO-                   9.71     9.93       9.78
 *     acetic acid                                 4.30     4.46       4.76
 *     methylamine                                10.41    10.65      10.66
 *     pyridine                                    5.11     5.23       5.23
 *     glycine NH3+ next to COOH  (CATION)         7.91     2.07       7.70
 *
 * The last row is the whole difference: a five-and-a-half log unit collapse on the one rung no
 * titration can populate, because deprotonating that ammonium gives glycine's neutral form, which does
 * not exist in water. Cross-validated per-site error IMPROVED — 0.7281 to 0.7173 on the rows both
 * corpora share — while the curated macroscopic set went 0.295 to 0.861 and zwitterions 0.165 to 1.285.
 *
 * **Neither statistical signal caught it.** The bad rung reported an interval of 0.46, the second
 * TIGHTEST of the four: the ensemble was confidently wrong, so the weighted solve gave it near-full
 * weight. The same blindness the confidence filter shows against over-detection, for the same reason —
 * a spread fitted on labelled data says nothing about species the labels do not contain.
 *
 * What did catch it is the thermodynamic cycle, which needs no reference value at all. Two protons
 * leaving in either order must cost the same; the shipped model misses that by 0.35 on glycine and the
 * rejected one by 6.51. So this is a gate rather than an anecdote: any future corpus can be screened
 * against it before anyone measures a macroscopic curve.
 */
describe("the cycle defect as a corpus gate", () => {
  it("keeps the amino acids physically possible", async () => {
    // A rejected corpus scored 6.51 here on glycine. The bound is loose enough to survive a retrain
    // that moves site values and tight enough that losing an unlabelled microstate fails it.
    for (const [name, smiles] of [
      ["glycine", "NCC(=O)O"],
      ["alanine", "CC(N)C(=O)O"],
      ["serine", "NC(CO)C(=O)O"],
      ["lysine", "NCCCCC(N)C(=O)O"]
    ] as const) {
      const folded = await fold(smiles, `gate-${name}`);
      expect(folded, name).toBeDefined();
      expect(folded!.inconsistency, `${name} contradicts itself`).toBeLessThan(2.5);
    }
  }, 1_800_000);
});

/**
 * Unpopulated rungs against their BLOCKED ANALOGUES — a second label-free gate, orthogonal to the cycle.
 *
 * An amino acid's NH3+ -> neutral rung is the one no titration can populate, and it is where a corpus that
 * improved every labelled figure put glycine at 2.07 against ~7.7. The cycle defect caught that; this
 * catches it a different way, and the difference matters because the cycle only says a molecule
 * contradicts ITSELF. Here the model is checked against its own answer for a molecule where the same
 * question IS measurable.
 *
 * Esterify the carboxyl and it can no longer ionise: glycine methyl ester's amine titrates in the
 * environment glycine's amine only ever sees on an unpopulated microstate. That value is experimentally
 * accessible — commonly quoted near 7.7, though the sourcing this was checked against is secondary, so
 * the ASSERTION here is the label-free one and the experimental figure is context. -COOH and -COOCH3 have
 * nearly equal inductive constants, which is what makes the substitution legitimate rather than
 * convenient.
 *
 * Measured scatter of the comparison, which is what sets the bound:
 *
 *     molecule          unpopulated rung   methyl ester   difference
 *     glycine                       7.91           7.77        +0.14
 *     alanine                       8.43           7.81        +0.62
 *     beta-alanine                  8.91           9.34        -0.43
 *     serine                        7.89           7.17        +0.72
 *     GABA                          9.69          10.14        -0.45
 *     phenylalanine                 8.09           7.08        +1.01
 *
 * Mean 0.56, worst 1.01 — against the ~5.7 it has to catch. That scatter is the ester approximation plus
 * the model's own noise and is not something to tighten away; the bound is set to 2.0 so a legitimate
 * substituent effect cannot fail it while the failure mode misses by a factor of three.
 *
 * **QM WAS TRIED FOR THIS AND WAS WORSE THAN USELESS.** B3LYP/6-31+G(d,p) with ddCOSMO put glycine's
 * rung at 3.74 — nearer the rejected model's 2.07 than the shipped 7.91, so it would have endorsed the
 * regression. `qm_microstate.py` records why: an electrostatic continuum under-stabilises a zwitterion by
 * about 5.4 kcal/mol, and the conformer search is not the problem.
 */
describe("unpopulated rungs against their blocked analogues", () => {
  it("agrees with itself about a rung no titration can reach", async () => {
    const PAIRS = [
      ["glycine", "NCC(=O)O", "COC(=O)CN"],
      ["alanine", "C[C@@H](N)C(=O)O", "COC(=O)[C@@H](C)N"],
      ["beta-alanine", "NCCC(=O)O", "COC(=O)CCN"],
      ["serine", "N[C@@H](CO)C(=O)O", "COC(=O)[C@@H](N)CO"],
      ["GABA", "NCCCC(=O)O", "COC(=O)CCCN"],
      ["phenylalanine", "N[C@@H](Cc1ccccc1)C(=O)O", "COC(=O)[C@@H](N)Cc1ccccc1"]
    ] as const;

    /** The amine's basic rung: for the acid it is unpopulated, for the ester it is what titrates. */
    const amineRung = async (smiles: string, runId: string) => {
      const { result } = await ionizationOf(smiles, runId);
      const basic = result.sites.filter((site) => site.acidCharge === 1 && site.pKa !== null);
      expect(basic, `${smiles} offers no protonated amine rung`).toHaveLength(1);
      return basic[0]!.pKa!;
    };

    const gaps: number[] = [];
    for (const [name, acid, ester] of PAIRS) {
      const rung = await amineRung(acid, `analogue-acid-${name}`);
      const blocked = await amineRung(ester, `analogue-ester-${name}`);
      const gap = rung - blocked;
      gaps.push(Math.abs(gap));
      expect(
        Math.abs(gap),
        `${name}: unpopulated rung ${rung.toFixed(2)} contradicts its blocked analogue ${blocked.toFixed(2)}`
      ).toBeLessThan(2);
    }
    // The mean is asserted too, so a corpus that degrades every pair a little cannot pass by staying
    // under the per-pair bound on each one.
    const mean = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
    expect(mean, "the analogue comparison has degraded across the board").toBeLessThan(1.2);
  }, 1_800_000);
});

/**
 * The second protonation of an azinium ring, which water does not hold.
 *
 * Six of SAMPL6's twenty-four molecules carry two nitrogens in one aromatic ring — a quinazoline, a
 * pyrimidine — and both were offered a basicity at similar values. Protonating the first leaves the
 * ring strongly electron-poor and the second nitrogen unprotonatable in any accessible range: pyrazine's
 * second pKa is near -6. Nothing taught the model that, because a diprotonated pyrazine cannot be
 * titrated either, so it filled the gap with a plausible number and a titration step appeared where the
 * molecule has none.
 *
 * The discriminator is CHARGE COMPENSATION, and the twenty-one corpus labels separate exactly on it:
 *
 *     ring bears no negative charge   n= 4   MAE 4.98   bias +4.98    0 of 4 inside pH 2-12
 *     ring bears a negative charge    n=17   MAE 1.31   bias +0.39   16 of 17 inside pH 2-12
 *
 * So a blanket rule would have deleted sixteen real, well-predicted uracil and thiouracil values. This
 * one suppresses four, every one measured below -2.7 and over-predicted by about five log units.
 */
describe("a second ring protonation the assay could never see", () => {
  it("stops offering one on an uncompensated diazine", async () => {
    // Pyrazine: first protonation 0.65, second near -5.8. Only the first is a titration step.
    for (const [name, smiles] of [
      ["pyrazine", "c1cnccn1"],
      ["pyrimidine", "c1cncnc1"],
      ["quinazoline", "c1ccc2ncncc2c1"]
    ] as const) {
      const folded = await fold(smiles, `azinium-${name}`);
      expect(folded, name).toBeDefined();
      const inWindow = folded!.pKa.filter((v) => v >= 2 && v <= 12);
      expect(inWindow.length, `${name} reports ${inWindow.length} steps inside pH 2-12`).toBeLessThan(2);
    }
  }, 1_800_000);

  it("leaves a single-nitrogen ring alone", async () => {
    // Pyridine and imidazole protonate once and that IS a titration step. The rule turns on a second
    // nitrogen in the SAME ring, so neither may be touched — and the charge-compensated exception,
    // which is what stops this deleting sixteen real uracil values, is pinned directly against the
    // predicate in `protonation.test.ts` rather than through a molecule whose neutral form does not
    // even reach the clause.
    for (const [name, smiles, expected] of [
      ["pyridine", "c1ccncc1", 5.23],
      ["imidazole", "c1c[nH]cn1", 6.95]
    ] as const) {
      const folded = await fold(smiles, `single-n-${name}`);
      expect(folded, name).toBeDefined();
      const inWindow = folded!.pKa.filter((v) => v >= 2 && v <= 12);
      expect(inWindow.length, `${name} lost its titration step`).toBe(1);
      expect(inWindow[0]!).toBeCloseTo(expected, 0);
    }
  }, 1_800_000);
});

/**
 * How many steps the method finds, measured where the tabulation is COMPLETE.
 *
 * This test exists because the only step-count figure this method had came from SAMPL6, and SAMPL6
 * cannot answer the question. It reports 31 measured values across 24 drug-like molecules — about 1.3
 * each — and those molecules have more ionizable groups than that. A prediction the assay never reported
 * is counted as an extra step whether it is wrong or merely unmeasured, so "12 of 24" conflates
 * over-detection with the benchmark's own coverage.
 *
 * These twenty are different: their aqueous pKa values are tabulated exhaustively, so an extra
 * prediction really is an extra. The method finds the right number on EIGHTEEN of them, and both
 * exceptions are the scoring window clipping a correct value rather than a detection error:
 *
 *     histidine   predicted [1.8, 6.1, 9.1, 13.3]   measured [1.85, 6.0, 9.33]
 *     oxalic acid predicted [0.8, 4.4]              measured [1.25, 4.14]
 *
 * Histidine's three measured values are all matched; 1.8 sits below a floor of 2. Oxalic acid's are both
 * matched; 0.8 sits below it too. So the honest reading of site detection is that it is close to right
 * where ground truth is complete, and the SAMPL6 count is measuring two things at once.
 *
 * The out-of-window predictions here are real chemistry, not noise: serine's 14.4 is its hydroxyl,
 * imidazole's 13.9 its N-H — tabulated at 14.4 — and citric acid's 14.0 its tertiary alcohol.
 */
describe("the number of titration steps, where the tabulation is complete", () => {
  const COMPLETE: Array<[string, string, number[]]> = [
    ["glycine", "NCC(=O)O", [2.35, 9.78]],
    ["alanine", "CC(N)C(=O)O", [2.34, 9.69]],
    ["serine", "NC(CO)C(=O)O", [2.21, 9.15]],
    ["cysteine", "NC(CS)C(=O)O", [1.71, 8.33, 10.78]],
    ["aspartic acid", "NC(CC(=O)O)C(=O)O", [1.99, 3.9, 9.9]],
    ["glutamic acid", "NC(CCC(=O)O)C(=O)O", [2.1, 4.07, 9.47]],
    ["lysine", "NCCCCC(N)C(=O)O", [2.15, 9.16, 10.67]],
    ["histidine", "NC(Cc1c[nH]cn1)C(=O)O", [1.85, 6.0, 9.33]],
    ["acetic acid", "CC(=O)O", [4.76]],
    ["phenol", "Oc1ccccc1", [9.95]],
    ["ethylenediamine", "NCCN", [6.85, 9.93]],
    ["malonic acid", "OC(=O)CC(=O)O", [2.83, 5.69]],
    ["succinic acid", "OC(=O)CCC(=O)O", [4.21, 5.64]],
    ["citric acid", "OC(=O)CC(O)(CC(=O)O)C(=O)O", [3.13, 4.76, 6.4]],
    ["imidazole", "c1c[nH]cn1", [6.95]],
    ["pyridine", "c1ccncc1", [5.23]],
    ["piperazine", "C1CNCCN1", [5.35, 9.73]],
    ["oxalic acid", "OC(=O)C(=O)O", [1.25, 4.14]],
    ["glutaric acid", "OC(=O)CCCC(=O)O", [4.34, 5.41]],
    ["phthalic acid", "OC(=O)c1ccccc1C(=O)O", [2.89, 5.51]]
  ];

  it("finds the right number on nearly all of them", async () => {
    // A floor of 1 rather than 2: oxalic acid's 1.25 and histidine's 1.85 are in every reference table,
    // so a window that excludes them is not describing aqueous titration. SAMPL6's narrower 2-12 is a
    // property of the UV-metric assay it used, not of water, and the two must not be confused.
    const [floor, ceiling] = [1, 12];
    const wrong: string[] = [];
    let extras = 0;
    let missed = 0;
    for (const [index, [name, smiles, measured]] of COMPLETE.entries()) {
      const folded = await fold(smiles, `complete-${index}`);
      expect(folded, name).toBeDefined();
      const inWindow = folded!.pKa.filter((v) => v >= floor && v <= ceiling);
      extras += Math.max(0, inWindow.length - measured.length);
      missed += Math.max(0, measured.length - inWindow.length);
      if (inWindow.length !== measured.length) {
        wrong.push(`${name}: ${inWindow.length} in window against ${measured.length} measured ` +
          `[${folded!.pKa.map((v) => v.toFixed(1)).join(", ")}]`);
      }
    }
    console.log(
      `\n  right number on ${COMPLETE.length - wrong.length}/${COMPLETE.length}` +
        `   extra ${extras}   missed ${missed}` +
        (wrong.length > 0 ? `\n    ${wrong.join("\n    ")}` : "") + "\n"
    );
    // Nineteen of twenty at a floor of 1 — only oxalic acid, whose first value is predicted 0.8 against
    // a measured 1.25, still falls out. That is a valuation error at the boundary, not a missing site.
    expect(COMPLETE.length - wrong.length).toBeGreaterThanOrEqual(18);
    // And it must not be achieving that by finding too few: over-detection is the failure under test.
    expect(extras).toBeLessThanOrEqual(2);
  }, 1_800_000);
});

/**
 * Carbon acids, a whole compound class this method could not see at all.
 *
 * The site table is transcribed from Dimorphite-DL and covers O, N and S. So a 1,3-diketone reported
 * NOTHING — acetylacetone's pKa is 8.9 and the acidic proton is its central CH2 — while the same compound
 * drawn as its enol reported 8.72 off the O-H. Nitroalkanes, malonates, cyanoacetates, β-ketoesters and
 * Meldrum's acid were all invisible the same way.
 *
 * The model was ALREADY TRAINED on them, which is what made this a detection fix rather than a new
 * prediction: 445 of 12,096 labels sit on a carbon. The only question was which to offer, answered by
 * activation count — at least one nitro, or at least two carbanion stabilisers:
 *
 *     admitted   n=350   MAE 1.15   bias +0.01   97% inside pH 1-14
 *     excluded   n= 95   MAE 2.63   bias -0.22   79% inside pH 1-14
 *
 * The excluded set is the lone ketones and unactivated carbons, whose real values run to 18, 19 and 30.9
 * where the model says 11.6, 18.7 and 16.4. Offering those would be the carbon-acid version of scoring an
 * amide N-H near 8 when it is really 16.
 */
describe("carbon acids", () => {
  it("matches literature on the classes it now offers", async () => {
    const known: Array<[string, string, number]> = [
      ["acetylacetone", "CC(=O)CC(=O)C", 8.9],
      ["dimedone", "CC1(C)CC(=O)CC(=O)C1", 5.23],
      ["Meldrum's acid", "CC1(C)OC(=O)CC(=O)O1", 4.97],
      ["ethyl acetoacetate", "CCOC(=O)CC(C)=O", 10.7],
      ["malononitrile", "N#CCC#N", 11.2],
      ["nitromethane", "C[N+](=O)[O-]", 10.2],
      ["nitroethane", "CC[N+](=O)[O-]", 8.5],
      ["2-nitropropane", "CC(C)[N+](=O)[O-]", 7.7]
    ];
    const errors: number[] = [];
    for (const [index, [name, smiles, literature]] of known.entries()) {
      const folded = await fold(smiles, `carbon-${index}`);
      expect(folded, `${name} reported no value`).toBeDefined();
      const closest = Math.min(...folded!.pKa.map((v) => Math.abs(v - literature)));
      errors.push(closest);
      expect(closest, `${name} against literature ${literature}`).toBeLessThan(1.5);
    }
    const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log(`\n  carbon acids: MAE ${mae.toFixed(3)} over ${errors.length} literature values\n`);
    // Measured 0.20 over these eight at introduction, against a corpus-wide 0.73.
    expect(mae).toBeLessThan(0.6);
  }, 1_800_000);

  it("declines the ones the corpus cannot support", async () => {
    // A lone ketone's alpha proton is near 20 and an unactivated C-H near 50; the model puts them in the
    // teens, so offering them would invent a titration step. And a carbon flanked by CARBOXYLS is
    // excluded separately: diethyl malonate's CH is 13.3 because its esters cannot ionise, malonic acid's
    // is far less acidic, and the corpus holds one label of 350 that could teach the difference. Offering
    // it gave malonic acid a third rung, doubled its error and made its thermodynamic cycle miss by 3.07.
    for (const smiles of ["CC(C)=O", "O=C1CCCCC1", "CC", "Cc1ccccc1", "CCO"]) {
      const folded = await fold(smiles, `no-carbon-${smiles}`);
      const values = folded?.pKa ?? [];
      expect(values.filter((v) => v >= 1 && v <= 14), smiles).toHaveLength(0);
    }
    // Malonic acid keeps exactly its two carboxyl steps, and no cycle defect.
    const malonic = await fold("OC(=O)CC(=O)O", "malonic-carbon");
    expect(malonic!.pKa).toHaveLength(2);
    expect(malonic!.inconsistency).toBeCloseTo(0, 6);
  }, 1_800_000);
});
