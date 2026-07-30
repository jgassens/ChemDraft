import { describe, expect, it } from "vitest";

import type { Classification } from "./classification";
import {
  aggregateStatus,
  AnalysisResultSchema,
  AnalysisRunSchema,
  AnalysisSchemaVersion,
  runFingerprint,
  statusHasValue,
  type AnalysisStatus
} from "./results";

const deterministicDescriptor: Classification = {
  derivation: "graph-derived",
  claim: "descriptor",
  determinism: "deterministic",
  flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
};

const base = {
  id: "tpsa",
  label: "Topological polar surface area",
  methodId: "rdkit.tpsa",
  methodVersion: "1.0.0",
  interpretationId: "source",
  classification: deterministicDescriptor,
  applicability: { status: "in-domain" as const, reasons: [], unsupportedFeatures: [] },
  uncertainties: [],
  citations: [],
  datasets: [],
  warnings: [],
  rawArtifacts: []
};

const okWarning = {
  code: "descriptor.unsupported_element",
  severity: "warning" as const,
  message: "Crippen tables have no boron parameters.",
  affectedResultIds: []
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

describe("scalar results", () => {
  it("accepts an ok value with a unit", () => {
    const parsed = AnalysisResultSchema.parse({
      ...base,
      kind: "scalar",
      status: "ok",
      value: 63.6,
      unit: "square-angstrom",
      decimalPlaces: 2
    });
    expect(parsed.kind).toBe("scalar");
  });

  it("refuses a value on a status that did not produce one", () => {
    // The failure this prevents: a stale or partial number rendered as though the run succeeded.
    for (const status of ["unsupported", "not-applicable", "failed", "cancelled", "timed-out"] as const) {
      const result = AnalysisResultSchema.safeParse({
        ...base,
        kind: "scalar",
        status,
        value: 63.6,
        unit: "square-angstrom",
        warnings: [okWarning]
      });
      expect(result.success, `status ${status} must not carry a value`).toBe(false);
    }
  });

  it('refuses "ok" with no value', () => {
    expect(
      AnalysisResultSchema.safeParse({ ...base, kind: "scalar", status: "ok", value: null, unit: "square-angstrom" })
        .success
    ).toBe(false);
  });

  it("requires a warning on every non-ok status", () => {
    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        kind: "scalar",
        status: "unsupported",
        value: null,
        unit: "square-angstrom"
      }).success
    ).toBe(false);

    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        kind: "scalar",
        status: "unsupported",
        value: null,
        unit: "square-angstrom",
        warnings: [okWarning]
      }).success
    ).toBe(true);
  });

  it('allows "partial" to carry both a value and a warning', () => {
    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        kind: "scalar",
        status: "partial",
        value: 63.6,
        unit: "square-angstrom",
        warnings: [okWarning]
      }).success
    ).toBe(true);
  });

  it("requires a seed for seeded and stochastic methods", () => {
    const seededClassification: Classification = {
      ...deterministicDescriptor,
      derivation: "force-field",
      determinism: "seeded"
    };

    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        classification: seededClassification,
        kind: "scalar",
        status: "ok",
        value: 1,
        unit: "kilocalorie-per-mole"
      }).success
    ).toBe(false);

    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        classification: seededClassification,
        kind: "scalar",
        status: "ok",
        value: 1,
        unit: "kilocalorie-per-mole",
        seed: 42
      }).success
    ).toBe(true);
  });

  it("rejects an unregistered unit string", () => {
    expect(
      AnalysisResultSchema.safeParse({ ...base, kind: "scalar", status: "ok", value: 1, unit: "furlongs" })
        .success
    ).toBe(false);
  });
});

describe("composition results", () => {
  it("keeps a salt's components rather than flattening them", () => {
    const parsed = AnalysisResultSchema.parse({
      ...base,
      id: "composition",
      label: "Composition",
      methodId: "rdkit.composition",
      kind: "composition",
      status: "ok",
      formula: "C7H5NaO2",
      formalCharge: 0,
      elements: [
        { symbol: "C", count: 7 },
        { symbol: "H", count: 5 },
        { symbol: "Na", count: 1 },
        { symbol: "O", count: 2 }
      ],
      components: [
        {
          formula: "C7H5O2",
          charge: -1,
          multiplicity: 1,
          elements: [
            { symbol: "C", count: 7 },
            { symbol: "H", count: 5 },
            { symbol: "O", count: 2 }
          ],
          sourceAtomIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9]
        },
        { formula: "Na", charge: 1, multiplicity: 1, elements: [{ symbol: "Na", count: 1 }], sourceAtomIndices: [0] }
      ],
      hasExplicitIsotopes: false,
      radicalElectronCount: 0
    });

    expect(parsed.kind === "composition" && parsed.components).toHaveLength(2);
  });

  it("records an explicit isotope label", () => {
    const parsed = AnalysisResultSchema.parse({
      ...base,
      id: "composition",
      label: "Composition",
      methodId: "rdkit.composition",
      kind: "composition",
      status: "ok",
      formula: "C2H4O2",
      formalCharge: 0,
      elements: [
        { symbol: "C", count: 1, isotope: 13 },
        { symbol: "C", count: 1 },
        { symbol: "H", count: 4 },
        { symbol: "O", count: 2 }
      ],
      components: [],
      hasExplicitIsotopes: true,
      radicalElectronCount: 0
    });

    expect(parsed.kind === "composition" && parsed.hasExplicitIsotopes).toBe(true);
  });
});

