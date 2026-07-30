import { describe, expect, it } from "vitest";

import {
  AnalysisWarningSchema,
  ApplicabilitySchema,
  DatasetRefSchema,
  RawArtifactRefSchema,
  inDomain
} from "./provenance";

describe("applicability", () => {
  it("accepts an in-domain result with no reasons", () => {
    expect(ApplicabilitySchema.safeParse(inDomain).success).toBe(true);
  });

  it("requires a reason for anything that is not in-domain", () => {
    // "Out of domain" with no explanation is indistinguishable from a bug, and a chemist cannot
    // check it. The reason is the deliverable, not the status.
    for (const status of ["borderline", "out-of-domain", "undetermined"] as const) {
      expect(
        ApplicabilitySchema.safeParse({ status, reasons: [], unsupportedFeatures: [] }).success,
        `status ${status} must state a reason`
      ).toBe(false);

      expect(
        ApplicabilitySchema.safeParse({
          status,
          reasons: ["contains boron; Crippen tables have no boron parameters"],
          unsupportedFeatures: ["boron"]
        }).success
      ).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(ApplicabilitySchema.safeParse({ status: "probably-fine", reasons: ["hm"] }).success).toBe(false);
  });
});

describe("warnings", () => {
  it("carries a code, a severity, and the results it undermines", () => {
    const parsed = AnalysisWarningSchema.parse({
      code: "interpretation.counterion_removed",
      severity: "info",
      message: "Sodium was removed before this calculation.",
      affectedResultIds: ["crippen-logp"]
    });
    expect(parsed.affectedResultIds).toEqual(["crippen-logp"]);
  });

  it("defaults to affecting nothing rather than everything", () => {
    const parsed = AnalysisWarningSchema.parse({
      code: "engine.slow",
      severity: "info",
      message: "Descriptor pass took longer than the interactive budget."
    });
    expect(parsed.affectedResultIds).toEqual([]);
  });

  it("rejects an empty code", () => {
    expect(
      AnalysisWarningSchema.safeParse({ code: "", severity: "warning", message: "something" }).success
    ).toBe(false);
  });
});

describe("dataset references", () => {
  it("records redistribution status and obligations", () => {
    // The nmrshiftdb2 case: the data's terms travel with any redistribution independently of the
    // code's licence, and the acknowledgements view is generated from these records.
    const parsed = DatasetRefSchema.parse({
      id: "nmrshiftdb2-derived",
      title: "nmrshiftdb2-derived HOSE-fragment statistics",
      version: "2026.02",
      source: "https://nmrshiftdb.nmr.uni-koeln.de/",
      license: "nmrshiftdb2 Database License (ODbL-derived)",
      redistributable: false,
      obligations: ["attribution", "share-alike on derived databases"]
    });

    expect(parsed.redistributable).toBe(false);
    expect(parsed.obligations).toContain("share-alike on derived databases");
  });

  it("requires a licence — an unlicensed dataset is not a recordable dependency", () => {
    expect(
      DatasetRefSchema.safeParse({
        id: "mystery",
        title: "Some numbers",
        version: "1",
        source: "a colleague",
        redistributable: true
      }).success
    ).toBe(false);
  });
});

describe("raw artifact references", () => {
  it("is a pointer, never a payload", () => {
    const parsed = RawArtifactRefSchema.parse({
      id: "mopac-out",
      kind: "engine-output",
      mediaType: "text/plain",
      byteLength: 84_213,
      location: "runs/run-1/mopac.out"
    });
    expect(parsed.byteLength).toBe(84_213);
    expect(Object.keys(parsed)).not.toContain("content");
  });
});
