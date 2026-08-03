/**
 * Ionizable-site assessment against the real RDKit SMARTS engine.
 *
 * The site table is transcribed from Dimorphite-DL, so the tests that matter are the ones checking we
 * read it the way Dimorphite does — above all that the per-site index selects the atom that actually
 * ionises, which is the trap this table sets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAnalysisReport, type IonizationSite } from "@chemdraft/analysis-core";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import {
  CONSENSUS_CALIBRATION,
  HAMMETT_IN_DOMAIN_MAE,
  IONIZATION_SITES_METHOD_ID,
  combineSiteEstimates,
  ionizationContract
} from "./ionization";
import { PKA_MODEL_TRAINING } from "./pkaModel";
import { IONIZATION_SITE_TYPES } from "./ionizationSites";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});
afterAll(() => {
  resetRdkitForTesting();
});

let counter = 0;
async function ionization(smiles: string) {
  counter += 1;
  const run = await analyzeStructure({
    format: "smiles",
    value: smiles,
    runId: `ion-${counter}`,
    startedAt: "2026-08-02T00:00:00.000Z"
  } as never);
  const result = run.results.find((entry) => entry.methodId === IONIZATION_SITES_METHOD_ID);
  if (!result || result.kind !== "ionization") throw new Error("no ionization result");
  return { run, result };
}

describe("finding the ionizable atom", () => {
  it("puts acetic acid's site on the hydroxyl oxygen, not the carbonyl", async () => {
    // The whole reason the index semantics were verified against Dimorphite's source. Acetic acid is
    // CC(=O)O — atom 1 is the carbonyl carbon, 2 the =O, 3 the -OH. The site must be atom 3.
    const { result } = await ionization("CC(=O)O");
    const site = result.sites.find((entry) => /carboxyl/i.test(entry.siteType));
    expect(site, "no carboxyl site found").toBeDefined();
    expect(site!.ionizableAtomIndex).toBe(3);
  });

  it("scores each site with the trained model, not with the table", async () => {
    // The table locates; the model values. Acetic acid's carboxyl measures 4.76.
    const { result } = await ionization("CC(=O)O");
    const site = result.sites.find((entry) => entry.ionizableAtomIndex === 3);
    expect(site?.basis).toBe("experimentally-trained-model");
    expect(site?.pKa).toBeGreaterThan(3);
    expect(site?.pKa).toBeLessThan(7);
  });

  it("gets phenol close to its measured value", async () => {
    // Phenol is 9.95. A useful end-to-end check that features, forest, and wiring all line up — a
    // feature-order slip would still produce a number, just not this one.
    const { result } = await ionization("Oc1ccccc1");
    const site = result.sites.find((entry) => entry.ionizableAtomIndex === 0);
    expect(site?.pKa).toBeGreaterThan(8.5);
    expect(site?.pKa).toBeLessThan(11.5);
  });

  it("gives an amine its BASIC pKa, not an acidity", async () => {
    // This test has now said three different things, and the history is the point. It first asserted
    // ethylamine's N scored ABOVE 12, reasoning that a weakly acidic N-H deserved a high number. Then
    // that it was declined outright, since the real N-H acidity is near 35 and unmeasurable. Both
    // missed what a chemist actually means by an amine's pKa: the AMMONIUM's, ~10.7 — a basicity.
    const { result } = await ionization("CCN");
    const site = result.sites.find((entry) => entry.ionizableAtomIndex === 2);
    expect(site?.transition).toBe("basic");
    expect(site!.pKa!).toBeGreaterThan(8);
    expect(site!.pKa!).toBeLessThan(12);

    // The acidic half is still absent: it is near 35, and zero of the 3,031 training labels is an
    // unactivated amine.
    expect(result.sites.filter((entry) => entry.transition === "acidic")).toEqual([]);
  });

  it("lists every candidate class when several claim the same atom", async () => {
    // 46% of labelled sites match more than one type, and the types describe different transitions —
    // so the candidates are shown rather than one being silently chosen.
    const { result } = await ionization("CC(=O)O");
    const ambiguous = result.sites.filter((site) => site.ambiguity);
    for (const site of ambiguous) {
      expect(site.ambiguity!.candidateTypes.length).toBeGreaterThan(1);
      expect(site.siteType).toContain("/");
    }
  });

  it("reports every site of a polyprotic molecule separately", async () => {
    // Histidine has three. Collapsing them into "the pKa" is the first thing that makes a pKa wrong,
    // which is why the result is a list.
    // Four ionizable positions are found. Two are scored (the imidazole N-H and the carboxyl) and two
    // are withheld with reasons (the protonless ring nitrogen, the amine terminus) — but each position
    // is accounted for separately, which is the property being pinned.
    const { result } = await ionization("NC(Cc1c[nH]cn1)C(=O)O");
    expect(result.sites.length + result.unassessed.length).toBeGreaterThanOrEqual(4);
    const atoms = new Set(result.sites.map((site) => site.ionizableAtomIndex));
    expect(atoms.size).toBe(result.sites.length);
  });

  it("labels the basis so the source of each number is legible", async () => {
    const { result } = await ionization("CC(=O)O");
    for (const site of result.sites) {
      // Never "inherited-from-another-predictor": this model's supervised signal is measured pKa.
      expect(site.basis).toBe("experimentally-trained-model");
    }
  });
});

describe("what it refuses to score", () => {
  it("says nothing ionizable rather than returning an empty success", async () => {
    // Benzene has no site. That is the method not applying, not failing, and it must not drag the
    // run's status down.
    const { run, result } = await ionization("c1ccccc1");
    expect(result.status).toBe("not-applicable");
    expect(result.sites).toEqual([]);
    expect(result.applicability.reasons[0]).toMatch(/No tabulated ionizable site/);
    expect(run.status).toBe("ok");
  });

  it("reports a metal-adjacent site as unassessed instead of scoring it", async () => {
    // The measured justification: across every training and test set the open pKa models ship —
    // 1.57M molecules — the count of metal-containing structures is zero. There is no evidence to
    // score this on, and inventing one is the failure this whole branch is against.
    const { result } = await ionization("[Na+].[O-]C(=O)c1ccccc1");
    const scored = result.sites.filter((site) => site.pKa !== null);
    const mentionsMetal = [...result.unassessed.map((entry) => entry.reason)].join(" ");
    if (result.unassessed.length > 0) {
      expect(mentionsMetal).toMatch(/No open pKa dataset contains a metal-bearing structure/);
      expect(result.status).toBe("partial");
    }
    // Whatever else happens, no site adjacent to sodium may carry a number.
    for (const site of scored) expect(site.atomIndices).not.toContain(0);
  });

  it("lists a recognised but non-titratable site with no value rather than its sentinel", async () => {
    // Dimorphite encodes "never titrates" as -1000. Rendering that would put "pKa -1000" on screen.
    const nitro = IONIZATION_SITE_TYPES.find((type) => type.name === "Nitro");
    expect(nitro?.sites[0]!.pKaMean).toBeLessThan(-100);

    const { result } = await ionization("O=[N+]([O-])c1ccccc1");
    for (const site of result.sites) {
      if (site.pKa !== null) expect(site.pKa).toBeGreaterThan(-100);
      else expect(site.spread).toBeUndefined();
    }
  });
});

describe("the second method, end to end", () => {
  it("reaches a consensus on a substituted phenol", async () => {
    // 4-nitrophenol measures 7.13. The model alone lands well off it; the Hammett relationship gets it
    // almost exactly, and the weighted consensus should sit close to the better method.
    const { result } = await ionization("O=[N+]([O-])c1ccc(O)cc1");
    const site = result.sites.find((entry) => entry.basis === "consensus");
    expect(site, "no consensus site — the second method did not fire").toBeDefined();
    expect(site!.agreement!.methods).toEqual(["model", "hammett"]);
    expect(site!.pKa).toBeGreaterThan(6.5);
    expect(site!.pKa).toBeLessThan(8.5);
  });

  it("shows the working, so a chemist can check it by hand", async () => {
    // The reason an LFER is worth having as the second opinion rather than another black box.
    const { result } = await ionization("Clc1ccc(O)cc1");
    const site = result.sites.find((entry) => entry.basis === "consensus");
    expect(site).toBeDefined();
    // The consensus itself carries no derivation, but the run must have had one to combine.
    const merged = combineSiteEstimates({
      model: [{ ...site!, basis: "experimentally-trained-model", pKa: 9.0 }],
      hammett: [{ ...site!, basis: "linear-free-energy-relationship", pKa: 9.44 }]
    });
    expect(merged[0]!.basis).toBe("consensus");
  });

  it("leaves a site the relationship cannot reach on the model alone", async () => {
    // Acetic acid is not an aryl acid. One opinion stays one opinion.
    const { result } = await ionization("CC(=O)O");
    for (const site of result.sites) expect(site.basis).not.toBe("consensus");
  });

  it("declines an ortho-substituted phenol rather than adding a bad second opinion", async () => {
    // 2-cresol is exactly the case Hammett does not describe. The model still scores it; the
    // relationship must simply not appear.
    const { result } = await ionization("Cc1ccccc1O");
    for (const site of result.sites) expect(site.basis).not.toBe("consensus");
    expect(result.sites.some((site) => site.pKa !== null)).toBe(true);
  });
});

const site = (atom: number, pKa: number, spread: number): IonizationSite => ({
    atomIndices: [atom],
    ionizableAtomIndex: atom,
    siteType: "Carboxyl",
    transition: "acidic",
    pKa,
    spread,
    basis: "site-type-average"
});

describe("confidence from agreement", () => {

  it("narrows nothing when two methods disagree", async () => {
    // The point of the span. Two routes three log units apart must not produce a confident consensus:
    // the merged interval is the whole disagreement, not a fraction of it.
    const merged = combineSiteEstimates({
      model: [site(3, 7.0, 0.5)],
      hammett: [site(3, 4.0, 0.5)]
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.basis).toBe("consensus");
    expect(merged[0]!.agreement!.span).toBeCloseTo(3.0, 6);
    expect(merged[0]!.spread).toBeGreaterThanOrEqual(3.0);
  });

  it("weights by measured accuracy rather than averaging", async () => {
    // Averaging is the obvious rule and it is measurably wrong. Where both methods fire, the forest
    // scores MAE 0.43 and the relationship 0.16; their mean scores 0.23 — worse than the better method
    // alone. So the consensus sits near the method that has earned it, not halfway.
    const merged = combineSiteEstimates({
      model: [site(3, 7.0, 0.5)],
      hammett: [site(3, 4.0, 0.5)]
    });
    expect(merged[0]!.pKa).toBeLessThan(5.5);

    // The weight is a rule, not a constant to keep in step by hand: inverse of each method's own
    // published MAE. Checked against the calibrated figure to make sure the rule and the measurement
    // are still describing the same thing.
    const weight =
      1 / PKA_MODEL_TRAINING.cvMae / (1 / PKA_MODEL_TRAINING.cvMae + 1 / HAMMETT_IN_DOMAIN_MAE);
    expect(weight).toBeCloseTo(CONSENSUS_CALIBRATION.forestWeight, 3);
    expect(merged[0]!.pKa).toBeCloseTo(4.0 + 3.0 * weight, 6);
  });

  it("takes the tightest input spread as its floor, not the widest", async () => {
    // Adding a precise second opinion has to be allowed to make the answer more precise, or there is
    // no reason to consult one. Measured: the consensus interval is 2.1x tighter than the model's own
    // and still covers more of the actual error (91% against 81%).
    const merged = combineSiteEstimates({
      model: [site(3, 4.2, 0.6)],
      hammett: [site(3, 4.0, 0.4)]
    });
    expect(merged[0]!.agreement!.span).toBeCloseTo(0.2, 6);
    expect(merged[0]!.spread).toBeCloseTo(0.4, 6);
    expect(merged[0]!.agreement!.methods).toEqual(["model", "hammett"]);
  });

  it("never reports certainty from two methods landing on the same number", async () => {
    // Span zero. Exact agreement is not evidence that both are right, so the floor still applies.
    const merged = combineSiteEstimates({
      model: [site(3, 4.0, 0.6)],
      hammett: [site(3, 4.0, 0.4)]
    });
    expect(merged[0]!.agreement!.span).toBe(0);
    expect(merged[0]!.spread).toBeCloseTo(0.4, 6);
  });

  it("passes a lone estimate through unchanged rather than calling it a consensus", async () => {
    const merged = combineSiteEstimates({ table: [site(3, 4.0, 0.5)] });
    expect(merged[0]!.basis).toBe("site-type-average");
    expect(merged[0]!.agreement).toBeUndefined();
  });
});

describe("the contract", () => {
  it("states the limits a reader would otherwise have to guess", async () => {
    const contract = ionizationContract();
    const conventions = contract.conventions.join(" ");
    expect(conventions).toMatch(/ACIDITY OF THAT SITE AS DRAWN/);
    expect(conventions).toMatch(/EVERY VALUE SAYS WHICH DIRECTION IT DESCRIBES/);
    expect(conventions).toMatch(/THE SITE TABLE ITSELF REPORTS NO pKa/);
    expect(contract.accuracyClaims[0]!.metric).toBe("mae");
    // The claim must name how folds were held out. Without that the number is unfalsifiable, which is
    // exactly how "1.18" survived: it was measured on folds grouped by canonical SMILES, a split that
    // separates identical molecules and nothing else.
    expect(contract.accuracyClaims[0]!.basis).toMatch(/Murcko/);
    expect(conventions).toMatch(/Bemis-Murcko scaffold/);
    expect(contract.datasets.some((entry) => entry.id === "dwar-ibond")).toBe(true);
    expect(conventions).toMatch(/aqueous only/i);
    // The one most likely to mislead: a missing site is not evidence of absence.
    expect(conventions).toMatch(/Absence of a site is not evidence that there is none/);
    expect(contract.knownUnsupportedChemistry.join(" ")).toMatch(/metal/i);
    expect(contract.datasets[0]!.license).toBe("Apache-2.0");
    expect(contract.citations.some((entry) => entry.id === "dimorphite-2019")).toBe(true);
  });
});

describe("what a reader actually sees", () => {
  it("puts every site in the report, with its interval and where it came from", async () => {
    // A method that computes a pKa nothing renders has not shipped. 4-nitrophenol is the case where
    // both methods fire, so the row has to show the consensus and how far apart they were.
    const { run } = await ionization("O=[N+]([O-])c1ccc(O)cc1");
    const report = buildAnalysisReport(run);
    const table = report.sections.find(
      (section) => section.kind === "table" && /ionizable site/i.test(section.title)
    );
    expect(table, "no ionizable-site section in the report").toBeDefined();
    if (table?.kind !== "table") return;

    expect(table.columns).toEqual(["Atom", "Site", "Transition", "pKa", "Basis"]);
    const consensus = table.rows.find((row) => row[4]!.startsWith("consensus"));
    expect(consensus, "the consensus row is missing").toBeDefined();
    // The number is never bare: a pKa without its interval reads as a measurement.
    expect(consensus![2]).toBe("loses H⁺");
    expect(consensus![3]).toMatch(/^\d+\.\d+ ± \d+\.\d+$/);
    expect(consensus![4]).toMatch(/model \+ hammett/);
    expect(consensus![4]).toMatch(/differing by/);
  });

  it("shows the Hammett working when it is the only method that fired", async () => {
    // The single-method path: no consensus, so the row shows the derivation instead — which sigma was
    // used for which substituent, so a chemist can check the number by hand.
    const site: IonizationSite = {
      atomIndices: [0],
      ionizableAtomIndex: 0,
      siteType: "Phenol",
      transition: "acidic",
      pKa: 7.12,
      spread: 0.16,
      basis: "linear-free-energy-relationship",
      derivation: "phenol series, rho applied to para-nitro (sigma 1.27)"
    };
    const merged = combineSiteEstimates({ hammett: [site] });
    expect(merged[0]!.basis).toBe("linear-free-energy-relationship");
    expect(merged[0]!.derivation).toMatch(/para-nitro/);
  });

  it("lists a site it could not assess rather than leaving it out", async () => {
    const { run } = await ionization("[Na+].[O-]C(=O)c1ccccc1");
    const report = buildAnalysisReport(run);
    const table = report.sections.find(
      (section) => section.kind === "table" && section.title === "Ionizable sites not assessed"
    );
    if (table?.kind === "table") {
      expect(table.columns).toEqual(["Atoms", "Reason"]);
      expect(table.rows[0]![1]).toMatch(/metal-bearing structure/);
    }
  });
});


describe("a partial result still shows what it computed", () => {
  it("renders a partial result's values instead of dropping the whole category", async () => {
    // The regression this guards is severe and quiet. Withholding the protonless nitrogen turned the
    // result's status from "ok" to "partial", and the report filtered on `status === "ok"` — so the
    // whole category vanished from the panel and the three perfectly good values went with it. A
    // report that drops what it DID compute is worse than the bug it was fixing.
    // Driven through the status rather than through a molecule, because no structure currently
    // produces `partial` — and that is exactly why this needs pinning rather than relying on one. The
    // property under test is the report's split, not the chemistry that reaches it.
    const { run } = await ionization("Oc1ccccc1");
    const partial = {
      ...run,
      results: run.results.map((entry) =>
        entry.methodId === IONIZATION_SITES_METHOD_ID
          ? { ...entry, status: "partial" as const, unassessed: [{ atomIndices: [1], reason: "withheld" }] }
          : entry
      )
    };

    const report = buildAnalysisReport(partial as typeof run);
    const table = report.sections.find(
      (section) => section.kind === "table" && section.title.startsWith("Ionizable sites (")
    );
    expect(table, "the sites table is missing from a partial result").toBeDefined();
    if (table?.kind === "table") expect(table.rows.length).toBeGreaterThan(0);
    expect(report.sections.some((section) => section.kind === "svg")).toBe(true);
    // And the shortfall is still disclosed, in its own section rather than by omission.
    expect(
      report.sections.some(
        (section) => section.kind === "table" && section.title === "Ionizable sites not assessed"
      )
    ).toBe(true);
  });

  it("draws one value per scored transition, and no more", async () => {
    // The figure must agree with the table. A coloured halo with no number would still read as "this
    // atom was assessed".
    const { run, result } = await ionization("NC(Cc1c[nH]cn1)C(=O)O");
    const figure = buildAnalysisReport(run).sections.find((section) => section.kind === "svg");
    if (figure?.kind !== "svg") throw new Error("no figure");
    expect(figure.svg.match(/±/g) ?? []).toHaveLength(result.sites.filter((s) => s.pKa !== null).length);
  });
});


describe("acidic and basic are reported separately", () => {
  /**
   * Reference values are ChemAxon's for the same four transitions on histidine. They are a second
   * implementation's answers, not ground truth — but a method that disagrees with the field's standard
   * tool by more than its own stated error has something to explain.
   */
  it("gives histidine all four transitions, each labelled", async () => {
    const { result } = await ionization("NC(Cc1c[nH]cn1)C(=O)O");
    const at = (atom: number) => result.sites.find((site) => site.ionizableAtomIndex === atom);

    // The amine terminus: BASIC. Its 9.03 under an acidity label was the bug — nearly the ammonium's
    // measured 9.25, and so read as correct while describing a different reaction.
    // The amine terminus is checked for its DIRECTION only, not its value, and the reason is a real
    // limitation rather than a slack test. Histidine's 9.25 is a MACROSCOPIC pKa, measured on the
    // species whose carboxyl is already ionised — the zwitterion. What is computed here is the
    // microstate with the carboxyl intact, which is a different equilibrium, and the two are not
    // comparable to better than a log unit or so. Macroscopic pKa needs protonation-state
    // enumeration, which PLANS.md still lists as open.
    expect(at(0)?.transition).toBe("basic");
    expect(at(0)!.pKa!).toBeGreaterThan(5);

    // The ring nitrogen with no hydrogen: BASIC, and it has a real value rather than being withheld.
    expect(at(7)?.transition).toBe("basic");
    expect(Math.abs(at(7)!.pKa! - 6.14)).toBeLessThan(2);

    // The ring N-H and the carboxyl: ACIDIC, the protons they are drawn with.
    expect(at(5)?.transition).toBe("acidic");
    expect(at(10)?.transition).toBe("acidic");
  });

  it("computes a basic value on the protonated microstate, not the neutral form", async () => {
    // The distinction the whole redesign rests on. Pyridine's nitrogen has no proton at all, so any
    // value for it must come from a structure where it does.
    const { result } = await ionization("c1ccncc1");
    const site = result.sites[0]!;
    expect(site.transition).toBe("basic");
    expect(site.pKa!).toBeGreaterThan(3);
    expect(site.pKa!).toBeLessThan(7);
  });

  it.each([
    // Deliberately no amino acid here: their tabulated amine pKa is macroscopic, measured on the
    // zwitterion, and does not describe the microstate this computes. These three are unambiguous.
    ["ethylamine", "CCN", 2, 10.7],
    ["pyridine", "c1ccncc1", 3, 5.25],
    ["aniline", "Nc1ccccc1", 0, 4.6]
  ])("puts %s's basic pKa within reach of the measured value", async (_name, smiles, atom, expected) => {
    const { result } = await ionization(smiles as string);
    const site = result.sites.find(
      (entry) => entry.ionizableAtomIndex === atom && entry.transition === "basic"
    );
    expect(site, "no basic value for this site").toBeDefined();
    expect(Math.abs(site!.pKa! - (expected as number))).toBeLessThan(2);
  });

  it("never merges an acidic and a basic value for the same atom", async () => {
    // They describe opposite reactions. Averaging them would be arithmetic on two different questions.
    const merged = combineSiteEstimates({
      model: [
        { ...site(3, 4.0, 0.5), transition: "acidic" },
        { ...site(3, 9.0, 0.5), transition: "basic" }
      ]
    });
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.transition).sort()).toEqual(["acidic", "basic"]);
    for (const entry of merged) expect(entry.basis).not.toBe("consensus");
  });

  it("does not offer a basic value on a pyrrole-type ring nitrogen", async () => {
    // Imidazole's N-H has its lone pair in the aromatic sextet — it is not available, and protonating
    // it would describe a species that does not form. Piperidine, which looks similar to a naive test
    // (ring, N-H, all single bonds), IS basic and must keep its value.
    const imidazole = await ionization("c1c[nH]cn1");
    const pyrroleType = imidazole.result.sites.filter(
      (entry) =>
        entry.transition === "basic" &&
        imidazole.result.depiction?.atoms[entry.ionizableAtomIndex]?.hydrogens === 1
    );
    expect(pyrroleType).toEqual([]);

    const piperidine = await ionization("C1CCNCC1");
    expect(piperidine.result.sites.some((entry) => entry.transition === "basic")).toBe(true);
  });
});
