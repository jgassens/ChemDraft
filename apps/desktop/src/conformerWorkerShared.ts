/** Types and pure cache keys shared by the worker and its callers. No worker bootstrap effects. */
import { defaultRefineForceField, type ConformerEngineName, type ConformerRefineOptions,
  type Generate3DConformerOptions, type Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import type { RdkitGenerate3DConformerOptions } from "@chemdraft/rdkit-adapter";
import type { Spin3dEnginePreference } from "./spin3dSettings";
import type { Spin3dTraceEvent } from "./conformerDebug";
import { qualityRefineIterationsFor } from "./spin3dRefineCaps";

export interface ConformerWorkRequest {
  kind: "generate" | "prefetch" | "warmup" | "cancel";
  id: number;
  molfile?: string;
  originalAtomCount?: number;
  sessionId?: string;
  /** Conformer refinement options for this request (Spin 3D mode → engine options).
   *  Embedding ignores these (it is force-field-independent and cached by molfile);
   *  only the refinement stage reads `optimize` / `maxMinimiseIterations`. */
  options?: RdkitGenerate3DConformerOptions;
  /** Which embed engine to use (Spin 3D Engine setting). Default "auto". */
  enginePreference?: Spin3dEnginePreference;
}

export interface ConformerWorkResponse {
  id: number;
  stage: "embedded" | "refined" | "error" | "warmed" | "trace" | "complete";
  result?: Generate3DConformerResult;
  message?: string;
  trace?: Spin3dTraceEvent;
}

/** Force field a given engine will ACTUALLY refine a request with. RDKit honours
 *  MMFF94/UFF (`defaultRefineForceField`); OCL ships only MMFF94 and silently refines with
 *  it regardless, so its effective field is always "mmff94" — keying or labelling an OCL
 *  refine as "uff" would only cause a redundant identical re-minimise on an MMFF94↔UFF toggle. */
export function effectiveRefineForceField(
  options: Generate3DConformerOptions | undefined,
  engine: ConformerEngineName
): NonNullable<ConformerRefineOptions["forceField"]> {
  if (engine === "openchemlib") return "mmff94";
  return defaultRefineForceField(options?.optimize);
}

/**
 * Stable key for a refined result within a single embedded conformer. Embedding is
 * force-field-independent, so the cache holds ONE embed per molfile and memoises the
 * refined coordinates per refinement mode here — switching Fast/Balanced/Quality (or
 * MMFF94↔UFF) reuses the embed and never reuses another mode's refined geometry.
 * `"none"` (Fast) is never stored: it has no refined stage. The key is the engine's
 * EFFECTIVE force field + iteration cap + interfragment flag, so MMFF94 and UFF refines of the same embed don't
 * collide on RDKit, while an OCL embed (MMFF94-only) shares one key across both selections.
 */
export function refinementKeyFor(
  options: RdkitGenerate3DConformerOptions | undefined,
  atomCount: number | undefined,
  engine: ConformerEngineName
): string {
  const optimize = options?.optimize ?? "auto";
  if (optimize === "none") return "none";
  const maxIts = options?.maxMinimiseIterations ?? qualityRefineIterationsFor(atomCount);
  return `${effectiveRefineForceField(options, engine)}:${maxIts}:interfragment=${options?.ignoreInterfragInteractions === false}`;
}
