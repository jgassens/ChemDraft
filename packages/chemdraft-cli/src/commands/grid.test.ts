import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { runGridCommand } from "./grid";

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-grid-cli-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

function pngWidth(png: Uint8Array): number {
  return ((png[16] ?? 0) << 24) | ((png[17] ?? 0) << 16) | ((png[18] ?? 0) << 8) | (png[19] ?? 0);
}

function memoryIo(): { stdout: string[]; stderr: string[]; io: { stdout: (line: string) => void; stderr: (line: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } };
}

async function writeJobs(name: string, jobs: readonly { name: string; smiles: string }[]): Promise<string> {
  const path = join(outputDirectory, name);
  await writeFile(path, JSON.stringify(jobs));
  return path;
}

const fourStructures = [
  { name: "ethanol", smiles: "CCO" },
  { name: "benzene", smiles: "c1ccccc1" },
  { name: "acetic-acid", smiles: "CC(=O)O" },
  { name: "alanine", smiles: "C[C@H](N)C(=O)O" }
] as const;

describe("chemdraft grid", () => {
  it("writes four structures as a two-by-two PNG at the requested width", async () => {
    const jobs = await writeJobs("four.json", fourStructures);
    const out = join(outputDirectory, "grid.png");
    const capture = memoryIo();

    await expect(runGridCommand([
      "--batch", jobs, "--out", out, "--columns", "2", "--width", "321"
    ], capture.io)).resolves.toBe(0);

    const result = JSON.parse(capture.stdout[0] ?? "{}") as { columns: number; rows: number; cells: unknown[] };
    expect(result.columns).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.cells).toHaveLength(4);
    expect(pngWidth(await readFile(out))).toBe(321);
  });

  it("puts one letter label under each structure in SVG output", async () => {
    const jobs = await writeJobs("letters.json", fourStructures);
    const out = join(outputDirectory, "letters.svg");
    const capture = memoryIo();

    await expect(runGridCommand([
      "--batch", jobs, "--out", out, "--columns", "2", "--labels", "letters"
    ], capture.io)).resolves.toBe(0);

    const svg = await readFile(out, "utf8");
    for (const label of ["A", "B", "C", "D"]) expect(svg).toContain(`>${label}<`);
  });

  it("uses job names when names labels are requested", async () => {
    const jobs = await writeJobs("names.json", fourStructures);
    const out = join(outputDirectory, "names.svg");
    const capture = memoryIo();

    await expect(runGridCommand([
      "--batch", jobs, "--out", out, "--columns", "2", "--labels", "names"
    ], capture.io)).resolves.toBe(0);

    const svg = await readFile(out, "utf8");
    expect(svg).toContain(">ethanol<");
    expect(svg).toContain(">benzene<");
  });

  it("fails the whole grid when a SMILES cannot be parsed", async () => {
    const jobs = await writeJobs("bad.json", [...fourStructures.slice(0, 2), { name: "bad", smiles: "not-smiles" }]);
    const out = join(outputDirectory, "bad.png");
    const capture = memoryIo();

    await expect(runGridCommand(["--batch", jobs, "--out", out], capture.io)).resolves.toBe(1);

    const result = JSON.parse(capture.stdout[0] ?? "{}") as { ok: boolean; smiles?: string; error?: string };
    expect(result.ok).toBe(false);
    expect(result.smiles).toBe("not-smiles");
    expect(result.error).toContain("not-smiles");
    await expect(readFile(out)).rejects.toThrow();
  });
});
