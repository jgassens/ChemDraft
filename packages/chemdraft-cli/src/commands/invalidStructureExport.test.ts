import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serializeDocument } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { invalidCarbonDocument, invalidCarbonWarning } from "../../../document-workflow-core/test/invalidStructureFixtures";
import { runRenderDocumentCommand } from "./renderDocument";
import { runExportCommand } from "./export";
import * as documentWorkflow from "../document";
import { unrecognizedLabelDocument, unrecognizedLabelMolfileWarning, unrecognizedLabelSmilesWarning, unrecognizedLabelCdxmlWarning } from "../../../document-workflow-core/test/unrecognizedLabelFixtures";

describe("headless invalid structure exports", () => {
  it.each(["Phe", "Qq"])("retains %s diagnostics across chemical exports, even without builder warnings", async label => {
    const directory = await mkdtemp(join(tmpdir(), "label-export-"));
    const { document, molecule } = unrecognizedLabelDocument(label);
    const built = { ...await documentWorkflow.buildSmilesDocument("CC"), document, molecule,
      identityMolfile: molecule.structure, sourceCanonicalSmiles: "*C", warnings: [] as string[] };
    const spy = vi.spyOn(documentWorkflow, "buildSmilesDocument").mockResolvedValue(built);
    try {
      for (const format of ["mol", "pdf", "cdxml"]) {
        for (const alreadyReported of [false, true]) {
          built.warnings = alreadyReported ? [unrecognizedLabelMolfileWarning(label)] : [];
          const lines: string[] = [];
          expect(await runExportCommand(["--smiles", "*C", "--out", join(directory, `label.${format}`)], {
            stdout: line => lines.push(line), stderr: () => {}
          })).toBe(0);
          const result = JSON.parse(lines[0]!);
          // Preserve main's CDXML warning order, including its round-trip writer diagnostic.
          expect(result.warnings).toEqual(format === "cdxml" ? [
            ...built.warnings, unrecognizedLabelCdxmlWarning(label), unrecognizedLabelMolfileWarning(label)
          ] : [unrecognizedLabelMolfileWarning(label)]);
        }
      }
      // Main refuses lossy label exports to SMI/SDF with this explaining diagnostic.
      for (const format of ["smi", "sdf"]) {
        const lines: string[] = [];
        expect(await runExportCommand(["--smiles", "*C", "--out", join(directory, `label.${format}`)], {
          stdout: line => lines.push(line), stderr: () => {}
        })).toBe(1);
        expect(JSON.parse(lines[0]!).error).toContain(unrecognizedLabelSmilesWarning(label));
      }
    } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it.each(["pdf", "svg", "png", "chemdraft"])("keeps main's Phe label diagnostic in native %s output", async format => {
    const directory = await mkdtemp(join(tmpdir(), "label-render-"));
    try {
      const input = join(directory, "drawing.json");
      await writeFile(input, serializeDocument(unrecognizedLabelDocument().document));
      const lines: string[] = [];
      expect(await runRenderDocumentCommand(["--document", input, "--out", join(directory, `drawing.${format}`)], {
        stdout: line => lines.push(line), stderr: () => {}
      })).toBe(0);
      expect(JSON.parse(lines[0]!).warnings).toEqual([
        unrecognizedLabelMolfileWarning(), ...(format === "chemdraft" ? [unrecognizedLabelCdxmlWarning()] : [])
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([false, true])("writes native drawing and named warning JSON (suppressed=%s)", async suppressed => {
    const directory = await mkdtemp(join(tmpdir(), "invalid-export-"));
    try {
      const input = join(directory, "drawing.json");
      const output = join(directory, "drawing.chemdraft");
      await writeFile(input, serializeDocument(invalidCarbonDocument(suppressed)));
      const lines: string[] = [];
      expect(await runRenderDocumentCommand(["--document", input, "--out", output], {
        stdout: line => lines.push(line), stderr: () => {}
      })).toBe(0);
      const result = JSON.parse(lines[0]!);
      expect(result).toMatchObject({ ok: true, warnings: [invalidCarbonWarning], molecules: [{
        objectId: "invalid_carbon", canonicalSmiles: null, chemistryStatus: "unverified",
        stereoCenters: null, unspecifiedStereoCenters: null, unspecifiedDoubleBonds: null,
        exportWarnings: [expect.objectContaining({ message: invalidCarbonWarning })]
      }] });
      const molecule = openChemDraftPayload(await readFile(output, "utf8")).document!.pages[0]!.objects[0]!;
      expect(molecule).toMatchObject({ type: "molecule", atoms: expect.any(Array), bonds: expect.any(Array) });
      if (molecule.type !== "molecule") throw new Error("Expected molecule");
      expect(molecule.atoms).toHaveLength(6);
      expect(molecule.bonds).toHaveLength(5);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps the SMILES-input identity refusal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invalid-smiles-"));
    try {
      const lines: string[] = [];
      expect(await runExportCommand(["--smiles", "C(C)(C)(C)(C)C", "--out", join(directory, "refused.mol")], {
        stdout: line => lines.push(line), stderr: () => {}
      })).toBe(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
