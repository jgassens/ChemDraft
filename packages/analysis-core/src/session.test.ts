import { describe, expect, it } from "vitest";

import {
  AnalysisResultSchema,
  AnalysisRunSchema,
  AnalysisSchemaVersion,
  type AnalysisResult,
  type AnalysisRun
} from "./results";
import { hashInterpretation, type MolecularInterpretation } from "./interpretation";
import { AnalysisSessionCache, analysisRequestKey, emptyAnalysisRun } from "./session";

const policy = {
  id: "source",
  sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
  componentPolicy: "whole-input" as const,
  explicitHydrogenPolicy: "as-drawn",
  isotopePolicy: "preserve-labels",
  aromaticityModel: "rdkit-default",
  transformations: []
};

const interpretation: MolecularInterpretation = {
  ...policy,
  label: "as drawn",
  interpretationHash: hashInterpretation(policy)
};

function run(runId: string): AnalysisRun {
  return {
    schemaVersion: AnalysisSchemaVersion,
    runId,
    sourceHash: interpretation.sourceHash,
    interpretations: [interpretation],
    engines: [],
    startedAt: "2026-07-30T12:00:00.000Z",
    status: "ok",
    results: [],
    warnings: [],
    fingerprint: `fnv1a64:${runId.padStart(16, "0")}`
  };
}

describe("analysisRequestKey", () => {
  const base = { format: "smiles", value: "CC(=O)Oc1ccccc1C(=O)O" };

  it("is stable for the same question asked twice", () => {
    expect(analysisRequestKey(base)).toBe(analysisRequestKey({ ...base }));
  });

  it("ignores method order — the same set is the same question", () => {
    expect(analysisRequestKey({ ...base, methodIds: ["a", "b"] })).toBe(
      analysisRequestKey({ ...base, methodIds: ["b", "a"] })
    );
  });

  it("respects fallback order, which decides which interpretation answers first", () => {
    expect(analysisRequestKey({ ...base, fallbackInterpretations: ["x", "y"] })).not.toBe(
      analysisRequestKey({ ...base, fallbackInterpretations: ["y", "x"] })
    );
  });

  it('distinguishes "no fallbacks" from "the default fallbacks"', () => {
    // The bug this prevents: a run computed strictly against the drawing serving a request that asked
    // for derived interpretations, or the reverse.
    expect(analysisRequestKey({ ...base, fallbackInterpretations: [] })).not.toBe(analysisRequestKey(base));
  });

  it("separates an override from the same methods without one", () => {
    expect(analysisRequestKey({ ...base, interpretationOverride: "neutralized" })).not.toBe(
      analysisRequestKey(base)
    );
  });

  it("changes when the engine artifacts change", () => {
    expect(analysisRequestKey(base, ["sha256:aaa"])).not.toBe(analysisRequestKey(base, ["sha256:bbb"]));
    expect(analysisRequestKey(base, ["a", "b"])).toBe(analysisRequestKey(base, ["b", "a"]));
  });

  it("separates the same text in two formats", () => {
    expect(analysisRequestKey({ format: "smiles", value: "CCO" })).not.toBe(
      analysisRequestKey({ format: "molfile-v2000", value: "CCO" })
    );
  });
});