describe("bulk-payload results", () => {
  const distributionBase = {
    ...base,
    id: "envelope",
    label: "Isotope envelope",
    methodId: "isospec.envelope",
    kind: "distribution" as const,
    status: "ok" as const,
    positionUnit: "dalton" as const,
    intensityUnit: "relative-abundance" as const,
    truncation: { policy: "relative-intensity-threshold" as const, threshold: 0.05 }
  };

  it("accepts matched typed arrays", () => {
    expect(
      AnalysisResultSchema.safeParse({
        ...distributionBase,
        positions: new Float64Array([180.042, 181.045]),
        intensities: new Float64Array([100, 9.9])
      }).success
    ).toBe(true);
  });

  it("rejects mismatched position/intensity lengths", () => {
    expect(
      AnalysisResultSchema.safeParse({
        ...distributionBase,
        positions: new Float64Array([180.042, 181.045]),
        intensities: new Float64Array([100])
      }).success
    ).toBe(false);
  });

  it("rejects a plain array where a typed array is required", () => {
    // The transport decision is load-bearing (§3): a plain array would serialise as JSON and defeat
    // the transferable path before a single spectrum exists.
    expect(
      AnalysisResultSchema.safeParse({
        ...distributionBase,
        positions: [180.042],
        intensities: [100]
      }).success
    ).toBe(false);
  });

  it("requires three coordinates per atom in a geometry result", () => {
    const geometryBase = {
      ...base,
      id: "geometry",
      label: "Conformer",
      methodId: "rdkit.etkdgv3",
      kind: "geometry" as const,
      status: "ok" as const,
      coordinateUnit: "angstrom" as const,
      classification: { ...deterministicDescriptor, determinism: "seeded" as const },
      seed: 42
    };

    expect(
      AnalysisResultSchema.safeParse({
        ...geometryBase,
        coordinates: new Float64Array([0, 0, 0, 1, 0, 0]),
        atomToSourceAtom: new Int32Array([0, 1])
      }).success
    ).toBe(true);

    expect(
      AnalysisResultSchema.safeParse({
        ...geometryBase,
        coordinates: new Float64Array([0, 0, 0]),
        atomToSourceAtom: new Int32Array([0, 1])
      }).success
    ).toBe(false);
  });

  it("requires an orbital grid to hold exactly nx·ny·nz points", () => {
    const orbitalBase = {
      ...base,
      id: "homo",
      label: "HOMO",
      methodId: "mopac.pm7.homo",
      kind: "orbital" as const,
      status: "ok" as const,
      gridOrigin: [0, 0, 0] as [number, number, number],
      gridSpacing: [0.5, 0.5, 0.5] as [number, number, number],
      isovalue: 0.02,
      basis: "PM7"
    };

    expect(
      AnalysisResultSchema.safeParse({
        ...orbitalBase,
        gridDimensions: [2, 2, 2],
        values: new Float64Array(8)
      }).success
    ).toBe(true);

    expect(
      AnalysisResultSchema.safeParse({
        ...orbitalBase,
        gridDimensions: [2, 2, 2],
        values: new Float64Array(7)
      }).success
    ).toBe(false);
  });
});

describe("correlation maps", () => {
  it("cannot be labelled anything but a candidate map", () => {
    // §6: HMBC depends on longer-range coupling and suppression conditions; COSY reflects scalar
    // coupling, not graph distance. The literal is the type-level refusal to call these spectra.
    const map = {
      ...base,
      id: "hmbc",
      label: "Candidate HMBC correlations",
      methodId: "graph.hmbc-candidates",
      kind: "correlation-map" as const,
      status: "ok" as const,
      experiment: "hmbc" as const,
      correlations: [{ sourceAtomA: 0, sourceAtomB: 3, tier: "expected" as const, bondSeparation: 3 }]
    };

    expect(AnalysisResultSchema.safeParse({ ...map, presentation: "candidate-correlation-map" }).success).toBe(
      true
    );
    expect(AnalysisResultSchema.safeParse({ ...map, presentation: "simulated-spectrum" }).success).toBe(false);
  });
});

