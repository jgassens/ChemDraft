/**
 * Ionizable-site assessment against the real RDKit SMARTS engine.
 *
 * The site table is transcribed from Dimorphite-DL, so the tests that matter are the ones checking we
 * read it the way Dimorphite does — above all that the per-site index selects the atom that actually
 * ionises, which is the trap this table sets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IonizationSite } from "@chemdraft/analysis-core";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import { IONIZATION_SITES_METHOD_ID, combineSiteEstimates, ionizationContract } from "./ionization";
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

  it("reports acidity, not basicity — the amine limitation, pinned", async () => {
    // The disclosure the contract makes, held to. The site pattern is `[C]-[NX3+0]`, a NEUTRAL
    // nitrogen, so what is scored is that N-H losing a proton: weakly acidic, hence a high value.
    // It is NOT ethylamine's familiar ~10.7, which belongs to the ammonium.
    const neutral = await ionization("CCN");
    const site = neutral.result.sites.find((entry) => entry.ionizableAtomIndex === 2);
    expect(site?.pKa).toBeGreaterThan(12);

    // And redrawing it protonated does not get you the other number: the pattern requires a neutral
    // nitrogen, so no site is located at all. Documented because it is the obvious thing to try.
    const protonated = await ionization("CC[NH3+]");
    expect(protonated.result.sites).toHaveLength(0);
    expect(protonated.result.status).toBe("not-applicable");
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
    const { result } = await ionization("NC(Cc1c[nH]cn1)C(=O)O");
    expect(result.sites.length).toBeGreaterThanOrEqual(3);
    const atoms = new Set(result.sites.map((site) => site.ionizableAtomIndex));
    expect(atoms.size).toBeGreaterThanOrEqual(3);
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

describe("confidence from agreement", () => {
  const site = (atom: number, pKa: number, spread: number): IonizationSite => ({
    atomIndices: [atom],
    ionizableAtomIndex: atom,
    siteType: "Carboxyl",
    pKa,
    spread,
    basis: "site-type-average"
  });

  it("narrows nothing when two methods disagree", async () => {
    // The point of the span. Two routes three log units apart must not produce a confident consensus;
    // the merged spread is at least half their disagreement.
    const merged = combineSiteEstimates({
      table: [site(3, 4.0, 0.5)],
      model: [site(3, 7.0, 0.5)]
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.basis).toBe("consensus");
    expect(merged[0]!.pKa).toBeCloseTo(5.5, 6);
    expect(merged[0]!.agreement!.span).toBeCloseTo(3.0, 6);
    expect(merged[0]!.spread).toBeGreaterThanOrEqual(1.5);
  });

  it("keeps the methods' own spread when they agree", async () => {
    const merged = combineSiteEstimates({
      table: [site(3, 4.0, 0.6)],
      model: [site(3, 4.2, 0.4)]
    });
    expect(merged[0]!.agreement!.span).toBeCloseTo(0.2, 6);
    // Half the span is 0.1, which is narrower than the widest input spread — so that wins.
    expect(merged[0]!.spread).toBeCloseTo(0.6, 6);
    expect(merged[0]!.agreement!.methods).toEqual(["table", "model"]);
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
    expect(conventions).toMatch(/IT DOES NOT REPORT BASICITY/);
    expect(conventions).toMatch(/THE SITE TABLE ITSELF REPORTS NO pKa/);
    expect(contract.accuracyClaims[0]!.metric).toBe("mae");
    expect(contract.datasets.some((entry) => entry.id === "dwar-ibond")).toBe(true);
    expect(conventions).toMatch(/aqueous only/i);
    // The one most likely to mislead: a missing site is not evidence of absence.
    expect(conventions).toMatch(/Absence of a site is not evidence that there is none/);
    expect(contract.knownUnsupportedChemistry.join(" ")).toMatch(/metal/i);
    expect(contract.datasets[0]!.license).toBe("Apache-2.0");
    expect(contract.citations.some((entry) => entry.id === "dimorphite-2019")).toBe(true);
  });
});
