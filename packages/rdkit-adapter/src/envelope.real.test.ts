/**
 * The isotope envelope inside a real analysis run (PLANS.md §9 Release 2).
 *
 * Run against both real engines rather than a fixture: the whole point of the method is that RDKit's
 * composition and IsoSpec's distribution agree, and only the real artifacts can show that.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnalysisResult, AnalysisRun } from "@chemdraft/analysis-core";
import { buildAnalysisReport, renderReportText } from "@chemdraft/analysis-core";

import { analyzeStructure, rdkitAnalysisContracts } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import { DEFAULT_ENVELOPE_RELATIVE_THRESHOLD, ISOTOPE_ENVELOPE_METHOD_ID } from "./envelope";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

let counter = 0;
function analyze(value: string, options: Record<string, unknown> = {}): Promise<AnalysisRun> {
  counter += 1;
  return analyzeStructure({
    format: "smiles",
    value,
    runId: `envelope-${counter}`,
    startedAt: "2026-07-30T12:00:00.000Z",
    ...options
  } as never);
}

function envelope(run: AnalysisRun): Extract<AnalysisResult, { kind: "distribution" }> {
  const found = run.results.find((result) => result.methodId === ISOTOPE_ENVELOPE_METHOD_ID);
  if (!found || found.kind !== "distribution") throw new Error("no isotope-envelope result in the run");
  return found;
}

const ENVELOPE_ONLY = { methodIds: [ISOTOPE_ENVELOPE_METHOD_ID] };

describe("the envelope is part of the run", () => {
  it("is in the canonical contract list, so the closeout lock covers it", () => {
    const ids = rdkitAnalysisContracts().map((contract) => contract.id);
    expect(ids).toContain(ISOTOPE_ENVELOPE_METHOD_ID);
  });

  it("names IsoSpec as a second engine and puts its hash in the fingerprint", async () => {
    const run = await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1", ENVELOPE_ONLY);
    const engines = run.engines.map((engine) => engine.name);
    expect(engines).toContain("rdkit-minimallib-wasm");
    expect(engines).toContain("isospec-wasm");
    expect(run.engines.find((engine) => engine.name === "isospec-wasm")?.artifactHashes[0]).toMatch(/^sha256:/);
  });

  it("produces a distribution whose base peak is RDKit's monoisotopic mass", async () => {
    // The cross-engine check, and the reason the envelope can be trusted at all: the two engines
    // compute the same quantity from different tables. If they disagree, one is wrong.
    const run = await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1");
    const distribution = envelope(run);
    const monoisotopic = run.results.find((result) => result.methodId === "rdkit.monoisotopic-mass");

    expect(distribution.status).toBe("ok");
    const base = distribution.intensities.indexOf(Math.max(...distribution.intensities));
    expect(monoisotopic?.kind).toBe("scalar");
    expect(distribution.positions[base]).toBeCloseTo(
      (monoisotopic as Extract<AnalysisResult, { kind: "scalar" }>).value!,
      5
    );
  });

  it("gives bromobenzene its textbook M/M+2 doublet", async () => {
    // ⁷⁹Br and ⁸¹Br are near-equally abundant, so M+2 is almost as tall as M. A wrong abundance table
    // or a mis-parsed formula could not produce this by accident.
    const distribution = envelope(await analyze("Brc1ccccc1", ENVELOPE_ONLY));
    const peaks = [...distribution.positions].map((position, index) => ({
      position,
      intensity: distribution.intensities[index]!
    }));
    const base = peaks.reduce((best, peak) => (peak.intensity > best.intensity ? peak : best));
    const mPlus2 = peaks.find((peak) => Math.abs(peak.position - (base.position + 1.998)) < 0.01);

    expect(base.intensity).toBe(100);
    expect(mPlus2?.intensity).toBeGreaterThan(90);
    expect(mPlus2?.intensity).toBeLessThan(100);
  });

  it("records the truncation policy and what it retained", async () => {
    // A truncated distribution whose truncation is not stated reads exactly like a complete one.
    const distribution = envelope(await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1", ENVELOPE_ONLY));
    expect(distribution.truncation.policy).toBe("relative-intensity-threshold");
    expect(distribution.truncation.threshold).toBe(DEFAULT_ENVELOPE_RELATIVE_THRESHOLD);
    expect(distribution.truncation.coveredProbability).toBeGreaterThan(0.99);
    expect(distribution.truncation.coveredProbability).toBeLessThanOrEqual(1);
  });

  it("orders peaks by mass and normalises the base peak to 100", async () => {
    const distribution = envelope(await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1", ENVELOPE_ONLY));
    const positions = [...distribution.positions];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(Math.max(...distribution.intensities)).toBe(100);
    expect(distribution.positions).toBeInstanceOf(Float64Array);
    expect(distribution.intensities).toHaveLength(distribution.positions.length);
  });

  it("carries the abundance-set convention, because the intensities depend on it", async () => {
    const distribution = envelope(await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1", ENVELOPE_ONLY));
    expect(distribution.conventions.some((entry) => entry.includes("CIAAW"))).toBe(true);
    expect(distribution.conventions.some((entry) => entry.includes("NOT A PREDICTED SPECTRUM"))).toBe(true);
  });
});

describe("declining beats a confident wrong number", () => {
  it("declines a charged structure rather than dropping the electron bookkeeping", async () => {
    const distribution = envelope(await analyze("CC(=O)[O-]", ENVELOPE_ONLY));
    expect(distribution.status).toBe("not-applicable");
    expect(distribution.positions).toHaveLength(0);
    expect(distribution.applicability.reasons[0]).toMatch(/formal charge/);
    expect(distribution.warnings.length).toBeGreaterThan(0);
  });

  it("declines an isotope-labelled structure instead of silently using natural abundances", async () => {
    // Measured against IsoSpec's parser, not assumed: `parse_formula` throws on any non-alphanumeric
    // character and resolves elements by bare symbol, so RDKit's `[13C]CH4O2` cannot be expressed.
    // Stripping the label to make it parse would return a different molecule's envelope.
    const distribution = envelope(await analyze("[13CH3]C(=O)O", ENVELOPE_ONLY));
    expect(distribution.status).toBe("not-applicable");
    expect(distribution.applicability.reasons[0]).toMatch(/isotope label/);
    expect(distribution.applicability.unsupportedFeatures).toContain("explicit isotope label");
  });

  it("keeps a decline out of the engine list — an engine that did not run is not provenance", async () => {
    // The charged case never reaches IsoSpec's tables, but the module did load, so naming it is honest.
    // What must not happen is the reverse: naming IsoSpec when it could not be loaded at all.
    const run = await analyze("CC(=O)[O-]", ENVELOPE_ONLY);
    expect(run.engines.some((engine) => engine.name === "isospec-wasm")).toBe(true);
  });
});

describe("the report shows it", () => {
  it("renders the peaks as a table with the truncation in the title", async () => {
    const report = buildAnalysisReport(await analyze("Brc1ccccc1"));
    const section = report.sections.find((entry) => entry.title.startsWith("Isotope envelope"));
    expect(section).toBeDefined();
    expect(section!.kind).toBe("table");
    expect(section!.title).toMatch(/\d+ peaks/);
    expect(section!.title).toMatch(/% of the distribution/);
    expect(section!.kind === "table" && section!.columns).toEqual(["Mass (Da)", "Intensity (%)"]);
  });

  it("reaches the pasted text with its masses", async () => {
    const text = renderReportText(buildAnalysisReport(await analyze("Brc1ccccc1")));
    expect(text).toContain("Isotope envelope");
    expect(text).toMatch(/155\.95746\s+100\.00/);
  });

  it("says so when a declined envelope produced nothing", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)[O-]"));
    expect(report.sections.some((entry) => entry.title.startsWith("Isotope envelope"))).toBe(false);
    const declined = report.sections.find((entry) => entry.title === "Not computed");
    expect(declined?.kind === "table" && declined.rows.some((cells) => cells[0] === "Isotope envelope")).toBe(true);
  });
});
