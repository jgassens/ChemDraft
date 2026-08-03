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
  type MicrostateSite
} from "./protonation";

const acidic = (n: number): MicrostateSite[] =>
  Array.from({ length: n }, (_, i) => ({
    siteIndex: i, atomIndex: i, transition: "acidic" as const, drawnCharge: 0
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
      return state.protonated[0] ? 9 : 6;
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
      W: number; appliesTo: string; validation: Record<string, number>;
    };
    expect(coupling.W).toBeGreaterThan(0);
    expect(coupling.appliesTo).toMatch(/acid\/base/);
    // The claim the correction exists to make. If a refit stops delivering it, this fails rather than
    // the improvement quietly evaporating.
    expect(coupling.validation.zwitterionicMaeAfter).toBeLessThan(
      coupling.validation.zwitterionicMaeBefore / 2
    );
    // And it must not have been bought by degrading everything else.
    expect(coupling.validation.independentMaeAfter).toBeCloseTo(
      coupling.validation.independentMaeBefore,
      2
    );
  });

  it("was fitted on a different observable than the model was trained on", async () => {
    // Fitting it against the same per-site labels would make it a second model on the same data, and
    // its agreement would mean nothing. Macroscopic values are an aggregate those labels do not hold.
    const coupling = (await import("../vendor/pka-model/coupling.json")).default as unknown as {
      measurement: string; fitMae: number; fitMaeUncorrected: number;
    };
    expect(coupling.measurement).toMatch(/MACROSCOPIC/);
    expect(coupling.fitMae).toBeLessThan(coupling.fitMaeUncorrected);
  });
});

describe("a proton that moved rather than left", () => {
  // An azole's two ring nitrogens present as two independent sites: one drawn with a hydrogen
  // (acidic), one without (basic). Deprotonating the first while protonating the second is not a
  // separate species -- it is the same molecule with the proton on the other nitrogen. Enumeration
  // cannot build it, because reaching the tautomer needs the ring's double bonds rearranged and all
  // the enumeration does is assign charges; what it builds instead is `c1c[nH+]c[n-]1`, an ylide.
  const azole: MicrostateSite[] = [
    { atomIndex: 2, siteIndex: 0, transition: "acidic", drawnCharge: 0 },
    { atomIndex: 4, siteIndex: 1, transition: "basic", drawnCharge: 0 }
  ];

  it("drops the state where the acid gave up a proton and the base took one", () => {
    const seen: string[] = [];
    macroscopicPka(
      azole,
      (state) => {
        seen.push(state.protonated.map((p) => (p ? "1" : "0")).join(""));
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
    const diacid: MicrostateSite[] = [
      { atomIndex: 1, siteIndex: 0, transition: "acidic", drawnCharge: 0 },
      { atomIndex: 5, siteIndex: 1, transition: "acidic", drawnCharge: 0 }
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
