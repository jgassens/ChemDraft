import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, moleculeToMolfileV2000, serializeDocument } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { nativeSingleHeavyElementLabelValence } from "@chemdraft/document-workflow-core";
import { metalHydrogenLossCases, preservedRadicalExportCases, radicalExportCases, readAtomStates } from "../../../document-workflow-core/test/radicalExportFixtures";
import { assertCanonicalIdentity, buildSmilesDocument, canonicalSmiles, type BuiltSmilesDocument } from "../document";
import { installNodeEngines } from "../engine";
import { runDocumentCommand } from "./document";
import { runExportCommand } from "./export";
import { runRenderDocumentCommand } from "./renderDocument";

vi.mock("../document", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../document")>();
  return { ...actual, buildSmilesDocument: vi.fn(actual.buildSmilesDocument) };
});

let directory: string;
beforeAll(async () => {
  installNodeEngines();
  directory = await mkdtemp(join(tmpdir(), "chemdraft-radical-export-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function collectIo() {
  const lines: string[] = [];
  return { lines, stdout: (line: string) => lines.push(line), stderr: () => {} };
}

describe("CLI refuses radical loss before making a canonical source", () => {
  it.each([...radicalExportCases, ...metalHydrogenLossCases.map((entry) => ({ ...entry, loss: true })), ...preservedRadicalExportCases.map((entry) => ({ ...entry, loss: false }))])("native document job: $name", async ({ molecule, name, states, loss }) => {
    const document = createEmptyDocument();
    document.pages[0]!.objects = [molecule];
    const file = join(directory, `${name.replaceAll(/[^a-z0-9]/gi, "-")}.json`);
    await writeFile(file, serializeDocument(document));
    const out = file.replace(/\.json$/, ".svg");
    const io = collectIo();
    const status = await runRenderDocumentCommand(["--document", file, "--out", out], io);
    const result = JSON.parse(io.lines[0]!) as { ok: boolean; error?: string; warnings: string[]; molecules: { canonicalSmiles: string }[] };
    if (!loss && molecule.atoms.every((atom) => (atom.markRadicals ?? 0) <= 2)) {
      expect(status).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(await readAtomStates(result.molecules[0]!.canonicalSmiles, true)).toEqual(states);
    } else {
      expect(status).toBe(1);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`Atom ${molecule.atoms[0]!.id}`) });
      expect(result.error).toMatch(/(?:radical electrons?|total hydrogens?)/);
      if (loss) expect(result.error).toContain("SMILES reparses with");
      await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  // Inject the native graph at the shared builder boundary: a SMILES input cannot encode the
  // impossible probe rows (literal C/1, Zn/1, D/2 or CH3/2). Real RDKit still makes and reparses
  // the canonical source. This proves equal canonicals alone would accept an already lossy source.
  it.each([...radicalExportCases, ...metalHydrogenLossCases.map((entry) => ({ ...entry, loss: true })), ...preservedRadicalExportCases.map((entry) => ({ ...entry, loss: false }))])("SMI/SDF job with a canonical source made from its own molfile: $name", async ({ molecule, name, states, loss }) => {
    const document = createEmptyDocument();
    document.pages[0]!.objects = [molecule];
    const identityMolfile = moleculeToMolfileV2000(molecule, {
      spellLabel: nativeSingleHeavyElementLabelValence,
      kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
    }).contents;
    const isotope = molecule.atoms[0]!.element;
    const sourceCanonicalSmiles = await canonicalSmiles(
      isotope === "D" ? "[2H]" : isotope === "T" ? "[3H]" : identityMolfile, "already converted source");
    if (isotope !== "D" && isotope !== "T") {
      await expect(assertCanonicalIdentity(sourceCanonicalSmiles, identityMolfile)).resolves.toBeUndefined();
    }
    const built: BuiltSmilesDocument = {
      name: "probe", smiles: sourceCanonicalSmiles, document, molecule,
      engine: "rdkit", stereoCenters: 0, unspecifiedStereoCenters: 0, unspecifiedDoubleBonds: 0,
      dativeBonds: 0, sourceCanonicalSmiles, identityVerifiedByRdkit: true, identityMolfile, warnings: []
    };
    for (const format of ["smi", "sdf"]) {
      vi.mocked(buildSmilesDocument).mockResolvedValueOnce(built);
      const out = join(directory, `${name.replaceAll(/[^a-z0-9]/gi, "-")}.${format}`);
      const io = collectIo();
      const status = await runExportCommand(["--smiles", sourceCanonicalSmiles, "--out", out], io);
      const result = JSON.parse(io.lines[0]!) as { ok: boolean; error?: string; warnings: string[] };
      if (!loss && molecule.atoms.every((atom) => (atom.markRadicals ?? 0) <= 2)) {
        expect(status).toBe(0);
        expect(result.warnings).toEqual([]);
        const contents = await readFile(out, "utf8");
        expect(await readAtomStates(format === "sdf" ? contents.split("> <SMILES>")[0]! : contents.split("\t")[0]!, true)).toEqual(states);
      } else {
        expect(status).toBe(1);
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`Atom ${molecule.atoms[0]!.id}`) });
        expect(result.error).toMatch(/(?:radical electrons?|total hydrogens?)/);
        if (loss) expect(result.error).toContain("SMILES reparses with");
        await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it.each([
    { smiles: "[CH3]", properties: "1 radical electron" },
    { smiles: "[13CH3]", properties: "1 radical electron and isotope 13" }
  ])("describes only the properties carried by input $smiles", async ({ smiles, properties }) => {
    const io = collectIo();
    expect(await runDocumentCommand(["--smiles", smiles, "--out", join(directory, "input-label.json")], io)).toBe(1);
    expect(JSON.parse(io.lines[0]!)).toMatchObject({
      ok: false,
      error: `Atom 1 carries ${properties}; ` +
        "ChemDraft cannot yet draw this radical without risking chemical identity."
    });
  });

  it.each(["[C]", "[CH]", "[CH3]", "[2H]", "[3H]"])("refuses radical SMILES input with an atom-specific message: %s", async (smiles) => {
    for (const command of [runDocumentCommand, runExportCommand]) {
      const out = join(directory, command === runDocumentCommand ? "input.json" : "input.sdf");
      const io = collectIo();
      expect(await command(["--smiles", smiles, "--out", out], io)).toBe(1);
      expect(JSON.parse(io.lines[0]!)).toMatchObject({ ok: false, error: expect.stringContaining("Atom 1") });
      await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
