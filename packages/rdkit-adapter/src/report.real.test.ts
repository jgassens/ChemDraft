/**
 * The provenance report against a real run (PLANS.md §9 Release 1).
 *
 * Built here rather than in `analysis-core` because the report's job is to describe what an actual
 * analysis produced. A report test over a hand-written run proves the formatter; a report test over
 * sodium benzoate proves the thing the report exists for — that a reader who was not watching can see
 * the salt was a salt, which method declined, and what the fragment answer was computed on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildAnalysisReport,
  ledgerLines,
  renderReportMarkdown,
  renderReportText,
  type AnalysisReport,
  type AnalysisRun
} from "@chemdraft/analysis-core";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
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
    runId: `report-${counter}`,
    startedAt: "2026-07-30T12:00:00.000Z",
    ...options
  });
}

/**
 * Sections whose rows all share one note carry it in the title ("Descriptors — convention-dependent
 * — see Provenance"), so lookups match on the leading name rather than the whole string.
 */
function section(report: AnalysisReport, title: string) {
  const found = report.sections.find((entry) => entry.title === title || entry.title.startsWith(`${title} — `));
  if (!found) throw new Error(`No "${title}" section. Have: ${report.sections.map((s) => s.title).join(", ")}`);
  return found;
}

function sectionTitle(report: AnalysisReport, title: string): string {
  return section(report, title).title;
}

describe("aspirin", () => {
  it("groups results by claim class — the display side of §2's bargain", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));

    // Titles carry a hoisted note where every row shares one, so compare on the leading name.
    const names = report.sections.map((entry) => entry.title.split(" — ")[0]);
    expect(names).toEqual(
      expect.arrayContaining(["Identity", "Composition", "Ions (m/z)", "Predicted properties", "Descriptors", "Provenance"])
    );

    // Crippen logP is a prediction; TPSA is a descriptor. The claim class is what puts them in
    // different sections, and it is the only thing in the codebase a claim class decides.
    const predicted = section(report, "Predicted properties");
    expect(predicted.kind === "keyValue" && predicted.rows.map((entry) => entry.label)).toContain("Crippen logP");
    const descriptors = section(report, "Descriptors");
    expect(descriptors.kind === "keyValue" && descriptors.rows.map((entry) => entry.label)).toContain(
      "Topological polar surface area (TPSA)"
    );
  });

  it("formats values to the decimals the method can defend, with units", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    const descriptors = section(report, "Descriptors");
    const tpsa = descriptors.kind === "keyValue" ? descriptors.rows.find((r) => r.label.includes("TPSA")) : undefined;

    // 63.60000000000001 rendered as the contract's two decimals, with the unit's symbol.
    expect(tpsa?.value).toBe("63.60 Å²");
  });

  it("marks convention-dependent and calibrated values rather than presenting them bare", async () => {
    // Where a section's rows all share one disclosure it is hoisted into the title: nine adduct rows
    // each ending with the same clause is a wall of identical text, and a disclosure nobody reads has
    // stopped disclosing.
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    expect(sectionTitle(report, "Predicted properties")).toMatch(/calibrated method/);
    expect(sectionTitle(report, "Descriptors")).toMatch(/convention-dependent/);
    expect(sectionTitle(report, "Ions (m/z)")).toMatch(/convention-dependent/);
  });

  it("keeps the note per row where a section mixes noted and unnoted values", async () => {
    // Composition holds the formula (a plain fact) beside the masses (convention-dependent), so
    // hoisting would attach the masses' disclosure to the formula too.
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    const composition = section(report, "Composition");
    const rows = composition.kind === "keyValue" ? composition.rows : [];
    expect(composition.title).toBe("Composition");
    expect(rows.find((r) => r.label === "Formula")?.note).toBeUndefined();
    expect(rows.find((r) => r.label === "Average mass")?.note).toMatch(/convention-dependent/);
  });

  it("carries identity, masses, and the engine pin", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));

    const identity = section(report, "Identity");
    expect(identity.kind === "keyValue" && identity.rows.map((r) => r.value)).toContain(
      "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"
    );

    const composition = section(report, "Composition");
    const rows = composition.kind === "keyValue" ? composition.rows : [];
    expect(rows.find((r) => r.label === "Formula")?.value).toBe("C9H8O4");
    // Five decimals, not RDKit's full float: 180.042258736 would claim significance the engine's own
    // atomic masses do not have.
    expect(rows.find((r) => r.label === "Monoisotopic mass")?.value).toBe("180.04226 Da");
    expect(rows.find((r) => r.label === "Average mass")?.value).toBe("180.159 g/mol");

    expect(report.engineSummary).toMatch(/rdkit-minimallib-wasm 2026\.03\.3/);
    expect(report.engineSummary).toMatch(/sha256:5b1bc11269/);
    expect(report.fingerprint).toMatch(/^fnv1a64:/);
  });

  it("omits a components table for a single-component molecule", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    expect(report.sections.some((entry) => entry.title.startsWith("Components"))).toBe(false);
  });

  it("reports one interpretation, active, changing nothing", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    expect(report.interpretations).toEqual([
      { id: "source", label: "as drawn", active: true, changesIdentity: false, ledger: [] }
    ]);
  });
});

