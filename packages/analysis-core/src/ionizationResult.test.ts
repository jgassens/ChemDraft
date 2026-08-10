/**
 * The ionization result contract and its rendering — the two paths nothing was testing.
 *
 * `AnalysisResultSchema` is `.strict()` and is never parsed at runtime; only tests exercise it. So a
 * field added to the `IonizationSite` interface but not to `IonizationSiteSchema` (or the reverse)
 * produced no failure anywhere, and `report.ts`'s ionization block had no coverage at all. That is the
 * gap this file closes, and it is written BEFORE the state-model change so the change has a net under
 * it rather than beside it.
 */
import { describe, expect, it } from "vitest";

import type { Classification } from "./classification";
import { buildAnalysisReport } from "./report";
import { AnalysisResultSchema, AnalysisRunSchema, AnalysisSchemaVersion } from "./results";

const trained: Classification = {
  derivation: "statistical-model",
  claim: "prediction",
  determinism: "deterministic",
  flags: { conventionDependent: false, experimentallyCalibrated: true, trainedOnExperimentalData: true }
};

const base = {
  id: "dimorphite.ionizable-sites",
  label: "Ionizable sites",
  methodId: "dimorphite.ionizable-sites",
  methodVersion: "1.0.0",
  interpretationId: "source",
  classification: trained,
  applicability: { status: "in-domain" as const, reasons: [], unsupportedFeatures: [] },
  uncertainties: [],
  conventions: [],
  citations: [],
  datasets: [],
  warnings: [],
  rawArtifacts: []
};

/** Acetic acid: one carboxyl oxygen, one value. The smallest result that is not empty. */
const aceticAcid = {
  ...base,
  kind: "ionization" as const,
  status: "ok" as const,
  sites: [
    {
      atomIndices: [1, 2, 3],
      ionizableAtomIndex: 3,
      siteType: "Carboxylic acid",
      transition: "acidic" as const,
      acidCharge: 0,
      pKa: 4.5,
      spread: 0.4,
      basis: "experimentally-trained-model" as const
    }
  ],
  unassessed: [],
  depiction: {
    atoms: [
      { index: 0, x: 0, y: 0, element: "C", charge: 0, hydrogens: 3 },
      { index: 1, x: 1, y: 0, element: "C", charge: 0, hydrogens: 0 },
      { index: 2, x: 1.5, y: 0.9, element: "O", charge: 0, hydrogens: 0 },
      { index: 3, x: 1.5, y: -0.9, element: "O", charge: 0, hydrogens: 1 }
    ],
    bonds: [
      { from: 0, to: 1, order: 1 },
      { from: 1, to: 2, order: 2 },
      { from: 1, to: 3, order: 1 }
    ]
  },
  confidenceBands: { good: 0.6, poor: 1.5, tightestQuartileMae: 0.36, widestQuartileMae: 1.25, partition: "out-of-fold calibration corpus, 12,096 sites" },
  macroscopic: { pKa: [4.5], inconsistency: 0, microstates: 2, zwitterionic: false }
};

const sourceInterpretation = {
  id: "source",
  label: "as drawn",
  sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
  interpretationHash: "fnv1a64:bbbbbbbbbbbbbbbb",
  componentPolicy: "whole-input" as const,
  explicitHydrogenPolicy: "as-drawn",
  isotopePolicy: "preserve-labels",
  aromaticityModel: "rdkit-default",
  transformations: []
};

function runWith(result: unknown) {
  return AnalysisRunSchema.parse({
    schemaVersion: AnalysisSchemaVersion,
    runId: "run-1",
    sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
    interpretations: [sourceInterpretation],
    engines: [],
    startedAt: "2026-08-03T00:00:00.000Z",
    status: "ok",
    results: [result],
    warnings: [],
    fingerprint: "fnv1a64:cccccccccccccccc"
  });
}

