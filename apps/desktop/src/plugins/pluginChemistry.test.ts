import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureOclResources, UnrequestedSmilesRadicalError } from "@chemdraft/ocl-adapter";
import { createPhase4Document } from "../documentWorkflow";
import { structureFromSmilesForPlugin } from "./pluginChemistry";

vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({
  generateSmiles2DMolfile: vi.fn().mockRejectedValue(new Error("WASM unavailable"))
}));

beforeAll(async () => { await ensureOclResources(); });

describe("plugin chemistry SMILES failure reasons", () => {
  it.each(["n1cccc1", "c1cccc1"])("passes the specific chemistry refusal for %s to the plugin", async (smiles) => {
    const document = createPhase4Document();
    const result = await structureFromSmilesForPlugin({ smiles }, () => document);
    expect(result).toEqual({
      available: true,
      built: false,
      reason: new UnrequestedSmilesRadicalError(smiles).message
    });
    expect(document.pages[0].objects).toHaveLength(0);
  });
});