describe("AnalysisSessionCache", () => {
  it("returns what it stored and counts hits and misses", () => {
    const cache = new AnalysisSessionCache();
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", run("1"));
    expect(cache.get("a")?.runId).toBe("1");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("evicts least-recently-used, not least-recently-inserted", () => {
    // The interactive pattern is edit → analyse → undo → analyse. Undo has to hit, which means recency
    // rather than insertion order decides what survives.
    const cache = new AnalysisSessionCache({ maxEntries: 2 });
    cache.set("a", run("1"));
    cache.set("b", run("2"));
    cache.get("a"); // "a" is now the most recent
    cache.set("c", run("3"));

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.stats().evictions).toBe(1);
  });

  it("overwrites in place without growing", () => {
    const cache = new AnalysisSessionCache({ maxEntries: 2 });
    cache.set("a", run("1"));
    cache.set("a", run("2"));
    expect(cache.stats().size).toBe(1);
    expect(cache.get("a")?.runId).toBe("2");
  });

  it("refuses a nonsensical bound rather than silently disabling itself", () => {
    expect(() => new AnalysisSessionCache({ maxEntries: 0 })).toThrowError(/positive integer/);
    expect(() => new AnalysisSessionCache({ maxEntries: 1.5 })).toThrowError(/positive integer/);
  });

  it("clears", () => {
    const cache = new AnalysisSessionCache();
    cache.set("a", run("1"));
    cache.clear();
    expect(cache.has("a")).toBe(false);
  });
});

describe("emptyAnalysisRun", () => {
  it("produces a schema-valid run for a scheduling outcome", () => {
    const cancelled = emptyAnalysisRun({
      runId: "scheduled-1",
      startedAt: "2026-07-30T12:00:00.000Z",
      interpretation,
      status: "cancelled",
      warnings: [
        { code: "analysis.superseded", severity: "info", message: "superseded", affectedResultIds: [] }
      ]
    });

    expect(AnalysisRunSchema.safeParse(cancelled).success).toBe(true);
    expect(cancelled.results).toEqual([]);
    expect(cancelled.status).toBe("cancelled");
  });

  it('refuses to produce an "ok" run with no results', () => {
    // An empty successful run reads as "analysis complete, nothing to report", which is never true.
    expect(() =>
      emptyAnalysisRun({
        runId: "r",
        startedAt: "2026-07-30T12:00:00.000Z",
        interpretation,
        status: "ok",
        warnings: [{ code: "x", severity: "info", message: "y", affectedResultIds: [] }]
      })
    ).toThrowError(/did not succeed/);
  });

  it("requires a warning explaining the status", () => {
    expect(() =>
      emptyAnalysisRun({
        runId: "r",
        startedAt: "2026-07-30T12:00:00.000Z",
        interpretation,
        status: "failed",
        warnings: []
      })
    ).toThrowError(/requires a warning/);
  });
});

describe("payload transport across the worker boundary", () => {
  /**
   * §3's transport decision, checked rather than asserted: bulk numeric channels are typed arrays
   * because they survive structured clone — which is what `postMessage` performs — while a JSON hop
   * turns them into plain objects that no renderer can read as arrays.
   */
  const spectrum: AnalysisResult = {
    id: "envelope",
    kind: "distribution",
    label: "Isotope envelope",
    methodId: "isospec.envelope",
    methodVersion: "1.0.0",
    interpretationId: "source",
    status: "ok",
    classification: {
      derivation: "convention",
      claim: "descriptor",
      determinism: "deterministic",
      flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
    },
    applicability: { status: "in-domain", reasons: [], unsupportedFeatures: [] },
    uncertainties: [],
    conventions: ["truncated at a relative-intensity threshold of 0.001"],
    citations: [],
    datasets: [],
    warnings: [],
    rawArtifacts: [],
    positions: new Float64Array([180.042258736, 181.045613]),
    intensities: new Float64Array([100, 9.92]),
    positionUnit: "dalton",
    intensityUnit: "relative-abundance",
    truncation: { policy: "relative-intensity-threshold", threshold: 0.05 }
  };

  it("survives structured clone with its typed arrays intact", () => {
    const cloned = structuredClone(spectrum) as typeof spectrum;
    expect(cloned.kind === "distribution" && cloned.positions).toBeInstanceOf(Float64Array);
    expect(cloned.kind === "distribution" && Array.from(cloned.positions)).toEqual([180.042258736, 181.045613]);
    expect(AnalysisResultSchema.safeParse(cloned).success).toBe(true);
  });

  it("does not survive a JSON hop, which is why the decision was made before spectra existed", () => {
    const viaJson = JSON.parse(JSON.stringify(spectrum)) as Record<string, unknown>;
    expect(viaJson.positions).not.toBeInstanceOf(Float64Array);
    // The schema catches it rather than letting an object-shaped "array" reach a renderer.
    expect(AnalysisResultSchema.safeParse(viaJson).success).toBe(false);
  });
});
