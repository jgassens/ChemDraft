import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeDocument } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { invalidCarbonDocument, invalidCarbonWarning } from "../../../document-workflow-core/test/invalidStructureFixtures";
import { runRenderDocumentCommand } from "./renderDocument";
import { runExportCommand } from "./export";

describe("headless invalid structure exports", () => {
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
