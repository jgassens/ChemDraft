/**
 * Force-field minimisation iteration budgets for Spin 3D, scaled by molecule size.
 *
 * Single source of truth shared by the conformer worker (the on-demand / background
 * refine) and `spin3dSettings` (the user-facing refinement modes), so the two can
 * never drift. OpenChemLib uses the budget in one capped call. RDKit may split the
 * same total budget across at most three focused passes on one transient conformer;
 * it does not multiply the budget. Cost per iteration grows with atom-pair count, so
 * these values continue to bound worst-case requested work.
 */

/** "Quality" mode: the historical Spin 3D caps (full depiction-grade cleanup). */
export function qualityRefineIterationsFor(atomCount: number | undefined): number {
  const n = atomCount ?? 0;
  if (n <= 30) return 800;
  if (n <= 60) return 400;
  return 240;
}

/** "Balanced" mode: a low cap that relieves the worst strain quickly. */
export function balancedRefineIterationsFor(atomCount: number | undefined): number {
  const n = atomCount ?? 0;
  if (n <= 30) return 120;
  if (n <= 60) return 80;
  return 50;
}
