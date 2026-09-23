import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { runExportCommand as runCli } from "./export";

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-export-cli-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

interface CollectedIo {
  stdoutLines: string[];
  stderrLines: string[];
}

function collectIo(): CollectedIo & { stdout: (line: string) => void; stderr: (line: string) => void } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line)
  };
}

function jsonLines(io: CollectedIo): unknown[] {
  return io.stdoutLines.map((line) => JSON.parse(line));
}

const ETHANOL = "CCO";
const D_ALANINE = "C[C@@H](N)C(=O)O";
const BAD_SMILES = "not-a-smiles(((";

describe("chemdraft export", () => {
  it("exports CDXML that round-trips with the same atom and bond counts", async () => {
    const out = join(outputDirectory, "ethanol.cdxml");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", ETHANOL, "--out", out], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    expect(contents.startsWith("<?xml")).toBe(true);
    expect(contents.length).toBeGreaterThan(0);

    const opened = openChemDraftPayload(contents);
    expect(opened.document).toBeDefined();
    const molecule = opened.document!.pages[0]!.objects.find(
      (object): object is MoleculeObject => object.type === "molecule"
    );
    expect(molecule).toBeDefined();
    expect(molecule!.atoms).toHaveLength(3);
    expect(molecule!.bonds).toHaveLength(2);

    const lines = jsonLines(io);
    expect(lines).toEqual([
      expect.objectContaining({ ok: true, out, format: "cdxml", smiles: ETHANOL })
    ]);
  });

  it("exports a PDF starting with the %PDF signature", async () => {
    const out = join(outputDirectory, "ethanol.pdf");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", ETHANOL, "--out", out], io);
    expect(exitCode).toBe(0);

    const bytes = await readFile(out);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(0);

    const line = jsonLines(io)[0] as { ok: boolean; bytes: number };
    expect(line.ok).toBe(true);
    expect(line.bytes).toBe(bytes.length);
  });

  it("exports a MOL file with a V2000 counts line", async () => {
    const out = join(outputDirectory, "ethanol.mol");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", ETHANOL, "--out", out], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    expect(contents).toMatch(/^  3  2  0  0  \d  0  0  0  0  0999 V2000$/m);
  });

  it("exports a single-structure SDF containing the $$$$ record terminator", async () => {
    const out = join(outputDirectory, "ethanol.sdf");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", ETHANOL, "--out", out], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    expect(contents).toContain("$$$$\n");
    expect(contents).toContain("> <SMILES>");
  });

  it("exports one SMILES line per structure", async () => {
    const out = join(outputDirectory, "ethanol.smi");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", ETHANOL, "--out", out], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    const lines = contents.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\t");
  });

  it("preserves D-alanine stereochemistry in SMILES export", async () => {
    const out = join(outputDirectory, "d-alanine.smi");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", D_ALANINE, "--out", out], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    expect(contents).toContain("@");
  });

  it("preserves D-alanine stereochemistry as a wedge/hash bond flag in SDF export", async () => {
    const out = join(outputDirectory, "d-alanine.sdf");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", D_ALANINE, "--out", out], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    // V2000 bond line: three 3-char fields (atom1, atom2, order), then a stereo flag field
    // that is "  1" (wedge) or "  6" (hash), then "  0  0  0".
    expect(contents).toMatch(/^.{9}(  1|  6)  0  0  0$/m);
  });

  it("reports ok:false naming the SMILES for an unparseable structure", async () => {
    const out = join(outputDirectory, "bad.mol");
    const io = collectIo();
    const exitCode = await runCli(["--smiles", BAD_SMILES, "--out", out], io);
    expect(exitCode).toBe(1);

    const lines = jsonLines(io) as { ok: boolean; smiles: string; error: string }[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ok).toBe(false);
    expect(lines[0]!.smiles).toBe(BAD_SMILES);
    expect(lines[0]!.error).toContain(BAD_SMILES);
  });

  it("writes one file per structure for cdxml/pdf/mol batches", async () => {
    const jobsFile = join(outputDirectory, "batch-mol-jobs.json");
    const outDir = join(outputDirectory, "batch-mol-out");
    await writeFile(jobsFile, JSON.stringify([
      { name: "ethanol", smiles: ETHANOL },
      { name: "alanine", smiles: D_ALANINE }
    ]));
    const io = collectIo();
    const exitCode = await runCli(["--batch", jobsFile, "--out-dir", outDir, "--format", "mol"], io);
    expect(exitCode).toBe(0);

    const ethanolContents = await readFile(join(outDir, "ethanol.mol"), "utf8");
    const alanineContents = await readFile(join(outDir, "alanine.mol"), "utf8");
    expect(ethanolContents).toMatch(/V2000$/m);
    expect(alanineContents).toMatch(/V2000$/m);

    const lines = jsonLines(io) as { ok: boolean; out: string }[];
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.out))).toEqual(
      new Set([join(outDir, "ethanol.mol"), join(outDir, "alanine.mol")])
    );
  });

  it("combines a batch of structures into one SDF file", async () => {
    const jobsFile = join(outputDirectory, "batch-sdf-jobs.json");
    const out = join(outputDirectory, "batch.sdf");
    await writeFile(jobsFile, JSON.stringify([
      { name: "ethanol", smiles: ETHANOL },
      { name: "alanine", smiles: D_ALANINE }
    ]));
    const io = collectIo();
    const exitCode = await runCli(["--batch", jobsFile, "--out", out, "--format", "sdf"], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    expect(contents.split("$$$$\n")).toHaveLength(3); // two records + trailing empty split
    expect(contents).toContain("ethanol");
    expect(contents).toContain("alanine");

    const lines = jsonLines(io) as { ok: boolean; out: string }[];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.out).toBe(out);
  });

  it("combines a batch of structures into one SMILES file", async () => {
    const jobsFile = join(outputDirectory, "batch-smi-jobs.json");
    const out = join(outputDirectory, "batch.smi");
    await writeFile(jobsFile, JSON.stringify([
      { name: "ethanol", smiles: ETHANOL },
      { name: "alanine", smiles: D_ALANINE }
    ]));
    const io = collectIo();
    const exitCode = await runCli(["--batch", jobsFile, "--out", out, "--format", "smi"], io);
    expect(exitCode).toBe(0);

    const contents = await readFile(out, "utf8");
    const lines = contents.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
  });

  it("emits one failed JSON line per combined record when --out is a directory", async () => {
    const jobsFile = join(outputDirectory, "write-error-jobs.json");
    const out = join(outputDirectory, "combined-output-directory");
    await writeFile(jobsFile, JSON.stringify([
      { name: "ethanol", smiles: ETHANOL },
      { name: "alanine", smiles: D_ALANINE }
    ]));
    await mkdir(out);
    const io = collectIo();
    const exitCode = await runCli(["--batch", jobsFile, "--out", out, "--format", "sdf"], io);

    expect(exitCode).toBe(1);
    const lines = jsonLines(io) as Array<{ name: string; ok: boolean; out: string; error: string }>;
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.name)).toEqual(["ethanol", "alanine"]);
    for (const line of lines) {
      expect(line).toMatchObject({ ok: false, out });
      expect(line.error).toContain(out);
    }
  });

  it("does not create an empty combined file when the batch has no records", async () => {
    const jobsFile = join(outputDirectory, "empty-jobs.json");
    const out = join(outputDirectory, "empty.smi");
    await writeFile(jobsFile, "[]");
    const io = collectIo();
    expect(await runCli(["--batch", jobsFile, "--out", out, "--format", "smi"], io)).toBe(1);
    await expect(readFile(out)).rejects.toThrow();
  });

  it("rejects --out-dir with a batch sdf/smi format", async () => {
    const io = collectIo();
    const exitCode = await runCli(
      ["--batch", join(outputDirectory, "missing.json"), "--out-dir", outputDirectory, "--format", "sdf"],
      io
    );
    expect(exitCode).toBe(2);
  });

  it("rejects --out with a batch mol/cdxml/pdf format", async () => {
    const io = collectIo();
    const exitCode = await runCli(
      ["--batch", join(outputDirectory, "missing.json"), "--out", join(outputDirectory, "x.mol"), "--format", "mol"],
      io
    );
    expect(exitCode).toBe(2);
  });

  it("prints help and exits 0", async () => {
    const io = collectIo();
    const exitCode = await runCli(["--help"], io);
    expect(exitCode).toBe(0);
    expect(io.stdoutLines[0]).toContain("ChemDraft headless document exporter");
  });
});
