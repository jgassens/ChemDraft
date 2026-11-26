import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openChemDraftPayload, readCdxmlDocumentStyle } from "@chemdraft/cdx-compat";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { applyPatches, createPageLayout, type MoleculeObject } from "@chemdraft/chem-core";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { buildSmilesDocument, canonicalSmiles } from "../document";
import {
  CDXML_STYLE_REFERENCE_ENV,
  loadStyleReference,
  resolveStyleReference,
  validateStyleReferenceArgumentPath
} from "../styleReference";
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

describe("styleReference argument: an input path, checked as an input", () => {
  const argument = (path: string) => ({ path, source: "argument" as const });

  it.each([
    ["win32", "C:\\TEMP\\STYLE~1.CDXML"],
    ["win32", "C:\\TEMP\\STYLE~1.CDX"],
    ["win32", "C:\\Users\\Ana María\\Styles\\ACS 1996, journal.cdxml"],
    ["win32", "\\\\server\\share\\house style.CdXmL"],
    ["darwin", "/Users/ana/Styles/ACS 1996, journal.cdxml"],
    ["darwin", "/tmp/STYLE~1.CDX"],
    ["linux", "/home/ana/styles/house+style (v2).CDXML"]
  ] as const)("accepts the %s input path %s before reading it", (platform, path) => {
    expect(() => validateStyleReferenceArgumentPath(argument(path), platform)).not.toThrow();
  });

  it.each([
    ["win32", "C:\\TEMP\\NUL.cdxml", "Windows device name"],
    ["win32", "C:\\TEMP\\..\\style.cdxml", "parent traversal"],
    ["darwin", "/tmp/../style.cdxml", "parent traversal"],
    ["darwin", "/tmp/style\0.cdxml", "NUL character"],
    ["win32", "C:\\TEMP\\style.txt", "does not have a .cdxml extension"],
    ["darwin", "/tmp/reference.cdx", "does not have a .cdxml extension"],
    ["win32", "C:\\TEMP\\LONGSTYLE1.CDX", "does not have a .cdxml extension"]
  ] as const)("refuses the %s input path %s", (platform, path, reason) => {
    expect(() => validateStyleReferenceArgumentPath(argument(path), platform)).toThrow(reason);
  });

  it("loads a CDXML reference through an 8.3 short name with a truncated .CDX extension", async () => {
    const short = join(directory, "STYLE~1.CDX");
    await writeFile(short, REFERENCE);
    const loaded = await loadStyleReference(argument(short));
    expect(loaded.style.bondLengthPt).toBe(14.4);
  });

  it("refuses a short-name .CDX file whose content is not CDXML", async () => {
    const binary = join(directory, "BINARY~1.CDX");
    await writeFile(binary, Buffer.from([0x56, 0x6a, 0x43, 0x44, 0x30, 0x31, 0x30, 0x30, 0x04, 0x03, 0x02, 0x01, 0x00]));
    await expect(loadStyleReference(argument(binary))).rejects.toThrow("accepted only as the 8.3 short name of a CDXML file");
  });

  it("accepts a name the output-filename rules would refuse", async () => {
    const named = join(directory, "ACS 1996, house style.CDXML");
    await writeFile(named, REFERENCE);
    expect((await loadStyleReference(argument(named))).style.bondLengthPt).toBe(14.4);
  });
});

describe("styleReference argument: symbolic links and file identity", () => {
  async function symlinkOrSkip(target: string, link: string): Promise<boolean> {
    try {
      await symlink(target, link);
      return true;
    } catch (error) {
      // Windows without Developer Mode or the SeCreateSymbolicLink privilege refuses symlink(2).
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }

  it("refuses an argument whose final component is a symbolic link, naming it", async (context) => {
    const link = join(directory, "linked.cdxml");
    if (!await symlinkOrSkip(reference, link)) {
      context.skip("this platform cannot create symbolic links without extra privileges (Windows without Developer Mode)");
    }
    await expect(loadStyleReference({ path: link, source: "argument" })).rejects.toThrow(
      `CDXML style reference "${link}" (styleReference argument) cannot be used: it is a symbolic link`
    );
    // The CLI flag and the environment variable name a file the user chose; a link there is followed.
    expect((await loadStyleReference({ path: link, source: "flag" })).style.bondLengthPt).toBe(14.4);
  });

  it("refuses a symbolic link to a non-CDXML file without reading it", async (context) => {
    const secret = join(directory, "secret.txt");
    await writeFile(secret, "not for agents");
    const link = join(directory, "secret-link.cdxml");
    if (!await symlinkOrSkip(secret, link)) {
      context.skip("this platform cannot create symbolic links without extra privileges (Windows without Developer Mode)");
    }
    // Refused on the link itself: the message is the link's, not a parse error from the target.
    await expect(loadStyleReference({ path: link, source: "argument" })).rejects.toThrow(/cannot be used: it is a symbolic link/);
  });

  it("refuses a file that was replaced between the check and the open", async () => {
    const swapped = join(directory, "swapped.cdxml");
    const replacement = join(directory, "replacement.cdxml");
    await writeFile(swapped, REFERENCE);
    await writeFile(replacement, REFERENCE);
    await expect(loadStyleReference({ path: swapped, source: "argument" }, {
      afterCheck: () => rename(replacement, swapped)
    })).rejects.toThrow("it changed between the check and the read");
  });
});

describe("built-in structure templates with a style reference", () => {
  // A SMILES that matches a built-in template takes the template's authored layout, drawn at the CLI
  // default bond length (28 px); the reference's bond length must still rescale it.
  const template = resolveStructureTemplateName("beta-cyclodextrin")!;
  const meanBondLength = (molecule: MoleculeObject) => {
    const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
    const lengths = molecule.bonds.map(bond => {
      const a = atoms.get(bond.fromAtomId)!, b = atoms.get(bond.toAtomId)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    });
    return lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  };

  it("rescales the template to the reference bond length", async () => {
    const loaded = await loadStyleReference({ path: reference, source: "flag" });
    const plain = await buildSmilesDocument(template.smiles);
    expect(plain.layout).toBe(`template:${template.id}`);
    expect(meanBondLength(plain.molecule)).toBeCloseTo(28, 4);

    const styled = await buildSmilesDocument(template.smiles, { drawingStyle: loaded.drawingStyle });
    expect(styled.layout).toBe(`template:${template.id}`);
    expect(meanBondLength(styled.molecule)).toBeCloseTo(19.2, 4);
    expect(styled.molecule.style).toMatchObject({ bondLengthPx: 19.2 });
  });

  it("exports the template's CDXML with the typical bond at the reference BondLength", async () => {
    const out = join(directory, "cyclodextrin.cdxml");
    const io = collectIo();
    expect(await runExportCommand(["--smiles", template.smiles, "--out", out, "--style-reference", reference], io, {})).toBe(0);
    expect(JSON.parse(io.stdoutLines[0]!)).toMatchObject({ ok: true, layout: `template:${template.id}` });
    const lengths = visibleBondLengths(await readFile(out, "utf8")).sort((a, b) => a - b);
    expect(lengths.length).toBeGreaterThan(50);
    expect(lengths[Math.floor(lengths.length / 2)]!).toBeCloseTo(14.4, 1);
    expect(lengths.reduce((sum, length) => sum + length, 0) / lengths.length).toBeCloseTo(14.4, 2);
  });
});
