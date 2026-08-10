/**
 * Release 1 closeout locks (PLANS.md §9 "Definition of done", §10).
 *
 * The other suites test behaviours. This one tests *completeness* — the properties that are easy to
 * satisfy today and easy to erode later, and that no single feature test would notice breaking:
 *
 *   - every shipped contract actually produces a result, and every result has a contract;
 *   - every corpus structure runs, validates, and declines where it must;
 *   - nothing on screen can claim to be a measurement;
 *   - the run's own invariants hold across the whole adversarial corpus, not just the happy path.
 *
 * It is deliberately slow-ish: it runs the full method set over every corpus entry, including the
 * 320-atom alkane. That is the point — a closeout check that only exercised aspirin would close out
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnalysisRunSchema,
  MethodRegistry,
  isMeasuredValue,
  propertyCorpus,
  requiresProvenanceOnExport,
  type AnalysisRun,
  type MethodContract
} from "@chemdraft/analysis-core";

import { analyzeStructure, rdkitAnalysisContracts } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

// The canonical set — descriptors, identifiers, composition, and the Release 2 adduct series.
const CONTRACTS: MethodContract[] = rdkitAnalysisContracts();

let counter = 0;
function analyze(value: string): Promise<AnalysisRun> {
  counter += 1;
  return analyzeStructure({
    format: "smiles",
    value,
    runId: `closeout-${counter}`,
    startedAt: "2026-07-30T12:00:00.000Z"
  });
}

/** One run per corpus entry, computed once and shared — the corpus is exercised in full, not sampled. */
let runs: { entry: (typeof propertyCorpus)[number]; run: AnalysisRun }[] = [];

beforeAll(async () => {
  runs = [];
  for (const entry of propertyCorpus) {
    runs.push({ entry, run: await analyze(entry.smiles) });
  }
}, 60_000);

describe("every shipped capability has a contract, and every contract ships", () => {
  it("produces a result for every registered contract somewhere in the corpus", () => {
    // A contract nobody can reach is documentation of a capability that does not exist.
    const produced = new Set(runs.flatMap(({ run }) => run.results.map((result) => result.methodId)));
    const unreachable = CONTRACTS.map((contract) => contract.id).filter((id) => !produced.has(id));
    expect(unreachable, `contracts that never produced a result: ${unreachable.join(", ")}`).toEqual([]);
  });

  it("backs every result with a registered contract", () => {
    // The reverse failure: a number on screen whose provenance cannot be looked up.
    const registered = new Set(CONTRACTS.map((contract) => contract.id));
    for (const { entry, run } of runs) {
      for (const result of run.results) {
        expect(registered.has(result.methodId), `${entry.id}: unregistered method "${result.methodId}"`).toBe(true);
      }
    }
  });

  it("registers the whole set without a schema violation", () => {
    const registry = new MethodRegistry();
    for (const contract of CONTRACTS) expect(() => registry.register(contract)).not.toThrow();
    expect(registry.list()).toHaveLength(CONTRACTS.length);
  });

  it("gives every contract the fields the definition of done names", () => {
    for (const contract of CONTRACTS) {
      expect(contract.implementation.engineVersion, `${contract.id} engine version`).toBeTruthy();
      expect(contract.defaultInterpretationId, `${contract.id} interpretation policy`).toBeTruthy();
      expect(contract.conventions.length, `${contract.id} conventions`).toBeGreaterThan(0);
      expect(contract.declinesWhen.length, `${contract.id} declining conditions`).toBeGreaterThan(0);
      expect(contract.versionIncrementTriggers.length, `${contract.id} version triggers`).toBeGreaterThan(0);
      if (contract.resultKind === "scalar" || contract.resultKind === "distribution") {
        expect(contract.unit, `${contract.id} unit`).toBeTruthy();
      }
    }
  });
});

