/**
 * The macroscopic fold, checked against cases with exact analytic answers.
 *
 * No chemistry here on purpose. The microscopic pKa values are supplied directly, so a failure is in
 * the thermodynamics rather than in the model — and the statistical factors below are the classic
 * result that any implementation of this has to reproduce.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SITES,
  logSumExp10,
  macroscopicApplies,
  macroscopicPka,
  chargeAtLevel,
  enumerateMicrostates,
  type ProtonationLadder
} from "./protonation";

/**
 * `n` independent neutral acids: each one atom with a single rung, drawn holding its proton.
 *
 * `acidCharge: 0` says the acid side is neutral, so the ladder's two levels are -1 (the anion) and 0
 * (the acid), and `drawnCharge: 0` puts the drawing on the upper one.
 */
const acidic = (n: number): ProtonationLadder[] =>
  Array.from({ length: n }, (_, i) => ({
    atomIndex: i,
    drawnCharge: 0,
    rungs: [{ siteIndex: i, acidCharge: 0 }]
  }));

describe("folding microscopic pKa into macroscopic", () => {
  it("leaves a single site exactly as it was", () => {
    // With one site the two descriptions coincide, and any implementation that shifts it is wrong.
    const outcome = macroscopicPka(acidic(1), () => 4.76);
    expect(macroscopicApplies(outcome)).toBe(true);
    if (!macroscopicApplies(outcome)) return;
    expect(outcome.pKa).toHaveLength(1);
    expect(outcome.pKa[0]!).toBeCloseTo(4.76, 9);
    expect(outcome.inconsistency).toBe(0);
  });

  it("reproduces the statistical factor for two equivalent independent sites", () => {
    // The textbook result: two identical non-interacting groups of microscopic pKa p titrate at
    // p - log10(2) and p + log10(2). It falls out of the degeneracy alone — there are two ways to hold
    // one proton and one way to hold two — so it is the sharpest possible check on the bookkeeping.
    const p = 4.5;
    const outcome = macroscopicPka(acidic(2), () => p);
    expect(macroscopicApplies(outcome)).toBe(true);
    if (!macroscopicApplies(outcome)) return;
    expect(outcome.pKa).toHaveLength(2);
    expect(outcome.pKa[0]!).toBeCloseTo(p - Math.log10(2), 9);
    expect(outcome.pKa[1]!).toBeCloseTo(p + Math.log10(2), 9);
  });

  it("reproduces the factor for three equivalent sites", () => {
    // Degeneracies 1, 3, 3, 1 give shifts of log10(3), 0 and -log10(3).
    const p = 7;
    const outcome = macroscopicPka(acidic(3), () => p);
    if (!macroscopicApplies(outcome)) throw new Error("declined");
    expect(outcome.pKa[0]!).toBeCloseTo(p - Math.log10(3), 9);
    expect(outcome.pKa[1]!).toBeCloseTo(p, 9);
    expect(outcome.pKa[2]!).toBeCloseTo(p + Math.log10(3), 9);
  });

  it("returns values in titration order, lowest first", () => {
    const sites = acidic(2);
    // Site 0 is the strong acid wherever it appears; site 1 is weak.
    const outcome = macroscopicPka(sites, (_state, i) => (i === 0 ? 2 : 10));
    if (!macroscopicApplies(outcome)) throw new Error("declined");
    expect(outcome.pKa[0]!).toBeLessThan(outcome.pKa[1]!);
    // Well-separated sites titrate at essentially their own values.
    expect(outcome.pKa[0]!).toBeCloseTo(2, 6);
    expect(outcome.pKa[1]!).toBeCloseTo(10, 6);
  });

  it("reports path disagreement instead of hiding it", () => {
    // Two routes to the doubly protonated state. Site 0 reads 4 whichever order it is reached in;
    // site 1 reads 6 alone but 9 once site 0 is protonated. The two paths therefore give 4+9=13 and
    // 6+4=10, and the 3-unit gap is a thermodynamic impossibility the model produced anyway.
    const outcome = macroscopicPka(acidic(2), (state, i) => {
      if (i === 0) return 4;
      return state.levels[0] === 1 ? 9 : 6;
    });
    if (!macroscopicApplies(outcome)) throw new Error("declined");
    expect(outcome.inconsistency).toBeCloseTo(3, 9);
  });

  it("declines rather than enumerating a molecule with too many sites", () => {
    // 2^n microstates, each needing a structure built and scored. A silent truncation here would
    // report a macroscopic pKa computed over some arbitrary subset of the ladder.
    const outcome = macroscopicPka(acidic(MAX_SITES + 1), () => 5);
    expect(macroscopicApplies(outcome)).toBe(false);
    if (!macroscopicApplies(outcome)) {
      expect(outcome.declined).toMatch(/microstates/);
      expect(outcome.declined).toMatch(/rather than a truncated one/);
    }
  });

  it("drops an edge it has no value for rather than assuming one", () => {
    const outcome = macroscopicPka(acidic(2), (_state, i) => (i === 0 ? 4 : undefined));
    if (!macroscopicApplies(outcome)) return;
    // Only the ladder that could be built contributes; the unreachable states are absent.
    expect(outcome.microstateCount).toBeLessThan(4);
  });
});

