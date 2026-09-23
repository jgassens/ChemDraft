import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { atomLabelHaloWidthPx, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import {
  generateSmiles2DMolfile,
  resetRdkitForTesting,
  setRdkitModuleLoader
} from "@chemdraft/rdkit-adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";

import { stereoPerceptionMolfile } from "../../../../apps/desktop/src/documentWorkflow";
import { renderSmilesToAssets, type RenderedSmiles } from "../document";
import { runRenderCommand as runCli } from "./render";

interface DecodedPng {
  width: number;
  height: number;
  pixels: Uint8Array;
}

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-render-cli-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

function u32(buffer: Uint8Array, offset: number): number {
  return ((buffer[offset] ?? 0) << 24) |
    ((buffer[offset + 1] ?? 0) << 16) |
    ((buffer[offset + 2] ?? 0) << 8) |
    (buffer[offset + 3] ?? 0);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(png: Uint8Array): DecodedPng {
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = u32(png, offset) >>> 0;
    const type = Buffer.from(png.slice(offset + 4, offset + 8)).toString("ascii");
    const data = png.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = u32(data, 0) >>> 0;
      height = u32(data, 4) >>> 0;
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += length + 12;
    if (type === "IEND") break;
  }

  const compressed = Buffer.concat(idat.map((chunk) => Buffer.from(chunk)));
  const filtered = inflateSync(compressed);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[source++] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[source++] ?? 0;
      const target = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[target - bytesPerPixel]! : 0;
      const above = y > 0 ? pixels[target - stride]! : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[target - stride - bytesPerPixel]! : 0;
      const predictor = filter === 1
        ? left
        : filter === 2
          ? above
          : filter === 3
            ? Math.floor((left + above) / 2)
            : filter === 4
              ? paeth(left, above, upperLeft)
              : 0;
      pixels[target] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  const offset = (y * png.width + x) * 4;
  return [
    png.pixels[offset]!,
    png.pixels[offset + 1]!,
    png.pixels[offset + 2]!,
    png.pixels[offset + 3]!
  ];
}

function expectWhiteEdges(png: DecodedPng): void {
  for (let x = 0; x < png.width; x += 1) {
    expect(pixelAt(png, x, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(png, x, png.height - 1)).toEqual([255, 255, 255, 255]);
  }
  for (let y = 0; y < png.height; y += 1) {
    expect(pixelAt(png, 0, y)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(png, png.width - 1, y)).toEqual([255, 255, 255, 255]);
  }
}

function expectInkNearAtomLabel(rendered: RenderedSmiles, png: DecodedPng, label: string): void {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = rendered.svg.match(new RegExp(`<g(?=[^>]*data-atom-label="${escapedLabel}")[^>]*>`))?.[0];
  const position = tag?.match(/transform="translate\(([-\d.]+) ([-\d.]+)\)/);
  expect(position, `expected a positioned SVG atom-label group for ${label}`).not.toBeNull();
  const pageX = Number(position?.[1]);
  const pageY = Number(position?.[2]);
  const centerX = Math.round((pageX - rendered.viewBox.x) / rendered.viewBox.width * png.width);
  const centerY = Math.round((pageY - rendered.viewBox.y) / rendered.viewBox.height * png.height);
  const radius = Math.max(8, Math.round(12 / rendered.viewBox.width * png.width));
  let foundInk = false;
  for (let y = Math.max(0, centerY - radius); y <= Math.min(png.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(png.width - 1, centerX + radius); x += 1) {
      const [red, green, blue, alpha] = pixelAt(png, x, y);
      if (alpha > 0 && Math.min(red, green, blue) < 128) foundInk = true;
    }
  }
  expect(foundInk, `expected raster ink around the ${label} atom label`).toBe(true);
}

function expectSvgLabelExtentsInsideViewBox(rendered: RenderedSmiles): void {
  const maxX = rendered.viewBox.x + rendered.viewBox.width;
  const maxY = rendered.viewBox.y + rendered.viewBox.height;
  const labels = planMoleculeAtomLabels(rendered.molecule);
  expect(labels.length).toBeGreaterThan(0);
  expect((rendered.svg.match(/<text\b/g) ?? []).length).toBeGreaterThan(0);
  for (const label of labels) {
    const halo = label.backgroundVisible ? atomLabelHaloWidthPx(label.drawingStyle) / 2 : 0;
    const minX = label.anchor.x + label.layout.bounds.x - halo;
    const minY = label.anchor.y + label.layout.bounds.y - halo;
    expect(minX, label.label).toBeGreaterThanOrEqual(rendered.viewBox.x - 0.001);
    expect(minX + label.layout.bounds.width + halo * 2, label.label).toBeLessThanOrEqual(maxX + 0.001);
    expect(minY, label.label).toBeGreaterThanOrEqual(rendered.viewBox.y - 0.001);
    expect(minY + label.layout.bounds.height + halo * 2, label.label).toBeLessThanOrEqual(maxY + 0.001);
  }
  // These fixtures deliberately contain text-only atom labels. If a future renderer emits paths
  // for them, the test must gain equivalent path bounds rather than silently stop checking them.
  expect(rendered.svg).not.toContain("<path");
}

describe("headless ChemDraft rendering", () => {
  const cases = [
    { name: "ethanol", smiles: "CCO", label: "OH" },
    { name: "benzene", smiles: "c1ccccc1" },
    { name: "aspirin", smiles: "CC(=O)Oc1ccccc1C(=O)O", label: "O" },
    { name: "alanine", smiles: "C[C@H](N)C(=O)O", label: "NH2" },
    { name: "tetramethylammonium", smiles: "C[N+](C)(C)C", label: "N+" }
  ] as const;

  for (const fixture of cases) {
    it(`renders ${fixture.name} to cropped SVG and a 600 px PNG`, async () => {
      const rendered = await renderSmilesToAssets(fixture.smiles, { name: fixture.name });
      expect(rendered.svg).toMatch(/^<svg /);
      expect(rendered.svg).toContain(`data-atom-count="${rendered.molecule.atoms.length}"`);
      if ("label" in fixture) expect(rendered.svg).toContain(`data-atom-label="${fixture.label}`);
      const png = decodePng(rendered.png);
      expect(png.width).toBe(600);
      expect(png.height).toBeGreaterThan(0);
    });
  }

  it("preserves tetrahedral stereo as a wedge/hash and reports one stereocenter", async () => {
    const rendered = await renderSmilesToAssets("C[C@H](N)C(=O)O", { name: "alanine" });
    expect(rendered.stereoCenters).toBe(1);
    expect(rendered.unspecifiedStereoCenters).toBe(0);
    expect(rendered.molecule.bonds.some((bond) =>
      bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"
    )).toBe(true);
    expect(rendered.svg).toMatch(/data-bond-style="(?:wedge|hashed)"/);
  });

  it("reports specified and unspecified constitutional stereocenters separately", async () => {
    const specified = await renderSmilesToAssets("C[C@H](N)C(=O)O");
    const unspecified = await renderSmilesToAssets("CC(N)C(=O)O");
    expect([specified.stereoCenters, specified.unspecifiedStereoCenters]).toEqual([1, 0]);
    expect([unspecified.stereoCenters, unspecified.unspecifiedStereoCenters]).toEqual([0, 1]);
  });

  it.each([
    "C[C@H](N)C(=O)O",
    "C[C@@H](N)C(=O)O",
    "C[C@H](O)[C@H](N)C(=O)O"
  ])("reads rendered chirality back with the same R/S descriptors for %s", async (smiles) => {
    const rendered = await renderSmilesToAssets(smiles);
    const sourceMolfile = await generateSmiles2DMolfile(smiles);
    const expected = perceiveStereoCentersFromMolfile(sourceMolfile)
      .map((center, atomIndex) => ({ atomIndex, ...center }))
      .filter((center) => center.isStereoCenter);
    const actual = perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(rendered.molecule))
      .map((center, atomIndex) => ({ atomIndex, ...center }))
      .filter((center) => center.isStereoCenter);
    expect(actual).toEqual(expected);
    expect(actual.every((center) => center.descriptor !== "unspecified")).toBe(true);
  });

  it.each([
    "C[C@H](N)C(=O)O",
    "C[C@@H](N)C(=O)O"
  ])("keeps the canonical isomeric SMILES after document export for %s", async (smiles) => {
    const rendered = await renderSmilesToAssets(smiles);
    const exportedMolfile = moleculeToMolfileV2000(rendered.molecule, { fromDocFrame: true });
    const [source, exported] = await Promise.all([
      computeStructureIdentifiers(smiles),
      computeStructureIdentifiers(exportedMolfile)
    ]);
    expect(exported?.smiles).toBe(source?.smiles);
  });

  it("does not collapse aromatic benzene to all-single bonds", async () => {
    const rendered = await renderSmilesToAssets("c1ccccc1", { name: "benzene" });
    expect(rendered.molecule.bonds.some((bond) =>
      bond.order === "aromatic" || bond.order === "double"
    )).toBe(true);
    expect(rendered.molecule.bonds.every((bond) => bond.order === "single")).toBe(false);
  });

  it("crops to planned molecule/label bounds and keeps labels away from white PNG edges", async () => {
    const rendered = await renderSmilesToAssets("CCO", { name: "ethanol", padding: 24 });
    expect(rendered.viewBox.width).toBeLessThan(200);
    expect(rendered.viewBox.height).toBeLessThan(150);
    expect(rendered.svg).not.toContain('viewBox="0 0 816 1056"');
    const png = decodePng(rendered.png);
    expectWhiteEdges(png);
    expectInkNearAtomLabel(rendered, png, "OH");
  });

  it.each(["NCC(=O)[O-]", "[NH2-]CC=O"])(
    "keeps every SVG text/path extent inside a zero-padding viewBox for %s",
    async (smiles) => {
      const rendered = await renderSmilesToAssets(smiles, { padding: 0 });
      expectSvgLabelExtentsInsideViewBox(rendered);
    }
  );

  it("fails loudly instead of dropping radical or isotope labels", async () => {
    const jobsPath = join(outputDirectory, "unsupported-labels.json");
    await writeFile(jobsPath, JSON.stringify([
      { name: "radical", smiles: "[CH3]" },
      { name: "carbon-13", smiles: "C[13CH2]O" },
      { name: "deuterium", smiles: "[2H]C(Cl)(Br)F" },
      { name: "ethanol", smiles: "CCO" }
    ]));
    const stdout: string[] = [];
    const code = await runCli(
      ["--batch", jobsPath, "--out-dir", join(outputDirectory, "unsupported-label-output")],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );
    const results = stdout.map((line) => JSON.parse(line) as {
      smiles: string;
      ok: boolean;
      error?: string;
    });
    expect(code).toBe(1);
    expect(results.map(({ smiles, ok }) => ({ smiles, ok }))).toEqual([
      { smiles: "[CH3]", ok: false },
      { smiles: "C[13CH2]O", ok: false },
      { smiles: "[2H]C(Cl)(Br)F", ok: false },
      { smiles: "CCO", ok: true }
    ]);
    for (const result of results.slice(0, 3)) {
      expect(result.error).toBe(
        `SMILES contains a radical/isotope label that ChemDraft cannot yet draw: ${result.smiles}`
      );
    }
  });

  it("reports an unparseable SMILES without a stack trace and exits 1", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["--smiles", "not-a-smiles", "--out", join(outputDirectory, "bad.svg")],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );
    expect(code).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ smiles: "not-a-smiles", ok: false });
    expect(JSON.parse(stdout[0]!).error).toContain("not-a-smiles");
    expect(stdout[0]).not.toContain(" at ");
    expect(stderr.join("\n")).toContain("Failed");
  });

  it("writes both formats from a base path and honors --width", async () => {
    const base = join(outputDirectory, "aspirin-both");
    const stdout: string[] = [];
    const code = await runCli(
      [
        "--smiles", "CC(=O)Oc1ccccc1C(=O)O",
        "--out", base,
        "--format", "both",
        "--width", "420"
      ],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      name: "aspirin-both",
      ok: true,
      files: [`${base}.svg`, `${base}.png`]
    });
    expect(await readFile(`${base}.svg`, "utf8")).toContain("data-atom-label=\"O\"");
    expect(decodePng(await readFile(`${base}.png`)).width).toBe(420);
  });

  it("continues a batch after a bad SMILES and exits 1", async () => {
    const jobsPath = join(outputDirectory, "mixed-jobs.json");
    const outDir = join(outputDirectory, "mixed-output");
    await writeFile(jobsPath, JSON.stringify([
      { name: "ethanol", smiles: "CCO" },
      { name: "bad", smiles: "not-a-smiles" },
      { name: "benzene", smiles: "c1ccccc1" }
    ]));
    const stdout: string[] = [];
    const code = await runCli(
      ["--batch", jobsPath, "--out-dir", outDir, "--format", "svg"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );
    expect(code).toBe(1);
    expect(stdout.map((line) => JSON.parse(line).ok)).toEqual([true, false, true]);
    expect(await readFile(join(outDir, "ethanol.svg"), "utf8")).toContain("<svg");
    expect(await readFile(join(outDir, "benzene.svg"), "utf8")).toContain("<svg");
  });

  it.each(["../x", "/tmp/x"])("rejects the path-like batch name %s", async (name) => {
    const jobsPath = join(outputDirectory, `invalid-${name.includes("tmp") ? "absolute" : "relative"}.json`);
    await writeFile(jobsPath, JSON.stringify([{ name, smiles: "CCO" }]));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["--batch", jobsPath, "--out-dir", join(outputDirectory, "rejected")],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }
    );
    expect(code).toBe(2);
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("Invalid batch name");
  });

  it("trims batch names and rejects a duplicate after trimming", async () => {
    const jobsPath = join(outputDirectory, "duplicate-jobs.json");
    await writeFile(jobsPath, JSON.stringify([
      { name: "ethanol", smiles: "CCO" },
      { name: "  ethanol  ", smiles: "CCO" }
    ]));
    const stderr: string[] = [];
    const code = await runCli(
      ["--batch", jobsPath, "--out-dir", join(outputDirectory, "duplicate-output")],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) }
    );
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain('Duplicate batch name "ethanol"');
  });

  it("rejects a whitespace-only batch name", async () => {
    const jobsPath = join(outputDirectory, "blank-name-jobs.json");
    await writeFile(jobsPath, JSON.stringify([{ name: "   ", smiles: "CCO" }]));
    const stderr: string[] = [];
    const code = await runCli(
      ["--batch", jobsPath, "--out-dir", join(outputDirectory, "blank-output")],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) }
    );
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("Invalid batch name");
  });

  it.each([
    ["an unknown flag", ["--smiles", "CCO", "--out", "ethanol.png", "--wat"]],
    ["--out without an extension", ["--smiles", "CCO", "--out", "ethanol"]]
  ] as const)("exits 2 for %s", async (_label, argv) => {
    expect(await runCli(argv, { stdout: () => undefined, stderr: () => undefined })).toBe(2);
  });

  it("uses the OCL fallback when the RDKit loader fails", async () => {
    // Prime the renderer's normal Node loader so this test remains independent when selected with
    // `-t`; the injected failing loader must be the one used by the subsequent render.
    await renderSmilesToAssets("C", { name: "loader-prime" });
    setRdkitModuleLoader(() => Promise.reject(new Error("forced RDKit failure")));
    const rendered = await renderSmilesToAssets("CCO", { name: "fallback" });
    expect(rendered.engine).toBe("ocl");
    expect(decodePng(rendered.png).width).toBe(600);
    expect(rendered.warnings.join("\n")).toContain("forced RDKit failure");
  });

  it("reports a missing RDKit loader as configuration failure instead of using OCL", () => {
    const fixture = fileURLToPath(new URL("./__fixtures__/rdkit-not-configured.ts", import.meta.url));
    const output = join(outputDirectory, "must-not-render.svg");
    const child = spawnSync(process.execPath, ["--import", "tsx", fixture, output], {
      encoding: "utf8"
    });
    expect(child.status, child.stderr).toBe(1);
    const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!);
    expect(result).toMatchObject({ ok: false, smiles: "CCO" });
    expect(result.error).toContain("RDKit module loader not set");
    expect(lines[0]).not.toContain('"engine":"ocl"');
  }, 30_000);
});