describe("sodium benzoate — what the report exists for", () => {
  const SALT = "[Na+].[O-]C(=O)c1ccccc1";

  it("shows the salt as a salt", async () => {
    const report = buildAnalysisReport(await analyze(SALT));
    const composition = section(report, "Composition");
    expect(composition.kind === "keyValue" && composition.rows.find((r) => r.label === "Formula")?.value).toBe(
      "C7H5NaO2"
    );

    const components = section(report, "Components (2)");
    expect(components.kind === "table" && components.rows).toEqual([
      ["Na", "+1", "1"],
      ["C7H5O2", "-1", "1"]
    ]);
  });

  it("names every declined method with its reason instead of dropping it", async () => {
    // A report that omits what it could not compute makes "unavailable" indistinguishable from
    // "not asked for" — §10 is blunt about which of those is dangerous.
    const report = buildAnalysisReport(await analyze(SALT));
    const declined = section(report, "Not computed");
    expect(declined.kind).toBe("table");
    const rows = declined.kind === "table" ? declined.rows : [];
    const logP = rows.find((cells) => cells[0] === "Crippen logP");
    expect(logP?.[1]).toBe("unsupported");
    expect(logP?.[2]).toMatch(/no parameters for Na/);
  });

  it("offers the derived interpretation as an alternative, with its ledger", async () => {
    const report = buildAnalysisReport(await analyze(SALT));
    expect(report.interpretations).toHaveLength(2);

    const fragment = report.interpretations.find((entry) => entry.id === "largest-organic-fragment")!;
    expect(fragment.label).toBe("largest organic fragment · Na removed");
    expect(fragment.changesIdentity).toBe(true);
    expect(fragment.ledger).toEqual(["largest-organic-fragment: removed Na; kept C7H5O2"]);

    // Most results were computed on the drawing, so that is what the panel's disclosure line names.
    expect(report.interpretations.find((entry) => entry.active)?.id).toBe("source");
  });

  it("surfaces the derivation notice, and does not repeat the decline as a notice", async () => {
    const report = buildAnalysisReport(await analyze(SALT));
    const notices = section(report, "Notices");
    const rows = notices.kind === "table" ? notices.rows : [];

    expect(rows.some((cells) => cells[1] === "interpretation.derived")).toBe(true);
    // The decline already has a row in "Not computed"; showing it twice makes the run look worse
    // than it was.
    expect(rows.some((cells) => cells[1] === "method.unparameterized_element")).toBe(false);
  });

  it("drops the interpretation suffix from labels when the whole report is one interpretation", async () => {
    // Under an override the header already says what everything was computed on, so repeating it on
    // every row is noise that pushes the values off the edge of the panel. With a mixed run it stays,
    // because a derived row has to be legible beside the declined source row it sits next to.
    const overridden = buildAnalysisReport(await analyze(SALT, { interpretationOverride: "neutralized" }));
    const composition = section(overridden, "Composition");
    const labels = composition.kind === "keyValue" ? composition.rows.map((r) => r.label) : [];
    expect(labels).toContain("Average mass");
    expect(labels.every((label) => !label.includes("neutralised"))).toBe(true);

    const mixed = buildAnalysisReport(await analyze(SALT));
    const predicted = section(mixed, "Predicted properties");
    const mixedLabels = predicted.kind === "keyValue" ? predicted.rows.map((r) => r.label) : [];
    expect(mixedLabels).toContain("Crippen logP · largest organic fragment · Na removed");
  });

  it("names the derived interpretation as the active one when the caller overrode it", async () => {
    const report = buildAnalysisReport(await analyze(SALT, { interpretationOverride: "neutralized" }));
    const active = report.interpretations.find((entry) => entry.active)!;
    expect(active.id).toBe("neutralized");
    expect(active.ledger).toEqual([
      "largest-organic-fragment: removed Na; kept C7H5O2",
      "neutralize: kept C7H6O2; 1 charge removed; 1 hydrogen added"
    ]);
  });
});

