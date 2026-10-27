import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(async () => { installRealRdkitModuleLoader(); await ensureRdkit(); });
afterAll(() => resetRdkitForTesting());

async function identity(structure: string): Promise<string | undefined> {
  const molecule = (await ensureRdkit()).get_mol(structure);
  expect(molecule).not.toBeNull();
  try { return molecule?.get_smiles?.(); } finally { molecule?.delete(); }
}

describe("RDKit macrocycle depiction budget", () => {
  it.each([
    ["30-carbon ring", `C1${"C".repeat(29)}1`],
    ["38-carbon ring", `C1${"C".repeat(37)}1`],
    ["60-carbon ring", `C1${"C".repeat(59)}1`],
    ["100-carbon ring", `C1${"C".repeat(99)}1`],
    ["36-crown-12", `O1CC${"OCC".repeat(11)}1`]
  ])("depicts %s within 3 s and preserves canonical identity", async (label, smiles) => {
    const started = performance.now();
    const molfile = await generateSmiles2DMolfile(smiles);
    const elapsedMs = performance.now() - started;
    console.info(JSON.stringify({ depiction: label, elapsedMs }));
    expect(elapsedMs).toBeLessThan(3_000);
    // RDKit independently verifies the identity of the generated V2000 structure.
    expect(await identity(molfile)).toBe(await identity(smiles));
  });

  // Captured from the original implementation with the same pinned WASM before adding the guard.
  it.each([
    ["CCO", "25845271a46e0d8e2f38c3587c4c2dbfedfdccc373c77115921c16885ba793db"],
    ["C[C@H](F)Cl", "b76bce580961d001448d2d9d1a1afe1d56c4929b5b8c7f29890493441d3fa251"],
    ["c1ccccc1", "25fee28557cab3677082b3d364203b5f324bdc756a82ae19d3b166f9a8e35a4f"],
    ["C1CCC2CCCCC2C1", "a5fbdc341c6fc6368dc0ba4876b6ff1400cdb074f651bd071b69d836bf0be9b5"]
  ])("retains the original depiction bytes for %s", async (smiles, sha256) => {
    expect(createHash("sha256").update(await generateSmiles2DMolfile(smiles)).digest("hex")).toBe(sha256);
  });
});
