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

  it("names an invented-hydrogen refusal in full for the plugin", async () => {
    const smiles = "O=[N]=O";
    const document = createPhase4Document();
    const result = await structureFromSmilesForPlugin({ smiles }, () => document);
    const refusal = new ocl.UnrequestedSmilesHydrogenError(smiles, { bracket: "[N]", atomNumber: 2, written: 0, parsed: 1 });
    expect(result).toEqual({
      available: true,
      built: false,
      reason: `No 2D structure could be generated for "${smiles}": ${refusal.message}`
    });
    expect(document.pages[0].objects).toHaveLength(0);
  });

  it("keeps a multi-line chemistry refusal whole", async () => {
    const refusal = new ocl.UnrequestedSmilesHydrogenError("C");
    Object.defineProperty(refusal, "message", { value: "first line\nsecond line" });
    vi.spyOn(ocl, "depictSmiles2D").mockImplementation(() => { throw refusal; });
    const result = await structureFromSmilesForPlugin({ smiles: "C" }, () => createPhase4Document());
    expect(result).toMatchObject({ built: false, reason: "No 2D structure could be generated for \"C\": first line\nsecond line" });
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
