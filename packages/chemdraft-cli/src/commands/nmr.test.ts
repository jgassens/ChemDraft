import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import type { CliIo } from "../output";
import { NMR_PLUGIN_DIR_ENV, nmrHelp, resolveNmrPluginDir, runNmrCommand } from "./nmr";

interface Resonance {
  nucleus: "1H" | "13C";
  atomIndices: number[];
  shiftPpm: number;
  multiplicity: string | null;
  jHz: number[];
  estimated: boolean;
  nEquivalent: number;
  source: string;
}

interface Line {
  name: string;
  ok: boolean;
  smiles: string;
  error?: string;
  resonances?: Resonance[];
  warnings?: string[];
  spectrum?: string[];
  database?: { license: string | null };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

async function run(argv: string[]): Promise<{ code: number; lines: Line[]; stderr: string[] }> {
  const { io, stdout, stderr } = captureIo();
  const code = await runNmrCommand(argv, io);
  return { code, lines: stdout.map((line) => JSON.parse(line) as Line), stderr };
}

async function withPluginDir<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env[NMR_PLUGIN_DIR_ENV];
  process.env[NMR_PLUGIN_DIR_ENV] = dir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[NMR_PLUGIN_DIR_ENV];
    else process.env[NMR_PLUGIN_DIR_ENV] = previous;
  }
}

const pluginDir = resolveNmrPluginDir();
const fixturePluginDir = fileURLToPath(new URL("./__fixtures__/nmr-plugin", import.meta.url));
const pluginPresent = existsSync(join(pluginDir, "src", "index.ts"));
if (!pluginPresent) {
  console.log(
    `Skipping chemdraft nmr prediction tests: no NMR predictor plugin at ${pluginDir} (set ${NMR_PLUGIN_DIR_ENV}).`
  );
}

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-nmr-cli-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

describe("chemdraft nmr without the plugin", () => {
  it("prints help that carries the scientific-claim rules", async () => {
    const { io, stdout } = captureIo();
    expect(await runNmrCommand(["--help"], io)).toBe(0);
    const help = stdout.join("\n");
    expect(help).toBe(nmrHelp);
    expect(help).toContain("HOSE-fragment lookup");
    expect(help).toContain("NMRShiftDB2");
    expect(help).toMatch(/first-order estimates/);
    expect(help).toContain("not an integration");
    expect(help).toContain("No shift is ever invented");
    expect(help).toContain("No confidence percentages");
    expect(help).toContain("nmrshiftdb2 Database License");
    expect(help).toContain(NMR_PLUGIN_DIR_ENV);
    expect(help).not.toMatch(/synthetic|fixture-backed/i);
  });

  it("reports a missing plugin directory as ok:false naming the environment variable", async () => {
    const missing = join(outputDirectory, "no-such-plugin");
    const { code, lines } = await withPluginDir(missing, () => run(["--smiles", "CCO"]));
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ok: false, smiles: "CCO" });
    expect(lines[0]!.error).toContain(NMR_PLUGIN_DIR_ENV);
    expect(lines[0]!.error).toContain(join(missing, "src", "index.ts"));
  });

  it("expands ~ in the plugin directory", () => {
    expect(resolveNmrPluginDir({ [NMR_PLUGIN_DIR_ENV]: "~/somewhere" })).not.toContain("~");
  });

  it("rejects bad arguments with exit code 2", async () => {
    expect((await run(["--smiles", "CCO", "--nuclei", "19F"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(["--smiles", "CCO", "--spectrum", "out.pdf"])).code).toBe(2);
  });
});

describe("chemdraft nmr with the CI fixture plugin", () => {
  it("formats resonances, warns on atom-order drift, and writes a relabelled spectrum", async () => {
    const spectrum = join(outputDirectory, "fixture-spectrum.svg");
    const { code, lines } = await withPluginDir(fixturePluginDir, () => run([
      "--smiles", "CCO",
      "--nuclei", "1H",
      "--spectrum", spectrum
    ]));
    expect(code).toBe(0);
    expect(lines[0]!.resonances).toEqual([expect.objectContaining({
      nucleus: "1H",
      atomIndices: [1],
      shiftPpm: 3.62,
      multiplicity: "q",
      jHz: [7.1],
      estimated: true,
      nEquivalent: 2,
      source: "hose-fragment"
    })]);
    expect(lines[0]!.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("NMR_FIXTURE"),
      expect.stringContaining("NMR_ATOM_ORDER_MISMATCH")
    ]));
    expect(lines[0]!.spectrum).toEqual([spectrum]);
    const svg = await readFile(spectrum, "utf8");
    expect(svg).toContain("predicted (HOSE / NMRShiftDB2)");
    expect(svg).toContain("not integration");
    expect(svg).not.toContain("synthetic fixture");
  });
});

