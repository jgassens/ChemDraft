import { it, expect, beforeAll, afterAll } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { flattenNativeMolecule3d } from "../documentWorkflow";
import { createChemistry3dProviders } from "./client";
import { runChemistry3dJob } from "./protocol";
import { ModelTokenAuthority } from "./token";
import type { Plugin3DModel } from "@chemdraft/plugin-api";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function explicitHydrogenChain(count: number): MoleculeObject {
  const atoms: MoleculeObject["atoms"] = [];
  const bonds: MoleculeObject["bonds"] = [];
  const addBond = (fromAtomId: string, toAtomId: string) => bonds.push({ id: `b${bonds.length}`, fromAtomId, toAtomId, order: "single" });
  for (let i = 0; i < count; i++) {
    const carbon = `c${i}`;
    atoms.push({ id: carbon, element: "C", formalCharge: 0, x: i * 2, y: i % 2 });
    if (i > 0) addBond(`c${i - 1}`, carbon);
    for (let h = 0; h < (i === 0 || i === count - 1 ? 3 : 2); h++) {
      const hydrogen = `h${i}_${h}`;
      atoms.push({ id: hydrogen, element: "H", formalCharge: 0, x: i * 2 + (h === 2 ? -0.5 : 0.5), y: i % 2 + (h % 2 ? 1 : -1) });
      addBond(carbon, hydrogen);
    }
  }
  return { id: "large", type: "molecule", atoms, bonds, x: 0, y: 0, width: 0, height: 0,
    rotation: 0, style: {}, structure: "", structureFormat: "molfile-v2000", superatoms: [], rGroups: [] };
}

// Opt-in profiling uses exactly the explicit-H V3000 Spin fixture, with no test deadline change.
const profile = process.env.CHEMDRAFT_PROFILE_3D === "1";
beforeAll(async () => { if (profile) { installRealRdkitModuleLoader(); await ensureRdkit(); } });
afterAll(() => { if (profile) resetRdkitForTesting(); });
it.skipIf(!profile)("profiles shared flatten at 100/334/500 heavy atoms", () => {
  for (const count of [100, 334, 500]) {
    const molecule = explicitHydrogenChain(count);
    const coords = molecule.atoms.flatMap(atom => [atom.x, -atom.y, 0]);
    const start = performance.now();
    const outcome = flattenNativeMolecule3d(molecule, coords, identity, { placement: { centerX: 400, centerY: 200, scale: 1 } });
    console.log(`shared flatten ${count}: ${(performance.now() - start).toFixed(1)} ms`);
    expect(outcome.status).toBe("committed");
  }
});
it.skipIf(!profile)("profiles flatten3d end to end at 500 heavy atoms", async () => {
  const molecule = explicitHydrogenChain(500);
  const indices = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
  const model: Plugin3DModel = { atoms: molecule.atoms.map(atom => ({ element: atom.element, charge: 0, component: 0, addedHydrogen: atom.element === "H" })),
    bonds: molecule.bonds.map(bond => ({ a: indices.get(bond.fromAtomId)!, b: indices.get(bond.toAtomId)!, order: 1 })),
    coords: molecule.atoms.flatMap(atom => [atom.x, -atom.y, 0]), components: [{ smiles: "C".repeat(500), atomStart: 0, atomCount: molecule.atoms.length }], modelToken: "unsigned" };
  const tokens = new ModelTokenAuthority();
  model.modelToken = await tokens.sign(model, 42);
  const providers = createChemistry3dProviders(job => runChemistry3dJob(job), tokens);
  const start = performance.now();
  const flat = await providers.flatten3d({ model, view: "auto" }, new AbortController().signal);
  console.log(`flatten3d end to end 500: ${(performance.now() - start).toFixed(1)} ms`);
  expect(flat.objects).toHaveLength(1);
});
