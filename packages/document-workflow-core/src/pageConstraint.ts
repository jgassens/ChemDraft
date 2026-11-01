// The one rule that keeps newly placed content on the page: structure paste (scaleParsedMolfileAtoms),
// table paste and Insert Table all use it, so they cannot disagree about where the page edge is.

import { clamp, type PagePoint } from "./shared";

/** Shifts no larger than this on both axes are left alone (floating-point noise, not an overhang). */
export const PAGE_CONSTRAINT_EPSILON_PX = 0.001;

/**
 * The shift that keeps drawn `bounds` on `page`. Each axis is clamped into [0, page size − bounds
 * size], so bounds larger than the page align their top-left with the page's top-left. When neither
 * axis moves by more than {@link PAGE_CONSTRAINT_EPSILON_PX}, the shift is zero on both.
 */
export function pageConstrainedShift(
  page: { readonly width: number; readonly height: number },
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): PagePoint {
  const x = clamp(bounds.x, 0, Math.max(0, page.width - bounds.width)) - bounds.x;
  const y = clamp(bounds.y, 0, Math.max(0, page.height - bounds.height)) - bounds.y;
  return Math.abs(x) > PAGE_CONSTRAINT_EPSILON_PX || Math.abs(y) > PAGE_CONSTRAINT_EPSILON_PX ? { x, y } : { x: 0, y: 0 };
}
