import { describe, expect, it } from "vitest";
import { Plugin3DModelSchema, Plugin3DRotationSchema, PluginEmbed3DRequestSchema, PluginMinimize3DRequestSchema,
  PluginFlatten3DRequestSchema, PluginMinimize3DResultSchema, type Plugin3DModel } from "./index";

const model: Plugin3DModel = { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }],
  bonds: [], coords: [0, 0, 0], components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "test" };

describe("3D chemistry public schemas", () => {
  it("requires a boolean clash result and a finite nonnegative contact distance when present", () => {
    const result = { model, clash: false, forceField: { name: "mmff94s", status: "converged", energy: 0, iterationsBudget: 1000 },
      method: { engine: "RDKit MinimalLib Release_2026_03_3 + patches 0001-0008", embedding: "ETKDGv3", seed: 42,
        forceField: "mmff94s", interfragment: false, coordinateUnits: "Angstrom", energyUnits: "kcal/mol", conventions: [] }, warnings: [] };
    expect(PluginMinimize3DResultSchema.parse(result).clash).toBe(false);
    expect(PluginMinimize3DResultSchema.parse({ ...result, clash: true, closestInterComponentHeavyAtomA: 1.85 }).clash).toBe(true);
    for (const clash of [undefined, "false", 0]) expect(PluginMinimize3DResultSchema.safeParse({ ...result, clash }).success).toBe(false);
    for (const distance of [-1, NaN, Infinity]) expect(PluginMinimize3DResultSchema.safeParse({ ...result, closestInterComponentHeavyAtomA: distance }).success).toBe(false);
  });
  it("rejects a separate bond stereo tag; geometry and component SMILES carry stereo", () => {
    const pair = { ...model, atoms: [model.atoms[0], model.atoms[0]], coords: [0, 0, 0, 1, 0, 0],
      components: [{ smiles: "CC", atomStart: 0, atomCount: 2 }], bonds: [{ a: 0, b: 1, order: 1 }] };
    expect(Plugin3DModelSchema.safeParse(pair).success).toBe(true);
    expect(Plugin3DModelSchema.safeParse({ ...pair, bonds: [{ ...pair.bonds[0], stereo: 1 }] }).success).toBe(false);
  });
  it("caps components, SMILES, iterations and heavy atoms", () => {
    expect(PluginEmbed3DRequestSchema.parse({ components: Array.from({ length: 8 }, () => ({ smiles: "C" })) }).components).toHaveLength(8);
    for (const components of [[], Array.from({ length: 9 }, () => ({ smiles: "C" })), [{ smiles: "C".repeat(5001) }]]) {
      expect(PluginEmbed3DRequestSchema.safeParse({ components }).success).toBe(false);
    }
    expect(PluginMinimize3DRequestSchema.safeParse({ model, interfragment: false, maxIters: 20001 }).success).toBe(false);
    const large = { ...model, atoms: Array.from({ length: 501 }, () => model.atoms[0]), coords: Array(1503).fill(0),
      components: [{ ...model.components[0], atomCount: 501 }] };
    expect(() => Plugin3DModelSchema.parse(large)).toThrow("at most 500 heavy atoms");
  });
  it.each([undefined, null, 0, 1, "true", "false", {}, []])("requires a strict boolean, refusing %s before native as_bool", value => {
    expect(() => PluginMinimize3DRequestSchema.parse({ model, interfragment: value })).toThrow("minimize3d interfragment must be a boolean (true or false).");
  });
  it("refuses interfragment with one component and malformed coordinate arrays", () => {
    expect(() => PluginMinimize3DRequestSchema.parse({ model, interfragment: true })).toThrow("requires more than one component");
    for (const coords of [[0], [NaN, 0, 0], [Infinity, 0, 0]]) expect(Plugin3DModelSchema.safeParse({ ...model, coords }).success).toBe(false);
    expect(Plugin3DModelSchema.safeParse({ ...model, components: Array(9).fill(model.components[0]) }).success).toBe(false);
  });
  it("accepts only finite proper orthonormal 3x3 rotations", () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(PluginFlatten3DRequestSchema.parse({ model, view: { rotation: identity } }).view).toEqual({ rotation: identity });
    expect(PluginFlatten3DRequestSchema.parse({ model, view: "auto" }).view).toBe("auto");
    for (const r of [[], Array(9).fill(0), [2, 0, 0, 0, 1, 0, 0, 0, 1], [-1, 0, 0, 0, 1, 0, 0, 0, 1],
      [1, 0.1, 0, 0, 1, 0, 0, 0, 1], [NaN, 0, 0, 0, 1, 0, 0, 0, 1]]) {
      expect(Plugin3DRotationSchema.safeParse(r).success).toBe(false);
    }
  });
});
