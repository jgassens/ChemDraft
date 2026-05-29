export type ChemistryStructureFormat = "smiles" | "molfile-v2000" | "molfile-v3000" | "rxnfile" | "unknown";

export interface ChemistryWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

export interface ChemistryStructureInput {
  format: ChemistryStructureFormat;
  value: string;
}

export interface ChemistryAdapterCapabilities {
  implementationName: string;
  implementationVersion?: string;
  supportedFormats: readonly ChemistryStructureFormat[];
  canValidateStructure: boolean;
  canCalculateFormula: boolean;
  canCalculateAverageMass: boolean;
  canCalculateExactMass: boolean;
  canCalculateTotalCharge: boolean;
  canReportStereochemistryWarnings: boolean;
  warnings: readonly ChemistryWarning[];
}

export interface StructureValidationResult {
  valid: boolean;
  errors: ChemistryWarning[];
  warnings: ChemistryWarning[];
}

export interface StructureProperties {
  formula?: string;
  averageMass?: number;
  exactMass?: number;
  totalCharge?: number;
  atomCount?: number;
  bondCount?: number;
  stereochemistry: string[];
}

export interface StructureAnalysisResult {
  input: ChemistryStructureInput;
  validation: StructureValidationResult;
  properties: StructureProperties;
  warnings: ChemistryWarning[];
}

export interface ChemistryAdapter {
  readonly id: string;
  getCapabilities(): ChemistryAdapterCapabilities;
  validateStructure(input: ChemistryStructureInput): Promise<StructureValidationResult>;
  analyzeStructure(input: ChemistryStructureInput): Promise<StructureAnalysisResult>;
}