describe("the ionization result schema", () => {
  it("accepts a scored site", () => {
    const parsed = AnalysisResultSchema.parse(aceticAcid);
    expect(parsed.kind).toBe("ionization");
    if (parsed.kind !== "ionization") return;
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.sites[0]!.pKa).toBe(4.5);
  });

  it("rejects a value with no spread, and a spread with no value", () => {
    // The pair is the estimate. A bare number reads as though it were measured.
    const noSpread = { ...aceticAcid, sites: [{ ...aceticAcid.sites[0]!, spread: undefined }] };
    expect(() => AnalysisResultSchema.parse(noSpread)).toThrow();
    const noValue = { ...aceticAcid, sites: [{ ...aceticAcid.sites[0]!, pKa: null }] };
    expect(() => AnalysisResultSchema.parse(noValue)).toThrow();
  });

  it("rejects an unknown field on a site", () => {
    // `.strict()` is what keeps the interface and the schema from drifting apart silently.
    const extra = { ...aceticAcid, sites: [{ ...aceticAcid.sites[0]!, madeUp: 1 }] };
    expect(() => AnalysisResultSchema.parse(extra)).toThrow();
  });

  it("treats a result with neither sites nor gaps as carrying no payload", () => {
    // `ok` requires a payload; an empty ionization result must declare itself not-applicable.
    const empty = { ...aceticAcid, sites: [], unassessed: [], macroscopic: undefined, depiction: undefined };
    expect(() => AnalysisResultSchema.parse(empty)).toThrow();
    const declared = {
      ...empty,
      status: "not-applicable" as const,
      warnings: [
        {
          code: "ionization.no_sites",
          severity: "info" as const,
          message: "Nothing in this structure ionizes in water.",
          affectedResultIds: []
        }
      ]
    };
    expect(() => AnalysisResultSchema.parse(declared)).not.toThrow();
  });

  it("keeps an unassessed gap as a payload in its own right", () => {
    // "There is a site here I cannot judge" is an answer, so `partial` is legitimate with zero sites.
    const gapOnly = {
      ...aceticAcid,
      status: "partial" as const,
      sites: [],
      macroscopic: undefined,
      depiction: undefined,
      unassessed: [{ atomIndices: [3], reason: "adjacent to Fe", feature: "metal-adjacent site" }],
      warnings: [
        {
          code: "ionization.unassessed_site",
          severity: "warning" as const,
          message: "adjacent to Fe",
          affectedResultIds: []
        }
      ]
    };
    expect(() => AnalysisResultSchema.parse(gapOnly)).not.toThrow();
  });
});

describe("rendering an ionization result", () => {
  it("draws the structure, the macroscopic values and the site table", () => {
    const report = buildAnalysisReport(runWith(aceticAcid));
    const kinds = report.sections.map((section) => section.kind);
    expect(kinds).toContain("svg");
    expect(kinds).toContain("keyValue");
    expect(kinds).toContain("table");
  });

  it("puts the pKa into the figure rather than only the table", () => {
    const report = buildAnalysisReport(runWith(aceticAcid));
    const svg = report.sections.find((section) => section.kind === "svg");
    expect(svg, "no figure was rendered").toBeDefined();
    if (svg?.kind !== "svg") return;
    expect(svg.svg).toContain("4.50");
  });

  it("names every site in the table", () => {
    const report = buildAnalysisReport(runWith(aceticAcid));
    const table = report.sections.find((section) => section.kind === "table");
    expect(table, "no site table was rendered").toBeDefined();
    if (table?.kind !== "table") return;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.join(" ")).toContain("Carboxylic acid");
  });

  it("renders a partial result's values instead of dropping them", () => {
    // The failure this guards is real: filtering on `status === "ok"` once removed a partial result's
    // content entirely, so a molecule with one unjudgeable site lost the sites that WERE scored.
    const partial = {
      ...aceticAcid,
      status: "partial" as const,
      unassessed: [{ atomIndices: [0], reason: "adjacent to Na", feature: "metal-adjacent site" }],
      warnings: [
        {
          code: "ionization.unassessed_site",
          severity: "warning" as const,
          message: "adjacent to Na",
          affectedResultIds: []
        }
      ]
    };
    const report = buildAnalysisReport(runWith(partial));
    const table = report.sections.find((section) => section.kind === "table");
    expect(table?.kind === "table" && table.rows.length).toBe(1);
  });

  it("says why no macroscopic value was folded, rather than showing nothing", () => {
    const declined = {
      ...aceticAcid,
      macroscopic: undefined,
      macroscopicDeclined: "9 ionizable sites would need 512 microstates."
    };
    const report = buildAnalysisReport(runWith(declined));
    const text = report.sections.filter((section) => section.kind === "text");
    expect(text.some((section) => section.kind === "text" && /microstates/.test(section.body))).toBe(true);
  });
});

