/**
 * Runtime validation of the serializable request/result. `contracts.ts` remains the type source of
 * truth; these schemas exist to *prove* a value is serializable and well-formed at the boundaries
 * that matter — the worker message channel (M7) and the generic analysis store (M8) — and to back
 * the "result is schema-valid" tests.
 */
import { z } from "zod";

export const NmrNucleusSchema = z.enum(["1H", "13C"]);

export const ChemicalStructureInputSchema = z.object({
  format: z.enum(["smiles", "molfile-v2000", "molfile-v3000"]),
  value: z.string()
});

export const NmrPredictionOptionsSchema = z.object({
  statistic: z.enum(["median", "mean"]),
  hoseLevels: z.array(z.number()),
  ignoreLabileHydrogens: z.boolean()
});

export const NmrPredictionRequestSchema = z.object({
  structure: ChemicalStructureInputSchema,
  nuclei: z.array(NmrNucleusSchema).min(1),
  options: NmrPredictionOptionsSchema,
  sourceFingerprint: z.string().optional()
});

const NmrAtomReferenceSchema = z.object({
  sourceAtomIndex: z.number(),
  element: z.string(),
  equivalentCount: z.number().optional(),
  backendAtomId: z.string().optional(),
  chemDraftAtomId: z.string().optional()
});

const NmrPredictionEvidenceSchema = z.object({
  method: z.enum(["fixture-fragment", "hose-fragment", "gnn", "dft", "hybrid"]),
  matchedSphere: z.number().optional(),
  sampleCount: z.number().optional(),
  environmentCode: z.string().optional()
});

const NmrPredictionUncertaintySchema = z.object({
  standardDeviationPpm: z.number().optional(),
  minimumPpm: z.number().optional(),
  maximumPpm: z.number().optional()
});

const NmrResonanceSchema = z.object({
  id: z.string(),
  nucleus: NmrNucleusSchema,
  deltaPpm: z.number(),
  atomRefs: z.array(NmrAtomReferenceSchema),
  equivalentNuclei: z.number().optional(),
  uncertainty: NmrPredictionUncertaintySchema.optional(),
  evidence: NmrPredictionEvidenceSchema.optional(),
  flags: z.array(z.string())
});

const NmrPredictionBackendSchema = z.object({
  id: z.string(),
  version: z.string(),
  dataVersion: z.string().optional(),
  method: z.string(),
  license: z.string().optional(),
  attribution: z.string().optional(),
  source: z.string().optional()
});

const NmrPredictionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  atomIndices: z.array(z.number()).optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const NmrPredictionResultSchema = z.object({
  schemaVersion: z.literal("1"),
  sourceFingerprint: z.string(),
  backend: NmrPredictionBackendSchema,
  resonances: z.array(NmrResonanceSchema),
  warnings: z.array(NmrPredictionWarningSchema),
  generatedAt: z.string()
});
