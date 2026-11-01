import { beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { depictSmiles, renderSmilesToAssets } from "./document";

beforeAll(async () => { await depictSmiles("CCO"); });

describe("CLI macrocycle render", () => {
  it("renders a 100-carbon ring with a deadline and unchanged identity", async () => {
    const smiles = `C1${"C".repeat(99)}1`;
    const started = performance.now();
    const result = await renderSmilesToAssets(smiles);
    const elapsedMs = performance.now() - started;
    console.info(JSON.stringify({ depiction: "CLI 100-carbon ring", elapsedMs, engine: result.engine }));
    expect(elapsedMs).toBeLessThan(3_000);
    expect(result.svg).toContain("<svg");
    expect(result.png.length).toBeGreaterThan(0);
    expect(result.molecule.atoms).toHaveLength(100);
    expect(result.molecule.bonds).toHaveLength(100);
    // Adjacent three-digit V2000 counts are supported; identity stays on the normal V2000 path.
    const output = await computeStructureIdentifiers(moleculeToMolfileV2000(result.molecule, {
      fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(result.molecule.atoms, result.molecule.bonds).kekuleOrders
    }).contents);
    const input = await computeStructureIdentifiers(smiles);
    expect(input?.smiles).toBeTruthy();
    expect(output?.smiles).toBe(input?.smiles);
  }, 10_000);
});