describe("the corpus runs, end to end", () => {
  it("parses and analyses every entry", () => {
    for (const { entry, run } of runs) {
      expect(run.status, `${entry.id} (${entry.name}) failed`).not.toBe("failed");
      expect(run.results.length, `${entry.id} produced no results`).toBeGreaterThan(0);
    }
  });

  it("produces a schema-valid run for every entry", () => {
    for (const { entry, run } of runs) {
      const parsed = AnalysisRunSchema.safeParse(run);
      expect(
        parsed.success,
        parsed.success ? "" : `${entry.id}: ${JSON.stringify(parsed.error.issues.slice(0, 2))}`
      ).toBe(true);
    }
  });

  it("declines everything the corpus says must decline", () => {
    for (const { entry, run } of runs) {
      for (const methodId of entry.mustDecline ?? []) {
        const result = run.results.find((candidate) => candidate.id === methodId);
        expect(result, `${entry.id}: no result for ${methodId}`).toBeDefined();
        expect(["unsupported", "not-applicable"], `${entry.id} / ${methodId}`).toContain(result!.status);
      }
    }
  });

  it("matches every pinned formula, charge, and component count", () => {
    for (const { entry, run } of runs) {
      const composition = run.results.find((result) => result.kind === "composition");
      expect(composition, `${entry.id} has no composition`).toBeDefined();
      if (composition?.kind !== "composition") continue;

      if (entry.expectedSourceFormula) {
        expect(composition.formula, `${entry.id} formula`).toBe(entry.expectedSourceFormula);
      }
      if (entry.expectedSourceCharge !== undefined) {
        expect(composition.formalCharge, `${entry.id} charge`).toBe(entry.expectedSourceCharge);
      }
      expect(
        composition.components.reduce((total, component) => total + component.multiplicity, 0),
        `${entry.id} components`
      ).toBe(entry.expectedComponentCount);
    }
  });

  it("survives the 320-atom alkane without truncating or blowing up", () => {
    const oversize = runs.find(({ entry }) => entry.id === "oversize-alkane")!;
    const composition = oversize.run.results.find((result) => result.kind === "composition");
    expect(composition?.kind === "composition" && composition.formula).toBe("C320H642");
    expect(oversize.run.status).toBe("ok");
  });

  it("reports an unspecified stereocentre rather than quietly assuming one", () => {
    const partial = runs.find(({ entry }) => entry.id === "threonine-partial-stereo")!;
    const unspecified = partial.run.results.find(
      (result) => result.id === "rdkit.unspecified-atom-stereocentre-count"
    );
    expect(unspecified?.kind === "scalar" && unspecified.value).toBe(1);
  });

  it("distinguishes the tautomer pair, which is why tautomerPolicy is enforced", () => {
    // Same formula, same heavy-atom count, different numbers. A method that cannot tell these apart
    // has no business running without a declared tautomer policy.
    const keto = runs.find(({ entry }) => entry.id === "acetylacetone-keto")!.run;
    const enol = runs.find(({ entry }) => entry.id === "acetylacetone-enol")!.run;
    const value = (run: AnalysisRun, id: string) => {
      const result = run.results.find((candidate) => candidate.id === id);
      return result?.kind === "scalar" ? result.value : undefined;
    };

    expect(value(keto, "rdkit.heavy-atom-count")).toBe(value(enol, "rdkit.heavy-atom-count"));
    expect(value(keto, "rdkit.crippen-logp")).not.toBe(value(enol, "rdkit.crippen-logp"));
    expect(value(keto, "rdkit.hbd")).not.toBe(value(enol, "rdkit.hbd"));
  });
});

describe("result invariants across the whole corpus", () => {
  it("gives every ok scalar a finite value and a unit, and every non-ok result a warning", () => {
    for (const { entry, run } of runs) {
      for (const result of run.results) {
        if (result.status === "ok") {
          if (result.kind === "scalar") {
            expect(Number.isFinite(result.value), `${entry.id}/${result.id} value`).toBe(true);
            expect(result.unit, `${entry.id}/${result.id} unit`).toBeTruthy();
          }
        } else {
          expect(result.warnings.length, `${entry.id}/${result.id} warning`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("points every result at an interpretation the run carries", () => {
    for (const { entry, run } of runs) {
      const carried = new Set(run.interpretations.map((interpretation) => interpretation.id));
      for (const result of run.results) {
        expect(carried.has(result.interpretationId), `${entry.id}/${result.id}`).toBe(true);
      }
    }
  });

  it("never claims a computed value is a measurement", () => {
    for (const { entry, run } of runs) {
      for (const result of run.results) {
        expect(isMeasuredValue(result.classification), `${entry.id}/${result.id}`).toBe(false);
      }
    }
  });

  it("requires provenance on export for every number that depends on a convention or a fit", () => {
    // Which is all of them here, and that is the honest finding rather than an oversight: ring counts
    // go through SSSR, masses through the standard atomic weights, identifiers through InChI's
    // normalisation layers.
    for (const { entry, run } of runs) {
      for (const result of run.results) {
        expect(requiresProvenanceOnExport(result.classification), `${entry.id}/${result.id}`).toBe(true);
      }
    }
  });

  it("keeps every declined result's payload empty", () => {
    for (const { entry, run } of runs) {
      for (const result of run.results) {
        if (result.status === "ok" || result.status === "partial") continue;
        if (result.kind === "scalar" || result.kind === "identifier") {
          expect(result.value, `${entry.id}/${result.id} must not carry a value`).toBeNull();
        }
      }
    }
  });
});
