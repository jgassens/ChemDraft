import {
  applyToolsetLayoutState,
  toolsetItemCustomizationId,
  type ToolsetDefinition,
  type ToolsetLayoutState,
  type UserToolsetOverride
} from "@chemdraft/toolset-registry";
import type { ToolbarProfileName } from "./toolbarProfileName";

const MAIN_TOOLSET_ID = "core.main";
const MAIN_ITEMS_GROUP_ID = "core.main.items";

/** The Main toolbar of the `molecule-drawing` profile, in display order. Everything else on Main is hidden. */
export const MOLECULE_DRAWING_MAIN_ITEM_IDS = [
  "widget.core.documentZoom",
  "tool.select",
  "tool.lasso",
  "tool.eraser",
  "core.main.divider.1",
  "tool.bond",
  "tool.wedgeBond",
  "tool.hashedBond",
  "tool.dashedBond",
  "tool.boldBond",
  "tool.doubleBond",
  "tool.chain",
  "tool.benzene",
  "core.main.divider.2",
  "tool.charge",
  "structure.cleanup2d"
] as const;

/** Added to Main from this toolset (with its flyout), since the shipped Main has no Chain button. */
const CHAIN_SOURCE_TOOLSET_ID = "core.structure";
const CHAIN_COMMAND_ID = "tool.chain";

/**
 * The profile as ordinary toolbar customization: Main's hidden items, item order and the Chain
 * addition, and every other core toolset hidden. Plugin and user toolsets are untouched.
 */
export function toolbarProfileLayoutState<TIcon extends string, TAssetName extends string>(
  profile: ToolbarProfileName,
  toolsets: readonly ToolsetDefinition<TIcon, TAssetName>[]
): ToolsetLayoutState<TIcon, TAssetName> {
  switch (profile) {
    case "molecule-drawing":
      return moleculeDrawingLayoutState(toolsets);
  }
}

/**
 * The toolset visibility the profile sets, by toolset id (empty without a profile). These are defaults:
 * a saved layout must never record them as the user's choice (see `mergeVisibilityIntoLayoutState`).
 */
export function toolbarProfileVisibility<TIcon extends string, TAssetName extends string>(
  profile: ToolbarProfileName | undefined,
  toolsets: readonly ToolsetDefinition<TIcon, TAssetName>[]
): ReadonlyMap<string, boolean> {
  if (profile === undefined) return new Map();
  return new Map(toolbarProfileLayoutState(profile, toolsets).toolsetOverrides
    .filter((override): override is UserToolsetOverride & { visible: boolean } => override.visible !== undefined)
    .map(override => [override.toolsetId, override.visible]));
}

/**
 * The toolsets a build starts from: `toolsets` itself without a profile, else the profile applied
 * through the same layout machinery as user customization. A user's saved layout applies on top.
 */
export function applyToolbarProfile<TIcon extends string, TAssetName extends string>(
  toolsets: ToolsetDefinition<TIcon, TAssetName>[],
  profile: ToolbarProfileName | undefined
): ToolsetDefinition<TIcon, TAssetName>[] {
  if (profile === undefined) return toolsets;
  return applyToolsetLayoutState<TIcon, TAssetName>(toolsets, toolbarProfileLayoutState(profile, toolsets), {
    onUnknownCommand: "throw"
  });
}

function moleculeDrawingLayoutState<TIcon extends string, TAssetName extends string>(
  toolsets: readonly ToolsetDefinition<TIcon, TAssetName>[]
): ToolsetLayoutState<TIcon, TAssetName> {
  const main = toolsets.find(toolset => toolset.id === MAIN_TOOLSET_ID);
  const mainGroup = main?.groups.find(group => group.id === MAIN_ITEMS_GROUP_ID);
  if (!main || !mainGroup) {
    throw new Error(`Toolbar profile "molecule-drawing" needs the "${MAIN_ITEMS_GROUP_ID}" group of "${MAIN_TOOLSET_ID}".`);
  }
  const chain = toolsets.find(toolset => toolset.id === CHAIN_SOURCE_TOOLSET_ID)?.groups
    .flatMap(group => group.items)
    .find(item => toolsetItemCustomizationId(item) === CHAIN_COMMAND_ID);
  if (!chain) {
    throw new Error(`Toolbar profile "molecule-drawing" needs "${CHAIN_COMMAND_ID}" in "${CHAIN_SOURCE_TOOLSET_ID}".`);
  }

  const mainIds = main.groups.flatMap(group => group.items.map(toolsetItemCustomizationId))
    .filter((id): id is string => id !== undefined);
  const kept = new Set<string>(MOLECULE_DRAWING_MAIN_ITEM_IDS);
  const missing = MOLECULE_DRAWING_MAIN_ITEM_IDS.filter(id => id !== CHAIN_COMMAND_ID && !mainIds.includes(id));
  if (missing.length > 0) {
    throw new Error(`Toolbar profile "molecule-drawing" names Main items the manifest no longer has: ${missing.join(", ")}.`);
  }

  const mainOverride: UserToolsetOverride = {
    toolsetId: MAIN_TOOLSET_ID,
    itemAdditions: [{ groupId: MAIN_ITEMS_GROUP_ID, item: structuredClone(chain) }],
    itemOrder: { [MAIN_ITEMS_GROUP_ID]: [...MOLECULE_DRAWING_MAIN_ITEM_IDS] },
    hiddenCommandIds: mainIds.filter(id => !kept.has(id))
  };
  const hiddenToolsets: UserToolsetOverride[] = toolsets
    .filter(toolset => toolset.source === "core" && toolset.id !== MAIN_TOOLSET_ID)
    .map(toolset => ({ toolsetId: toolset.id, visible: false }));

  return { version: 1, toolsetOverrides: [mainOverride, ...hiddenToolsets], userToolsets: [] };
}
