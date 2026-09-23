import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  convertNameWithOpsin,
  defaultOpsinPaths,
  runNameCommand
} from "./name";

let outputDirectory: string;
const enginePaths = defaultOpsinPaths();
const runtimeAvailable = existsSync(dirname(dirname(enginePaths.javaPath)));

if (!runtimeAvailable) {
  console.warn("skipping real OPSIN tests: run scripts/build-opsin-runtime.sh to build the bundled JRE");
}

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-name-cli-"));
});

afterAll(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
});

function capturedIo(): { stdout: string[]; stderr: string[]; io: { stdout: (line: string) => void; stderr: (line: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
  };
}

describe("headless ChemDraft name conversion", () => {
  it("prints help", async () => {
    const capture = capturedIo();
    expect(await runNameCommand(["--help"], capture.io)).toBe(0);
    expect(capture.stdout.join("\n")).toContain("--name");
  });

  it("rejects a newline in a name as bad arguments", async () => {
    const capture = capturedIo();
    expect(await runNameCommand(["--name", "benzene\nethanol"], capture.io)).toBe(2);
    expect(capture.stdout).toHaveLength(0);
    expect(capture.stderr.join("\n")).toContain("tabs or newlines");
  });

  it("reports a missing bundled JRE separately from an invalid chemical name", async () => {
    await expect(convertNameWithOpsin("benzene", {
      ...enginePaths,
      javaPath: join(outputDirectory, "missing-jre", "bin", "java")
    })).rejects.toThrow("missing bundled Java executable");
    await expect(convertNameWithOpsin("benzene", {
      ...enginePaths,
      javaPath: join(outputDirectory, "missing-jre", "bin", "java")
    })).rejects.toThrow("scripts/build-opsin-runtime.sh");
  });

  it.skipIf(!runtimeAvailable)("converts aspirin, ibuprofen, and chiral alanine", async () => {
    const fixtures = [
      ["aspirin", "2-acetoxybenzoic acid"],
      ["ibuprofen", "ibuprofen"],
      ["alanine", "(2S)-2-aminopropanoic acid"]
    ] as const;
    for (const [name, query] of fixtures) {
      const capture = capturedIo();
      expect(await runNameCommand(["--name", query], capture.io)).toBe(0);
      const result = JSON.parse(capture.stdout[0]!) as { name: string; query: string; ok: boolean; smiles: string };
      expect(result).toMatchObject({ name: query, query, ok: true, engine: "opsin-2.9.0" });
      expect(result.smiles).not.toHaveLength(0);
      if (name === "alanine") expect(result.smiles).toContain("@");
    }
  });

  it.skipIf(!runtimeAvailable)("reports a nonsense name as a failed JSON line", async () => {
    const capture = capturedIo();
    expect(await runNameCommand(["--name", "xyzzy-not-a-real-chemical-name"], capture.io)).toBe(1);
    expect(capture.stdout).toHaveLength(1);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      name: "xyzzy-not-a-real-chemical-name",
      query: "xyzzy-not-a-real-chemical-name",
      ok: false,
      engine: "opsin-2.9.0"
    });
    expect(JSON.parse(capture.stdout[0]!).error).toContain("xyzzy-not-a-real-chemical-name");
  });

  it.skipIf(!runtimeAvailable)("renders a converted name to the requested PNG path", async () => {
    const png = join(outputDirectory, "aspirin.png");
    const capture = capturedIo();
    expect(await runNameCommand(["--name", "2-acetoxybenzoic acid", "--render", png], capture.io)).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({ ok: true, png });
    expect((await stat(png)).size).toBeGreaterThan(0);
  });
});
