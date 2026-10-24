import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openChemDraftPayload, readCdxmlDocumentStyle } from "@chemdraft/cdx-compat";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { CDXML_STYLE_REFERENCE_ENV, resolveDefaultCdxmlStylePath, runExportCommand } from "./export";

vi.setConfig({ testTimeout: 60_000 });

const CAFFEINE = "CN1C=NC2=C1C(=O)N(C(=O)N2C)C";
const L_ALANINE = "C[C@H](N)C(=O)O";

/** Synthetic document-style reference: 14.4 pt bonds and 10 pt Helvetica labels. */
const REFERENCE = [
  '<?xml version="1.0" encoding="UTF-8" ?>',
  '<CDXML CreationProgram="Reference" LabelFont="21" LabelSize="10" LabelFace="96" HashSpacing="2.83"',
  ' MarginWidth="1" LineWidth="0.90" BoldWidth="2" BondLength="14.40" BondSpacing="14" ChainAngle="120">',
  '<fonttable><font id="21" charset="x-mac-roman" name="Helvetica"/></fonttable>',
  '<page id="1"/>',
  "</CDXML>"
].join("\n");

let directory: string;
let reference: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chemdraft-export-style-"));
  reference = join(directory, "reference.cdxml");
  await writeFile(reference, REFERENCE);
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(directory, { recursive: true, force: true });
});

/** Run export with an explicit environment and default style path, never the machine's own. */
function run(argv: string[], io: ReturnType<typeof collectIo>, env: NodeJS.ProcessEnv = {}, defaultStylePath: string | null = null) {
  return runExportCommand(argv, io, env, defaultStylePath);
}

function collectIo() {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (line: string) => stdoutLines.push(line),
    stderr: (line: string) => stderrLines.push(line)
  };
}

/** Visible-layer bond lengths in points, read straight from the CDXML a reader would draw. CDXML
 *  coordinates carry four decimals, so lengths match the target to about 0.001 pt. */
function visibleBondLengths(contents: string): number[] {
  const points = new Map<string, [number, number]>();
  for (const match of contents.matchAll(/<n id="(\d+)" p="([-\d.]+) ([-\d.]+)"/g)) {
    points.set(match[1]!, [Number(match[2]), Number(match[3])]);
  }
  return [...contents.matchAll(/<b id="\d+" B="(\d+)" E="(\d+)"/g)].map((match) => {
    const [x1, y1] = points.get(match[1]!)!;
    const [x2, y2] = points.get(match[2]!)!;
    return Math.hypot(x2 - x1, y2 - y1);
  });
}

function reopenedMolecule(contents: string): MoleculeObject {
  const opened = openChemDraftPayload(contents);
  expect(opened.source).toBe("native-payload");
  expect(opened.conflict).toBeUndefined();
  return opened.document!.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
}