describe("identifier results", () => {
  it("carries the InChI flavour as a structured field", () => {
    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        id: "inchi",
        label: "InChI",
        methodId: "rdkit.inchi",
        kind: "identifier",
        status: "ok",
        identifierType: "inchi",
        value: "InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)",
        flavour: "standard"
      }).success
    ).toBe(true);
  });

  it("rejects an empty identifier string — absence is null, not empty", () => {
    expect(
      AnalysisResultSchema.safeParse({
        ...base,
        id: "inchi",
        label: "InChI",
        methodId: "rdkit.inchi",
        kind: "identifier",
        status: "ok",
        identifierType: "inchi",
        value: ""
      }).success
    ).toBe(false);
  });
});

describe("AnalysisRun", () => {
  const okScalar = {
    ...base,
    kind: "scalar" as const,
    status: "ok" as const,
    value: 63.6,
    unit: "square-angstrom" as const
  };

  function run(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: AnalysisSchemaVersion,
      runId: "run-1",
      sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
      interpretations: [sourceInterpretation],
      engines: [
        {
          name: "rdkit-minimallib-wasm",
          version: "2026.03.3",
          artifactHashes: ["48b725a2e80af7f9792cd56abf65f16cea402f1cfe4f3f6c32a71669f1d848aa"]
        }
      ],
      startedAt: "2026-07-30T12:00:00.000Z",
      finishedAt: "2026-07-30T12:00:00.120Z",
      status: "ok",
      results: [okScalar],
      warnings: [],
      fingerprint: "fnv1a64:cccccccccccccccc",
      ...overrides
    };
  }

  it("accepts a well-formed run", () => {
    expect(AnalysisRunSchema.safeParse(run()).success).toBe(true);
  });

  it("rejects a result whose interpretation the run does not carry", () => {
    // Provenance that cannot be reconstructed is worse than a missing result, because it still renders.
    const parsed = AnalysisRunSchema.safeParse(
      run({ results: [{ ...okScalar, interpretationId: "neutralized" }] })
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/neutralized/);
    }
  });

  it("rejects a warning pointing at a result that is not in the run", () => {
    expect(
      AnalysisRunSchema.safeParse(
        run({
          warnings: [{ code: "x.y", severity: "warning", message: "orphaned", affectedResultIds: ["ghost"] }]
        })
      ).success
    ).toBe(false);
  });

  it("requires at least one interpretation", () => {
    expect(AnalysisRunSchema.safeParse(run({ interpretations: [] })).success).toBe(false);
  });

  it("pins the schema version", () => {
    expect(AnalysisRunSchema.safeParse(run({ schemaVersion: "chemdraft.analysis.v2" })).success).toBe(false);
  });
});

describe("status aggregation", () => {
  it("reports the worst outcome, not the last", () => {
    expect(aggregateStatus(["ok", "ok"])).toBe("ok");
    expect(aggregateStatus(["ok", "partial"])).toBe("partial");
    expect(aggregateStatus(["ok", "unsupported", "partial"])).toBe("unsupported");
    expect(aggregateStatus(["not-applicable", "failed"])).toBe("failed");
    expect(aggregateStatus(["cancelled", "timed-out"])).toBe("timed-out");
  });

  it("does not let an inapplicable method drag down a run that worked", () => {
    // Aspirin has no nitrogen, so "[M+H−NH₃]⁺" correctly does not apply. Reporting the whole run as
    // not-applicable because of it would tell the user something went wrong with an analysis in which
    // nothing did.
    expect(aggregateStatus(["ok", "not-applicable"])).toBe("ok");
    expect(aggregateStatus(["ok", "not-applicable", "partial"])).toBe("partial");
    // A capability gap still counts — that one belongs in the headline.
    expect(aggregateStatus(["ok", "not-applicable", "unsupported"])).toBe("unsupported");
  });

  it("keeps not-applicable when it is the whole story", () => {
    expect(aggregateStatus(["not-applicable", "not-applicable"])).toBe("not-applicable");
  });

  it("treats an empty suite as ok", () => {
    expect(aggregateStatus([])).toBe("ok");
  });

  it("agrees with statusHasValue about which statuses carry payloads", () => {
    const withValue: AnalysisStatus[] = ["ok", "partial"];
    const without: AnalysisStatus[] = ["unsupported", "not-applicable", "failed", "cancelled", "timed-out"];
    for (const status of withValue) expect(statusHasValue(status)).toBe(true);
    for (const status of without) expect(statusHasValue(status)).toBe(false);
  });
});

describe("run fingerprint", () => {
  it("is stable across input ordering and sensitive to engine artifacts", () => {
    const shared = { sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa", interpretationHashes: ["a", "b"] };
    expect(
      runFingerprint({ ...shared, methodKeys: ["m1", "m2"], engineHashes: ["e1"] })
    ).toBe(runFingerprint({ ...shared, methodKeys: ["m2", "m1"], engineHashes: ["e1"] }));

    // A rebuilt engine must change the fingerprint — that is what makes "the numbers moved" reviewable.
    expect(runFingerprint({ ...shared, methodKeys: ["m1"], engineHashes: ["e1"] })).not.toBe(
      runFingerprint({ ...shared, methodKeys: ["m1"], engineHashes: ["e2"] })
    );
  });
});
