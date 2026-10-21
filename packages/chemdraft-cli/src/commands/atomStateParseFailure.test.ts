import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as identifiers from "@chemdraft/rdkit-adapter/identifiers";
import * as documentWorkflow from "../document";
import { runExportCommand } from "./export";

it.each([
  { format: "smi", partialEvidence: true }, { format: "sdf", partialEvidence: true },
  { format: "smi", partialEvidence: false }, { format: "sdf", partialEvidence: false }
])("refuses $format with unverified states (partial evidence: $partialEvidence)", async ({ format, partialEvidence }) => {
  const directory = await mkdtemp(join(tmpdir(), "chemdraft-unverified-export-"));
  const out = join(directory, `unverified.${format}`);
  const built = await documentWorkflow.buildSmilesDocument("CCO");
  const builder = vi.spyOn(documentWorkflow, "buildSmilesDocument").mockResolvedValue(built);
  const compute = identifiers.computeStructureIdentifiers;
  let stateRequests = 0;
  const parser = vi.spyOn(identifiers, "computeStructureIdentifiers").mockImplementation(async (input, options) => {
    const result = await compute(input, options);
    // Let source verification succeed, then fail the final export's state parse.
    if (options?.includeAtomStates && ++stateRequests === 2) {
      return { smiles: result?.smiles, ...(partialEvidence ? { smilesAtomStates: [] } : {}) };
    }
    return result;
  });
  const lines: string[] = [];
  try {
    expect(await runExportCommand(["--smiles", "CCO", "--out", out], {
      stdout: (line) => lines.push(line), stderr: () => {}
    })).toBe(1);
    expect(stateRequests).toBe(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: false, error: expect.stringContaining("could not be verified against the exported SMILES")
    });
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    parser.mockRestore();
    builder.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
