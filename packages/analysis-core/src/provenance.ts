/**
 * Provenance primitives shared by every analysis result (PLANS.md §3).
 *
 * Uncertainty, applicability, citations, dataset references, warning codes, and raw-artifact
 * references. Each exists because omitting it produced a specific failure the plan names:
 *
 * - Uncertainty is a **list**, because a method can carry both a validation-set RMSE and a
 *   per-structure interval, and collapsing them loses the distinction.
 * - `metric: "unknown"` is a first-class member, not a gap. Where redistributable validation data is
 *   scarce — logP and pKa especially — the honest answer is "no quantified uncertainty, here is the
 *   citation". The schema makes that sayable and forbids the alternative of inventing a number.
 * - Applicability is separate from status: a method can succeed mechanically and still be answering
 *   about a molecule outside its domain. "A predictor that returns a number for everything is more
 *   dangerous than one that explicitly declines an out-of-domain structure."
 * - Warnings carry **codes** and the ids of the results they affect, so a UI can attach a warning to
 *   the value it undermines instead of dumping prose at the bottom of a panel.
 */
import { z } from "zod";

import { UnitIdSchema, type UnitId } from "./units";

// --- citations and datasets ------------------------------------------------------------------

export type CitationKind = "journal" | "book" | "software" | "dataset" | "standard" | "specification";

export interface CitationRef {
  id: string;
  kind: CitationKind;
  title: string;
  authors?: string;
  year?: number;
  doi?: string;
  url?: string;
  /** Version of the cited software or specification, where the citation is to a versioned artifact. */
  version?: string;
}

export const CitationRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["journal", "book", "software", "dataset", "standard", "specification"]),
    title: z.string().min(1),
    authors: z.string().min(1).optional(),
    year: z.number().int().optional(),
    doi: z.string().min(1).optional(),
    url: z.string().url().optional(),
    version: z.string().min(1).optional()
  })
  .strict();

/**
 * A dataset a method depends on — training data, a parameter table, a reference database.
 *
 * `redistributable` is not decoration. The nmrshiftdb2 case (PLANS.md §4) is exactly a dataset whose
 * terms travel with any redistribution independently of the code's licence, and the acknowledgements
 * view is generated from these records rather than maintained by hand.
 */
export interface DatasetRef {
  id: string;
  title: string;
  version: string;
  source: string;
  license: string;
  redistributable: boolean;
  recordCount?: number;
  /** Content hash of the shipped artifact, so a data swap is a visible change. */
  checksum?: string;
  /** Anything the licence obliges a redistributor to do — attribution, share-alike, notice files. */
  obligations?: string[];
}

export const DatasetRefSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    version: z.string().min(1),
    source: z.string().min(1),
    license: z.string().min(1),
    redistributable: z.boolean(),
    recordCount: z.number().int().nonnegative().optional(),
    checksum: z.string().min(1).optional(),
    obligations: z.array(z.string().min(1)).optional()
  })
  .strict();

// --- uncertainty -----------------------------------------------------------------------------

export type UncertaintyMetric =
  | "standard-deviation"
  | "standard-error"
  | "rmse"
  | "mae"
  | "confidence-interval"
  | "prediction-interval"
  | "range"
  | "unknown";

export interface Uncertainty {
  metric: UncertaintyMetric;
  /** Magnitude for the single-number metrics. Absent — and forbidden — when metric is "unknown". */
  value?: number;
  /** Interval bounds, in the result's own units. Both or neither. */
  lower?: number;
  upper?: number;
  /** e.g. 0.95 for a 95% interval. Only meaningful for the interval metrics. */
  coverageProbability?: number;
  unit: UnitId;
  /** What the number was computed over: "validation set of 1128 measured logP values", and so on. */
  basis: string;
  citationId?: string;
}

