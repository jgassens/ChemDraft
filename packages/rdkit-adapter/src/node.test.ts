import { afterEach, describe, expect, it } from "vitest";

import {
  ensureRdkit,
  resetRdkitForTesting,
  setRdkitModuleLoader
} from "./conformer";
import { installNodeRdkitModuleLoader } from "./node";

afterEach(() => resetRdkitForTesting());

async function expectRealRdkitCall(): Promise<void> {
  const rdkit = await ensureRdkit();
  const molecule = rdkit.get_mol("CCO");
  expect(molecule).not.toBeNull();
  try {
    expect(molecule?.get_smiles?.()).toBe("CCO");
  } finally {
    molecule?.delete();
  }
}

describe("installNodeRdkitModuleLoader", () => {
  it("restores the real loader after the adapter is reset", async () => {
    installNodeRdkitModuleLoader();
    resetRdkitForTesting();
    installNodeRdkitModuleLoader();

    await expectRealRdkitCall();
  }, 60_000);

  it("restores the real loader after another loader replaces it", async () => {
    installNodeRdkitModuleLoader();
    setRdkitModuleLoader(() => Promise.reject(new Error("injected loader failure")));
    installNodeRdkitModuleLoader();

    await expectRealRdkitCall();
  }, 60_000);
});
