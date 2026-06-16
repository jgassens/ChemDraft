/**
 * User setting for Spin 3D conformer refinement.
 *
 * Three modes trade speed for geometry quality, all on the engine ChemDraft
 * actually ships today (OpenChemLib MMFF94 — OCL 9.22.1 exposes no other force
 * field). The "force field" framing is deliberately avoided in the UI until an
 * external engine (OpenBabel) lands; see PLAN-spin3d-forcefields.md.
 *
 *   fast      — embedded conformer only, no force-field refinement (fastest).
 *   balanced  — quick MMFF94 cleanup with a low iteration cap.
 *   quality   — full MMFF94 cleanup (the historical Spin 3D behaviour; default).
 */
import type { Generate3DConformerOptions } from "@chemdraft/chemistry-adapter";
import { balancedRefineIterationsFor, qualityRefineIterationsFor } from "./spin3dRefineCaps";

export type Spin3dRefinementMode = "fast" | "balanced" | "quality";

export interface Spin3dSettings {
  refinementMode: Spin3dRefinementMode;
}

export const DEFAULT_SPIN3D_SETTINGS: Spin3dSettings = {
  // Default preserves the historical behaviour — existing users see no change
  // unless they opt into a faster mode.
  refinementMode: "quality"
};

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";

export function isSpin3dRefinementMode(value: unknown): value is Spin3dRefinementMode {
  return value === "fast" || value === "balanced" || value === "quality";
}

export function loadSpin3dSettings(): Spin3dSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Spin3dSettings> | null) : null;
    if (parsed && isSpin3dRefinementMode(parsed.refinementMode)) {
      return { refinementMode: parsed.refinementMode };
    }
  } catch {
    // Corrupt/blocked storage — fall back to the default.
  }
  return DEFAULT_SPIN3D_SETTINGS;
}

export function saveSpin3dSettings(settings: Spin3dSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort (private mode / disabled storage).
  }
}

/**
 * Resolve a mode + molecule size to the conformer options sent to the worker (and
 * the in-page fallback). `fast` disables refinement; `balanced`/`quality` request
 * MMFF94 with an explicit, size-scaled iteration cap from the shared cap policy.
 */
export function conformerOptionsForSpin3d(
  settings: Spin3dSettings,
  atomCount: number
): Generate3DConformerOptions {
  switch (settings.refinementMode) {
    case "fast":
      return { optimize: "none" };
    case "balanced":
      return { optimize: "mmff94", maxMinimiseIterations: balancedRefineIterationsFor(atomCount) };
    case "quality":
    default:
      return { optimize: "mmff94", maxMinimiseIterations: qualityRefineIterationsFor(atomCount) };
  }
}
