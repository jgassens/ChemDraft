/**
 * The Molecular Inspector's content model, over a real run.
 *
 * In `rdkit-adapter` rather than `analysis-core` for the reason the report tests already live here: a
 * model test over a hand-written report proves the transform, while one over sulfamethoxazole proves
 * the thing the window exists for — that a reader can find the number they want and copy exactly it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildInspectorModel,
  reconcileSelection,
  renderSelectionMarkdown,
  renderSelectionText,
  reportForSelection,
  selectedSections,
  splitSectionTitle,
  type AnalysisRun
} from "@chemdraft/analysis-core";
import { buildAnalysisReport } from "@chemdraft/analysis-core";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

const SULFAMETHOXAZOLE = "Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1";

let counter = 0;
async function report(value: string, options: Record<string, unknown> = {}) {
  counter += 1;
  const run: AnalysisRun = await analyzeStructure({
    format: "smiles",
    value,
    runId: `inspector-${counter}`,
    startedAt: "2026-07-31T12:00:00.000Z",
    ...options
  } as never);
  return buildAnalysisReport(run);
}

describe("splitSectionTitle", () => {
  it("keeps a naming parenthetical but peels a computed one", () => {
    // The rule is the digit: "(m/z)" names the section, "(3)" and "(20 peaks, ...)" are counts that
    // change with the structure and would otherwise rename the category out from under a selection.
    expect(splitSectionTitle("Ions (m/z)")).toEqual({ label: "Ions (m/z)" });
    expect(splitSectionTitle("Components (3)")).toEqual({ label: "Components", detail: "3" });
    expect(splitSectionTitle("Isotope envelope (20 peaks, 99.9% of the distribution)")).toEqual({
      label: "Isotope envelope",
      detail: "20 peaks, 99.9% of the distribution"
    });
  });

  it("separates a section's name from its hoisted disclosure", () => {
    expect(splitSectionTitle("Descriptors — convention-dependent — see Conventions")).toEqual({
      label: "Descriptors",
      note: "convention-dependent — see Conventions"
    });
  });

  it("leaves an unnoted title alone", () => {
    expect(splitSectionTitle("Composition")).toEqual({ label: "Composition" });
  });
});

describe("the category list", () => {
  it("groups the mass-spectrometry sections under one category and leaves the rest alone", async () => {
    const model = buildInspectorModel(await report(SULFAMETHOXAZOLE));
    const labels = model.categories.map((category) => category.label);

    expect(labels).toEqual(
      expect.arrayContaining(["Identity", "Composition", "Mass Spec", "Descriptors", "Provenance", "Conventions"])
    );
    // The ion series, the isotope envelope, and the mass methods that declined render three different
    // ways but are one subject; a reader should not have to visit three categories to find them.
    expect(labels).not.toContain("Ions (m/z)");
    expect(labels).not.toContain("Isotope envelope");
    // The note is kept as a subtitle rather than dropped: it is the §2 disclosure.
    const descriptors = model.categories.find((category) => category.label === "Descriptors");
    expect(descriptors?.note).toMatch(/convention-dependent/);
  });

  it("counts entries so an empty category cannot look like a populated one", async () => {
    const model = buildInspectorModel(await report(SULFAMETHOXAZOLE));
    for (const category of model.categories) {
      expect(category.entryCount).toBe(category.entries.length);
      expect(category.entryCount).toBeGreaterThan(0);
    }
  });

  it("exposes individual rows as selectable entries, with their values", async () => {
    const model = buildInspectorModel(await report(SULFAMETHOXAZOLE));
    const descriptors = model.categories.find((category) => category.label === "Descriptors");
    const tpsa = descriptors?.entries.find((entry) => entry.label.includes("TPSA"));
    expect(tpsa?.value).toBe("106.60 Å²");
  });

  it("counts a grouped category across every section it spans", async () => {
    const built = await report("Brc1ccccc1");
    const model = buildInspectorModel(built);
    const massSpec = model.categories.find((category) => category.label === "Mass Spec");
    expect(massSpec).toBeDefined();

    // Entries from all three of its sections, in report order: ions first, then the envelope's peaks.
    expect(massSpec!.entries.some((entry) => entry.label === "[M+H]⁺")).toBe(true);
    expect(massSpec!.entries.some((entry) => entry.label === "155.95746" && entry.value === "100.00")).toBe(true);
    expect(massSpec!.entryCount).toBe(massSpec!.entries.length);
  });
});

describe("selection", () => {
  it("defaults to the whole report", async () => {
    const built = await report(SULFAMETHOXAZOLE);
    expect(selectedSections(built, {})).toHaveLength(built.sections.length);
    expect(reportForSelection(built, {})).toBe(built);
  });

  it("narrows to one category without reformatting it", async () => {
    // The narrowed value is still an AnalysisReport, so the viewport and both renderers take exactly
    // the same input for a category as for the whole run. No second formatter to drift.
    const built = await report(SULFAMETHOXAZOLE);
    const narrowed = reportForSelection(built, { categoryId: "Descriptors" });
    expect(narrowed.sections).toHaveLength(1);
    expect(splitSectionTitle(narrowed.sections[0]!.title).label).toBe("Descriptors");
    expect(narrowed.engineSummary).toBe(built.engineSummary);
    expect(narrowed.fingerprint).toBe(built.fingerprint);
  });

  it("keeps a selection that still exists after a recomputation, and drops one that does not", async () => {
    // A structure edit changes which categories exist. Yanking the reader back to "everything" when
    // their category survived would be the annoying failure; keeping a dead one would be the wrong one.
    const salt = buildInspectorModel(await report("[Na+].[O-]C(=O)c1ccccc1"));
    expect(reconcileSelection(salt, { categoryId: "Descriptors" })).toEqual({ categoryId: "Descriptors" });
    expect(reconcileSelection(salt, { categoryId: "Not a category" })).toEqual({});
    expect(reconcileSelection(salt, {})).toEqual({});
  });
});

describe("export matches what is on screen", () => {
  it("copies only the selected category, and says which build produced it", async () => {
    const built = await report(SULFAMETHOXAZOLE);
    const text = renderSelectionText(built, { categoryId: "Descriptors" });

    expect(text).toContain("Descriptors");
    expect(text).toContain("106.60 Å²");
    // Not the whole report: the Ions section is a different category and must not ride along.
    expect(text).not.toContain("[M+Na]⁺");
    // Provenance travels with every fragment — a pasted number that cannot be traced is not evidence.
    expect(text).toContain("Engine:");
    expect(text).toMatch(/Run fingerprint: fnv1a64:/);
  });

  it("exports a grouped category as every section it spans", async () => {
    // Selecting Mass Spec copies the ions, the envelope, and the mass declines together — the whole
    // subject — while still excluding everything that is not part of it.
    const built = await report(SULFAMETHOXAZOLE);
    const markdown = renderSelectionMarkdown(built, { categoryId: "Mass Spec" });
    expect(markdown).toMatch(/^# Molecular properties — Mass Spec/m);
    expect(markdown).toContain("[M+H]⁺");
    expect(markdown).toContain("| Mass (Da) |");
    expect(markdown).not.toContain("## Identity");
    expect(markdown).not.toContain("## Descriptors");
  });

  it("exports everything when nothing is narrowed", async () => {
    const built = await report(SULFAMETHOXAZOLE);
    const all = renderSelectionText(built, {});
    expect(all).toContain("Identity");
    expect(all).toContain("Descriptors");
    expect(all).toContain("Conventions");
  });
});
