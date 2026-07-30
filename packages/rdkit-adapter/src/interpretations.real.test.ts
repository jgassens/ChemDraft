/**
 * Derived interpretations against the real engine (PLANS.md §1, Phase 3).
 *
 * The sodium-benzoate case is the whole architecture in one structure, and it is a first-class test
 * here rather than an example in a comment: composition and mass describe the salt the user drew,
 * Crippen logP declines on it, and the same method answers on the largest organic fragment with the
 * transformation named — **both results in the run**, neither substituted for the other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnalysisRunSchema,
  interpretationChangesIdentity,
  sourceAtomsFor,
  type AnalysisResult,
  type AnalysisRun
} from "@chemdraft/analysis-core";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import type { DerivedInterpretationId } from "./interpretations";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

let counter = 0;
function analyze(
  value: string,
  options: {
    methodIds?: readonly string[];
    fallbackInterpretations?: readonly DerivedInterpretationId[];
    interpretationOverride?: DerivedInterpretationId;
  } = {}
): Promise<AnalysisRun> {
  counter += 1;
  return analyzeStructure({
    format: "smiles",
    value,
    runId: `interp-${counter}`,
    startedAt: "2026-07-30T12:00:00.000Z",
    ...options
  });
}

function find(run: AnalysisRun, id: string): AnalysisResult {
  const result = run.results.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Run carried no result "${id}". Have: ${run.results.map((r) => r.id).join(", ")}`);
  return result;
}

function scalar(run: AnalysisRun, id: string): number | null {
  const result = find(run, id);
  if (result.kind !== "scalar") throw new Error(`"${id}" is a ${result.kind}.`);
  return result.value;
}

const DESCRIPTOR_SUBSET = ["rdkit.composition", "rdkit.crippen-logp", "rdkit.tpsa", "rdkit.average-mass"];

describe("sodium benzoate — the case the interpretation ledger exists for", () => {
  it("keeps the salt's composition and mass while offering logP on the organic fragment", async () => {
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1", { methodIds: DESCRIPTOR_SUBSET });

    // Source-preserving: the composition and mass describe what was drawn, on `source`.
    const composition = find(run, "rdkit.composition");
    expect(composition.interpretationId).toBe("source");
    expect(composition.kind === "composition" && composition.formula).toBe("C7H5NaO2");
    expect(scalar(run, "rdkit.average-mass")).toBe(144.105);

    // Declined as drawn — and the decline survives, rather than being replaced.
    const declined = find(run, "rdkit.crippen-logp");
    expect(declined.status).toBe("unsupported");
    expect(declined.interpretationId).toBe("source");
    expect(declined.applicability.unsupportedFeatures).toEqual(["Na"]);

    // Answered on the fragment, with the transformation named.
    const derived = find(run, "rdkit.crippen-logp@largest-organic-fragment");
    expect(derived.status).toBe("ok");
    expect(derived.kind === "scalar" && derived.value).toBe(0.05009999999999992);
    expect(derived.label).toBe("Crippen logP · largest organic fragment · Na removed");
    const notice = derived.warnings.find((warning) => warning.code === "interpretation.derived");
    expect(notice?.severity).toBe("info");
    expect(notice?.message).toMatch(/Na removed/);
    expect(notice?.affectedResultIds).toEqual(["rdkit.crippen-logp@largest-organic-fragment"]);

    // And the number is the anion's, not a fallback contribution's.
    const anion = await analyze("[O-]C(=O)c1ccccc1", { methodIds: ["rdkit.crippen-logp"] });
    expect(scalar(anion, "rdkit.crippen-logp")).toBe(derived.kind === "scalar" ? derived.value : null);
  });

  it("records the ledger the derived number was computed through", async () => {
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1", { methodIds: DESCRIPTOR_SUBSET });
    const fragment = run.interpretations.find((entry) => entry.id === "largest-organic-fragment");

    expect(fragment).toBeDefined();
    expect(fragment!.label).toBe("largest organic fragment · Na removed");
    expect(fragment!.componentPolicy).toBe("largest-organic-fragment");
    expect(fragment!.transformations).toHaveLength(1);
    expect(fragment!.transformations[0]).toMatchObject({
      name: "largest-organic-fragment",
      componentsRemoved: ["Na"],
      componentsRetained: ["C7H5O2"]
    });
    expect(interpretationChangesIdentity(fragment!)).toBe(true);
  });

  it("maps a fragment atom index back to the atom the user drew", async () => {
    // The mapping is load-bearing, not bookkeeping: a highlight computed on the fragment has to land
    // on the drawn atom, and the counterion shifted every index by one.
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1", { methodIds: DESCRIPTOR_SUBSET });
    const fragment = run.interpretations.find((entry) => entry.id === "largest-organic-fragment")!;

    expect(sourceAtomsFor(fragment, [0])).toEqual([1]);
    expect(sourceAtomsFor(fragment, [0, 1, 8])).toEqual([1, 2, 9]);
    // Sodium is atom 0 of the drawing and has no counterpart in the fragment.
    expect(sourceAtomsFor(fragment, [8, 9])).toEqual([9]);
  });

  it("computes strictly against the drawing when fallbacks are switched off", async () => {
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1", {
      methodIds: DESCRIPTOR_SUBSET,
      fallbackInterpretations: []
    });
    expect(run.interpretations).toHaveLength(1);
    expect(run.results.every((result) => result.interpretationId === "source")).toBe(true);
    expect(find(run, "rdkit.crippen-logp").status).toBe("unsupported");
  });

  it("chains fragment then neutralisation when the caller asks for it", async () => {
    // §7's "a neutralized largest organic fragment", reachable in one step from a salt.
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1", {
      methodIds: DESCRIPTOR_SUBSET,
      interpretationOverride: "neutralized"
    });

    const neutral = run.interpretations.find((entry) => entry.id === "neutralized")!;
    expect(neutral.label).toBe("largest organic fragment · Na removed · neutralised · 1 charge removed");
    expect(neutral.transformations.map((step) => step.name)).toEqual([
      "largest-organic-fragment",
      "neutralize"
    ]);
    expect(neutral.transformations[1]).toMatchObject({ chargeChanges: 1, hydrogenChanges: 1 });

    const composition = find(run, "rdkit.composition@neutralized");
    expect(composition.kind === "composition" && composition.formula).toBe("C7H6O2");
    expect(scalar(run, "rdkit.crippen-logp@neutralized")).toBe(1.3848);
  });
});

describe("neutralisation", () => {
  it("neutralises a zwitterion's two charges and reports both", async () => {
    const run = await analyze("[NH3+]CC(=O)[O-]", {
      methodIds: DESCRIPTOR_SUBSET,
      interpretationOverride: "neutralized"
    });

    const neutral = run.interpretations.find((entry) => entry.id === "neutralized")!;
    expect(neutral.label).toBe("neutralised · 2 charges removed");
    // Net hydrogen change is zero — one added to the carboxylate, one taken from the ammonium — which
    // is exactly why the ledger counts charged atoms rather than netting charges.
    expect(neutral.transformations[0]).toMatchObject({ chargeChanges: 2, hydrogenChanges: 0 });

    const composition = find(run, "rdkit.composition@neutralized");
    expect(composition.kind === "composition" && composition.formula).toBe("C2H5NO2");
    // The number moves a long way: the zwitterion reads −3.02, glycine −0.97.
    expect(scalar(run, "rdkit.crippen-logp@neutralized")).toBe(-0.9702999999999999);
    const asDrawn = await analyze("[NH3+]CC(=O)[O-]", { methodIds: ["rdkit.crippen-logp"] });
    expect(scalar(asDrawn, "rdkit.crippen-logp")).toBe(-3.0218);
  });

  it("removes a hydrogen when neutralising a cation", async () => {
    const run = await analyze("Cn1cc[nH+]c1", {
      methodIds: DESCRIPTOR_SUBSET,
      interpretationOverride: "neutralized"
    });
    const neutral = run.interpretations.find((entry) => entry.id === "neutralized")!;
    expect(neutral.transformations[0]).toMatchObject({ chargeChanges: 1, hydrogenChanges: -1 });
    const composition = find(run, "rdkit.composition@neutralized");
    expect(composition.kind === "composition" && composition.formula).toBe("C4H6N2");
  });

  it("declines to neutralise a quaternary ammonium, which has no neutral form", async () => {
    // RDKit returns null for the charge-stripped molblock rather than inventing a five-valent nitrogen.
    // The run says the interpretation is unavailable and computes against the drawing instead.
    const run = await analyze("C[N+](C)(C)C", {
      methodIds: DESCRIPTOR_SUBSET,
      interpretationOverride: "neutralized"
    });

    expect(run.interpretations.map((entry) => entry.id)).toEqual(["source"]);
    expect(run.warnings.map((warning) => warning.code)).toContain("interpretation.override_unavailable");
    expect(find(run, "rdkit.composition").interpretationId).toBe("source");
  });

  it("declines to neutralise a nitro group, whose charge separation is the molecule", async () => {
    const run = await analyze("O=[N+]([O-])c1ccccc1", {
      methodIds: DESCRIPTOR_SUBSET,
      interpretationOverride: "neutralized"
    });
    expect(run.interpretations.map((entry) => entry.id)).toEqual(["source"]);
    expect(run.warnings.map((warning) => warning.code)).toContain("interpretation.override_unavailable");
  });

  it("preserves isotope labels and stereochemistry through the round trip", async () => {
    // Neutralisation goes through a molblock, so `M  ISO` and the wedge/parity records have to survive
    // it — otherwise the derived interpretation would quietly be a different molecule.
    const run = await analyze("[13CH3]C(=O)[O-]", {
      methodIds: ["rdkit.composition", "rdkit.monoisotopic-mass"],
      interpretationOverride: "neutralized"
    });
    const composition = find(run, "rdkit.composition@neutralized");
    expect(composition.kind === "composition" && composition.formula).toBe("[13C]CH4O2");
    expect(composition.kind === "composition" && composition.hasExplicitIsotopes).toBe(true);

    const chiral = await analyze("C[C@H](O)C(=O)[O-]", {
      methodIds: ["rdkit.canonical-smiles"],
      interpretationOverride: "neutralized"
    });
    const smiles = find(chiral, "rdkit.canonical-smiles@neutralized");
    expect(smiles.kind === "identifier" && smiles.value).toBe("C[C@H](O)C(=O)O");
  });
});

describe("when no interpretation helps", () => {
  it("leaves cisplatin declined — there is no organic fragment to fall back to", async () => {
    const run = await analyze("N.N.Cl[Pt]Cl", { methodIds: DESCRIPTOR_SUBSET });
    expect(run.interpretations.map((entry) => entry.id)).toEqual(["source"]);
    expect(find(run, "rdkit.crippen-logp").status).toBe("unsupported");
    expect(run.results.some((result) => result.id.includes("@"))).toBe(false);
  });

  it("leaves phenylboronic acid declined — a single component has no fragment to select", async () => {
    const run = await analyze("OB(O)c1ccccc1", { methodIds: DESCRIPTOR_SUBSET });
    expect(find(run, "rdkit.crippen-logp").status).toBe("unsupported");
    expect(run.interpretations).toHaveLength(1);
  });

  it("says so when an override cannot be derived, instead of silently ignoring it", async () => {
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O", {
      methodIds: DESCRIPTOR_SUBSET,
      interpretationOverride: "largest-organic-fragment"
    });
    expect(run.warnings.map((warning) => warning.code)).toContain("interpretation.override_unavailable");
    expect(find(run, "rdkit.composition").interpretationId).toBe("source");
  });
});

describe("ferrocene — when the fragment choice is arbitrary", () => {
  it("records that an equally large organic component was discarded", async () => {
    const run = await analyze("[Fe+2].c1cc[cH-]c1.c1cc[cH-]c1", { methodIds: DESCRIPTOR_SUBSET });
    const fragment = run.interpretations.find((entry) => entry.id === "largest-organic-fragment")!;

    expect(fragment.transformations[0]!.componentsRemoved).toEqual(["Fe", "C5H5"]);
    expect(fragment.transformations[0]!.unrepresentableFeatures[0]).toMatch(/arbitrary/);
    // A number is still offered — but nobody reading the ledger can mistake it for ferrocene's logP.
    expect(find(run, "rdkit.crippen-logp@largest-organic-fragment").status).toBe("ok");
  });
});

describe("run integrity with several interpretations", () => {
  it("validates against the run schema, which rejects an unlisted interpretation", async () => {
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1");
    const parsed = AnalysisRunSchema.safeParse(run);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });

  it("carries every interpretation its results reference, and no more", async () => {
    const run = await analyze("[Na+].[O-]C(=O)c1ccccc1");
    const referenced = new Set(run.results.map((result) => result.interpretationId));
    const carried = new Set(run.interpretations.map((entry) => entry.id));
    for (const id of referenced) expect(carried.has(id)).toBe(true);
    expect(carried.has("source")).toBe(true);
  });

  it("fingerprints a fallback-enabled run differently from a source-only one", async () => {
    // The interpretation is part of what was computed, so it belongs in the fingerprint — otherwise a
    // cached source-only run would serve a request that asked for fallbacks.
    const withFallbacks = await analyze("[Na+].[O-]C(=O)c1ccccc1", { methodIds: DESCRIPTOR_SUBSET });
    const sourceOnly = await analyze("[Na+].[O-]C(=O)c1ccccc1", {
      methodIds: DESCRIPTOR_SUBSET,
      fallbackInterpretations: []
    });
    expect(withFallbacks.fingerprint).not.toBe(sourceOnly.fingerprint);

    const repeat = await analyze("[Na+].[O-]C(=O)c1ccccc1", { methodIds: DESCRIPTOR_SUBSET });
    expect(withFallbacks.fingerprint).toBe(repeat.fingerprint);
  });

  it("leaves an ordinary neutral molecule with one interpretation and no derived results", async () => {
    // The common case must not pay for the machinery: aspirin gets exactly what Phase 2 gave it.
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    expect(run.interpretations).toHaveLength(1);
    expect(run.results.every((result) => result.interpretationId === "source")).toBe(true);
    expect(run.status).toBe("ok");
  });
});
