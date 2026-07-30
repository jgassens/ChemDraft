/**
 * Three-axis classification with behaviour on the flags (PLANS.md §2).
 *
 * The load-bearing rule, and the reason an earlier single `ScientificClass` enum was replaced:
 *
 *   **The enums are for display and grouping; the flags are what code branches on.**
 *
 * The axes overlap and always will — PM7 is simultaneously a simulation and an empirically
 * parameterised method, a fragment method *is* a statistical fit, and "convention-dependent" cuts
 * across masses, descriptors, identifiers, and simulations. Branching on an overlapping enum produces
 * rules that are wrong for the third example someone tries. So every predicate exported here reads
 * `flags` only, and `predicatesIgnoreDisplayAxes` in the test suite pins that: two classifications with
 * identical flags must produce identical behaviour no matter how their enums differ.
 *
 * Resist adding a fourth axis.
 */
import { z } from "zod";

/** How the number was arrived at. Display and grouping only. */
export type DerivationClass =
  | "graph-derived"
  | "convention"
  | "fragment-rule"
  | "database-lookup"
  | "statistical-model"
  | "force-field"
  | "electronic-structure";

/** What kind of claim the number makes. Display and grouping only. */
export type ClaimClass = "identity" | "composition" | "descriptor" | "prediction" | "simulated-observable";

export type Determinism = "deterministic" | "seeded" | "stochastic";

/**
 * The branchable facts.
 *
 * - `conventionDependent` — a differently-but-defensibly defined method would return a different
 *   number for the same molecule. Rotatable-bond counts and TPSA are the canonical cases: RDKit and
 *   OpenChemLib disagree in both directions and neither is wrong.
 * - `experimentallyCalibrated` — parameters were fitted to measurements, so the value inherits the
 *   fit's domain even when the arithmetic is deterministic (Crippen logP, Joback).
 * - `trainedOnExperimentalData` — a learned model sits between the structure and the number, so its
 *   training distribution, not just its parameters, bounds where it can be trusted.
 */
export interface ClassificationFlags {
  conventionDependent: boolean;
  experimentallyCalibrated: boolean;
  trainedOnExperimentalData: boolean;
}

export interface Classification {
  derivation: DerivationClass;
  claim: ClaimClass;
  determinism: Determinism;
  flags: ClassificationFlags;
}

export const DerivationClassSchema = z.enum([
  "graph-derived",
  "convention",
  "fragment-rule",
  "database-lookup",
  "statistical-model",
  "force-field",
  "electronic-structure"
]);

export const ClaimClassSchema = z.enum([
  "identity",
  "composition",
  "descriptor",
  "prediction",
  "simulated-observable"
]);

export const DeterminismSchema = z.enum(["deterministic", "seeded", "stochastic"]);

export const ClassificationFlagsSchema = z
  .object({
    conventionDependent: z.boolean(),
    experimentallyCalibrated: z.boolean(),
    trainedOnExperimentalData: z.boolean()
  })
  .strict();

export const ClassificationSchema = z
  .object({
    derivation: DerivationClassSchema,
    claim: ClaimClassSchema,
    determinism: DeterminismSchema,
    flags: ClassificationFlagsSchema
  })
  .strict();

// --- the predicates. flags only. -------------------------------------------------------------

/**
 * Show the method's definition alongside the number, because a different-but-legitimate definition
 * gives a different answer. This is what stops a tooltip-less "Rotatable bonds: 2" from reading as
 * a fact about the molecule rather than a fact about a chosen rule.
 */
export function requiresConventionDisclosure(classification: Classification): boolean {
  return classification.flags.conventionDependent;
}

/**
 * Show where the parameters or training data came from, and the domain they cover. True for anything
 * that inherited a fit — whether the fit is a Crippen atom-contribution table or a neural network.
 */
export function requiresEmpiricalProvenance(classification: Classification): boolean {
  return classification.flags.experimentallyCalibrated || classification.flags.trainedOnExperimentalData;
}

/**
 * Gate for anything leaving the app — clipboard, report, exported document. A number that depends on a
 * convention or a fit is meaningless without the method that produced it, so it never travels alone.
 */
export function requiresProvenanceOnExport(classification: Classification): boolean {
  return requiresConventionDisclosure(classification) || requiresEmpiricalProvenance(classification);
}

/**
 * "Is this a measurement?" — the answer for everything ChemDraft computes is no, and the flags say so
 * directly: a calibrated or trained value is *derived from* measurements, which is the opposite of
 * being one. Kept as a named function because the question gets asked, and answering it in one place
 * beats each caller inventing its own test.
 */
export function isMeasuredValue(_classification: Classification): boolean {
  return false;
}
