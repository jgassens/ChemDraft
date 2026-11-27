import type { ToolsetLayoutState } from "@chemdraft/toolset-registry";

export const MAIN_TOOLBAR_DEFAULTS_REVISION = 2;

/** Stamp new customization before it is rendered, broadcast or saved as a historical layout. */
export function withCurrentMainToolbarDefaults<T extends ToolsetLayoutState>(state: T): T {
  return { ...state, mainToolbarDefaultsRevision: Math.max(state.mainToolbarDefaultsRevision ?? 0, MAIN_TOOLBAR_DEFAULTS_REVISION) };
}

const EMPTY_LAYOUT_STATE: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

/**
 * Record the current palette visibility as `toolsetOverrides[].visible`, merged onto any existing
 * layout state so opening/closing a palette doesn't clobber other customization (order, user
 * toolsets) that a later phase will store in the same file. Overrides for toolsets that aren't
 * currently known (e.g. a plugin toolset that isn't loaded right now) are preserved untouched.
 *
 * `profileVisibility` is the visibility a build-time toolbar profile gives toolsets (empty without a
 * profile). A profile is a default, never a user's choice, so it is never written: a toolset it covers
 * is recorded only once the user's visibility differs from the profile's, or when the saved layout
 * already holds the user's own value for it. The profile is re-applied underneath on every load.
 */
export function mergeVisibilityIntoLayoutState(
  existing: ToolsetLayoutState | undefined,
  allToolsetIds: readonly string[],
  visibleToolsetIds: ReadonlySet<string>,
  profileVisibility: ReadonlyMap<string, boolean> = new Map()
): ToolsetLayoutState {
  const base = existing ?? EMPTY_LAYOUT_STATE;
  const known = new Set(allToolsetIds);
  const overridesById = new Map(base.toolsetOverrides.map((override) => [override.toolsetId, override]));

  const updated = allToolsetIds.flatMap((toolsetId) => {
    const saved = overridesById.get(toolsetId);
    const visible = visibleToolsetIds.has(toolsetId);
    if (profileVisibility.get(toolsetId) === visible && saved?.visible === undefined) {
      // Still the profile's default: keep whatever else the user customized, but no visibility.
      return saved ? [saved] : [];
    }
    return [{ ...saved, toolsetId, visible }];
  });
  const preserved = base.toolsetOverrides.filter((override) => !known.has(override.toolsetId));

  // Copy userToolsets rather than spread `base` by reference: when `existing` is undefined, `base`
  // is the module-level EMPTY_LAYOUT_STATE and spreading it would return its array, so a later
  // mutation of the result would corrupt the shared constant for every subsequent merge.
  return {
    ...base,
    version: 1,
    mainToolbarDefaultsRevision: base.mainToolbarDefaultsRevision ?? MAIN_TOOLBAR_DEFAULTS_REVISION,
    toolsetOverrides: [...preserved, ...updated],
    userToolsets: [...base.userToolsets],
    ...(base.toolsetOrder ? { toolsetOrder: [...base.toolsetOrder] } : {})
  };
}
