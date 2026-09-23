import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { runCli } from "./cli";

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-cli-dispatch-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

describe("chemdraft CLI dispatch", () => {
  it("keeps direct-process stdout as pure JSON Lines", () => {
    const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const child = spawnSync(process.execPath, [
      "--import", "tsx",
      cliPath,
      "stereo",
      "--smiles", "C[C@H](N)C(=O)O"
    ], { encoding: "utf8" });

    expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, warnings: [] });
  }, 30_000);

  it("lists all eight subcommands in top-level help", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    expect(code).toBe(0);
    for (const name of ["render", "grid", "reaction", "analyze", "name", "stereo", "nmr", "export"]) {
      expect(stdout.join("\n")).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("returns 2 for an unknown subcommand", async () => {
    const stderr: string[] = [];
    const code = await runCli(["unknown"], {
      stdout: () => undefined,
      stderr: (line) => stderr.push(line)
    });

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain('unknown subcommand "unknown"');
  });

  it("dispatches render and writes aspirin SVG", async () => {
    const output = join(outputDirectory, "aspirin.svg");
    const stdout: string[] = [];
    const code = await runCli(
      ["render", "--smiles", "CC(=O)Oc1ccccc1C(=O)O", "--out", output],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, name: "aspirin", files: [output] });
    expect(await readFile(output, "utf8")).toContain("<svg");
  });
});