describe("the partition sum", () => {
  it("stays finite where a plain 10^x would not", () => {
    // A polyamine's most protonated microstate reaches L above 300, where 10**L is Infinity. The
    // macroscopic value is still perfectly well defined.
    expect(logSumExp10([400, 399])).toBeCloseTo(400 + Math.log10(1 + 10 ** -1), 9);
    expect(Number.isFinite(logSumExp10([400, 399]))).toBe(true);
  });

  it("agrees with the naive computation where that is representable", () => {
    const values = [1.5, 2.25, 0.75];
    const naive = Math.log10(values.reduce((sum, v) => sum + 10 ** v, 0));
    expect(logSumExp10(values)).toBeCloseTo(naive, 12);
  });
});

describe("the electrostatic coupling", () => {
  /**
   * The correction is applied inside `macroscopicFromSites`, which needs real structures. What can be
   * pinned here is the shape it must have — the sign, and that it touches only acid/base pairs.
   */
  it("keeps a fitted parameter, not a typed-in one", async () => {
    const coupling = (await import("../vendor/pka-model/coupling.json")).default as unknown as {
      W: number; appliesTo: string; fitMae: number; fitMaeUncorrected: number; note: string;
    };
    expect(coupling.W).toBeGreaterThanOrEqual(0);
    expect(coupling.appliesTo).toMatch(/acid\/base/);
    // It must not be WORSE than no correction on its own fitting set. That is now the whole claim:
    // this test used to assert the correction HALVED the zwitterion error, and it did — against the
    // Dwar-iBond-only corpus, where both scaffold halves independently chose W = 7. Adding pKaCHU,
    // which contains the amino-acid neutral forms Dwar-iBond never recorded, collapsed the effect to
    // 0.037 log units and made the old W = 6 worse than switching the term off. The physics was never
    // something the model could not learn; it was something the LABELS did not contain.
    expect(coupling.fitMae).toBeLessThanOrEqual(coupling.fitMaeUncorrected);
    expect(coupling.note).toMatch(/COLLAPSED/);
  });

  it("has switched itself off, and the artifact says so", async () => {
    // This test has tracked the term's whole life. It once asserted the correction HALVED the
    // zwitterion error, and it did: fitted against Dwar-iBond alone, both scaffold halves independently
    // chose W = 7 and the term was worth 1.36 log units. Adding pKaCHU — which contains the amino-acid
    // neutral forms Dwar-iBond never recorded — took it to W = 1 and 0.037. Replacing the forest with a
    // message-passing network takes it to nothing: every W above 0 makes the validation zwitterions
    // monotonically worse (0.32, 0.36, 0.44, 0.69 at W = 0, 0.5, 1, 2).
    //
    // The electrostatics were never physics the model could not learn. They were physics the LABELS
    // did not contain, and then physics the FOREST could not represent.
    //
    // The fit switches the term off itself rather than being hand-set: below a floor of 0.05 log units
    // on its own fitting set, W is zero. If a future model or corpus makes it worth something again,
    // the fit will say so and this test will fail — which is the point of asserting it here.
    const coupling = (await import("../vendor/pka-model/coupling.json")).default as unknown as {
      W: number; fitMae: number; fitMaeUncorrected: number;
    };
    expect(coupling.W).toBe(0);
    expect(coupling.fitMaeUncorrected - coupling.fitMae).toBeLessThan(0.05);

    const macro = (await import("../vendor/pka-model/macro-validation.json")).default as unknown as {
      byClass: Record<string, { raw_ladder: number; "+_coupling": number }>;
    };
    // With W = 0 the correction is the identity, so every class must be untouched to the last decimal.
    for (const kind of ["independent", "zwitterionic", "azole", "ALL"]) {
      const cls = macro.byClass[kind]!;
      expect(cls["+_coupling"], `${kind} moved with W = 0`).toBeCloseTo(cls.raw_ladder, 6);
    }
  });

  it("was fitted on a different observable than the model was trained on", async () => {
    // Fitting it against the same per-site labels would make it a second model on the same data, and
    // its agreement would mean nothing. Macroscopic values are an aggregate those labels do not hold.
    const coupling = (await import("../vendor/pka-model/coupling.json")).default as unknown as {
      measurement: string; fitMae: number; fitMaeUncorrected: number;
    };
    expect(coupling.measurement).toMatch(/MACROSCOPIC/);
    // Less than OR EQUAL: at W = 0 the correction is the identity and the two are the same number.
    // The claim being pinned is that fitting it never made its own fitting set worse, which stays
    // meaningful whether or not the term is currently doing anything.
    expect(coupling.fitMae).toBeLessThanOrEqual(coupling.fitMaeUncorrected);
  });
});

