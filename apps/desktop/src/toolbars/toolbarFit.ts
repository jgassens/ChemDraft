import { MAIN_TOOLBAR_FOLD_ORDER } from "@chemdraft/toolset-registry";

/** Lengths come from the unconstrained DOM grid, including its packing, padding and borders. */
export interface ToolbarGroupFootprint {
  id?: string;
  length: number;
  prefixes: number[];
  foldedLength: number;
}

export function foldMainToolbar(groups: readonly ToolbarGroupFootprint[], available: number, gap: number): Set<string> {
  const folded = new Set<string>();
  const length = () => groups.reduce((sum, group) => sum + (folded.has(group.id ?? "") ? group.foldedLength : group.length),
    Math.max(0, groups.length - 1) * gap);
  for (const step of MAIN_TOOLBAR_FOLD_ORDER) {
    if (length() <= available) break;
    for (const id of step) if (groups.some(group => group.id === id)) folded.add(id);
  }
  return folded;
}

/** Reserve the overflow cell before choosing the largest ordered prefix. Never skip a wide cell. */
export function toolbarOverflowPrefix(groups: readonly ToolbarGroupFootprint[], available: number, gap: number, overflowLength: number): number {
  const full = groups.reduce((sum, group) => sum + group.length, Math.max(0, groups.length - 1) * gap);
  const count = groups.reduce((sum, group) => sum + group.prefixes.length, 0);
  if (full <= available) return count;
  let best = 0;
  let used = 0;
  let seen = 0;
  for (const group of groups) {
    for (let index = 0; index < group.prefixes.length; index++) {
      const length = used + group.prefixes[index] + (seen > 0 ? gap : 0) + gap + overflowLength;
      if (length <= available) best = seen + index + 1;
      else return best;
    }
    used += group.length + (seen > 0 ? gap : 0);
    seen += group.prefixes.length;
  }
  return best;
}
