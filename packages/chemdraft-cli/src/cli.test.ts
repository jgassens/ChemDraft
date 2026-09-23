import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
