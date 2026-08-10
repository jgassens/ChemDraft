/**
 * A permanent charge on a non-ionizable atom is part of the species, and the report must say so.
 *
 * `chargeAtLevel` sees ladder atoms only, so a quaternary ammonium — the charge that makes a betaine a
 * betaine — is invisible to it. Both `zwitterionic` and `speciesDistribution` used to test against that
 * partial view, which misjudged the textbook case the zwitterion comment names as its motivation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeStructure } from "./analysis";
import { IONIZATION_SITES_METHOD_ID } from "./ionization";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => { installRealRdkitModuleLoader(); });

async function macro(smiles: string) {
  const run = await analyzeStructure({
    format: "smiles", value: smiles, runId: `pc-${smiles}`,
    startedAt: "2026-08-09T00:00:00.000Z"
  } as never);
  const r = run.results.find((e) => e.methodId === IONIZATION_SITES_METHOD_ID);
  if (r?.kind !== "ionization") throw new Error(`no ionization result for ${smiles}`);
  return (r as unknown as { macroscopic?: {
    zwitterionic?: boolean;
    distribution?: { dominantCharge?: number; fractionNetNeutral?: number; fractionUncharged?: number };
  } }).macroscopic;
}

describe("a permanent charge counts toward the species", () => {
  it("calls betaine a zwitterion, and nets its quaternary nitrogen against its carboxylate", async () => {
    const m = await macro("C[N+](C)(C)CC(=O)[O-]");
    expect(m?.zwitterionic, "betaine is the textbook zwitterion").toBe(true);
    // Reported -1 before the fix: the N+ was not on a ladder, so it was dropped from the net.
    expect(m?.distribution?.dominantCharge).toBe(0);
    // Reported 0.00001 before the fix, because the true net-neutral state was filed under -1.
    expect(m?.distribution?.fractionNetNeutral ?? 0).toBeGreaterThan(0.9);
    // Never uncharged at any pH: the N+ does not titrate away.
    expect(m?.distribution?.fractionUncharged ?? 1).toBeLessThan(0.01);
  });

  it("still separates glycine's net-neutral zwitterion from its uncharged form", async () => {
    // The control that proves the fix is about PERMANENT charge, not a blanket change: glycine has
    // none, and its five-orders-of-magnitude split is the module's own worked example.
    const m = await macro("NCC(=O)O");
    expect(m?.zwitterionic).toBe(true);
    expect(m?.distribution?.dominantCharge).toBe(0);
    expect(m?.distribution?.fractionNetNeutral ?? 0).toBeGreaterThan(0.9);
    expect(m?.distribution?.fractionUncharged ?? 1).toBeLessThan(0.001);
  });
});
