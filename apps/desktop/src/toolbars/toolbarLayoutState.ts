import type { ToolsetLayoutState } from "@chemdraft/toolset-registry";

const EMPTY_LAYOUT_STATE: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

/**
 * Record the current palette visibility as `toolsetOverrides[].visible`, merged onto any existing
 * layout state so opening/closing a palette doesn't clobber other customization (order, user
 * toolsets) that a later phase will store in the same file. Overrides for toolsets that aren't
 * currently known (e.g. a plugin toolset that isn't loaded right now) are preserved untouched.
 */
export function mergeVisibilityIntoLayoutState(
  existing: ToolsetLayoutState | undefined,
  allToolsetIds: readonly string[],
  visibleToolsetIds: ReadonlySet<string>
): ToolsetLayoutState {
  const base = existing ?? EMPTY_LAYOUT_STATE;
  const known = new Set(allToolsetIds);
  const overridesById = new Map(base.toolsetOverrides.map((override) => [override.toolsetId, override]));

  const updated = allToolsetIds.map((toolsetId) => ({
    ...overridesById.get(toolsetId),
    toolsetId,
    visible: visibleToolsetIds.has(toolsetId)
  }));
  const preserved = base.toolsetOverrides.filter((override) => !known.has(override.toolsetId));

  // Copy userToolsets rather than spread `base` by reference: when `existing` is undefined, `base`
  // is the module-level EMPTY_LAYOUT_STATE and spreading it would return its array, so a later
  // mutation of the result would corrupt the shared constant for every subsequent merge.
  return {
    ...base,
    version: 1,
    toolsetOverrides: [...preserved, ...updated],
    userToolsets: [...base.userToolsets],
    ...(base.toolsetOrder ? { toolsetOrder: [...base.toolsetOrder] } : {})
  };
}