export const UncertaintySchema = z
  .object({
    metric: z.enum([
      "standard-deviation",
      "standard-error",
      "rmse",
      "mae",
      "confidence-interval",
      "prediction-interval",
      "range",
      "unknown"
    ]),
    value: z.number().finite().nonnegative().optional(),
    lower: z.number().finite().optional(),
    upper: z.number().finite().optional(),
    coverageProbability: z.number().gt(0).lte(1).optional(),
    unit: UnitIdSchema,
    basis: z.string().min(1),
    citationId: z.string().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.metric === "unknown") {
      // The whole point of the "unknown" member is that it carries no number. Allowing one back in
      // would let a placeholder masquerade as a quantified uncertainty.
      for (const field of ["value", "lower", "upper", "coverageProbability"] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `Uncertainty with metric "unknown" must not carry ${field}; state the basis instead.`
          });
        }
      }
      return;
    }
    const hasInterval = value.lower !== undefined || value.upper !== undefined;
    if (hasInterval && (value.lower === undefined || value.upper === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lower"],
        message: "An uncertainty interval needs both lower and upper bounds."
      });
    }
    if (hasInterval && value.lower !== undefined && value.upper !== undefined && value.lower > value.upper) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lower"], message: "lower must not exceed upper." });
    }
    if (value.value === undefined && !hasInterval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `Uncertainty with metric "${value.metric}" needs a value or an interval; use "unknown" if there is none.`
      });
    }
  });

/** The honest placeholder: no quantified uncertainty, and a stated reason. */
export function unknownUncertainty(unit: UnitId, basis: string, citationId?: string): Uncertainty {
  return { metric: "unknown", unit, basis, ...(citationId ? { citationId } : {}) };
}

// --- applicability ---------------------------------------------------------------------------

export type ApplicabilityStatus = "in-domain" | "borderline" | "out-of-domain" | "undetermined";

export interface Applicability {
  status: ApplicabilityStatus;
  /** Why — in terms a chemist can check: "contains boron; Crippen tables have no boron parameters". */
  reasons: string[];
  /** Structural features the method could not handle, named individually. */
  unsupportedFeatures: string[];
}

export const ApplicabilitySchema = z
  .object({
    status: z.enum(["in-domain", "borderline", "out-of-domain", "undetermined"]),
    reasons: z.array(z.string().min(1)).default([]),
    unsupportedFeatures: z.array(z.string().min(1)).default([])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status !== "in-domain" && value.reasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasons"],
        message: `Applicability "${value.status}" must state at least one reason.`
      });
    }
  });

export const inDomain: Applicability = { status: "in-domain", reasons: [], unsupportedFeatures: [] };

// --- warnings --------------------------------------------------------------------------------

export type AnalysisWarningSeverity = "info" | "warning" | "error";

/**
 * Warnings are codes, not prose. `AGENTS.md` §14 wants explicit errors; §8a forbids runtime failures
 * being smuggled into free text. `affectedResultIds` is what lets the UI put the warning on the value
 * rather than in a footer.
 */
export interface AnalysisWarning {
  code: string;
  severity: AnalysisWarningSeverity;
  message: string;
  affectedResultIds: string[];
}

export const AnalysisWarningSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    affectedResultIds: z.array(z.string().min(1)).default([])
  })
  .strict();

// --- raw artifacts ---------------------------------------------------------------------------

/**
 * A pointer to something too large or too engine-specific to inline — a MOPAC output deck, a WASM
 * log, a molblock the engine actually consumed. Reference, never payload: results stay
 * structured-clone-safe and small enough to cross the worker and panel bridges.
 */
export interface RawArtifactRef {
  id: string;
  kind: "input-deck" | "engine-output" | "log" | "molblock" | "coordinates";
  mediaType: string;
  byteLength: number;
  /** Where the run stashed it. Retention is the job layer's business (PLANS.md §5). */
  location: string;
  checksum?: string;
}

export const RawArtifactRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["input-deck", "engine-output", "log", "molblock", "coordinates"]),
    mediaType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    location: z.string().min(1),
    checksum: z.string().min(1).optional()
  })
  .strict();
