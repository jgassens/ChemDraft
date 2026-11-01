import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { chemistry3dResultError } from "../../../../packages/plugin-host/src/chemistry3dResult";
import { createChemistry3dProviders } from "./client";
import { runChemistry3dJob } from "./protocol";
import { ModelTokenAuthority } from "./token";

const stop = () => new AbortController().signal;
const providers = createChemistry3dProviders(job => runChemistry3dJob(job), new ModelTokenAuthority());
const cbpqt = "C1c2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+](cc2)Cc2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+]1cc2";
const peg2Ttf = "C1(COCCOCCOC)=C(COCCOCCOC)SC(S1)=C1SC(COCCOCCOC)=C(COCCOCCOC)S1";

function expectAccepted(method: "embed3d" | "minimize3d" | "flatten3d", result: unknown): void {
  // Worker results arrive as structured-cloned data, not class instances or shared objects.
  expect(chemistry3dResultError(method, structuredClone(result))).toBeUndefined();
}

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

describe("real RDKit 3D results satisfy the plugin-host result contract", () => {
  it("accepts the non-clashing CBPQT4+/PEG2-TTF complex through embed, minimize, and flatten", async () => {
    const embedded = await providers.embed3d({ components: [{ smiles: cbpqt }, { smiles: peg2Ttf }] }, stop());
    expectAccepted("embed3d", embedded);

    const minimized = await providers.minimize3d({ model: embedded.model, interfragment: true }, stop());
    expect(minimized.clash).toBe(false);
    expectAccepted("minimize3d", minimized);

    const flattened = await providers.flatten3d({ model: minimized.model, view: "auto" }, stop());
    expectAccepted("flatten3d", flattened);
  }, 30000);

  it("accepts a simple two-component result through embed, minimize, and flatten", async () => {
    const embedded = await providers.embed3d({ components: [{ smiles: "CCO" }, { smiles: "O" }] }, stop());
    expectAccepted("embed3d", embedded);

    const minimized = await providers.minimize3d({ model: embedded.model, interfragment: true }, stop());
    expectAccepted("minimize3d", minimized);

    const flattened = await providers.flatten3d({ model: minimized.model, view: "auto" }, stop());
    expectAccepted("flatten3d", flattened);
  }, 30000);

  it("accepts the real warning-bearing minimization result", async () => {
    const embedded = await providers.embed3d({ components: [{ smiles: "C" }, { smiles: "C" }] }, stop());
    const model = structuredClone(embedded.model);
    const second = model.components[1].atomStart;
    const delta = [model.coords[0] + 1.85 - model.coords[second * 3], model.coords[1] - model.coords[second * 3 + 1],
      model.coords[2] - model.coords[second * 3 + 2]];
    for (let i = second; i < model.atoms.length; i++) for (let axis = 0; axis < 3; axis++) model.coords[i * 3 + axis] += delta[axis];

    const minimized = await providers.minimize3d({ model, interfragment: false }, stop());
    expect(minimized.warnings).not.toHaveLength(0);
    expectAccepted("minimize3d", minimized);
  }, 30000);
});
