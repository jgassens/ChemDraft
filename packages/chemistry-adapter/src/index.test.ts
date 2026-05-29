import { describe, expect, it } from "vitest";
import type { ChemistryAdapter } from "./index";

describe("ChemistryAdapter contract", () => {
  it("supports validation and property analysis through one adapter boundary", async () => {
    const adapter: ChemistryAdapter = {
      id: "fixture",
      getCapabilities() {
        return {
          implementationName: "Fixture chemistry",
          supportedFormats: ["smiles"],
          canValidateStructure: true,
          canCalculateFormula: true,
          canCalculateAverageMass: true,
          canCalculateExactMass: false,
          canCalculateTotalCharge: true,
          canReportStereochemistryWarnings: false,
          warnings: []
        };
      },
      async validateStructure() {
        return { valid: true, errors: [], warnings: [] };
      },
      async analyzeStructure(input) {
        return {
          input,
          validation: { valid: true, errors: [], warnings: [] },
          properties: {
            formula: "CH4",
            averageMass: 16.043,
            totalCharge: 0,
            stereochemistry: []
          },
          warnings: []
        };
      }
    };

    await expect(adapter.analyzeStructure({ format: "smiles", value: "C" })).resolves.toMatchObject({
      validation: { valid: true },
      properties: { formula: "CH4", totalCharge: 0 }
    });
  });
});
