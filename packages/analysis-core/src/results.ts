/**
 * The discriminated result union and the run that carries it (PLANS.md §3).
 *
 * Separate shared execution metadata from individual outputs, and make each result kind *require* what
 * it needs. A scalar with a unit, an identifier that stops masquerading as a property, a distribution
 * that must declare how it was truncated — none of these are the same shape, and one permissive
 * `{ value: unknown }` is how a spectrum ends up JSON-serialised field by field.
 *
 * **Payload transport, decided here rather than retrofitted.** Bulk numeric channels — spectra,
 * geometries, orbital grids, isotope envelopes — are `Float64Array`. They are structured-clone-safe
 * (so they cross the worker and plugin-panel bridges unchanged) *and* transferable (so a large grid
 * can move without a copy when ownership permits). Small fixed-arity data stays plain JSON. The rule
 * is: anything whose length scales with atom count, grid size, or point count is a typed array.
 *
 * **One documented extension to the plan's seven variants.** §3 lists Scalar, Identifier,
 * Distribution, Spectrum, Geometry, Orbital, and CorrelationMap. Release 1's first deliverable —
 * "source-preserving formula, charge, components, isotope specification" — has no home among them:
 * squeezing per-element counts and a per-component breakdown into an `IdentifierResult` string throws
 * away exactly the structure that makes a salt legible as a salt. `CompositionResult` is added for it,
 * recorded here so the extension is deliberate rather than drift.
 */
import { z } from "zod";

import { ClassificationSchema, type Classification } from "./classification";
import {
  AnalysisWarningSchema,
  ApplicabilitySchema,
  CitationRefSchema,
  DatasetRefSchema,
  RawArtifactRefSchema,
  UncertaintySchema,
  type AnalysisWarning,
  type Applicability,
  type CitationRef,
  type DatasetRef,
  type RawArtifactRef,
  type Uncertainty
} from "./provenance";
import { analysisHash, MolecularInterpretationSchema, type MolecularInterpretation } from "./interpretation";
import { UnitIdSchema, type UnitId } from "./units";

/** Bump when a field's meaning changes. Additive fields do not need a bump; reinterpretations do. */
export const AnalysisSchemaVersion = "chemdraft.analysis.v1" as const;

export type AnalysisStatus =
  | "ok"
  | "partial"
  | "unsupported"
  | "not-applicable"
  | "failed"
  | "cancelled"
  | "timed-out";

export const AnalysisStatusSchema = z.enum([
  "ok",
  "partial",
  "unsupported",
  "not-applicable",
  "failed",
  "cancelled",
  "timed-out"
]);

/** Statuses that carry a value. Everything else must null its payload. */
export function statusHasValue(status: AnalysisStatus): boolean {
  return status === "ok" || status === "partial";
}

export type AnalysisResultKind =
  | "scalar"
  | "identifier"
  | "composition"
  | "distribution"
  | "spectrum"
  | "geometry"
  | "orbital"
  | "correlation-map";

// --- shared base -----------------------------------------------------------------------------

export interface AnalysisResultBase {
  /** Stable within a run; what `AnalysisWarning.affectedResultIds` points at. */
  id: string;
  label: string;
  /** The contract this result came from. Version travels with the value, not just with the build. */
  methodId: string;
  methodVersion: string;
  /** Which named interpretation the number describes (PLANS.md §1). Never implicit. */
  interpretationId: string;
  status: AnalysisStatus;
  classification: Classification;
  applicability: Applicability;
  uncertainties: Uncertainty[];
  /**
   * The named choices the method made, copied from its contract when the value was computed (§2).
   *
   * Carried on the result rather than looked up from a registry, for the same reason `methodVersion`
   * is: a run is cached, serialised, and re-rendered later, and the convention that produced a number
   * is the one that was in force *then*. Reading it back from a live contract would relabel a cached
   * TPSA with whatever convention the current engine build happens to use — the silent-wrong-provenance
   * failure §3 exists to prevent, and precisely what the `includeSandP` rebuild made possible.
   */
  conventions: string[];
  citations: CitationRef[];
  datasets: DatasetRef[];
  warnings: AnalysisWarning[];
  /** Present for `seeded` and `stochastic` methods; its absence there is a reproducibility bug. */
  seed?: number;
  rawArtifacts: RawArtifactRef[];
}

const resultBaseShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  methodId: z.string().min(1),
  methodVersion: z.string().min(1),
  interpretationId: z.string().min(1),
  status: AnalysisStatusSchema,
  classification: ClassificationSchema,
  applicability: ApplicabilitySchema,
  uncertainties: z.array(UncertaintySchema).default([]),
  conventions: z.array(z.string().min(1)).default([]),
  citations: z.array(CitationRefSchema).default([]),
  datasets: z.array(DatasetRefSchema).default([]),
  warnings: z.array(AnalysisWarningSchema).default([]),
  seed: z.number().int().optional(),
  rawArtifacts: z.array(RawArtifactRefSchema).default([])
};

// --- variants --------------------------------------------------------------------------------

export interface ScalarResult extends AnalysisResultBase {
  kind: "scalar";
  value: number | null;
  unit: UnitId;
  /** Significant decimal places the method can defend. Rendering must not exceed it. */
  decimalPlaces?: number;
}

/**
 * InChI, InChIKey, SMILES, CAS — strings that identify rather than measure. A separate variant so they
 * stop appearing in a properties table between logP and TPSA as though they were quantities.
 */
export interface IdentifierResult extends AnalysisResultBase {
  kind: "identifier";
  identifierType: "inchi" | "inchikey" | "smiles" | "canonical-smiles" | "molblock" | "cas" | "iupac-name";
  value: string | null;
  /** e.g. `"standard"` vs `"non-standard"` InChI, or the SMILES flavour. Conventions are not free text elsewhere. */
  flavour?: string;
}

export interface ElementCount {
  symbol: string;
  count: number;
  /** Mass number when the atom carries an explicit isotope label; absent for natural-abundance atoms. */
  isotope?: number;
}

export interface CompositionComponent {
  /** Hill-notation formula for this connected component. */
  formula: string;
  charge: number;
  /** How many copies of this component the input contains. */
  multiplicity: number;
  elements: ElementCount[];
  /** Source atom indices belonging to this component, so a UI can highlight the counterion it named. */
  sourceAtomIndices: number[];
}

/**
 * Formula, charge, and per-component breakdown, source-preserving by default.
 *
 * `components.length > 1` is the salt case the whole interpretation ledger exists for: this result
 * describes what the user drew, and any neutralised or largest-fragment view is a *different* result
 * against a *different* interpretation, side by side rather than in place of it.
 */
export interface CompositionResult extends AnalysisResultBase {
  kind: "composition";
  /** Hill notation for the whole input under this interpretation. */
  formula: string | null;
  formalCharge: number | null;
  elements: ElementCount[];
  components: CompositionComponent[];
  /** True when at least one atom carries an explicit isotope label that the formula reflects. */
  hasExplicitIsotopes: boolean;
  radicalElectronCount: number;
}

/**
 * An isotope envelope, or any other set of (position, intensity) pairs that is not a spectrum.
 *
 * `truncation` is required, not optional. An envelope is always cut off somewhere, and an intensity
 * list without its cutoff rule cannot be compared against another engine's — PLANS.md §9 makes
 * recording it a Release 2 gate.
 */
export interface DistributionResult extends AnalysisResultBase {
  kind: "distribution";
  positions: Float64Array;
  intensities: Float64Array;
  positionUnit: UnitId;
  intensityUnit: UnitId;
  truncation: {
    policy: "relative-intensity-threshold" | "cumulative-probability" | "peak-count" | "none";
    threshold: number;
    /** Total probability the retained peaks account for, where the engine reports it. */
    coveredProbability?: number;
  };
}

export interface SpectrumAxis {
  label: string;
  unit: UnitId;
  /** Chemical-shift axes run right-to-left; a renderer must not have to guess. */
  reversed: boolean;
}

export interface SpectrumResult extends AnalysisResultBase {
  kind: "spectrum";
  axis: SpectrumAxis;
  intensityAxis: SpectrumAxis;
  stickPositions: Float64Array;
  stickIntensities: Float64Array;
  /** Lineshape is a simulation parameter, never a measurement (AGENTS.md §8a). */
  broadening?: { lineshape: "lorentzian" | "gaussian" | "none"; widthHz: number };
  /** Spectrometer frequency where the simulation used one. Also a parameter, not an instrument. */
  fieldMHz?: number;
}

