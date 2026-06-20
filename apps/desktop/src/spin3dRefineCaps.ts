/**
 * MMFF94 minimisation iteration caps for Spin 3D, scaled by molecule size.
 *
 * Single source of truth shared by the conformer worker (the on-demand / background
 * refine) and `spin3dSettings` (the user-facing refinement modes), so the two can
 * never drift. MMFF94 cost per iteration grows with the atom-pair count and the
 * planarising/strain-relief work happens in the early iterations, so the caps bound
 * the worst case while keeping small molecules ideal.
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