describe("a proton that moved rather than left", () => {
  // An azole's two ring nitrogens present as two independent sites: one drawn with a hydrogen
  // (acidic), one without (basic). Deprotonating the first while protonating the second is not a
  // separate species -- it is the same molecule with the proton on the other nitrogen. Enumeration
  // cannot build it, because reaching the tautomer needs the ring's double bonds rearranged and all
  // the enumeration does is assign charges; what it builds instead is `c1c[nH+]c[n-]1`, an ylide.
  // Two ring nitrogens: one drawn holding a proton (a neutral acid, rung at 0) and one drawn without
  // (a base whose conjugate acid is a cation, rung at +1).
  const azole: ProtonationLadder[] = [
    { atomIndex: 2, drawnCharge: 0, rungs: [{ siteIndex: 0, acidCharge: 0 }] },
    { atomIndex: 4, drawnCharge: 0, rungs: [{ siteIndex: 1, acidCharge: 1 }] }
  ];

  it("drops the state where the acid gave up a proton and the base took one", () => {
    const seen: string[] = [];
    macroscopicPka(
      azole,
      (state) => {
        seen.push(state.levels.join(""));
        return 7;
      },
      [[0, 1]]
    );
    // 01 is the ylide: site 0 (acidic) deprotonated, site 1 (basic) protonated.
    expect(seen).not.toContain("01");
    expect(seen).toContain("10");
  });

  it("leaves the count of macroscopic values alone", () => {
    // Dropping a state must not drop a titration step: two sites still give two pKa values, because
    // the tautomer is the same protonation state as the microstate that survives.
    const withPair = macroscopicPka(azole, () => 7, [[0, 1]]);
    const without = macroscopicPka(azole, () => 7, []);
    expect(macroscopicApplies(withPair)).toBe(true);
    expect(macroscopicApplies(without)).toBe(true);
    if (!macroscopicApplies(withPair) || !macroscopicApplies(without)) return;
    expect(withPair.pKa).toHaveLength(without.pKa.length);
    expect(withPair.pKa).toHaveLength(2);
    // One fewer microstate reached, but the same number of titration steps.
    expect(withPair.microstateCount).toBe(without.microstateCount - 1);
  });

  it("ignores same-transition pairs, which are never tautomers of each other", () => {
    // Two acidic sites cannot be related by a proton moving between them in this sense -- there is no
    // acceptor. Passing such a pair must not silently delete a real microstate.
    const diacid: ProtonationLadder[] = [
      { atomIndex: 1, drawnCharge: 0, rungs: [{ siteIndex: 0, acidCharge: 0 }] },
      { atomIndex: 5, drawnCharge: 0, rungs: [{ siteIndex: 1, acidCharge: 0 }] }
    ];
    const paired = macroscopicPka(diacid, () => 4, [[0, 1]]);
    const plain = macroscopicPka(diacid, () => 4, []);
    expect(macroscopicApplies(paired)).toBe(true);
    expect(macroscopicApplies(plain)).toBe(true);
    if (!macroscopicApplies(paired) || !macroscopicApplies(plain)) return;
    expect(paired.pKa).toEqual(plain.pKa);
    expect(paired.microstateCount).toBe(plain.microstateCount);
  });
});

