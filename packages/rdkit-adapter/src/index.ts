import type {
  ChemistryAdapter,
  ChemistryAdapterCapabilities,
  ChemistryStructureInput,
  ChemistryWarning,
  StructureAnalysisResult,
  StructureProperties,
  StructureValidationResult
} from "@chemdraft/chemistry-adapter";

export const rdkitAdapterStatus = "placeholder" as const;

const placeholderWarning: ChemistryWarning = {
  code: "rdkit.placeholder",
  message: "RDKit is not bundled; this adapter provides fixture-backed Phase 5 chemistry checks only.",
  severity: "warning"
};

export const rdkitPlaceholderCapabilities: ChemistryAdapterCapabilities = {
  implementationName: "RDKit placeholder",
  implementationVersion: "0.0.0",
  supportedFormats: ["smiles"],
  canValidateStructure: true,
  canCalculateFormula: true,
  canCalculateAverageMass: true,
  canCalculateExactMass: true,
  canCalculateTotalCharge: true,
  canReportStereochemistryWarnings: true,
  warnings: [placeholderWarning]
};

interface FixtureAnalysis {
  properties: StructureProperties;
  warnings?: ChemistryWarning[];
}

const fixtureAnalyses = new Map<string, FixtureAnalysis>([
  [
    "C",
    {
      properties: {
        formula: "CH4",
        averageMass: 16.043,
        exactMass: 16.0313,
        totalCharge: 0,
        atomCount: 1,
        bondCount: 0,
        stereochemistry: []
      }
    }
  ],
  [
    "CCO",
    {
      properties: {
        formula: "C2H6O",
        averageMass: 46.069,
        exactMass: 46.0419,
        totalCharge: 0,
        atomCount: 3,
        bondCount: 2,
        stereochemistry: []
      }
    }
  ],
  [
    "c1ccccc1",
    {
      properties: {
        formula: "C6H6",
        averageMass: 78.114,
        exactMass: 78.047,
        totalCharge: 0,
        atomCount: 6,
        bondCount: 6,
        stereochemistry: []
      }
    }
  ],
  [
    "[NH4+]",
    {
      properties: {
        formula: "H4N",
        averageMass: 18.039,
        exactMass: 18.0344,
        totalCharge: 1,
        atomCount: 1,
        bondCount: 0,
        stereochemistry: []
      }
    }
  ],
  [
    "F[C@H](Cl)Br",
    {
      properties: {
        formula: "CHBrClF",
        averageMass: 147.374,
        totalCharge: 0,
        atomCount: 4,
        bondCount: 3,
        stereochemistry: ["tetrahedral"]
      },
      warnings: [
        {
          code: "stereochemistry.placeholder",
          message: "Stereochemistry was detected, but assignment requires a real chemistry engine.",
          severity: "warning"
        }
      ]
    }
  ]
]);

export function createRdkitPlaceholderAdapter(): ChemistryAdapter {
  return {
    id: "rdkit-placeholder",
    getCapabilities() {
      return rdkitPlaceholderCapabilities;
    },
    async validateStructure(input) {
      return validateFixture(input);
    },
    async analyzeStructure(input) {
      const validation = validateFixture(input);
      const fixture = validation.valid ? fixtureAnalyses.get(normalizeInput(input.value)) : undefined;
      const fixtureWarnings = fixture?.warnings ?? [];
      const warnings = [...rdkitPlaceholderCapabilities.warnings, ...validation.warnings, ...fixtureWarnings];

      return {
        input,
        validation: {
          ...validation,
          warnings: [...validation.warnings, ...fixtureWarnings]
        },
        properties: fixture?.properties ?? { stereochemistry: [] },
        warnings
      };
    }
  };
}

function validateFixture(input: ChemistryStructureInput): StructureValidationResult {
  if (input.format !== "smiles") {
    const error = {
      code: "structure.unsupported_format",
      message: `RDKit placeholder only supports SMILES input, received "${input.format}".`,
      severity: "error" as const
    };
    return { valid: false, errors: [error], warnings: [] };
  }

  const normalized = normalizeInput(input.value);
  if (normalized.length === 0) {
    const error = {
      code: "structure.empty",
      message: "Structure input is empty.",
      severity: "error" as const
    };
    return { valid: false, errors: [error], warnings: [] };
  }

  if (!fixtureAnalyses.has(normalized)) {
    const warning = {
      code: "structure.placeholder_unsupported",
      message: `SMILES "${normalized}" is outside the placeholder fixture set.`,
      severity: "warning" as const
    };
    return { valid: false, errors: [], warnings: [warning] };
  }

  return { valid: true, errors: [], warnings: [] };
}

function normalizeInput(value: string): string {
  return value.trim();
}