export interface GeometryResult extends AnalysisResultBase {
  kind: "geometry";
  /** Flat [x,y,z, …] in the result's own atom order. */
  coordinates: Float64Array;
  coordinateUnit: UnitId;
  /** Result atom index → source atom index; `-1` for an atom the engine added. */
  atomToSourceAtom: Int32Array;
  conformerId?: string;
}

export interface OrbitalResult extends AnalysisResultBase {
  kind: "orbital";
  gridDimensions: readonly [number, number, number];
  gridOrigin: readonly [number, number, number];
  gridSpacing: readonly [number, number, number];
  values: Float64Array;
  isovalue: number;
  basis: string;
  orbitalIndex?: number;
}

/**
 * Graph-derived HSQC/HMBC/COSY connectivity.
 *
 * `presentation` is a required literal, and the reason is §6: HMBC depends on longer-range coupling and
 * suppression conditions, COSY reflects scalar coupling rather than graph distance. These are
 * **candidate correlation maps**, never simulated spectra, and the type refuses to let a renderer
 * decide otherwise.
 */
export interface CorrelationMapResult extends AnalysisResultBase {
  kind: "correlation-map";
  experiment: "hsqc" | "hmbc" | "cosy" | "noesy";
  presentation: "candidate-correlation-map";
  correlations: {
    sourceAtomA: number;
    sourceAtomB: number;
    /** Honest tiers only — no calibrated confidence percentages (AGENTS.md §8a, ADR-0020). */
    tier: "expected" | "possible" | "unlikely";
    bondSeparation: number;
  }[];
}

export type AnalysisResult =
  | ScalarResult
  | IdentifierResult
  | CompositionResult
  | DistributionResult
  | SpectrumResult
  | GeometryResult
  | OrbitalResult
  | CorrelationMapResult;

// --- schemas ---------------------------------------------------------------------------------

const float64ArraySchema = z.instanceof(Float64Array);
const int32ArraySchema = z.instanceof(Int32Array);

const ElementCountSchema = z
  .object({
    symbol: z.string().min(1).max(3),
    count: z.number().int().positive(),
    isotope: z.number().int().positive().optional()
  })
  .strict();

const CompositionComponentSchema = z
  .object({
    formula: z.string().min(1),
    charge: z.number().int(),
    multiplicity: z.number().int().positive(),
    elements: z.array(ElementCountSchema),
    sourceAtomIndices: z.array(z.number().int().nonnegative()).default([])
  })
  .strict();

const ScalarResultSchema = z
  .object({ ...resultBaseShape, kind: z.literal("scalar"), value: z.number().finite().nullable(), unit: UnitIdSchema, decimalPlaces: z.number().int().nonnegative().optional() })
  .strict();

const IdentifierResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("identifier"),
    identifierType: z.enum(["inchi", "inchikey", "smiles", "canonical-smiles", "molblock", "cas", "iupac-name"]),
    value: z.string().min(1).nullable(),
    flavour: z.string().min(1).optional()
  })
  .strict();

const CompositionResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("composition"),
    formula: z.string().min(1).nullable(),
    formalCharge: z.number().int().nullable(),
    elements: z.array(ElementCountSchema).default([]),
    components: z.array(CompositionComponentSchema).default([]),
    hasExplicitIsotopes: z.boolean(),
    radicalElectronCount: z.number().int().nonnegative()
  })
  .strict();

const DistributionResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("distribution"),
    positions: float64ArraySchema,
    intensities: float64ArraySchema,
    positionUnit: UnitIdSchema,
    intensityUnit: UnitIdSchema,
    truncation: z
      .object({
        policy: z.enum(["relative-intensity-threshold", "cumulative-probability", "peak-count", "none"]),
        threshold: z.number().finite().nonnegative(),
        coveredProbability: z.number().gt(0).lte(1).optional()
      })
      .strict()
  })
  .strict();

const SpectrumAxisSchema = z
  .object({ label: z.string().min(1), unit: UnitIdSchema, reversed: z.boolean() })
  .strict();

const SpectrumResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("spectrum"),
    axis: SpectrumAxisSchema,
    intensityAxis: SpectrumAxisSchema,
    stickPositions: float64ArraySchema,
    stickIntensities: float64ArraySchema,
    broadening: z
      .object({ lineshape: z.enum(["lorentzian", "gaussian", "none"]), widthHz: z.number().finite().nonnegative() })
      .strict()
      .optional(),
    fieldMHz: z.number().finite().positive().optional()
  })
  .strict();

const GeometryResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("geometry"),
    coordinates: float64ArraySchema,
    coordinateUnit: UnitIdSchema,
    atomToSourceAtom: int32ArraySchema,
    conformerId: z.string().min(1).optional()
  })
  .strict();

const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const OrbitalResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("orbital"),
    gridDimensions: z.tuple([
      z.number().int().positive(),
      z.number().int().positive(),
      z.number().int().positive()
    ]),
    gridOrigin: vec3Schema,
    gridSpacing: vec3Schema,
    values: float64ArraySchema,
    isovalue: z.number().finite(),
    basis: z.string().min(1),
    orbitalIndex: z.number().int().optional()
  })
  .strict();

const CorrelationMapResultSchema = z
  .object({
    ...resultBaseShape,
    kind: z.literal("correlation-map"),
    experiment: z.enum(["hsqc", "hmbc", "cosy", "noesy"]),
    presentation: z.literal("candidate-correlation-map"),
    correlations: z.array(
      z
        .object({
          sourceAtomA: z.number().int().nonnegative(),
          sourceAtomB: z.number().int().nonnegative(),
          tier: z.enum(["expected", "possible", "unlikely"]),
          bondSeparation: z.number().int().positive()
        })
        .strict()
    )
  })
  .strict();

/** The payload field each variant nulls when its status carries no value. */
function payloadIsAbsent(result: AnalysisResult): boolean {
  switch (result.kind) {
    case "scalar":
    case "identifier":
      return result.value === null;
    case "composition":
      return result.formula === null && result.formalCharge === null;
    case "distribution":
      return result.positions.length === 0;
    case "spectrum":
      return result.stickPositions.length === 0;
    case "geometry":
      return result.coordinates.length === 0;
    case "orbital":
      return result.values.length === 0;
    case "correlation-map":
      return result.correlations.length === 0;
  }
}

export const AnalysisResultSchema = z
  .discriminatedUnion("kind", [
    ScalarResultSchema,
    IdentifierResultSchema,
    CompositionResultSchema,
    DistributionResultSchema,
    SpectrumResultSchema,
    GeometryResultSchema,
    OrbitalResultSchema,
    CorrelationMapResultSchema
  ])
  .superRefine((result, ctx) => {
    const typed = result as AnalysisResult;

    // A non-value status that still carries a payload is the exact failure mode the status enum
    // exists to prevent: a stale or partial number rendered as though the run succeeded.
    if (!statusHasValue(typed.status) && !payloadIsAbsent(typed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: `Status "${typed.status}" must not carry a payload; clear the value.`
      });
    }
    if (typed.status === "ok" && payloadIsAbsent(typed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: 'Status "ok" requires a payload; use "partial", "unsupported", or "not-applicable".'
      });
    }
    // Silence is the thing to forbid. Every non-ok outcome names itself.
    if (typed.status !== "ok" && typed.warnings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warnings"],
        message: `Status "${typed.status}" requires at least one warning explaining it.`
      });
    }
    if (typed.classification.determinism !== "deterministic" && typed.seed === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seed"],
        message: `Determinism "${typed.classification.determinism}" requires a recorded seed.`
      });
    }
    if (typed.kind === "distribution" && typed.positions.length !== typed.intensities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intensities"],
        message: "positions and intensities must have equal length."
      });
    }
    if (typed.kind === "spectrum" && typed.stickPositions.length !== typed.stickIntensities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stickIntensities"],
        message: "stickPositions and stickIntensities must have equal length."
      });
    }
    if (typed.kind === "geometry" && typed.coordinates.length !== typed.atomToSourceAtom.length * 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coordinates"],
        message: "coordinates must hold exactly three values per atom in atomToSourceAtom."
      });
    }
    if (typed.kind === "orbital") {
      const [nx, ny, nz] = typed.gridDimensions;
      if (typed.values.length !== nx * ny * nz) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["values"],
          message: `values must hold ${nx * ny * nz} points for grid ${nx}×${ny}×${nz}.`
        });
      }
    }
  });

// --- the run ---------------------------------------------------------------------------------

export interface EngineEnvironment {
  /** "rdkit-minimallib-wasm", "openchemlib", "mopac", … */
  name: string;
  version: string;
  /** Hashes of the executable, model, and data artifacts the run depended on. */
  artifactHashes: string[];
  platform?: string;
}

