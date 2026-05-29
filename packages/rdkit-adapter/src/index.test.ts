import { describe, expect, it } from "vitest";
import { createRdkitPlaceholderAdapter, rdkitAdapterStatus } from "./index";

describe("createRdkitPlaceholderAdapter", () => {
  it("reports honest placeholder capabilities", () => {
    const adapter = createRdkitPlaceholderAdapter();

    expect(rdkitAdapterStatus).toBe("placeholder");
    expect(adapter.getCapabilities()).toMatchObject({
      implementationName: "RDKit placeholder",
      supportedFormats: ["smiles"],
      canValidateStructure: true,
      canCalculateFormula: true,
      canCalculateAverageMass: true,
      canCalculateTotalCharge: true
    });
    expect(adapter.getCapabilities().warnings[0].code).toBe("rdkit.placeholder");
  });

  it("validates and calculates basic properties for fixture-backed SMILES", async () => {
    const adapter = createRdkitPlaceholderAdapter();

    const result = await adapter.analyzeStructure({ format: "smiles", value: "CCO" });

    expect(result.validation.valid).toBe(true);
    expect(result.properties).toMatchObject({
      formula: "C2H6O",
      averageMass: 46.069,
      exactMass: 46.0419,
      totalCharge: 0,
      atomCount: 3,
      bondCount: 2
    });
  });

  it("reports charge and stereochemistry limitations without claiming full RDKit support", async () => {
    const adapter = createRdkitPlaceholderAdapter();

    await expect(adapter.analyzeStructure({ format: "smiles", value: "[NH4+]" })).resolves.toMatchObject({
      validation: { valid: true },
      properties: { formula: "H4N", totalCharge: 1 }
    });

    const chiral = await adapter.analyzeStructure({ format: "smiles", value: "F[C@H](Cl)Br" });
    expect(chiral.validation.valid).toBe(true);
    expect(chiral.properties.stereochemistry).toEqual(["tetrahedral"]);
    expect(chiral.validation.warnings.map((warning) => warning.code)).toContain("stereochemistry.placeholder");
  });

  it("fails safely for unsupported formats and unknown structures", async () => {
    const adapter = createRdkitPlaceholderAdapter();

    await expect(adapter.validateStructure({ format: "molfile-v3000", value: "fixture" })).resolves.toMatchObject({
      valid: false,
      errors: [{ code: "structure.unsupported_format" }]
    });

    await expect(adapter.validateStructure({ format: "smiles", value: "not-a-fixture" })).resolves.toMatchObject({
      valid: false,
      warnings: [{ code: "structure.placeholder_unsupported" }]
    });
  });
});
