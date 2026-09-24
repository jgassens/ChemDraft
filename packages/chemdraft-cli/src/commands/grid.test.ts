import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { atomLabelHaloWidthPx, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { renderGrid, runGridCommand } from "./grid";

vi.setConfig({ testTimeout: 60_000 });

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
  it("preserves safe-build E/Z warnings and dashed dative bonds", async () => {
    const capture = memoryIo();
    const rendered = await renderGrid([
      { name: "unspecified-alkene", smiles: "CC=CC" },
      { name: "platinum-complex", smiles: "N->[Pt+2](<-N)(Cl)Cl" }
    ], {
      columns: 2,
      labels: "letters",
      width: 600,
      gutter: 32,
      padding: 24,
      background: "white"
    }, capture.io);

    expect(rendered.warnings).toContain(
      "E/Z unspecified for 1 double bond(s); the 2D drawing necessarily shows one geometry"
    );
    expect(rendered.svg.match(/stroke-dasharray=/g)).toHaveLength(2);
  });

  it("keeps a charged outer atom label disjoint from its neighbouring letter label", async () => {
    const capture = memoryIo();
    const rendered = await renderGrid([
      { name: "ammonium", smiles: "[NH4+]" },
      { name: "chloride", smiles: "[Cl-]" }
    ], {
      columns: 2,
      labels: "letters",
      width: 600,
      gutter: 0,
      padding: 0,
      background: "transparent"
    }, capture.io);

    const objects = rendered.document.pages[0]!.objects;
    const firstMolecule = objects.find((object) => object.type === "molecule");
    const firstLetter = objects.find((object) => object.type === "text" && object.text === "A");
    expect(firstMolecule?.type).toBe("molecule");
    expect(firstLetter?.type).toBe("text");
    if (firstMolecule?.type !== "molecule" || firstLetter?.type !== "text") return;

    for (const label of planMoleculeAtomLabels(firstMolecule)) {
      const halo = label.backgroundVisible ? atomLabelHaloWidthPx(label.drawingStyle) / 2 : 0;
      const atomBox = {
        minX: label.anchor.x + label.layout.bounds.x - halo,
        minY: label.anchor.y + label.layout.bounds.y - halo,
        maxX: label.anchor.x + label.layout.bounds.x + label.layout.bounds.width + halo,
        maxY: label.anchor.y + label.layout.bounds.y + label.layout.bounds.height + halo
      };
      const boxesOverlap = atomBox.minX < firstLetter.x + firstLetter.width &&
        atomBox.maxX > firstLetter.x &&
        atomBox.minY < firstLetter.y + firstLetter.height &&
        atomBox.maxY > firstLetter.y;
      expect(boxesOverlap, label.label).toBe(false);
    }
  });

  it("keeps charged atom-label boxes in every outer cell inside a zero-padding viewBox", async () => {
    const capture = memoryIo();
    const rendered = await renderGrid([
      { name: "carboxylate", smiles: "NCC(=O)[O-]" },
      { name: "diammonium", smiles: "[NH3+]CCCCCCCCC[NH3+]" }
    ], {
      columns: 2,
      labels: "none",
      width: 600,
      gutter: 0,
      padding: 0,
      background: "transparent"
    }, capture.io);

    const maxX = rendered.viewBox.x + rendered.viewBox.width;
    const maxY = rendered.viewBox.y + rendered.viewBox.height;
    const molecules = rendered.document.pages[0]!.objects.filter((object) => object.type === "molecule");
    expect(molecules).toHaveLength(2);
    expect(rendered.svg).toContain("NH3+");
    expect(rendered.svg).toContain('data-atom-label="O-"');
    for (const molecule of molecules) {
      for (const label of planMoleculeAtomLabels(molecule)) {
        const halo = label.backgroundVisible ? atomLabelHaloWidthPx(label.drawingStyle) / 2 : 0;
        const minX = label.anchor.x + label.layout.bounds.x - halo;
        const minY = label.anchor.y + label.layout.bounds.y - halo;
        expect(minX, label.label).toBeGreaterThanOrEqual(rendered.viewBox.x - 0.001);
        expect(minY, label.label).toBeGreaterThanOrEqual(rendered.viewBox.y - 0.001);
        expect(minX + label.layout.bounds.width + halo * 2, label.label).toBeLessThanOrEqual(maxX + 0.001);
        expect(minY + label.layout.bounds.height + halo * 2, label.label).toBeLessThanOrEqual(maxY + 0.001);
      }
    }
  });

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
    expect(svg).toContain('fill="#ffffff"');
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

  it("attributes a grid failure to the quoted failing SMILES, not a short SMILES it contains", async () => {
    // Methane's "C" occurs inside the error text ("OpenChemLib"), so an unquoted substring match
    // would blame methane for the bad entry.
    const jobs = await writeJobs("methane-bad.json", [
      { name: "methane", smiles: "C" },
      { name: "bad", smiles: "not-smiles" }
    ]);
    const out = join(outputDirectory, "methane-bad.png");
    const capture = memoryIo();

    await expect(runGridCommand(["--batch", jobs, "--out", out], capture.io)).resolves.toBe(1);

    const result = JSON.parse(capture.stdout[0] ?? "{}") as { ok: boolean; smiles?: string; error?: string };
    expect(result.ok).toBe(false);
    expect(result.smiles).toBe("not-smiles");
    expect(result.error).toContain('"not-smiles"');
  }, 60_000);

  it("rejects an oversized --width as a usage error before reading or rendering jobs", async () => {
    const capture = memoryIo();
    const out = join(outputDirectory, "too-wide.png");
    await expect(runGridCommand([
      "--batch", join(outputDirectory, "does-not-exist.json"),
      "--out", out,
      "--width", "5000"
    ], capture.io)).resolves.toBe(2);

    expect(capture.stdout).toHaveLength(0);
    expect(capture.stderr.join("\n")).toContain("--width must be between 16 and 4000 pixels");
    expect(capture.stderr.join("\n")).not.toContain("Could not read batch file");
  });
});
