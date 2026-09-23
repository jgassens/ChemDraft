import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { runAnalyzeCommand as runCli } from "./analyze";

interface CapturedResult {
  name: string;
  smiles: string;
  ok: boolean;
  error?: string;
  report?: string;
  file?: string;
  summary?: {
    formula: string | null;
    monoisotopicMass: number | null;
    averageMass: number | null;
    canonicalSmiles: string | null;
    inchiKey: string | null;
    logP: number | null;
    tpsa: number | null;
    hbd: number | null;
    hba: number | null;
    rotatableBonds: number | null;
    pka: Array<{
      site: string;
      value: number;
      interval: { lower: number; upper: number } | null;
    }>;
  };
  run?: {
    status: string;
    results: Array<{
      id: string;
      methodId: string;
      interpretationId: string;
      status: string;
      kind: string;
      value?: number | string | null;
      formula?: string | null;
    }>;
    interpretations: Array<{
      id: string;
      transformations: unknown[];
    }>;
  };
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
      formula: "C9H8O4",
      hbd: 1,
      hba: 3,
      rotatableBonds: 2
    });
    expect(result.summary!.monoisotopicMass).toBeCloseTo(180.042, 3);
    expect(result.summary!.averageMass).toBeCloseTo(180.159, 3);
    expect(result.summary!.logP).toBeTypeOf("number");
    expect(result.summary!.tpsa).toBeCloseTo(63.6, 1);
    expect(result.summary!.canonicalSmiles).toBeTruthy();
    expect(result.summary!.inchiKey).toMatch(/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/);
    expect(result.summary!.pka.length).toBeGreaterThan(0);
    expect(result.summary!.pka[0]!.interval).toEqual({
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
    expect(result.summary?.formula).toBe("C7H5NaO2");
    expect(result.summary?.averageMass).toBe(144.105);
    expect(result.summary?.logP).toBeNull();
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
    expect(stdout.join("\n")).toContain("pnpm chemdraft analyze --smiles");
  });
});
