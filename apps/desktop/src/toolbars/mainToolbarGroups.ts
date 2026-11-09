import {
  MAIN_TOOLBAR_GROUP_IDS,
  MAIN_TOOLBAR_GROUPS,
  parseToolsetManifest,
  toolsetItemCustomizationId,
  type ToolsetItemDefinition,
  type ToolsetDefinition,
  type ToolbarGroupId
} from "@chemdraft/toolset-registry";
import manifest from "../toolsets/desktop-toolsets.json";

/** Authored definitions include hidden-by-default buttons, unlike the rendered registry. */
export const mainToolbarDefinition = parseToolsetManifest(manifest).find(toolset => toolset.id === "core.main")!;
export const mainToolbarItems = new Map(mainToolbarDefinition.groups.flatMap(group => group.items.map(item => [
  toolsetItemCustomizationId(item)!, item
] as const)));
const homeGroups = new Map<string, ToolbarGroupId>();
// Primary homes take precedence over appearances in someone else's flyout.
for (const group of mainToolbarDefinition.groups) {
  for (const item of group.items) homeGroups.set(toolsetItemCustomizationId(item)!, group.id as ToolbarGroupId);
}
for (const group of mainToolbarDefinition.groups) {
  for (const item of group.items) {
    for (const child of item.submenu?.items ?? []) {
      if (!homeGroups.has(child.commandId)) homeGroups.set(child.commandId, group.id as ToolbarGroupId);
    }
  }
}

// A webview has one toolbar catalog. Keep its live home metadata here so existing edit/gallery
// callers (including detached palettes) resolve the same homes without a second plugin runtime.
let pluginDefinition: ToolsetDefinition | undefined;
let pluginHomes = new Map<string, ToolbarGroupId>();

export function setMainToolbarPluginDefinition(definition: ToolsetDefinition): void {
  pluginDefinition = definition;
  pluginHomes = new Map(definition.groups.flatMap(group => group.items.flatMap(item => {
    const id = toolsetItemCustomizationId(item);
    return id && !mainToolbarItems.has(id) && isMainToolbarGroupId(group.id ?? "")
      ? [[id, group.id as ToolbarGroupId] as const] : [];
  })));
}

export function currentMainToolbarDefinition(): ToolsetDefinition {
  return pluginDefinition ?? mainToolbarDefinition;
}

export function mainToolbarHomeGroupId(itemId: string): ToolbarGroupId {
  return homeGroups.get(itemId) ?? pluginHomes.get(itemId) ?? "undeclared";
}

export function isAbsentPluginToolbarItem(itemId: string): boolean {
  return itemId.startsWith("plugin.") && !pluginHomes.has(itemId);
}

export function isMainToolbarGroupId(id: string): id is ToolbarGroupId {
  return (MAIN_TOOLBAR_GROUP_IDS as readonly string[]).includes(id);
}

export function isToolbarSpacingItem(item: ToolsetItemDefinition): boolean {
  return item.kind === "spacer" || item.kind === "separator";
}

export function mainToolbarGroupMetadata(id: ToolbarGroupId) {
  return MAIN_TOOLBAR_GROUPS.find(group => group.id === id)!;
}
