import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openChemDraftPayload, readCdxmlDocumentStyle } from "@chemdraft/cdx-compat";
import { applyPatches, createPageLayout, type MoleculeObject } from "@chemdraft/chem-core";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { buildSmilesDocument, canonicalSmiles } from "../document";
import { CDXML_STYLE_REFERENCE_ENV, loadStyleReference, resolveStyleReference } from "../styleReference";
import { exportPerJobFormat, runExportCommand } from "./export";

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

it("resolves a flag, then an argument, then the explicit environment variable", () => {
  const env = { [CDXML_STYLE_REFERENCE_ENV]: reference };
  expect(resolveStyleReference({ flag: "flag.cdxml", argument: "argument.cdxml", env })).toEqual({
    path: "flag.cdxml", source: "flag"
  });
  expect(resolveStyleReference({ argument: "argument.cdxml", env })).toEqual({
    path: "argument.cdxml", source: "argument"
  });
  expect(resolveStyleReference({ env })).toEqual({ path: reference, source: "environment" });
  expect(resolveStyleReference({ env: { [CDXML_STYLE_REFERENCE_ENV]: " " } })).toBeUndefined();
});

describe("chemdraft export --style-reference", () => {
  it("draws CDXML at the reference's bond length and declares its settings", async () => {
    const out = join(directory, "caffeine.cdxml");
    const io = collectIo();
    expect(await runExportCommand(["--smiles", CAFFEINE, "--out", out, "--style-reference", reference], io, {})).toBe(0);

    const contents = await readFile(out, "utf8");
    for (const length of visibleBondLengths(contents)) expect(length).toBeCloseTo(14.4, 2);
    expect(readCdxmlDocumentStyle(contents).style).toMatchObject({
      bondLengthPt: 14.4, labelSizePt: 10, labelFontName: "Helvetica", lineWidthPt: 0.9, boldWidthPt: 2
    });

    const molecule = reopenedMolecule(contents);
    expect(molecule.atoms).toHaveLength(14);
    expect(molecule.bonds).toHaveLength(15);
    expect(molecule.style).toMatchObject({ bondLengthPx: 19.2, atomLabelFontSizePx: 13.3333, bondStrokeWidthPx: 1.2 });
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({
      ok: true, format: "cdxml", styleReference: { path: reference, source: "flag" }, warnings: []
    });
  });

  it("keeps stereochemistry: the identity check still runs on the styled file", async () => {
    const out = join(directory, "l-alanine.cdxml");
    const io = collectIo();
    expect(await runExportCommand(["--smiles", L_ALANINE, "--out", out, "--style-reference", reference], io, {})).toBe(0);
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({ ok: true, smiles: L_ALANINE });
    for (const length of visibleBondLengths(await readFile(out, "utf8"))) expect(length).toBeCloseTo(14.4, 2);
  });

  it("styles every structure in a CDXML batch", async () => {
    const jobs = join(directory, "jobs.json");
    const outDir = join(directory, "batch");
    await writeFile(jobs, JSON.stringify([{ name: "caffeine", smiles: CAFFEINE }, { name: "ethanol", smiles: "CCO" }]));
    const io = collectIo();
    expect(await runExportCommand(
      ["--batch", jobs, "--out-dir", outDir, "--format", "cdxml", "--style-reference", reference], io, {}
    )).toBe(0);
    for (const name of ["caffeine", "ethanol"]) {
      const contents = await readFile(join(outDir, `${name}.cdxml`), "utf8");
      expect(contents).toContain('BondLength="14.4"');
      for (const length of visibleBondLengths(contents)) expect(length).toBeCloseTo(14.4, 2);
    }
    expect(io.stdoutLines.map(line => JSON.parse(line).styleReference)).toEqual([
      { path: reference, source: "flag" }, { path: reference, source: "flag" }
    ]);
    expect(io.stderrLines).toContain("Exporting caffeine…");
  });

  it("includes the selected reference in a failed CDXML job record", async () => {
    const io = collectIo();
    const out = join(directory, "invalid-structure.cdxml");
    expect(await runExportCommand(["--smiles", "C1CC", "--out", out, "--style-reference", reference], io)).toBe(1);
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({
      ok: false, styleReference: { path: reference, source: "flag" }
    });
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(`uses and reports the reference named by ${CDXML_STYLE_REFERENCE_ENV}`, async () => {
    const out = join(directory, "from-env.cdxml");
    const io = collectIo();
    vi.stubEnv(CDXML_STYLE_REFERENCE_ENV, reference);
    try {
      expect(await runExportCommand(["--smiles", "CCO", "--out", out], io)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await readFile(out, "utf8")).toContain('BondLength="14.4"');
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({
      ok: true, styleReference: { path: reference, source: "environment" }
    });
  });

  it("lets --style-reference override the reference named in the environment", async () => {
    const other = join(directory, "other.cdxml");
    await writeFile(other, REFERENCE.replace('BondLength="14.40"', 'BondLength="20"'));
    const out = join(directory, "override.cdxml");
    const io = collectIo();
    expect(await runExportCommand(
      ["--smiles", "CCO", "--out", out, "--style-reference", other],
      io, { env: { [CDXML_STYLE_REFERENCE_ENV]: reference } }
    )).toBe(0);
    expect(JSON.parse(io.stdoutLines[0]!).styleReference).toEqual({ path: other, source: "flag" });
    for (const length of visibleBondLengths(await readFile(out, "utf8"))) expect(length).toBeCloseTo(20, 2);
  });

  it("ignores the environment reference for formats other than CDXML", async () => {
    const out = join(directory, "plain.mol");
    const io = collectIo();
    expect(await runExportCommand(["--smiles", "CCO", "--out", out], io, {
      env: { [CDXML_STYLE_REFERENCE_ENV]: join(directory, "missing.cdxml") }
    })).toBe(0);
    expect(JSON.parse(io.stdoutLines[0]!)).not.toHaveProperty("styleReference");
  });

  it("omits the report and uses the built-in style even when a file exists in the home config directory", async () => {
    const out = join(directory, "unstyled.cdxml");
    const home = join(directory, "home");
    const config = join(home, ".config", "chemdraft");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "cdxml-style.cdxml"), REFERENCE);
    const io = collectIo();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv(CDXML_STYLE_REFERENCE_ENV, undefined);
    try {
      expect(await runExportCommand(["--smiles", "CCO", "--out", out], io)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(JSON.parse(io.stdoutLines[0]!)).not.toHaveProperty("styleReference");
    // The root keeps only what an unstyled export always writes (the visible-hash version and the
    // page setup); no style attribute and no font table appear.
    const contents = await readFile(out, "utf8");
    expect(contents).toMatch(/<CDXML CreationProgram="ChemDraft"[^>]*>/);
    expect(contents).not.toMatch(/<CDXML [^>]*(?:LabelFont|LabelSize|BondLength|LineWidth)=/);
  });

  it("warns about structure settings the reference leaves unset", async () => {
    const partial = join(directory, "partial.cdxml");
    await writeFile(partial, '<?xml version="1.0"?><CDXML BondLength="14.4"><page id="1"/></CDXML>');
    const io = collectIo();
    expect(await runExportCommand(["--smiles", "CCO", "--out", join(directory, "partial-out.cdxml"), "--style-reference", partial], io, {})).toBe(0);
    const [warning] = (JSON.parse(io.stdoutLines[0]!) as { warnings: string[] }).warnings;
    expect(warning).toContain("sets no LineWidth, BoldWidth");
    expect(warning).toContain("ChemDraft's own values were kept");
  });

  it("refuses --style-reference with a format other than CDXML", async () => {
    const io = collectIo();
    expect(await runExportCommand(["--smiles", "CCO", "--out", join(directory, "x.pdf"), "--style-reference", reference], io, {})).toBe(2);
    expect(io.stderrLines.join("\n")).toContain("--style-reference applies only to CDXML exports, not --format pdf");
  });

  it.each([
    ["a missing file", () => join(directory, "nope.cdxml"), "ENOENT"],
    ["a directory", () => directory, "it is not a regular file"]
  ])("fails the run with exit 2 for %s", async (_name, path, reason) => {
    const io = collectIo();
    const out = join(directory, "never.cdxml");
    expect(await runExportCommand(["--smiles", "CCO", "--out", out, "--style-reference", path()], io, {})).toBe(2);
    expect(io.stderrLines.join("\n")).toContain(reason);
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the environment variable when its reference is unusable", async () => {
    const broken = join(directory, "broken.cdxml");
    await writeFile(broken, '<?xml version="1.0"?><CDXML BondLength="0"/>');
    const io = collectIo();
    expect(await runExportCommand(["--smiles", "CCO", "--out", join(directory, "never2.cdxml")], io, {
      env: { [CDXML_STYLE_REFERENCE_ENV]: broken }
    })).toBe(2);
    const message = io.stderrLines.join("\n");
    expect(message).toContain(CDXML_STYLE_REFERENCE_ENV);
    expect(message).toContain('BondLength="0" is not a usable value');
  });
});

describe("CDXML style reference round trip", () => {
  it("re-imports a styled export: root settings merged with page setup, one font table, identity kept", async () => {
    const loaded = await loadStyleReference({ path: reference, source: "flag" });
    const built = await buildSmilesDocument(CAFFEINE, { name: "caffeine", drawingStyle: loaded.drawingStyle });
    // A landscape page is not the plain default page, so the root also carries page setup (PrintMargins).
    const document = applyPatches(built.document, [
      { op: "updatePageLayout", pageId: built.document.pages[0]!.id, layout: createPageLayout("letter", "landscape") }
    ]);
    // exportPerJobFormat reopens the written file and checks its canonical SMILES against the input; it throws on a mismatch.
    const exported = await exportPerJobFormat("cdxml", { ...built, document }, loaded.style);
    const contents = exported.contents as string;

    const root = /<CDXML [^>]*>/.exec(contents)![0];
    const rootNames = [...root.matchAll(/ ([A-Za-z_][\w.:-]*)="/g)].map((match) => match[1]!);
    expect(new Set(rootNames).size).toBe(rootNames.length);
    expect(rootNames).toEqual(expect.arrayContaining([
      "CreationProgram", "PrintMargins", "LabelFont", "LabelSize", "LabelFace", "HashSpacing", "MarginWidth",
      "LineWidth", "BoldWidth", "BondLength", "BondSpacing", "ChainAngle"
    ]));

    const fontTables = contents.match(/<fonttable>[\s\S]*?<\/fonttable>/g) ?? [];
    expect(fontTables).toHaveLength(1);
    const fontIds = new Map([...fontTables[0]!.matchAll(/<font id="(\d+)"[^>]* name="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
    expect(fontIds.size).toBe(fontTables[0]!.match(/<font /g)!.length);
    expect(fontIds.get(/ LabelFont="(\d+)"/.exec(root)![1]!)).toBe("Helvetica");
    for (const match of contents.matchAll(/ font="(\d+)"/g)) expect(fontIds.has(match[1]!)).toBe(true);

    expect(readCdxmlDocumentStyle(contents).style).toEqual(loaded.style);
    const molecule = reopenedMolecule(contents);
    expect(molecule.style).toMatchObject({ bondLengthPx: 19.2, atomLabelFontFamily: "Helvetica, Arial, sans-serif" });
    expect(await canonicalSmiles(molecule.structure, "re-imported structure")).toBe(await canonicalSmiles(CAFFEINE, "input"));
  });
});
