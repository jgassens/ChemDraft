import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  convertNameWithOpsin,
  defaultOpsinPaths,
  runNameCommand
} from "./name";

let outputDirectory: string;
const enginePaths = defaultOpsinPaths();
const fakeJavaPath = fileURLToPath(new URL("./__fixtures__/fake-java.sh", import.meta.url));
const fakeJarPath = fileURLToPath(new URL("./__fixtures__/fake-opsin.jar", import.meta.url));
const runtimeAvailable = existsSync(dirname(dirname(enginePaths.javaPath)));

if (!runtimeAvailable) {
  console.warn("skipping real OPSIN tests: run scripts/build-opsin-runtime.sh to build the bundled JRE");
}

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-name-cli-"));
  await chmod(fakeJavaPath, 0o755);
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

  it("exercises the OPSIN line protocol with a fake Java process", async () => {
    const paths = { javaPath: fakeJavaPath, jarPath: fakeJarPath };
    await expect(convertNameWithOpsin("ethanol", paths)).resolves.toEqual({ smiles: "CCO" });
    await expect(convertNameWithOpsin("parse-failure", paths)).resolves.toEqual({
      failureReason: "OPSIN could not parse the supplied name"
    });
    await expect(convertNameWithOpsin("non-zero", paths)).rejects.toThrow(/exit 7.*simulated JVM failure/);
  });

  it("escalates an OPSIN timeout and reports it without rebuild advice", async () => {
    const failure = await convertNameWithOpsin("timeout", {
      javaPath: fakeJavaPath,
      jarPath: fakeJarPath,
      timeoutMs: 40,
      killGraceMs: 40
    }).then(
      () => "unexpected success",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect(failure).toMatch(/OPSIN timed out after 40 ms/);
    expect(failure).not.toMatch(/rebuild/i);
  });

  it("passes depiction warnings through a rendered name result", async () => {
    const png = join(outputDirectory, "warning.png");
    const capture = capturedIo();
    const renderSmiles = async () => ({
      png: new Uint8Array([137, 80, 78, 71]),
      warnings: ["simulated depiction warning"]
    }) as Awaited<ReturnType<typeof import("../document").renderSmilesToAssets>>;
    expect(await runNameCommand(
      ["--name", "ethanol", "--render", png],
      capture.io,
      {
        opsinPaths: { javaPath: fakeJavaPath, jarPath: fakeJarPath },
        renderSmiles
      }
    )).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      ok: true,
      warnings: ["simulated depiction warning"]
    });
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
  }, 120_000);

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
  }, 120_000);

  it.skipIf(!runtimeAvailable)("renders a converted name to the requested PNG path", async () => {
    const png = join(outputDirectory, "aspirin.png");
    const capture = capturedIo();
    expect(await runNameCommand(["--name", "2-acetoxybenzoic acid", "--render", png], capture.io)).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({ ok: true, png });
    expect((await stat(png)).size).toBeGreaterThan(0);
  }, 120_000);
});