describe("chemdraft export --style-reference", () => {
  it("draws CDXML at the reference's bond length and declares its settings", async () => {
    const out = join(directory, "caffeine.cdxml");
    const io = collectIo();
    expect(await run(["--smiles", CAFFEINE, "--out", out, "--style-reference", reference], io, {})).toBe(0);

    const contents = await readFile(out, "utf8");
    for (const length of visibleBondLengths(contents)) expect(length).toBeCloseTo(14.4, 2);
    expect(readCdxmlDocumentStyle(contents).style).toMatchObject({
      bondLengthPt: 14.4, labelSizePt: 10, labelFontName: "Helvetica", lineWidthPt: 0.9, boldWidthPt: 2
    });

    const molecule = reopenedMolecule(contents);
    expect(molecule.atoms).toHaveLength(14);
    expect(molecule.bonds).toHaveLength(15);
    expect(molecule.style).toMatchObject({ bondLengthPx: 19.2, atomLabelFontSizePx: 13.3333, bondStrokeWidthPx: 1.2 });
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({ ok: true, format: "cdxml", styleReference: reference, warnings: [] });
  });

  it("keeps stereochemistry: the identity check still runs on the styled file", async () => {
    const out = join(directory, "l-alanine.cdxml");
    const io = collectIo();
    expect(await run(["--smiles", L_ALANINE, "--out", out, "--style-reference", reference], io, {})).toBe(0);
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({ ok: true, smiles: L_ALANINE });
    for (const length of visibleBondLengths(await readFile(out, "utf8"))) expect(length).toBeCloseTo(14.4, 2);
  });

  it("styles every structure in a CDXML batch", async () => {
    const jobs = join(directory, "jobs.json");
    const outDir = join(directory, "batch");
    await writeFile(jobs, JSON.stringify([{ name: "caffeine", smiles: CAFFEINE }, { name: "ethanol", smiles: "CCO" }]));
    const io = collectIo();
    expect(await run(
      ["--batch", jobs, "--out-dir", outDir, "--format", "cdxml", "--style-reference", reference], io, {}
    )).toBe(0);
    for (const name of ["caffeine", "ethanol"]) {
      const contents = await readFile(join(outDir, `${name}.cdxml`), "utf8");
      expect(contents).toContain('BondLength="14.4"');
      for (const length of visibleBondLengths(contents)) expect(length).toBeCloseTo(14.4, 2);
    }
  });

  it(`uses ${CDXML_STYLE_REFERENCE_ENV} as the default reference`, async () => {
    const out = join(directory, "from-env.cdxml");
    const io = collectIo();
    expect(await run(["--smiles", "CCO", "--out", out], io, { [CDXML_STYLE_REFERENCE_ENV]: reference })).toBe(0);
    expect(await readFile(out, "utf8")).toContain('BondLength="14.4"');
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({ ok: true, styleReference: reference });
  });

  it("lets --style-reference override the environment default", async () => {
    const other = join(directory, "other.cdxml");
    await writeFile(other, REFERENCE.replace('BondLength="14.40"', 'BondLength="20"'));
    const out = join(directory, "override.cdxml");
    expect(await run(
      ["--smiles", "CCO", "--out", out, "--style-reference", other], collectIo(), { [CDXML_STYLE_REFERENCE_ENV]: reference }
    )).toBe(0);
    for (const length of visibleBondLengths(await readFile(out, "utf8"))) expect(length).toBeCloseTo(20, 2);
  });

  it("ignores the environment default for formats other than CDXML", async () => {
    const out = join(directory, "plain.mol");
    const io = collectIo();
    expect(await run(["--smiles", "CCO", "--out", out], io, { [CDXML_STYLE_REFERENCE_ENV]: join(directory, "missing.cdxml") })).toBe(0);
    expect(JSON.parse(io.stdoutLines[0]!)).not.toHaveProperty("styleReference");
  });

  it("leaves CDXML exports unstyled when no reference is configured", async () => {
    const out = join(directory, "unstyled.cdxml");
    expect(await run(["--smiles", "CCO", "--out", out], collectIo(), {})).toBe(0);
    expect(await readFile(out, "utf8")).toContain('<CDXML CreationProgram="ChemDraft">');
  });

  it("warns about structure settings the reference leaves unset", async () => {
    const partial = join(directory, "partial.cdxml");
    await writeFile(partial, '<?xml version="1.0"?><CDXML BondLength="14.4"><page id="1"/></CDXML>');
    const io = collectIo();
    expect(await run(["--smiles", "CCO", "--out", join(directory, "partial-out.cdxml"), "--style-reference", partial], io, {})).toBe(0);
    const [warning] = (JSON.parse(io.stdoutLines[0]!) as { warnings: string[] }).warnings;
    expect(warning).toContain("sets no LineWidth, BoldWidth");
    expect(warning).toContain("ChemDraft's own values were kept");
  });

  it("refuses --style-reference with a format other than CDXML", async () => {
    const io = collectIo();
    expect(await run(["--smiles", "CCO", "--out", join(directory, "x.pdf"), "--style-reference", reference], io, {})).toBe(2);
    expect(io.stderrLines.join("\n")).toContain("--style-reference applies only to CDXML exports, not --format pdf");
  });

  it.each([
    ["a missing file", () => join(directory, "nope.cdxml"), "ENOENT"],
    ["a directory", () => directory, "it is not a file"]
  ])("fails the run with exit 2 for %s", async (_name, path, reason) => {
    const io = collectIo();
    const out = join(directory, "never.cdxml");
    expect(await run(["--smiles", "CCO", "--out", out, "--style-reference", path()], io, {})).toBe(2);
    expect(io.stderrLines.join("\n")).toContain(reason);
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the environment variable when its reference is unusable", async () => {
    const broken = join(directory, "broken.cdxml");
    await writeFile(broken, '<?xml version="1.0"?><CDXML BondLength="0"/>');
    const io = collectIo();
    expect(await run(["--smiles", "CCO", "--out", join(directory, "never2.cdxml")], io, { [CDXML_STYLE_REFERENCE_ENV]: broken })).toBe(2);
    const message = io.stderrLines.join("\n");
    expect(message).toContain(CDXML_STYLE_REFERENCE_ENV);
    expect(message).toContain('BondLength="0" is not a usable value');
  });

  describe("the per-user default style file", () => {
    it("is cdxml-style.cdxml in the account's ChemDraft settings folder", () => {
      expect(resolveDefaultCdxmlStylePath(() => ({ homedir: "/home/chemist" })))
        .toBe(join("/home/chemist", ".config", "chemdraft", "cdxml-style.cdxml"));
      expect(resolveDefaultCdxmlStylePath(() => ({ homedir: "" }))).toBeUndefined();
      expect(resolveDefaultCdxmlStylePath(() => { throw new Error("no account"); })).toBeUndefined();
    });

    it("styles CDXML exports when it exists", async () => {
      const out = join(directory, "default-file.cdxml");
      const io = collectIo();
      expect(await run(["--smiles", "CCO", "--out", out], io, {}, reference)).toBe(0);
      expect(await readFile(out, "utf8")).toContain('BondLength="14.4"');
      expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({ ok: true, styleReference: reference });
    });

    it("leaves exports unstyled when it does not exist", async () => {
      const out = join(directory, "no-default-file.cdxml");
      const io = collectIo();
      expect(await run(["--smiles", "CCO", "--out", out], io, {}, join(directory, "absent", "cdxml-style.cdxml"))).toBe(0);
      expect(await readFile(out, "utf8")).toContain('<CDXML CreationProgram="ChemDraft">');
      expect(JSON.parse(io.stdoutLines[0]!)).not.toHaveProperty("styleReference");
    });

    it(`gives way to ${CDXML_STYLE_REFERENCE_ENV} and to --style-reference`, async () => {
      const other = join(directory, "other-default.cdxml");
      await writeFile(other, REFERENCE.replace('BondLength="14.40"', 'BondLength="20"'));
      const fromEnv = join(directory, "env-over-default.cdxml");
      expect(await run(["--smiles", "CCO", "--out", fromEnv], collectIo(), { [CDXML_STYLE_REFERENCE_ENV]: other }, reference)).toBe(0);
      expect(await readFile(fromEnv, "utf8")).toContain('BondLength="20"');
      const fromFlag = join(directory, "flag-over-default.cdxml");
      expect(await run(["--smiles", "CCO", "--out", fromFlag, "--style-reference", other], collectIo(), {}, reference)).toBe(0);
      expect(await readFile(fromFlag, "utf8")).toContain('BondLength="20"');
    });

    it("is ignored by formats other than CDXML", async () => {
      const io = collectIo();
      expect(await run(["--smiles", "CCO", "--out", join(directory, "default.mol")], io, {}, reference)).toBe(0);
      expect(JSON.parse(io.stdoutLines[0]!)).not.toHaveProperty("styleReference");
    });

    it("fails the run with exit 2, naming it, when it is unusable", async () => {
      const broken = join(directory, "broken-default.cdxml");
      await writeFile(broken, '<?xml version="1.0"?><CDXML LineWidth="-1"/>');
      const io = collectIo();
      expect(await run(["--smiles", "CCO", "--out", join(directory, "never3.cdxml")], io, {}, broken)).toBe(2);
      expect(io.stderrLines.join("\n")).toContain("(default style file) cannot be used");
    });
  });
});
