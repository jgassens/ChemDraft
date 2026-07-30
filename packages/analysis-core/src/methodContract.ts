/**
 * The machine-readable method contract (PLANS.md §10).
 *
 * "Each capability declares one contract … That single artifact generates documentation, tooltips,
 * test fixtures, acknowledgements, and half the result provenance — and it is what prevents the UI and
 * the science from drifting apart."
 *
 * Two rules make that true rather than aspirational:
 *
 * 1. A method may not ship without a contract. `MethodRegistry.register` validates, so a capability
 *    that forgot its declining conditions or its unit fails at registration, not in review.
 * 2. A tautomer-sensitive method may not run against an interpretation with no `tautomerPolicy`
 *    (§1). That is enforced here, at the seam where the two meet.
 */
import { z } from "zod";

import { ClassificationSchema, type Classification } from "./classification";
import { CitationRefSchema, DatasetRefSchema, UncertaintySchema, type CitationRef, type DatasetRef, type Uncertainty } from "./provenance";
import { assertTautomerPolicy, type MolecularInterpretation } from "./interpretation";
import { UnitIdSchema, type UnitId } from "./units";

export interface MethodImplementation {
  /** "rdkit-minimallib-wasm", "openchemlib", "chemdraft-native", "mopac" */
  engine: string;
  engineVersion: string;
  /** The exact entry point: `"JSMol::get_descriptors.tpsa"`, `"MoleculeProperties.getLogP"`. */
  symbol: string;
  /** Everything that changes the number and is not the molecule. Part of the cache key. */
  parameters: Record<string, string | number | boolean>;
}

export interface MethodContract {
  /** Stable id: `"rdkit.tpsa"`. Referenced by every result and by the cache key. */
  id: string;
  publicName: string;
  /** Bumped by anything in `versionIncrementTriggers`. Travels with each result. */
  version: string;
  implementation: MethodImplementation;
  defaultInterpretationId: string;
  resultKind: "scalar" | "identifier" | "composition" | "distribution" | "spectrum" | "geometry" | "orbital" | "correlation-map";
  /** Required for scalars and distributions; a number without a unit is not a result. */
  unit?: UnitId;
  /**
   * The choices a differently-but-defensibly-defined method would have made differently. RDKit and
   * OpenChemLib disagree on rotatable bonds in both directions; this is where the chosen rule is named
   * so the tooltip can show it (PLANS.md §7).
   */
  conventions: string[];
  classification: Classification;
  supportedChemistry: string[];
  knownUnsupportedChemistry: string[];
  /** The conditions under which the method returns `unsupported` or `not-applicable` rather than a number. */
  declinesWhen: string[];
  accuracyClaims: Uncertainty[];
  validationCorpus?: { datasetIds: string[]; provenanceNote: string };
  citations: CitationRef[];
  datasets: DatasetRef[];
  /** What obliges a version bump. Written down so the next person does not have to infer it. */
  versionIncrementTriggers: string[];
  /**
   * True when the answer depends on which tautomer is chosen. Forces an explicit `tautomerPolicy` on
   * any interpretation this method runs against — the wrong-tautomer NMR prediction is the classic
   * silent-wrong-answer case.
   */
  tautomerSensitive: boolean;
}

export const MethodImplementationSchema = z
  .object({
    engine: z.string().min(1),
    engineVersion: z.string().min(1),
    symbol: z.string().min(1),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
  })
  .strict();

export const MethodContractSchema = z
  .object({
    id: z.string().min(1),
    publicName: z.string().min(1),
    version: z.string().min(1),
    implementation: MethodImplementationSchema,
    defaultInterpretationId: z.string().min(1),
    resultKind: z.enum([
      "scalar",
      "identifier",
      "composition",
      "distribution",
      "spectrum",
      "geometry",
      "orbital",
      "correlation-map"
    ]),
    unit: UnitIdSchema.optional(),
    conventions: z.array(z.string().min(1)).default([]),
    classification: ClassificationSchema,
    supportedChemistry: z.array(z.string().min(1)).default([]),
    knownUnsupportedChemistry: z.array(z.string().min(1)).default([]),
    declinesWhen: z.array(z.string().min(1)).default([]),
    accuracyClaims: z.array(UncertaintySchema).default([]),
    validationCorpus: z
      .object({ datasetIds: z.array(z.string().min(1)), provenanceNote: z.string().min(1) })
      .strict()
      .optional(),
    citations: z.array(CitationRefSchema).default([]),
    datasets: z.array(DatasetRefSchema).default([]),
    versionIncrementTriggers: z.array(z.string().min(1)).default([]),
    tautomerSensitive: z.boolean()
  })
  .strict()
  .superRefine((contract, ctx) => {
    if ((contract.resultKind === "scalar" || contract.resultKind === "distribution") && !contract.unit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: `resultKind "${contract.resultKind}" requires a unit.`
      });
    }
    if (contract.declinesWhen.length === 0) {
      // A method that never declines is claiming universal applicability. If that is really true, say
      // so explicitly — an empty list reads as "nobody thought about it", and PLANS.md §10 is blunt
      // about which of the two is more dangerous.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declinesWhen"],
        message:
          "State at least one declining condition. If the method truly never declines, say so explicitly " +
          '(e.g. "never — composition is defined for any parsed structure").'
      });
    }
    if (contract.classification.flags.conventionDependent && contract.conventions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conventions"],
        message: "A convention-dependent method must name the conventions it chose."
      });
    }
    if (
      (contract.classification.flags.experimentallyCalibrated ||
        contract.classification.flags.trainedOnExperimentalData) &&
      contract.citations.length === 0 &&
      contract.datasets.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations"],
        message: "A calibrated or trained method must cite its parameters, training data, or both."
      });
    }
    if (contract.versionIncrementTriggers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionIncrementTriggers"],
        message: "State what obliges a version bump; otherwise the version stops meaning anything."
      });
    }
  });

/** The cache-key half a method owns: id, version, and every parameter that changes the number. */
export function methodKey(contract: MethodContract): string {
  const parameters = Object.keys(contract.implementation.parameters)
    .sort()
    .map((key) => `${key}=${String(contract.implementation.parameters[key])}`)
    .join(",");
  return `${contract.id}@${contract.version}[${contract.implementation.engine}@${contract.implementation.engineVersion}]{${parameters}}`;
}

export class MethodRegistry {
  readonly #contracts = new Map<string, MethodContract>();

  register(contract: MethodContract): MethodContract {
    const parsed = MethodContractSchema.parse(contract) as MethodContract;
    const existing = this.#contracts.get(parsed.id);
    if (existing && existing.version !== parsed.version) {
      throw new Error(
        `Method "${parsed.id}" is already registered at version ${existing.version}; ` +
          `refusing to shadow it with ${parsed.version}.`
      );
    }
    this.#contracts.set(parsed.id, parsed);
    return parsed;
  }

  get(id: string): MethodContract | undefined {
    return this.#contracts.get(id);
  }

  require(id: string): MethodContract {
    const contract = this.#contracts.get(id);
    if (!contract) throw new Error(`No method contract registered for "${id}".`);
    return contract;
  }

  list(): MethodContract[] {
    return [...this.#contracts.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Check a method against the interpretation it is about to run on. The §1 rule that cannot be
   * expressed in the type system lives here, so it is impossible to reach an engine call without
   * passing through it.
   */
  assertRunnable(id: string, interpretation: MolecularInterpretation): MethodContract {
    const contract = this.require(id);
    if (contract.tautomerSensitive) assertTautomerPolicy(interpretation, id);
    return contract;
  }
}
