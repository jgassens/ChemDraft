import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  handleCliError,
  parseNamedSmilesJob,
  readBatchFile
} from "./output";

async function readNamedJobs(jobs: unknown): Promise<unknown[]> {
  const directory = await mkdtemp(join(tmpdir(), "chemdraft-batch-validation-"));
  const path = join(directory, "jobs.json");
  try {
    await writeFile(path, JSON.stringify(jobs));
    return await readBatchFile(path, (candidate) => candidate as { name: string });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("shared CLI output helpers", () => {
  it("validates the common named-SMILES job shape", () => {
    expect(parseNamedSmilesJob({ name: "ethanol", smiles: "CCO" }, 0))
      .toEqual({ name: "ethanol", smiles: "CCO" });
    expect(() => parseNamedSmilesJob({ name: "broken" }, 2))
      .toThrow('Batch job 3 must contain string "name" and "smiles" fields');
  });

  it("emits the shared silent-pnpm usage route and exit policy", () => {
    const stderr: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => stderr.push(line) };
    expect(handleCliError(new CliUsageError("bad option"), io, "render")).toBe(2);
    expect(stderr).toEqual([
      "Error: bad option",
      "Run pnpm -s chemdraft render --help for usage."
    ]);
    expect(handleCliError(new Error("engine failed"), io, "render")).toBe(1);
  });

  it("rejects control characters and extensions in named batches before output paths are derived", async () => {
    await expect(readNamedJobs([{ name: "ethanol\nCC poison" }]))
      .rejects.toThrow('Invalid batch name "ethanol\\nCC poison"');
    await expect(readNamedJobs([{ name: "a.svg" }]))
      .rejects.toThrow('Invalid batch name "a.svg"');
  });

  it("rejects case-insensitive batch-name collisions", async () => {
    await expect(readNamedJobs([{ name: "A" }, { name: "a" }]))
      .rejects.toThrow('Duplicate batch name "a": conflicts with "A"');
  });

  it("rejects a batch larger than 500 jobs and names the first excess job", async () => {
    const jobs = Array.from({ length: 501 }, (_, index) => ({ name: `job-${index + 1}` }));
    await expect(readNamedJobs(jobs))
      .rejects.toThrow('Batch job 501 named "job-501" exceeds the maximum of 500 jobs');
  });
});
