import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnalysisRun } from "@chemdraft/analysis-core";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { runAnalyzeCommand as runCli, summarizeAnalysisRun } from "./analyze";

interface CapturedResult {
  name: string;
  smiles: string;
  ok: boolean;
  error?: string;
  report?: string;
  file?: string;
  summary?: {
    formula: { value: string | null; status: string; reason?: string };
    monoisotopicMass: { value: number | null; status: string; reason?: string };
    averageMass: { value: number | null; status: string; reason?: string };
    canonicalSmiles: { value: string | null; status: string; reason?: string };
    inchiKey: { value: string | null; status: string; reason?: string };
    logP: { value: number | null; status: string; reason?: string };
    tpsa: { value: number | null; status: string; reason?: string };
    hbd: { value: number | null; status: string; reason?: string };
    hba: { value: number | null; status: string; reason?: string };
    rotatableBonds: { value: number | null; status: string; reason?: string };
    pka: { value: Array<{
      atomIndex: number | null;
      derivedAtomIndex?: number;
      siteType: string;
      transition: "acidic" | "basic";
      acidCharge: number;
      basis: string;
      value: number | null;
      reason?: string;
      interval: { lower: number; upper: number } | null;
    }> | null; status: string; reason?: string; interpretationId?: string; interpretationLabel?: string };
  };
  run?: AnalysisRun;
}

const ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O";
const SUMMARY_METHODS = [
  "rdkit.composition",
  "rdkit.monoisotopic-mass",
  "rdkit.average-mass",
  "rdkit.canonical-smiles",
  "rdkit.inchikey",
  "rdkit.crippen-logp",
  "rdkit.tpsa",
  "rdkit.hbd",
  "rdkit.hba",
  "rdkit.rotatable-bonds",
  "dimorphite.ionizable-sites"
].join(",");

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-analyze-cli-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

async function run(argv: readonly string[]): Promise<{
  code: number;
  results: CapturedResult[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  });
  return {
    code,
    results: stdout.map((line) => JSON.parse(line) as CapturedResult),
    stderr
  };
}