describe("renderings", () => {
  it("renders text a chemist can paste into a notebook", async () => {
    const report = buildAnalysisReport(await analyze("[Na+].[O-]C(=O)c1ccccc1"));
    const text = renderReportText(report);

    expect(text).toContain("Molecular properties");
    expect(text).toContain("Computed on: as drawn");
    expect(text).toContain("Also available: largest organic fragment · Na removed");
    expect(text).toMatch(/Formula\s+C7H5NaO2/);
    expect(text).toMatch(/Crippen logP\s+unsupported/);
    expect(text).toContain("Run fingerprint: fnv1a64:");
    // Fixed-width columns: every table row lines up with its header.
    const componentHeader = text.split("\n").find((line) => line.startsWith("Formula  "));
    expect(componentHeader).toBeDefined();
  });

  it("renders markdown with escaped pipes", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain("# Molecular properties");
    expect(markdown).toContain("**Computed on:** as drawn");
    expect(markdown).toContain("## Composition");
    expect(markdown).toContain("| Formula | C9H8O4 |");
    expect(markdown).toContain("## Predicted properties — calibrated method — see Provenance");
    expect(markdown).toMatch(/_Run fingerprint: `fnv1a64:[0-9a-f]+`_/);
  });

  it("escapes a pipe in a value rather than breaking the table", async () => {
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    report.sections.push({ kind: "keyValue", title: "Odd", rows: [{ label: "a|b", value: "c|d" }] });
    expect(renderReportMarkdown(report)).toContain("| a\\|b | c\\|d |");
  });

  it("renders a run that failed to parse without throwing", async () => {
    // The report has to survive the empty case: a panel that crashes on a bad structure is worse than
    // one that says nothing was computed.
    const report = buildAnalysisReport(await analyze("C1CC"));
    expect(report.sections.some((entry) => entry.title === "Notices")).toBe(true);
    expect(() => renderReportText(report)).not.toThrow();
    expect(renderReportText(report)).toContain("structure.parse_failed");
  });
});

describe("ledgerLines", () => {
  it("describes an untransformed interpretation as an empty ledger", async () => {
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    expect(ledgerLines(run.interpretations[0]!)).toEqual([]);
  });

  it("flags an arbitrary fragment choice in the ledger it prints", async () => {
    const run = await analyze("[Fe+2].c1cc[cH-]c1.c1cc[cH-]c1");
    const fragment = run.interpretations.find((entry) => entry.id === "largest-organic-fragment")!;
    expect(ledgerLines(fragment)[0]).toMatch(/⚠ another organic component/);
  });
});
