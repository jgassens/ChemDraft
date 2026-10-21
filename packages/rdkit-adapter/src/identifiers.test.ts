import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRdkitForTesting, setRdkitModuleLoader, type RdkitMinimalModule } from "./conformer";
import { computeSmilesAtomStates, computeStructureIdentifiers } from "./identifiers";
import { installNodeRdkitModuleLoader } from "./node";

beforeEach(() => { installNodeRdkitModuleLoader(); });
afterEach(() => { resetRdkitForTesting(); });

describe("RDKit SMILES atom states", () => {
  it("reads token order, defaults, bracket H, bonded H, charge, isotope and radicals", async () => {
    expect(await computeSmilesAtomStates("[13CH2]O[2H].[Na+]")).toEqual([
      { element: "C", formalCharge: 0, isotope: 13, nRad: 1, hydrogenCount: 2 },
      { element: "O", formalCharge: 0, isotope: 0, nRad: 0, hydrogenCount: 1 },
      { element: "H", formalCharge: 0, isotope: 2, nRad: 0, hydrogenCount: 0 },
      { element: "Na", formalCharge: 1, isotope: 0, nRad: 0, hydrogenCount: 0 }
    ]);
    expect(await computeSmilesAtomStates("[H]C")).toEqual([
      { element: "H", formalCharge: 0, isotope: 0, nRad: 0, hydrogenCount: 0 },
      { element: "C", formalCharge: 0, isotope: 0, nRad: 0, hydrogenCount: 4 }
    ]);
  });

  it.each([
    ["[Pt]", "Pt", 0], ["[Ni]", "Ni", 0], ["[Pd]", "Pd", 0],
    ["[Fe]", "Fe", 0], ["[Na]", "Na", 1], ["[Mg]", "Mg", 2]
  ] as const)("reads %s from the engine", async (smiles, element, nRad) => {
    expect(await computeSmilesAtomStates(smiles)).toEqual([
      { element, formalCharge: 0, isotope: 0, nRad, hydrogenCount: 0 }
    ]);
  });

  it("returns no states for invalid SMILES", async () => {
    expect(await computeSmilesAtomStates("invalid smiles")).toBeUndefined();
  });

  it("maps a canonical traversal back to its input order, retaining explicit H", async () => {
    const identifiers = await computeStructureIdentifiers("OC([2H])C", { includeAtomStates: true });
    expect(identifiers?.smilesAtomOrder).not.toEqual([0, 1, 2, 3]);
    const byInput = new Map(identifiers!.smilesAtomOrder!.map((input, output) =>
      [input, identifiers!.smilesAtomStates![output]!]));
    expect([0, 1, 2, 3].map((index) => byInput.get(index)?.element)).toEqual(["O", "C", "H", "C"]);
    expect(byInput.get(2)?.isotope).toBe(2);
  });

  it.each([undefined, "", "{}"])("declines an unavailable JSON value (%s) and deletes the handle", async (json) => {
    const dispose = vi.fn();
    const loader = vi.fn(async () => ({ get_mol: () => ({
      delete: dispose, ...(json === undefined ? {} : { get_json: () => json })
    }) }) as unknown as RdkitMinimalModule);
    setRdkitModuleLoader(loader);
    expect(loader).not.toHaveBeenCalled();
    expect(await computeSmilesAtomStates("C")).toBeUndefined();
    expect(loader).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("deletes the handle if JSON decoding fails", async () => {
    const dispose = vi.fn();
    setRdkitModuleLoader(async () => ({ get_mol: () => ({ delete: dispose, get_json: () => "invalid" }) }) as unknown as RdkitMinimalModule);
    await expect(computeSmilesAtomStates("C")).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