/**
 * Shared execution metadata for a set of results (PLANS.md §3).
 *
 * Deliberately lean for Release 1 — in-process descriptors do not need job scheduling — but the shape
 * is the one the sidecar layer grows into, so the boundary does not move when MOPAC arrives.
 */
export interface AnalysisRun {
  schemaVersion: typeof AnalysisSchemaVersion;
  runId: string;
  sourceHash: string;
  /** Every interpretation any result in this run was computed against. */
  interpretations: MolecularInterpretation[];
  engines: EngineEnvironment[];
  startedAt: string;
  finishedAt?: string;
  status: AnalysisStatus;
  results: AnalysisResult[];
  warnings: AnalysisWarning[];
  /** Deterministic over inputs: same source, interpretations, methods, and engines → same fingerprint. */
  fingerprint: string;
}

export const EngineEnvironmentSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    artifactHashes: z.array(z.string().min(1)).default([]),
    platform: z.string().min(1).optional()
  })
  .strict();

export const AnalysisRunSchema = z
  .object({
    schemaVersion: z.literal(AnalysisSchemaVersion),
    runId: z.string().min(1),
    sourceHash: z.string().min(1),
    interpretations: z.array(MolecularInterpretationSchema).min(1),
    engines: z.array(EngineEnvironmentSchema).default([]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    status: AnalysisStatusSchema,
    results: z.array(AnalysisResultSchema).default([]),
    warnings: z.array(AnalysisWarningSchema).default([]),
    fingerprint: z.string().min(1)
  })
  .strict()
  .superRefine((run, ctx) => {
    const known = new Set(run.interpretations.map((interpretation) => interpretation.id));
    for (const [index, result] of run.results.entries()) {
      if (!known.has(result.interpretationId)) {
        // An unlisted interpretation id means the result's provenance cannot be reconstructed — which
        // is worse than a missing result, because it still renders.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["results", index, "interpretationId"],
          message: `Result references interpretation "${result.interpretationId}", which the run does not carry.`
        });
      }
    }
    const resultIds = new Set(run.results.map((result) => result.id));
    for (const [index, warning] of run.warnings.entries()) {
      for (const affected of warning.affectedResultIds) {
        if (!resultIds.has(affected)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["warnings", index, "affectedResultIds"],
            message: `Warning "${warning.code}" points at unknown result "${affected}".`
          });
        }
      }
    }
  });

/**
 * A run's status is the worst of its results', ordered worst-first so `find` returns the dominant
 * outcome — with one deliberate exception.
 *
 * **`not-applicable` does not drag a run down.** A method that does not apply to this structure is its
 * contract working, not a shortfall: aspirin has no nitrogen, so "[M+H−NH₃]⁺" correctly does not
 * apply, and a run that reported `not-applicable` overall because of it would tell the user something
 * went wrong with an analysis in which nothing did. `unsupported` still counts, because that IS a
 * capability gap worth putting in the headline.
 *
 * A run where *everything* was inapplicable is still `not-applicable` — there, it is the whole story.
 */
const STATUS_SEVERITY: readonly Exclude<AnalysisStatus, "not-applicable">[] = [
  "failed",
  "timed-out",
  "cancelled",
  "unsupported",
  "partial",
  "ok"
];

export function aggregateStatus(statuses: readonly AnalysisStatus[]): AnalysisStatus {
  if (statuses.length === 0) return "ok";
  const applicable = statuses.filter(
    (status): status is Exclude<AnalysisStatus, "not-applicable"> => status !== "not-applicable"
  );
  if (applicable.length === 0) return "not-applicable";
  return STATUS_SEVERITY.find((candidate) => applicable.includes(candidate)) ?? "ok";
}

/**
 * Deterministic over the run's inputs, and over nothing else: no timestamps, no run id, no result
 * values. Two runs of the same methods, on the same source, under the same interpretations and the
 * same engine artifacts must fingerprint identically — that is what makes a differing fingerprint
 * mean "something in the pipeline changed" rather than "time passed".
 */
export function runFingerprint(input: {
  sourceHash: string;
  interpretationHashes: readonly string[];
  methodKeys: readonly string[];
  engineHashes: readonly string[];
}): string {
  return analysisHash(
    [
      input.sourceHash,
      [...input.interpretationHashes].sort().join(","),
      [...input.methodKeys].sort().join(","),
      [...input.engineHashes].sort().join(",")
    ].join(" ")
  );
}
