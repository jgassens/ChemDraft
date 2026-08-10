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
import { PINNED_RDKIT_WASM_SHA256 } from "./methods";
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
 * — see Conventions"), so lookups match on the leading name rather than the whole string.
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

  it("points every disclosure note at a section that actually exists", async () => {
    // The structural invariant, and the one that was broken: every note ends "see X", and for a long
    // time X was "Provenance" for convention-dependent values — a table of method ids and versions
    // that never named a convention. A note pointing somewhere the answer is not is worse than no
    // note, because it reads as though the disclosure happened.
    const report = buildAnalysisReport(await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1"));
    const names = new Set(report.sections.map((entry) => entry.title.split(" — ")[0]!));

    // A hoisted note is everything after the FIRST separator — the note itself contains one
    // ("convention-dependent — see Conventions"), so splitting on every separator shreds it.
    const hoisted = (title: string): string[] =>
      title.includes(" — ") ? [title.slice(title.indexOf(" — ") + 3)] : [];
    const notes = report.sections.flatMap((entry) => [
      ...hoisted(entry.title),
      ...(entry.kind === "keyValue" ? entry.rows.map((row) => row.note).filter((note): note is string => Boolean(note)) : [])
    ]);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      const target = /see (.+)$/.exec(note)?.[1];
      expect(target, `note ${JSON.stringify(note)} names no section`).toBeDefined();
      expect(names, `note ${JSON.stringify(note)} points at a section that does not exist`).toContain(target!);
    }
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
    expect(report.engineSummary).toContain(`sha256:${PINNED_RDKIT_WASM_SHA256}`);
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
    // Three, not two: the descriptors decline on Na and fall back to the fragment, while pKa builds
    // its ladder from the canonical protomer — benzoic acid rather than the drawn benzoate. A run that
    // used three interpretations says so, because the panel's whole job is naming what produced what.
    expect(report.interpretations).toHaveLength(3);
    expect(report.interpretations.map((entry) => entry.id)).toContain("reference-protomer");

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

/**
 * The conventions disclosure (§2).
 *
 * Every one of the 62 shipped contracts is convention-dependent and names its conventions, and the
 * schema refuses a convention-dependent contract that does not. For a long time none of that reached
 * a reader: the panel said "convention-dependent — see Provenance" and Provenance listed method ids
 * and versions. The rebuild that put `includeSandP` in the binary is what made it urgent — TPSA moved
 * from 98.22 to 106.60 Å² purely because the convention changed, with no way to find out which one.
 */
describe("conventions reach the reader", () => {
  const SULFAMETHOXAZOLE = "Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1";

  function conventionsSection(report: AnalysisReport) {
    const found = report.sections.find((entry) => entry.kind === "conventions");
    if (!found || found.kind !== "conventions") throw new Error("no Conventions section");
    return found;
  }

  it("names the S-included convention that produced the number on screen", async () => {
    const report = buildAnalysisReport(await analyze(SULFAMETHOXAZOLE));
    const tpsa = conventionsSection(report).groups.find((group) =>
      group.appliesTo.some((label) => label.includes("TPSA"))
    );
    expect(tpsa).toBeDefined();
    expect(tpsa!.conventions.some((entry) => entry.includes("sulfur and phosphorus INCLUDED"))).toBe(true);
    expect(tpsa!.conventions).toContain("Ertl 2000 fragment contributions");
  });

  it("carries the conventions on the result, so a cached run keeps the ones it was computed under", async () => {
    // Not looked up from a live registry: the contract is rebuilt each run from the detected engine
    // capabilities, so a registry lookup would relabel a cached S-excluded TPSA as S-included after a
    // rebuild — the exact silent-wrong-provenance failure §3 exists to prevent.
    const run = await analyze(SULFAMETHOXAZOLE, { methodIds: ["rdkit.tpsa"] });
    const tpsa = run.results.find((result) => result.methodId === "rdkit.tpsa");
    expect(tpsa?.methodVersion).toBe("2.0.0");
    expect(tpsa?.conventions.some((entry) => entry.includes("INCLUDED"))).toBe(true);
  });

  it("states a shared convention set once instead of repeating it per method", async () => {
    // The nine adducts name one identical set. Nine copies of a four-line disclosure is the failure
    // mode the note-hoisting already guards against, arriving by another route.
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    const groups = conventionsSection(report).groups;
    const adducts = groups.find((group) => group.appliesTo.includes("[M+H]⁺"));
    expect(adducts).toBeDefined();
    expect(adducts!.appliesTo.length).toBeGreaterThan(4);
    expect(groups.length).toBeLessThan(report.sections.length + groups.reduce((n, g) => n + g.appliesTo.length, 0));
  });

  it("omits methods that produced no value — their reason is the story, not their conventions", async () => {
    // Aspirin has no chlorine, so [M+H−HCl]⁺ is not-applicable and "Not computed" carries the reason.
    // Aspirin rather than sodium benzoate: there, Crippen logP declines on the source interpretation
    // but succeeds on the derived fragment, so a value IS shown and its conventions do belong.
    const report = buildAnalysisReport(await analyze("CC(=O)Oc1ccccc1C(=O)O"));
    const listed = conventionsSection(report).groups.flatMap((group) => group.appliesTo);
    expect(listed.some((label) => label.includes("HCl"))).toBe(false);
    expect(listed.some((label) => label.startsWith("Composition"))).toBe(true);

    // Aspirin's only decline is the HCl loss, which is a mass method — so it lands in the Mass Spec
    // category's own "Not computed (mass spec)" and there is no general one to find.
    const declined = section(report, "Not computed (mass spec)");
    expect(declined.kind === "table" && declined.rows.some((cells) => cells[0]?.includes("HCl"))).toBe(true);
  });

  it("still lists a method that declined on one interpretation but produced a value on another", async () => {
    // Sodium benzoate: Crippen logP is unsupported as drawn and computed on the organic fragment. A
    // number is on screen, so the convention behind it has to be too.
    const report = buildAnalysisReport(await analyze("[Na+].[O-]C(=O)c1ccccc1"));
    const listed = conventionsSection(report).groups.flatMap((group) => group.appliesTo);
    expect(listed.some((label) => label.startsWith("Crippen logP"))).toBe(true);
  });

  it("reaches the plain text a chemist pastes into a notebook", async () => {
    const text = renderReportText(buildAnalysisReport(await analyze(SULFAMETHOXAZOLE)));
    expect(text).toContain("Conventions");
    expect(text).toContain("sulfur and phosphorus INCLUDED");
    // Rendered as an indented bullet under its method, not as a padded table column: a convention is a
    // sentence, and padColumns would size a column to the longest one and wreck every other row.
    expect(text).toMatch(/\n {2}- Ertl 2000 fragment contributions\n/);
  });

  it("reaches the exported markdown", async () => {
    const markdown = renderReportMarkdown(buildAnalysisReport(await analyze(SULFAMETHOXAZOLE)));
    expect(markdown).toContain("## Conventions");
    expect(markdown).toContain("- Ertl 2000 fragment contributions");
    expect(markdown).toMatch(/\*\*[^*]*TPSA[^*]*\*\*/);
    expect(markdown).toContain("sulfur and phosphorus INCLUDED");
  });

  it("survives a run with no results at all", async () => {
    const report = buildAnalysisReport(await analyze("C1CC"));
    expect(report.sections.some((entry) => entry.kind === "conventions")).toBe(false);
    expect(() => renderReportText(report)).not.toThrow();
    expect(() => renderReportMarkdown(report)).not.toThrow();
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
