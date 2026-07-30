/**
 * The `ChemistryAdapter` surface, now backed by the real engine.
 *
 * Replaces the placeholder suite, which asserted hand-entered masses for ten hardcoded SMILES and
 * rejected everything else as "outside the placeholder fixture set".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetRdkitForTesting } from "./conformer";
import { createRdkitAdapter, rdkitAdapterStatus } from "./index";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

const ETHANOL_MOLFILE = `
  Mrv

  3  2  0  0  0  0            999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.5981    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
M  END
`;

describe("createRdkitAdapter", () => {
  it("reports real capabilities with no placeholder warning", () => {
    const adapter = createRdkitAdapter();

    expect(rdkitAdapterStatus).toBe("real");
    expect(adapter.id).toBe("rdkit-minimallib-wasm");
    expect(adapter.getCapabilities()).toMatchObject({
      implementationName: "RDKit MinimalLib (WASM)",
      implementationVersion: "2026.03.3",
      supportedFormats: ["smiles", "molfile-v2000", "molfile-v3000"],
      canValidateStructure: true,
      canCalculateFormula: true
    });
    expect(adapter.getCapabilities().warnings).toEqual([]);
  });

  it("analyses an arbitrary structure, not just a fixture", async () => {
    const adapter = createRdkitAdapter();
    // Caffeine was never in the placeholder's fixture set, so the old adapter refused it outright.
    const result = await adapter.analyzeStructure({ format: "smiles", value: "Cn1cnc2c1c(=O)n(C)c(=O)n2C" });

    expect(result.validation.valid).toBe(true);
    expect(result.properties).toMatchObject({
      formula: "C8H10N4O2",
      totalCharge: 0,
      atomCount: 14,
      bondCount: 15
    });
    expect(result.properties.averageMass).toBeCloseTo(194.194, 3);
    expect(result.properties.exactMass).toBeCloseTo(194.080376, 6);
  });

  it("reads molfiles, which the SMILES-only placeholder rejected", async () => {
    const adapter = createRdkitAdapter();
    const result = await adapter.analyzeStructure({ format: "molfile-v2000", value: ETHANOL_MOLFILE });

    expect(result.validation.valid).toBe(true);
    expect(result.properties).toMatchObject({ formula: "C2H6O", totalCharge: 0, atomCount: 3, bondCount: 2 });
  });

  it("reports real CIP descriptors rather than a coarse stereo category", async () => {
    const adapter = createRdkitAdapter();
    const result = await adapter.analyzeStructure({ format: "smiles", value: "C[C@H](O)C(=O)O" });
    expect(result.properties.stereochemistry).toEqual(["atom 1 (S)"]);
  });

  it("surfaces a decline as a warning even though StructureProperties has no room for it", async () => {
    // The narrower contract cannot carry per-method status, so the decline has to reach a caller some
    // other way. If it did not, "logP unavailable" would be indistinguishable from "logP not asked for".
    const adapter = createRdkitAdapter();
    const result = await adapter.analyzeStructure({ format: "smiles", value: "[Na+].[O-]C(=O)c1ccccc1" });

    expect(result.validation.valid).toBe(true);
    expect(result.properties.formula).toBe("C7H5NaO2");
    const declines = result.warnings.filter((warning) => warning.code === "method.unparameterized_element");
    expect(declines.length).toBeGreaterThan(0);
    expect(declines.some((warning) => warning.message.includes("Crippen logP"))).toBe(true);
    expect(declines.every((warning) => warning.message.includes("Na"))).toBe(true);
  });

  it("rejects a format it cannot read", async () => {
    const adapter = createRdkitAdapter();
    await expect(adapter.validateStructure({ format: "unknown", value: "anything" })).resolves.toMatchObject({
      valid: false,
      errors: [{ code: "structure.unsupported_format" }]
    });
  });

  it("invalidates a structure the engine cannot parse, and reports no properties for it", async () => {
    const adapter = createRdkitAdapter();

    await expect(adapter.validateStructure({ format: "smiles", value: "C1CC" })).resolves.toMatchObject({
      valid: false,
      errors: [{ code: "structure.parse_failed" }]
    });

    const analysis = await adapter.analyzeStructure({ format: "smiles", value: "C1CC" });
    expect(analysis.validation.valid).toBe(false);
    expect(analysis.properties).toEqual({ stereochemistry: [] });
  });

  it("invalidates empty input", async () => {
    const adapter = createRdkitAdapter();
    await expect(adapter.validateStructure({ format: "smiles", value: "" })).resolves.toMatchObject({
      valid: false,
      errors: [{ code: "structure.empty" }]
    });
  });
});
