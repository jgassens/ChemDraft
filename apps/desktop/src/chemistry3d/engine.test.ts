import { beforeEach, describe, expect, it, vi } from "vitest";
import { embed3dInWorker, minimize3dInWorker } from "./engine";
import { chemistry3dMethod } from "./method";

const rdkit = vi.hoisted(() => ({ get_mol: vi.fn(), optimize: vi.fn(), generate: vi.fn(), dispose: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({ ensureRdkit: async () => ({ get_mol: rdkit.get_mol }),
  generate3DConformerProgressive: rdkit.generate }));
const model = { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
  components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "test" };
beforeEach(() => {
  vi.clearAllMocks();
  rdkit.get_mol.mockReturnValue({ optimize_3d_conformer: rdkit.optimize, get_smiles: () => "C",
    add_hs: () => "explicit-H", get_json: () => JSON.stringify({ molecules: [{ atoms: [{}], bonds: [] }] }), delete: rdkit.dispose });
});
describe("minimize3d worker engine contract", () => {
  it.each([[2.1999, true], [2.2, false], [2.2001, false]] as const)("screens contacts at %s A independently of convergence", async (distance, clash) => {
    const pair = { ...model, atoms: [model.atoms[0], { ...model.atoms[0], component: 1 }], coords: [0, 0, 0, distance, 0, 0],
      components: [model.components[0], { ...model.components[0], atomStart: 1 }] };
    rdkit.optimize.mockReturnValue(JSON.stringify({ embedOk: true, coords3dByEngineAtom: pair.coords,
      forceField: { status: "converged", energy: 4 } }));
    const result = await minimize3dInWorker({ model: pair, interfragment: true }, chemistry3dMethod(42));
    expect(result.clash).toBe(clash);
    expect(result.closestInterComponentHeavyAtomA).toBe(distance);
    expect(result.warnings).toHaveLength(clash ? 1 : 0);
  });
  it("reuses the real Spin adapter entry/settings while retaining all added-H coordinates", async () => {
    const base = { atoms: [{ z: 6 }], bonds: [] };
    const withH = { atoms: [{ z: 6 }, { z: 1 }, { z: 1 }, { z: 1 }, { z: 1 }],
      bonds: [1, 2, 3, 4].map(i => ({ atoms: [0, i] })) };
    rdkit.get_mol.mockImplementation((input: string) => ({ delete: rdkit.dispose,
      add_hs: () => "explicit-hydrogen-molblock",
      get_json: () => JSON.stringify({ molecules: [input === "C" ? base : withH] })
    }));
    rdkit.generate.mockResolvedValue({ embedded: { embed: { status: "ok" }, warnings: [],
      mapping: { coords3dByOriginalAtom: Float64Array.from(Array(15).fill(1)) } } });
    const result = await embed3dInWorker({ components: [{ smiles: "C" }], seed: 9 });
    expect(rdkit.generate).toHaveBeenCalledWith({ molfile: "explicit-hydrogen-molblock", originalAtomCount: 1 },
      { seed: 9, optimize: "none", embedCandidates: 4 });
    expect(result.model.atoms.map(atom => atom.addedHydrogen)).toEqual([false, true, true, true, true]);
    expect(result.model.coords).toHaveLength(15);
  });
  it("runs 1000-iteration passes up to the TOTAL cap, stops at convergence, and passes a real boolean", async () => {
    rdkit.optimize.mockImplementation((input: string) => {
      const opts = JSON.parse(input);
      expect(opts).toMatchObject({ forceField: "mmff94s", ignoreInterfragInteractions: true });
      return JSON.stringify({ embedOk: true, coords3dByEngineAtom: [1, 2, 3], forceField: {
        status: rdkit.optimize.mock.calls.length >= 2 ? "converged" : "not-converged", energy: 4 } });
    });
    const result = await minimize3dInWorker({ model, interfragment: false, maxIters: 1500 }, chemistry3dMethod(42));
    expect(rdkit.optimize.mock.calls.map(([json]) => JSON.parse(json).maxIters)).toEqual([1000, 500]);
    expect(result.forceField).toEqual({ name: "mmff94s", status: "converged", energy: 4, iterationsBudget: 1500 });
    // Optimization handle + signed intent at input and output. No specified stereo needs no
    // added-H/geometry parse; those handles are still used for specified tetrahedra and E/Z.
    expect(rdkit.dispose).toHaveBeenCalledTimes(3);
  });
  it("reports setup failure without inventing a fallback field or geometry", async () => {
    rdkit.optimize.mockReturnValue(JSON.stringify({ embedOk: false, coords3dByEngineAtom: [], forceField: { status: "setup-failed" } }));
    const result = await minimize3dInWorker({ model, interfragment: false, forceField: "uff" }, chemistry3dMethod(42));
    expect(result.forceField).toMatchObject({ name: "uff", status: "setup-failed", energy: null });
    expect(result.model.coords).toEqual(model.coords);
    expect(result.warnings[0]).toContain("coordinates are unchanged");
    expect(rdkit.optimize).toHaveBeenCalledOnce();
  });
  it("refuses non-booleans before anything reaches the RDKit binding", async () => {
    await expect(minimize3dInWorker({ model, interfragment: "false" } as never, chemistry3dMethod(42)))
      .rejects.toThrow("minimize3d interfragment must be a boolean (true or false).");
    expect(rdkit.get_mol).not.toHaveBeenCalled();
    expect(rdkit.optimize).not.toHaveBeenCalled();
  });
});
