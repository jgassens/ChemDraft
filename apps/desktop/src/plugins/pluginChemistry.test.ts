import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as ocl from "@chemdraft/ocl-adapter";
import { createPhase4Document } from "../documentWorkflow";
import { structureFromSmilesForPlugin } from "./pluginChemistry";

vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({
  generateSmiles2DMolfile: vi.fn().mockRejectedValue(new Error("WASM unavailable"))
}));

beforeAll(async () => { await ocl.ensureOclResources(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("plugin chemistry SMILES failure reasons", () => {
  it.each(["n1cccc1", "c1cccc1"])("names %s and the specific chemistry refusal for the plugin", async (smiles) => {
    const document = createPhase4Document();
    const result = await structureFromSmilesForPlugin({ smiles }, () => document);
    expect(result).toEqual({
      available: true,
      built: false,
      reason: `No 2D structure could be generated for "${smiles}": ${new ocl.UnrequestedSmilesRadicalError(smiles).message}`
    });
    expect(document.pages[0].objects).toHaveLength(0);
  });

  it("keeps only the first line of an OCL parser exception", async () => {
    vi.spyOn(ocl, "depictSmiles2D").mockImplementation(() => {
      throw new Error("Class$S19: SmilesParser could not parse the input\nat parser stack frame");
    });
    const result = await structureFromSmilesForPlugin({ smiles: "C1" }, () => createPhase4Document());
    expect(result).toEqual({
      available: true,
      built: false,
      reason: "No 2D structure could be generated for \"C1\": Class$S19: SmilesParser could not parse the input"
    });
  });
});
