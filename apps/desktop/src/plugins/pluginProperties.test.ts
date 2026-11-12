import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeStructure } from "../../../../packages/rdkit-adapter/src/analysis";
import { installRealRdkitModuleLoader } from "../../../../packages/rdkit-adapter/src/testing";
import { ensureRdkit, resetRdkitForTesting } from "../../../../packages/rdkit-adapter/src/conformer";
import type { AnalysisClient } from "../analysisClient";
import { computePropertiesForPlugin, PLUGIN_PROPERTIES_METHODS } from "./pluginProperties";

beforeAll(installRealRdkitModuleLoader);
afterAll(resetRdkitForTesting);
const analyze: AnalysisClient["analyze"] = async (_slot, spec) => analyzeStructure({
  format: spec.format === "smiles" ? "smiles" : spec.format === "molfile-v3000" ? "molfile-v3000" : "molfile-v2000",
  value: spec.value, methodIds: spec.methodIds,
  runId: "properties-test", startedAt: "2026-11-08T12:00:00Z", maxHeavyAtoms: 500 });
const client = { analyze } as AnalysisClient;

describe("plugin properties use the property panel's RDKit analysis", () => {
  it.each([
    ["CC(=O)Oc1ccccc1C(=O)O", "C9H8O4", 0, 180.159, 180.04226],
    ["[Na+].O=C([O-])c1ccccc1", "C7H5NaO2", 0, 144.105, 144.01872],
    ["O=C([O-])c1ccccc1", "C7H5O2", -1, 121.115, 121.0295],
    ["[13CH4]", "[13C]H4", 0, 17.03535, 17.03465]
  ])("preserves composition for %s", async (structure, formula, formalCharge, averageMass, monoisotopicMass) => {
    const result = await computePropertiesForPlugin({ format: "smiles", structure }, client);
    expect(result).toMatchObject({ available: true, formula, formalCharge, isotopeLabelled: structure.includes("13C") });
    if (!result.available) throw new Error(result.reason);
    expect(result.averageMass).toBeCloseTo(averageMass, 3);
    expect(result.monoisotopicMass).toBeCloseTo(monoisotopicMass, 5);
    const panelRun = await analyze("panel", { format: "smiles", value: structure, methodIds: PLUGIN_PROPERTIES_METHODS });
    expect(panelRun.results.find(r => r.methodId === "rdkit.average-mass")).toMatchObject({ kind: "scalar", value: result.averageMass });
    expect(panelRun.results.find(r => r.methodId === "rdkit.monoisotopic-mass")).toMatchObject({ kind: "scalar", value: result.monoisotopicMass });
    expect(result.method).toMatchObject({ engine: "RDKit", version: panelRun.engines[0]!.version });
    expect(result.method.conventions.join(" ")).toContain("g/mol");
    expect(result.method.conventions.join(" ")).toContain("Da");
  });

  it("accepts a molfile without trimming its blank title line", async () => {
    const module = await ensureRdkit();
    const mol = module.get_mol("CCO")!;
    try {
      const result = await computePropertiesForPlugin({ format: "molfile", structure: mol.get_molblock!() }, client);
      expect(result).toMatchObject({ available: true, formula: "C2H6O" });
    } finally { mol.delete(); }
  });

  it.each(["invalid smiles", "C".repeat(501), "C".repeat(5001), ""])("declines invalid or oversized input", async structure => {
    expect(await computePropertiesForPlugin({ format: "smiles", structure }, client)).toMatchObject({ available: false, reason: expect.any(String) });
  });
  it("explains the character and heavy atom limits", async () => {
    expect(await computePropertiesForPlugin({ format: "smiles", structure: "C".repeat(5001) }, client)).toEqual({
      available: false, reason: "The structure is too long: 5001 characters; the limit is 5000."
    });
    expect(await computePropertiesForPlugin({ format: "smiles", structure: "C".repeat(501) }, client)).toEqual({
      available: false, reason: "The structure has 501 heavy atoms, over the 500 limit for this analysis."
    });
  });
  it("declines missing or failed engines", async () => {
    expect(await computePropertiesForPlugin({ format: "smiles", structure: "C" }, null)).toMatchObject({ available: false });
    expect(await computePropertiesForPlugin({ format: "smiles", structure: "C" }, { analyze: vi.fn().mockRejectedValue(new Error("engine unavailable")) } as unknown as AnalysisClient))
      .toMatchObject({ available: false, reason: expect.stringContaining("engine unavailable") });
  });
  it("uses separate slots for concurrent calls and requests only the three source methods", async () => {
    const spy = vi.fn(analyze);
    await Promise.all(["C", "CC"].map(structure => computePropertiesForPlugin({ format: "smiles", structure }, { analyze: spy } as unknown as AnalysisClient)));
    expect(spy.mock.calls[0]![0]).not.toBe(spy.mock.calls[1]![0]);
    expect(spy.mock.calls[0]![1].methodIds).toEqual(PLUGIN_PROPERTIES_METHODS);
  });
});
