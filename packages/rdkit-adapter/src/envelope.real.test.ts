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

  it("gives chloroform the ~96% M+2 the demo plugin used to estimate", async () => {
    // Inherited from `examples/plugins/mass-fragment-demo`, whose first-order approximation this
    // replaces. Three chlorines put M+2 just under the base peak — the chemistry the plugin used to
    // showcase, now computed against a real abundance table instead of an eight-element one.
    const distribution = envelope(await analyze("ClC(Cl)Cl", ENVELOPE_ONLY));
    const peaks = [...distribution.positions].map((position, index) => ({
      position,
      intensity: distribution.intensities[index]!
    }));
    const base = peaks.reduce((best, peak) => (peak.intensity > best.intensity ? peak : best));
    const mPlus2 = peaks.find((peak) => Math.abs(peak.position - (base.position + 1.997)) < 0.01);

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

describe("an ion gets an envelope, on the m/z axis", () => {
  const monoisotopic = (run: AnalysisRun): number => {
    const found = run.results.find((result) => result.methodId === "rdkit.monoisotopic-mass");
    if (!found || found.kind !== "scalar" || found.value == null) throw new Error("no monoisotopic mass");
    return found.value;
  };

  it("computes an anion, and agrees with RDKit's own electron bookkeeping", async () => {
    // The cross-engine check that makes the charge correction trustworthy. RDKit's exactmw already
    // accounts for charge — it is why `[H+]` is the proton and not hydrogen — so its monoisotopic mass
    // for the acetate anion is an independent answer to the question IsoSpec's table just answered.
    //
    // Compared at 1e-7 rather than tighter because that is what the two tables actually deliver: they
    // round AME differently in the last digits, so agreement runs to ~1e-8 across these structures.
    // That is table rounding, not a disagreement about chemistry, and pretending to 1e-9 would make
    // the suite fail on a molecule with more atoms rather than on a real defect.
    const run = await analyze("CC(=O)[O-]");
    const distribution = envelope(run);

    expect(distribution.status).toBe("ok");
    expect(distribution.positionUnit).toBe("thomson");
    const base = distribution.positions[distribution.intensities.indexOf(100)]!;
    expect(base).toBeCloseTo(monoisotopic(run), 7);
    expect(base).toBeCloseTo(59.013853, 6);
  });

  it("puts [NH4+] where the mass module measured it", async () => {
    // The exact structure `mass.ts` used to establish that RDKit's `[H+]` is the proton: 18.03382554809,
    // one electron below NH₃ + H. The envelope has to land on the same number by a different route —
    // IsoSpec's neutral-atom sum, less one electron from IsoSpec's own table.
    const run = await analyze("[NH4+]");
    const distribution = envelope(run);
    const base = distribution.positions[distribution.intensities.indexOf(100)]!;

    expect(distribution.positionUnit).toBe("thomson");
    expect(base).toBeCloseTo(18.03382554809, 7);
    expect(base).toBeCloseTo(monoisotopic(run), 7);
  });

  it("halves the peak spacing at 2+, which is how a reader gets charge state off a pattern", async () => {
    // The case that makes dividing by |z| more than cosmetic. Reporting the ion's mass instead would
    // draw 1.0 spacing for a doubly charged species and quietly misstate its charge — the pattern
    // would be self-consistent and wrong.
    const run = await analyze("C[N+](C)(C)CCCC[N+](C)(C)C");
    const distribution = envelope(run);
    const positions = [...distribution.positions];
    const base = positions[distribution.intensities.indexOf(100)]!;

    expect(distribution.positionUnit).toBe("thomson");
    expect(base).toBeCloseTo(monoisotopic(run) / 2, 7);
    expect(base).toBeCloseTo(87.104251, 6);
    // ¹³C sits half a unit above the base peak, not a whole one.
    expect(positions[1]! - positions[0]!).toBeCloseTo(0.4985, 3);
  });

  it("leaves a neutral structure on the mass axis, unchanged", async () => {
    // The charge work must not move a neutral molecule's numbers. Same value the pre-charge build
    // produced, and still daltons.
    const distribution = envelope(await analyze("Brc1ccccc1", ENVELOPE_ONLY));
    expect(distribution.positionUnit).toBe("dalton");
    expect(distribution.positions[distribution.intensities.indexOf(100)]).toBeCloseTo(155.95746326, 8);
  });

  it("computes a salt whose charges cancel as the neutral it is", async () => {
    // Sodium benzoate's net formal charge is zero, so there is no electron correction to make and no
    // |z| to divide by — the whole formula is a neutral species. A per-atom charge count rather than a
    // net one would have divided this by two.
    const distribution = envelope(await analyze("[Na+].[O-]C(=O)c1ccccc1", ENVELOPE_ONLY));
    expect(distribution.status).toBe("ok");
    expect(distribution.positionUnit).toBe("dalton");
  });
});

describe("a labelled structure keeps its label", () => {
  const intensityAt = (
    distribution: Extract<AnalysisResult, { kind: "distribution" }>,
    mass: number
  ): number => {
    const index = [...distribution.positions].findIndex((position) => Math.abs(position - mass) < 0.002);
    return index < 0 ? 0 : distribution.intensities[index]!;
  };

  it("computes 1-¹³C acetic acid at the labelled mass", async () => {
    // The formula parser cannot spell `[13C]` at all, so this goes through IsoSpec's explicit-isotope
    // constructor. RDKit, which tracks the label in its own mass, is the check.
    const run = await analyze("[13CH3]C(=O)O");
    const distribution = envelope(run);
    const monoisotopic = run.results.find((result) => result.methodId === "rdkit.monoisotopic-mass");

    expect(distribution.status).toBe("ok");
    expect(distribution.positions[distribution.intensities.indexOf(100)]).toBeCloseTo(
      (monoisotopic as Extract<AnalysisResult, { kind: "scalar" }>).value!,
      7
    );
    expect(distribution.positions[distribution.intensities.indexOf(100)]).toBeCloseTo(61.024484, 6);
  });

  it("halves the ¹³C satellite, because only one carbon is still free to be one", async () => {
    // The whole reason a label cannot be dropped, and the reason it cannot be applied to the element
    // as a whole either. Acetic acid has two carbons, each carrying a ~1.09% ¹³C satellite, so M+1 is
    // ~2.18%. Label one of them and that carbon is ¹³C with certainty — it contributes no satellite —
    // while the other still does. Reporting the unlabelled envelope would say 2.18%; treating the whole
    // element as labelled would say 0.
    const labelled = envelope(await analyze("[13CH3]C(=O)O", ENVELOPE_ONLY));
    const plain = envelope(await analyze("CC(=O)O", ENVELOPE_ONLY));

    expect(intensityAt(plain, 61.024484)).toBeCloseTo(2.181, 2);
    expect(intensityAt(labelled, 62.027839)).toBeCloseTo(1.091, 2);
    expect(intensityAt(labelled, 62.027839)).toBeCloseTo(intensityAt(plain, 61.024484) / 2, 2);
  });

  it("leaves no carbon satellite when every carbon is labelled", async () => {
    // Both carbons fixed, so the only isotopologues left come from hydrogen. Two peaks, not four.
    const distribution = envelope(await analyze("[13CH3][13CH3]", ENVELOPE_ONLY));
    expect(distribution.positions[distribution.intensities.indexOf(100)]).toBeCloseTo(32.05366, 5);
    expect(distribution.positions).toHaveLength(2);
  });

  it("handles a deuterium label the same way", async () => {
    // Not carbon-specific: d₃-acetic acid, where the labelled atoms are the ones RDKit tallies apart
    // from the acid proton it left implicit.
    const distribution = envelope(await analyze("[2H]C([2H])([2H])C(=O)O", ENVELOPE_ONLY));
    expect(distribution.status).toBe("ok");
    expect(distribution.positions[distribution.intensities.indexOf(100)]).toBeCloseTo(63.03996, 5);
  });

  it("composes with the charge correction", async () => {
    // Labelled *and* drawn as an ion: the explicit-isotope path produces the distribution and the
    // electron bookkeeping still applies to it. Neither follow-up special-cases the other.
    const run = await analyze("[13CH3]C(=O)[O-]");
    const distribution = envelope(run);
    const monoisotopic = run.results.find((result) => result.methodId === "rdkit.monoisotopic-mass");

    expect(distribution.status).toBe("ok");
    expect(distribution.positionUnit).toBe("thomson");
    expect(distribution.positions[distribution.intensities.indexOf(100)]).toBeCloseTo(
      (monoisotopic as Extract<AnalysisResult, { kind: "scalar" }>).value!,
      7
    );
  });
});

describe("declining beats a confident wrong number", () => {
  it("declines an isotope the tables do not carry, rather than dropping the label", async () => {
    // RDKit will happily report a mass for ⁹⁹C — it just adds mass numbers. IsoSpec has no such
    // isotope, and the two safe answers are "decline" and "compute the unlabelled molecule". The
    // second is a different molecule, so it declines and names what it could not find.
    const distribution = envelope(await analyze("[99CH3]C(=O)O", ENVELOPE_ONLY));
    expect(distribution.status).toBe("not-applicable");
    expect(distribution.positions).toHaveLength(0);
    expect(distribution.applicability.reasons[0]).toMatch(/no 99C/);
    expect(distribution.applicability.unsupportedFeatures).toContain("unknown isotope 99C");
    expect(distribution.warnings.length).toBeGreaterThan(0);
  });

  it("still names IsoSpec on a decline — the module loaded even though no envelope came back", async () => {
    // The decline happens while reading IsoSpec's tables, so the module did load and naming it is
    // honest. What must not happen is the reverse: naming IsoSpec when it could not be loaded at all.
    const run = await analyze("[99CH3]C(=O)O", ENVELOPE_ONLY);
    expect(run.engines.some((engine) => engine.name === "isospec-wasm")).toBe(true);
  });
});

describe("the report shows it", () => {
  it("renders the peaks as a plottable spectrum with the truncation in the title", async () => {
    // A spectrum section rather than a table: an isotope pattern is a shape, and a column of numbers
    // does not show it. The section carries the values so each surface renders what suits it — the
    // panel draws sticks, the clipboard still gets the table (see the text/Markdown tests below).
    const report = buildAnalysisReport(await analyze("Brc1ccccc1"));
    const section = report.sections.find((entry) => entry.title.startsWith("Isotope envelope"));
    expect(section).toBeDefined();
    expect(section!.kind).toBe("spectrum");
    expect(section!.title).toMatch(/\d+ peaks/);
    expect(section!.title).toMatch(/% of the distribution/);
    if (section!.kind !== "spectrum") return;

    expect(section!.positions).toHaveLength(section!.intensities.length);
    expect(Math.max(...section!.intensities)).toBe(100);
    expect(section!.positionUnit).toBe("dalton");
    expect(section!.intensityUnit).toBe("relative-abundance");
    // A stick plot is indistinguishable from a measured spectrum, so the disclosure ships with it.
    expect(section!.caption).toMatch(/not a predicted mass spectrum/i);
  });

  it("reaches the pasted text with its masses", async () => {
    const text = renderReportText(buildAnalysisReport(await analyze("Brc1ccccc1")));
    expect(text).toContain("Isotope envelope");
    expect(text).toMatch(/155\.95746\s+100\.00/);
  });

  it("labels an ion's axis m/z rather than Mass", async () => {
    // The axis has to follow the unit. "Mass (Da)" over m/z values is a mislabelled plot in exactly the
    // case where the distinction carries the charge state.
    const report = buildAnalysisReport(await analyze("CC(=O)[O-]"));
    const section = report.sections.find((entry) => entry.title.startsWith("Isotope envelope"));
    expect(section?.kind).toBe("spectrum");
    if (section?.kind !== "spectrum") return;
    expect(section.positionUnit).toBe("thomson");
    expect(section.positionLabel).toBe("m/z");
  });

  it("does not stutter the unit in the pasted header", async () => {
    // m/z is both the label and the symbol, so the usual "Label (Symbol)" would render "m/z (m/z)".
    const text = renderReportText(buildAnalysisReport(await analyze("CC(=O)[O-]")));
    expect(text).toContain("m/z");
    expect(text).not.toContain("m/z (m/z)");
    expect(text).toMatch(/59\.01385\s+100\.00/);
  });

  it("says so when a declined envelope produced nothing", async () => {
    const report = buildAnalysisReport(await analyze("[99CH3]C(=O)O"));
    expect(report.sections.some((entry) => entry.title.startsWith("Isotope envelope"))).toBe(false);
    // A declined envelope is a mass-spec fact, so it lands in that category's own declines table
    // rather than the general one.
    const declined = report.sections.find((entry) => entry.title === "Not computed (mass spec)");
    expect(declined?.kind === "table" && declined.rows.some((cells) => cells[0] === "Isotope envelope")).toBe(true);
  });
});
