import { describe, expect, it } from "vitest";
import {
  CORPUS,
  CORPUS_DEFERRED_FAMILIES,
  MEANINGFUL_WARNING_CODES,
  formatCorpusReport,
  runCorpus
} from "./corpus";

describe("Phase 1C corpus runner", () => {
  it("every labeled case produces its required commit/warn/refuse outcome", () => {
    const report = runCorpus();
    const failures = report.results.filter((r) => !r.pass);
    // Surface a readable report if anything regresses.
    expect(failures, formatCorpusReport(report)).toHaveLength(0);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.total);
  });

  it("covers all three labels with at least one adversarial refusal and one warn", () => {
    const report = runCorpus();
    expect(report.byLabel.mustCommit.total).toBeGreaterThanOrEqual(1);
    expect(report.byLabel.warnButAllow.total).toBeGreaterThanOrEqual(1);
    expect(report.byLabel.mustRefuse.total).toBeGreaterThanOrEqual(1);
  });

  it("classifies warnButAllow off MEANINGFUL warnings only (perspective-cleanup is baseline noise)", () => {
    // perspective-cleanup must NOT be treated as a meaningful warning.
    expect(MEANINGFUL_WARNING_CODES).not.toContain("perspective-cleanup");
    const report = runCorpus();
    const cleanCommits = report.results.filter((r) => r.label === "mustCommit" && r.pass);
    // A clean mustCommit case must carry ZERO meaningful warnings despite the
    // baseline perspective-cleanup warning the function always emits.
    for (const r of cleanCommits) expect(r.meaningfulWarnings).toHaveLength(0);
  });

  it("documents the engine-dependent families it deliberately defers to Phase 2", () => {
    expect(CORPUS_DEFERRED_FAMILIES).toContain("chair / cyclohexane");
    expect(CORPUS_DEFERRED_FAMILIES.length).toBeGreaterThan(0);
    // None of the deferred families may sneak into the engine-free corpus.
    const presentFamilies = new Set(CORPUS.map((c) => c.family));
    for (const deferred of CORPUS_DEFERRED_FAMILIES) {
      expect(presentFamilies.has(deferred)).toBe(false);
    }
  });

  it("has unique case ids", () => {
    const ids = CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
