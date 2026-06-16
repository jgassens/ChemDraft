/**
 * User settings for Spin 3D conformer generation.
 *
 *   refinementMode   — how much force-field cleanup runs after embedding:
 *                        fast      — embedded conformer only (no refinement).
 *                        balanced  — quick refinement with a low iteration cap.
 *                        quality   — full refinement (historical behaviour; default).
 *   enginePreference — which engine embeds the conformer:
 *                        auto        — RDKit ETKDG when its WASM is available, else OCL.
 *                        rdkit       — RDKit ETKDG (falls back to OCL if it can't load).
 *                        openchemlib — force the legacy OpenChemLib engine (rollback path).
 *   forceField       — refinement force field: MMFF94 (both engines) or UFF (RDKit only;
 *                        OCL refines with MMFF94 regardless, since it ships no UFF).
 */
import type { Generate3DConformerOptions } from "@chemdraft/chemistry-adapter";
import { balancedRefineIterationsFor, qualityRefineIterationsFor } from "./spin3dRefineCaps";

export type Spin3dRefinementMode = "fast" | "balanced" | "quality";
export type Spin3dEnginePreference = "auto" | "rdkit" | "openchemlib";
export type Spin3dForceField = "mmff94" | "uff";

export interface Spin3dSettings {
  refinementMode: Spin3dRefinementMode;
  enginePreference: Spin3dEnginePreference;
  forceField: Spin3dForceField;
}

export const DEFAULT_SPIN3D_SETTINGS: Spin3dSettings = {
  // Defaults preserve historical geometry: full MMFF94 cleanup, RDKit-first embedding
  // (with transparent OCL fallback). Existing users see faster Spin 3D, same chemistry.
  refinementMode: "quality",
  enginePreference: "auto",
  forceField: "mmff94"
};

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";

export function isSpin3dRefinementMode(value: unknown): value is Spin3dRefinementMode {
  return value === "fast" || value === "balanced" || value === "quality";
}

export function isSpin3dEnginePreference(value: unknown): value is Spin3dEnginePreference {
  return value === "auto" || value === "rdkit" || value === "openchemlib";
}

export function isSpin3dForceField(value: unknown): value is Spin3dForceField {
  return value === "mmff94" || value === "uff";
}

export function loadSpin3dSettings(): Spin3dSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Spin3dSettings> | null) : null;
    if (parsed && typeof parsed === "object") {
      // Each field is validated independently and defaulted if absent/invalid, so older
      // persisted settings (refinementMode only) load forward-compatibly.
      return {
        refinementMode: isSpin3dRefinementMode(parsed.refinementMode)
          ? parsed.refinementMode
          : DEFAULT_SPIN3D_SETTINGS.refinementMode,
        enginePreference: isSpin3dEnginePreference(parsed.enginePreference)
          ? parsed.enginePreference
          : DEFAULT_SPIN3D_SETTINGS.enginePreference,
        forceField: isSpin3dForceField(parsed.forceField)
          ? parsed.forceField
          : DEFAULT_SPIN3D_SETTINGS.forceField
      };
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

export function isSpin3dSettings(value: unknown): value is Spin3dSettings {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Spin3dSettings>;
  return (
    isSpin3dRefinementMode(v.refinementMode) &&
    isSpin3dEnginePreference(v.enginePreference) &&
    isSpin3dForceField(v.forceField)
  );
}

/**
 * Resolve a mode + force field + molecule size to the conformer options sent to the worker
 * (and the in-page fallback). `fast` disables refinement; `balanced`/`quality` request the
 * chosen force field with an explicit, size-scaled iteration cap from the shared cap policy.
 */
export function conformerOptionsForSpin3d(
  settings: Spin3dSettings,
  atomCount: number
): Generate3DConformerOptions {
  switch (settings.refinementMode) {
    case "fast":
      return { optimize: "none" };
    case "balanced":
      return { optimize: settings.forceField, maxMinimiseIterations: balancedRefineIterationsFor(atomCount) };
    case "quality":
    default:
      return { optimize: settings.forceField, maxMinimiseIterations: qualityRefineIterationsFor(atomCount) };
  }
}
