import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit, resetRdkitForTesting, type RdkitMinimalModule } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

type ForceField = "mmff94" | "mmff94s" | "uff";
const fixture = JSON.parse(readFileSync(
  new URL("../test-fixtures/optimize-default-golden.json", import.meta.url), "utf8"
)) as {
  embedDetails: { seed: number };
  maxIters: number;
  cases: Array<{ smiles: string; results: Record<ForceField, string> }>;
};

let rdkit: RdkitMinimalModule;
beforeAll(async () => {
  installRealRdkitModuleLoader();
  rdkit = await ensureRdkit();
});
afterAll(() => resetRdkitForTesting());

describe("optimize_3d_conformer default bytes (captured before patch 0008)", () => {
  for (const { smiles, results } of fixture.cases) {
    for (const forceField of ["mmff94", "mmff94s", "uff"] as const) {
      it.each([undefined, true])(`${smiles}, ${forceField}, ignoreInterfragInteractions:%s`, (ignoreInterfragInteractions) => {
        const mol = rdkit.get_mol(smiles);
        expect(mol).not.toBeNull();
        if (!mol) throw new Error(`RDKit could not parse ${smiles}`);
        try {
          // No timeout: this regression depends only on the fixed seed and iteration budget.
          const embed = JSON.parse(mol.generate_3d_embed(JSON.stringify(fixture.embedDetails)));
          expect(embed.embedOk).toBe(true);
          const details = { forceField, maxIters: fixture.maxIters, ignoreInterfragInteractions };
          const actual = mol.optimize_3d_conformer(JSON.stringify(details));
          // Compare the entire raw string, including coordinate/energy precision and key order.
          expect(actual).toBe(results[forceField]);
        } finally {
          mol.delete();
        }
      });
    }
  }
});