describe.skipIf(!pluginPresent)("chemdraft nmr with the predictor plugin", () => {
  it("predicts three 1H environments for ethanol with estimated multiplicity and J", async () => {
    const { code, lines } = await run(["--smiles", "CCO", "--nuclei", "1H"]);
    expect(code).toBe(0);
    const line = lines[0]!;
    expect(line.ok).toBe(true);
    const resonances = line.resonances!;
    resonances.forEach((resonance) => {
      expect(resonance.nucleus).toBe("1H");
      expect(resonance.estimated).toBe(true);
    });

    // Atom order follows the SMILES: C0 (CH3), C1 (OCH2), O2 (OH).
    const methyl = resonances.find((resonance) => resonance.atomIndices.includes(0))!;
    const methylene = resonances.find((resonance) => resonance.atomIndices.includes(1))!;
    const hydroxyl = resonances.find((resonance) => resonance.atomIndices.includes(2));
    expect(methyl.shiftPpm).toBeGreaterThan(0.9);
    expect(methyl.shiftPpm).toBeLessThan(1.45);
    expect(methyl.nEquivalent).toBe(3);
    expect(methyl.multiplicity).toBe("t");
    expect(methyl.jHz.length).toBeGreaterThan(0);
    expect(methylene.shiftPpm).toBeGreaterThan(3.3);
    expect(methylene.shiftPpm).toBeLessThan(4.0);
    expect(methylene.nEquivalent).toBe(2);
    if (hydroxyl) {
      expect(hydroxyl.nEquivalent).toBe(1);
      expect(resonances).toHaveLength(3);
    } else {
      expect(line.warnings!.some((warning) => /NMR_(LABILE_PROTON_OMITTED|NO_FRAGMENT_MATCH)/.test(warning))).toBe(true);
    }
    expect(line.database!.license).toMatch(/nmrshiftdb2/i);
  }, 60_000);

  it("predicts two 13C environments for ethanol", async () => {
    const { code, lines } = await run(["--smiles", "CCO", "--nuclei", "13C"]);
    expect(code).toBe(0);
    const resonances = lines[0]!.resonances!;
    expect(resonances).toHaveLength(2);
    const methyl = resonances.find((resonance) => resonance.atomIndices.includes(0))!;
    const oxygenated = resonances.find((resonance) => resonance.atomIndices.includes(1))!;
    expect(methyl.shiftPpm).toBeGreaterThan(8);
    expect(methyl.shiftPpm).toBeLessThan(25);
    expect(oxygenated.shiftPpm).toBeGreaterThan(50);
    expect(oxygenated.shiftPpm).toBeLessThan(70);
    resonances.forEach((resonance) => expect(resonance.multiplicity).toBeNull());
  }, 60_000);

  it("omits an unmatched environment with a warning instead of a number", async () => {
    // Ethyl methyl selenide: the Se-bound CH2 has neither a database match nor an applicable rule.
    const { code, lines } = await run(["--smiles", "CC[Se]C", "--nuclei", "1H"]);
    expect(code).toBe(0);
    const line = lines[0]!;
    expect(line.resonances!.some((resonance) => resonance.atomIndices.includes(1))).toBe(false);
    expect(line.warnings!.some((warning) => warning.startsWith("NMR_NO_FRAGMENT_MATCH"))).toBe(true);
    expect(line.warnings!.some((warning) => warning.startsWith("NMR_PARTIAL_PREDICTION"))).toBe(true);
  }, 60_000);

  it("reports an unparseable SMILES as ok:false naming it", async () => {
    const { code, lines } = await run(["--smiles", "C1CC("]);
    expect(code).toBe(1);
    expect(lines[0]).toMatchObject({ ok: false, smiles: "C1CC(" });
    expect(lines[0]!.error).toContain('"C1CC("');
  });

  it("writes one relabelled stick spectrum per nucleus", async () => {
    const base = join(outputDirectory, "ethanol.svg");
    const { code, lines } = await run(["--smiles", "CCO", "--spectrum", base]);
    expect(code).toBe(0);
    expect(lines[0]!.spectrum).toEqual([join(outputDirectory, "ethanol-1H.svg"), join(outputDirectory, "ethanol-13C.svg")]);
    const svg = await readFile(join(outputDirectory, "ethanol-1H.svg"), "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/synthetic/i);
    expect(svg).toContain("not integration");
  }, 60_000);

  it("runs a batch with a PNG spectrum directory", async () => {
    const jobsFile = join(outputDirectory, "jobs.json");
    await writeFile(jobsFile, JSON.stringify([
      { name: "ethanol", smiles: "CCO" },
      { name: "broken", smiles: "C1CC(" }
    ]));
    const spectrumDir = join(outputDirectory, "spectra");
    const { code, lines } = await run([
      "--batch", jobsFile, "--nuclei", "13C", "--spectrum-dir", spectrumDir, "--spectrum-format", "png"
    ]);
    expect(code).toBe(1);
    expect(lines.map((line) => [line.name, line.ok])).toEqual([["ethanol", true], ["broken", false]]);
    const png = await readFile(join(spectrumDir, "ethanol-13C.png"));
    expect(Array.from(png.subarray(0, 4))).toEqual([137, 80, 78, 71]);
  }, 60_000);
});