describe("an amphoteric atom in the figure", () => {
  // Aniline's nitrogen carries two rungs: it loses a proton near 12.9 and gains one near 4.6. The
  // figure keyed annotations into a Map by atom index and took the LAST, so the drawing showed 4.60
  // and silently dropped 12.90 while the table beside it listed both. A reader had no way to tell.
  const aniline = {
    ...base,
    kind: "ionization" as const,
    status: "ok" as const,
    unassessed: [],
    confidenceBands: { good: 1.0, poor: 2.6, tightestQuartileMae: 0.36, widestQuartileMae: 1.25, partition: "out-of-fold calibration corpus, 12,096 sites" },
    sites: [
      {
        atomIndices: [0], ionizableAtomIndex: 0, siteType: "Aniline",
        transition: "acidic" as const, acidCharge: 0,
        pKa: 12.9, spread: 0.5, basis: "experimentally-trained-model" as const
      },
      {
        atomIndices: [0], ionizableAtomIndex: 0, siteType: "Aniline",
        transition: "basic" as const, acidCharge: 1,
        pKa: 4.6, spread: 0.3, basis: "experimentally-trained-model" as const
      }
    ],
    depiction: {
      atoms: [
        { index: 0, x: 0, y: 0, element: "N", charge: 0, hydrogens: 2 },
        { index: 1, x: 1, y: 0, element: "C", charge: 0, hydrogens: 0 },
        { index: 2, x: 2, y: 0, element: "C", charge: 0, hydrogens: 1 }
      ],
      bonds: [{ from: 0, to: 1, order: 1 }, { from: 1, to: 2, order: 2 }]
    }
  };

  it("draws BOTH of the atom's values", () => {
    const report = buildAnalysisReport(runWith(aniline));
    const svg = report.sections.find((section) => section.kind === "svg");
    expect(svg, "no figure was rendered").toBeDefined();
    if (svg?.kind !== "svg") return;
    expect(svg.svg, "the basic value is missing").toContain("4.60");
    expect(svg.svg, "the acidic value was dropped, which is the bug this guards").toContain("12.90");
  });

  it("orders them most acidic first, which is titration order", () => {
    const report = buildAnalysisReport(runWith(aniline));
    const svg = report.sections.find((section) => section.kind === "svg");
    expect(svg, "no figure was rendered").toBeDefined();
    if (svg?.kind !== "svg") return;
    // Both values must be PRESENT before their order means anything. Comparing raw `indexOf` results
    // let a figure that dropped 4.60 entirely pass, because -1 is less than any real index — which is
    // precisely the failure the sibling test three lines up calls "the acidic value was dropped".
    expect(svg.svg).toContain("4.60");
    expect(svg.svg).toContain("12.90");
    expect(svg.svg.indexOf("4.60")).toBeLessThan(svg.svg.indexOf("12.90"));
  });

  it("still lists each rung as its own table row", () => {
    // The figure merges; the table must not. Two rungs are two equilibria.
    const report = buildAnalysisReport(runWith(aniline));
    const table = report.sections.find((section) => section.kind === "table");
    expect(table?.kind === "table" && table.rows.length).toBe(2);
  });
});

/**
 * The species distribution, through the schema and the renderer.
 *
 * `AnalysisResultSchema` is `.strict()` and is not parsed at runtime, so a field added to the interface
 * and forgotten in the schema is invisible until something else parses a run. That is the divergence
 * this file exists to catch, and a new nested object is exactly the shape it catches.
 */
describe("the species distribution", () => {
  const glycine = {
    ...aceticAcid,
    macroscopic: {
      pKa: [2.31, 9.73],
      inconsistency: 0.25,
      microstates: 4,
      zwitterionic: true,
      distribution: {
        pH: 7.4,
        charges: [
          { charge: 0, fraction: 0.9954, protonCount: 1 },
          { charge: -1, fraction: 0.0046, protonCount: 0 }
        ],
        dominantCharge: 0,
        fractionNetNeutral: 0.9954,
        fractionUncharged: 3.8e-6
      }
    }
  };

  it("passes the strict schema", () => {
    expect(() => AnalysisResultSchema.parse(glycine)).not.toThrow();
  });

  it("rejects a fraction outside zero to one", () => {
    const broken = {
      ...glycine,
      macroscopic: {
        ...glycine.macroscopic,
        distribution: { ...glycine.macroscopic.distribution, fractionNetNeutral: 1.4 }
      }
    };
    expect(() => AnalysisResultSchema.parse(broken)).toThrow();
  });

  it("renders each charge state as a percentage", () => {
    const report = buildAnalysisReport(runWith(glycine));
    const rendered = JSON.stringify(report);
    expect(rendered).toContain("Species at pH 7.4");
    expect(rendered).toContain("no net charge");
    expect(rendered).toContain("99.5%");
  });

  it("splits out the uncharged fraction for a zwitterion, and says the rest is charged at both ends", () => {
    // The distinction the interface exists to make. Glycine's net-zero population is a zwitterion, and
    // a reader who read "99.5% neutral" and reached for a permeability argument would be wrong by five
    // orders of magnitude.
    const report = buildAnalysisReport(runWith(glycine));
    const rendered = JSON.stringify(report);
    expect(rendered).toContain("of which carries no charge at all");
    expect(rendered).toContain("<0.1%");
    expect(rendered).toContain("zwitterionic");
  });

  it("does not split it out for a plain acid, where the two coincide", () => {
    const acid = {
      ...aceticAcid,
      macroscopic: {
        pKa: [4.3],
        inconsistency: 0,
        microstates: 2,
        zwitterionic: false,
        distribution: {
          pH: 7.4,
          charges: [
            { charge: -1, fraction: 0.9992, protonCount: 0 },
            { charge: 0, fraction: 0.0008, protonCount: 1 }
          ],
          dominantCharge: -1,
          fractionNetNeutral: 0.0008,
          fractionUncharged: 0.0008
        }
      }
    };
    const rendered = JSON.stringify(buildAnalysisReport(runWith(acid)));
    expect(rendered).toContain("Species at pH 7.4");
    expect(rendered).not.toContain("of which carries no charge at all");
  });
});