describe("an amphoteric atom, which the boolean model could not describe", () => {
  // Aniline's nitrogen loses a proton (to the anilide anion) AND gains one (to anilinium). Two rungs,
  // three levels, ONE variable. Under independent booleans this was two switches, and the state where
  // both were thrown put the same nitrogen at -1 and +1 at once.
  const aniline: ProtonationLadder[] = [
    { atomIndex: 0, drawnCharge: 0, rungs: [{ siteIndex: 0, acidCharge: 0 }, { siteIndex: 1, acidCharge: 1 }] }
  ];

  it("gives one atom three levels rather than two independent switches", () => {
    const states = enumerateMicrostates(aniline, 0);
    expect(states).toHaveLength(3);
    expect(states.map((state) => chargeAtLevel(aniline[0]!, state.levels[0]!)).sort()).toEqual([-1, 0, 1]);
  });

  it("cannot place one atom at two charges at once", () => {
    // The property the whole refactor exists for. Every state assigns each atom exactly one charge,
    // because a level index IS one charge — there is no combination of bits to get wrong.
    for (const state of enumerateMicrostates(aniline, 0)) {
      expect(state.levels).toHaveLength(aniline.length);
      expect(Number.isInteger(state.levels[0])).toBe(true);
    }
  });

  it("titrates its two rungs in order", () => {
    // The callback is asked for the pKa of the rung being DESCENDED from the current level: at level 2
    // that is anilinium losing its proton (4.6), at level 1 it is neutral aniline losing one (30.7).
    const outcome = macroscopicPka(aniline, (state) => (state.levels[0] === 2 ? 4.6 : 30.7));
    expect(macroscopicApplies(outcome)).toBe(true);
    if (!macroscopicApplies(outcome)) return;
    expect(outcome.pKa).toHaveLength(2);
    expect(outcome.pKa[0]!).toBeCloseTo(4.6, 9);
    expect(outcome.pKa[1]!).toBeCloseTo(30.7, 9);
  });
});

describe("what counts as a zwitterion", () => {
  // A statement about the CHARGES IN THE DOMINANT SPECIES, not about which site types are present.
  // The old rule — "there is an acidic site and a basic site" — flagged acetamide, urea, pyridinium
  // and aniline, none of which is a zwitterion.
  const amphoteric = (atomIndex: number, siteIndex: number): ProtonationLadder => ({
    atomIndex,
    drawnCharge: 0,
    rungs: [{ siteIndex, acidCharge: 0 }, { siteIndex: siteIndex + 1, acidCharge: 1 }]
  });

  it("does not flag a single amphoteric atom", () => {
    // Acetamide: one nitrogen that both loses and gains a proton. One atom cannot be a zwitterion.
    const outcome = macroscopicPka([amphoteric(2, 0)], (state) => (state.levels[0] === 2 ? 8.6 : 11.6));
    if (!macroscopicApplies(outcome)) throw new Error("declined");
    expect(outcome.zwitterionic).toBe(false);
  });

  it("flags an acid and a base that are genuinely both charged at once", () => {
    // Glycine's shape: an amine whose conjugate acid is a cation, and a carboxyl whose base is an
    // anion. The neutral-charge state that dominates carries +1 and -1 on different atoms.
    const glycine: ProtonationLadder[] = [
      { atomIndex: 0, drawnCharge: 0, rungs: [{ siteIndex: 0, acidCharge: 1 }] },
      { atomIndex: 4, drawnCharge: 0, rungs: [{ siteIndex: 1, acidCharge: 0 }] }
    ];
    const outcome = macroscopicPka(glycine, (_state, i) => (i === 0 ? 9.6 : 2.4));
    if (!macroscopicApplies(outcome)) throw new Error("declined");
    expect(outcome.zwitterionic).toBe(true);
  });

  it("does not flag two acids", () => {
    const outcome = macroscopicPka(acidic(2), () => 4.5);
    if (!macroscopicApplies(outcome)) throw new Error("declined");
    expect(outcome.zwitterionic).toBe(false);
  });
});