describe("chemdraft analyze", () => {
  it("returns aspirin's full run and compact source-preserving summary", async () => {
    const { code, results } = await run([
      "--smiles", ASPIRIN,
      "--methods", SUMMARY_METHODS,
      "--format", "json"
    ]);

    expect(code).toBe(0);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      formula: { value: "C9H8O4", status: "ok" },
      hbd: { value: 1, status: "ok" },
      hba: { value: 3, status: "ok" },
      rotatableBonds: { value: 2, status: "ok" }
    });
    expect(result.summary!.monoisotopicMass.value).toBeCloseTo(180.042, 3);
    expect(result.summary!.averageMass.value).toBeCloseTo(180.159, 3);
    expect(result.summary!.logP.value).toBeTypeOf("number");
    expect(result.summary!.tpsa.value).toBeCloseTo(63.6, 1);
    expect(result.summary!.canonicalSmiles.value).toBeTruthy();
    expect(result.summary!.inchiKey.value).toMatch(/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/);
    expect(result.summary!.pka.value!.length).toBeGreaterThan(0);
    expect(result.summary!.pka.value![0]).toMatchObject({
      atomIndex: expect.any(Number),
      siteType: expect.any(String),
      acidCharge: expect.any(Number),
      basis: expect.any(String)
    });
    expect(result.summary!.pka.value![0]!.interval).toEqual({
      lower: expect.any(Number),
      upper: expect.any(Number)
    });
    expect(result.run?.results.map((entry) => entry.methodId)).toEqual(
      expect.arrayContaining(SUMMARY_METHODS.split(","))
    );
  }, 120_000);

  it("keeps sodium benzoate as the source and carries its desalted interpretation beside it", async () => {
    const { code, results } = await run([
      "--smiles", "[Na+].[O-]C(=O)c1ccccc1",
      "--methods", "rdkit.composition,rdkit.average-mass,rdkit.crippen-logp"
    ]);

    expect(code).toBe(0);
    const result = results[0]!;
    expect(result.summary?.formula).toEqual({ value: "C7H5NaO2", status: "ok" });
    expect(result.summary?.averageMass.value).toBe(144.105);
    expect(result.summary?.logP).toMatchObject({ value: null, status: "unsupported" });
    expect(result.summary?.logP.reason).toMatch(/parameters|sodium|Na/i);
    expect(result.run?.interpretations[0]?.id).toBe("source");
    expect(result.run?.interpretations.some((entry) =>
      entry.id === "largest-organic-fragment" && entry.transformations.length > 0
    )).toBe(true);
    expect(result.run?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        methodId: "rdkit.crippen-logp",
        interpretationId: "source",
        status: "unsupported"
      }),
      expect.objectContaining({
        methodId: "rdkit.crippen-logp",
        interpretationId: "largest-organic-fragment",
        status: "ok"
      })
    ]));
  }, 120_000);

  it("shows a boron Crippen decline in Markdown", async () => {
    const { code, results } = await run([
      "--smiles", "OB(O)c1ccccc1",
      "--methods", "rdkit.crippen-logp",
      "--format", "md"
    ]);

    expect(code).toBe(0);
    expect(results[0]?.report).toContain("Crippen logP");
    expect(results[0]?.report).toMatch(/unsupported/i);
    expect(results[0]?.report).toMatch(/boron|\bB\b/i);
  }, 120_000);

  it("distinguishes not-requested summary fields from declined methods", async () => {
    const composition = await run([
      "--smiles", ASPIRIN,
      "--methods", "rdkit.composition"
    ]);
    expect(composition.code).toBe(0);
    expect(composition.results[0]!.summary!.formula).toEqual({ value: "C9H8O4", status: "ok" });
    expect(composition.results[0]!.summary!.logP).toEqual({ value: null, status: "not-requested" });
    expect(composition.results[0]!.summary!.pka).toEqual({ value: null, status: "not-requested" });

    const boron = await run([
      "--smiles", "OB(O)c1ccccc1",
      "--methods", "rdkit.crippen-logp"
    ]);
    expect(boron.code).toBe(0);
    expect(boron.results[0]!.summary!.logP).toMatchObject({ value: null, status: "unsupported" });
    expect(boron.results[0]!.summary!.logP.reason).toMatch(/boron|\bB\b/i);
  }, 120_000);

  it("reports basic-site metadata separately and retains null-valued recognized sites", async () => {
    const amine = await run([
      "--smiles", "CN",
      "--methods", "dimorphite.ionizable-sites"
    ]);
    const basic = amine.results[0]!.summary!.pka.value!.find((site) => site.transition === "basic");
    expect(basic).toMatchObject({
      atomIndex: 1,
      siteType: expect.any(String),
      acidCharge: expect.any(Number),
      basis: expect.any(String)
    });
    expect(basic!.siteType).not.toContain("(atom");
    expect(basic!.value).toBeGreaterThan(10.1);
    expect(basic!.value).toBeLessThan(11.1);

    const sourceRun = amine.results[0]!.run!;
    const ionization = sourceRun.results.find((result) =>
      result.kind === "ionization" && result.methodId === "dimorphite.ionizable-sites"
    );
    expect(ionization?.kind).toBe("ionization");
    if (!ionization || ionization.kind !== "ionization") throw new Error("Expected ionization result.");
    const recognizedSite = ionization.sites[0]!;
    const summary = summarizeAnalysisRun({
      ...sourceRun,
      results: sourceRun.results.map((result) => result === ionization
        ? {
            ...ionization,
            sites: [{
              ...recognizedSite,
              pKa: null,
              derivation: "Recognized site has no reportable pKa value."
            }]
          }
        : result)
    });
    const nullSite = summary.pka.value!.find((site) => site.value === null);
    expect(nullSite).toMatchObject({ value: null, reason: expect.any(String) });
  }, 120_000);

  it("reports a pKa computed on the reference protomer as ok, on the drawn atoms", async () => {
    // Glycine drawn as its zwitterion: Dimorphite's ladder runs on the reference protomer, so the
    // only ionization result lives on a derived interpretation. It must not read as not-requested.
    const { code, results } = await run([
      "--smiles", "[NH3+]CC(=O)[O-]",
      "--methods", "dimorphite.ionizable-sites"
    ]);
    expect(code).toBe(0);
    const pka = results[0]!.summary!.pka;
    expect(pka.status).toBe("ok");
    expect(pka.interpretationId).toBe("reference-protomer");
    expect(pka.interpretationLabel).toMatch(/reference protomer/);
    const sites = pka.value!;
    expect(sites).toHaveLength(2);
    const amine = sites.find((site) => site.transition === "basic")!;
    const carboxyl = sites.find((site) => site.transition === "acidic")!;
    // Source atoms of [NH3+]CC(=O)[O-]: N0 C1 C2 O3 O4.
    expect(amine.atomIndex).toBe(0);
    expect(carboxyl.atomIndex).toBe(4);
    expect(Math.abs(amine.value! - 9.1)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(carboxyl.value! - 4.3)).toBeLessThanOrEqual(0.5);

    // The mapping, not coincidence, supplies the source index: reverse the ledger's atom mapping and
    // the same derived sites must land on the mirrored source atoms.
    const sourceRun = results[0]!.run!;
    const reversed: AnalysisRun = {
      ...sourceRun,
      interpretations: sourceRun.interpretations.map((interpretation) =>
        interpretation.id !== "reference-protomer"
          ? interpretation
          : {
              ...interpretation,
              transformations: interpretation.transformations.map((step) => ({
                ...step,
                atomMapping: step.atomMapping.map(([, derived]) => [4 - derived, derived] as const)
              }))
            })
    };
    const remapped = summarizeAnalysisRun(reversed).pka.value!;
    expect(remapped.find((site) => site.transition === "basic")).toMatchObject({ atomIndex: 4, derivedAtomIndex: 0 });
    expect(remapped.find((site) => site.transition === "acidic")).toMatchObject({ atomIndex: 0, derivedAtomIndex: 4 });

    // A derived site with no source counterpart is reported with a null index and a reason, not dropped.
    const orphaned: AnalysisRun = {
      ...sourceRun,
      interpretations: sourceRun.interpretations.map((interpretation) =>
        interpretation.id !== "reference-protomer"
          ? interpretation
          : {
              ...interpretation,
              transformations: interpretation.transformations.map((step) => ({
                ...step,
                atomMapping: step.atomMapping.filter(([, derived]) => derived !== 0)
              }))
            })
    };
    const orphanSite = summarizeAnalysisRun(orphaned).pka.value!.find((site) => site.transition === "basic");
    expect(orphanSite).toMatchObject({ atomIndex: null, derivedAtomIndex: 0 });
    expect(orphanSite!.reason).toMatch(/no counterpart in the drawn structure/);
  }, 60_000);

  it("writes Markdown, returns text inline, and emits JSON runs", async () => {
    const markdownPath = join(outputDirectory, "aspirin.md");
    const markdown = await run([
      "--smiles", ASPIRIN,
      "--methods", "rdkit.composition",
      "--format", "md",
      "--out", markdownPath
    ]);
    expect(markdown.code).toBe(0);
    expect(markdown.results[0]).toMatchObject({ ok: true, file: markdownPath });
    expect(await readFile(markdownPath, "utf8")).toContain("| Formula | C9H8O4 |");

    const text = await run([
      "--smiles", ASPIRIN,
      "--methods", "rdkit.composition",
      "--format", "text"
    ]);
    expect(text.code).toBe(0);
    expect(text.results[0]?.report).toMatch(/Formula\s+C9H8O4/);

    const json = await run([
      "--smiles", ASPIRIN,
      "--methods", "rdkit.composition",
      "--format", "json"
    ]);
    expect(json.code).toBe(0);
    expect(json.results[0]?.run?.results).toEqual([
      expect.objectContaining({ methodId: "rdkit.composition", formula: "C9H8O4" })
    ]);
  }, 120_000);

  it("continues a batch after bad SMILES and emits one JSON line per input", async () => {
    const jobsPath = join(outputDirectory, "jobs.json");
    await writeFile(jobsPath, JSON.stringify([
      { name: "aspirin", smiles: ASPIRIN },
      { name: "bad", smiles: "not-a-smiles" },
      { name: "ethanol", smiles: "CCO" }
    ]));

    const { code, results } = await run([
      "--batch", jobsPath,
      "--methods", "rdkit.composition"
    ]);
    expect(code).toBe(1);
    expect(results.map((result) => ({ name: result.name, ok: result.ok }))).toEqual([
      { name: "aspirin", ok: true },
      { name: "bad", ok: false },
      { name: "ethanol", ok: true }
    ]);
    expect(results[1]?.error).toContain("not-a-smiles");
    expect(results[1]?.error).not.toContain(" at ");
  }, 120_000);

  it("returns ok:false for an unparseable SMILES without a stack trace", async () => {
    const { code, results, stderr } = await run([
      "--smiles", "not-a-smiles",
      "--methods", "rdkit.composition"
    ]);
    expect(code).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, smiles: "not-a-smiles" });
    expect(results[0]?.error).toContain("not-a-smiles");
    expect(results[0]?.error).not.toContain(" at ");
    expect(stderr.join("\n")).toContain("Failed");
  }, 120_000);

  it("rejects unknown method ids with the contract registry's valid ids", async () => {
    const { code, results, stderr } = await run([
      "--smiles", "CCO",
      "--methods", "rdkit.not-real"
    ]);
    expect(code).toBe(2);
    expect(results).toEqual([]);
    expect(stderr.join("\n")).toContain("rdkit.not-real");
    expect(stderr.join("\n")).toContain("rdkit.composition");
    expect(stderr.join("\n")).toContain("dimorphite.ionizable-sites");
  });

  it("shows command help", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("pnpm -s chemdraft analyze --smiles");
  });
});
