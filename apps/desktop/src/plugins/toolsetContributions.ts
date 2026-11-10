import type { PluginManifest } from "@chemdraft/plugin-api";
import { MAIN_TOOLBAR_GROUP_IDS } from "@chemdraft/toolset-registry";
import type { DesktopToolsetDefinition } from "../toolsets";

/** A transport fragment, never a separate toolbar. Runtime registration owns its permission gate. */
export function pluginToolbarButtonsToDefinition(manifest: PluginManifest): DesktopToolsetDefinition | undefined {
  if (manifest.contributes.toolbarButtons.length === 0) return undefined;
  const commands = new Map(manifest.contributes.commands.map(command => [command.id, command]));
  const seen = new Set<string>();
  const buttons = [...manifest.contributes.toolbarButtons].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const button of buttons) {
    if (!commands.has(button.commandId)) {
      throw new Error(`Plugin toolbar button "${button.id}" references command "${button.commandId}" that this plugin does not contribute.`);
    }
  }
  return {
    id: "core.main", title: "Main", source: "plugin", defaultVisible: false, defaultMode: "floating",
    groups: MAIN_TOOLBAR_GROUP_IDS.flatMap(groupId => {
      const items = buttons.filter(button => (button.toolbarGroup ?? "undeclared") === groupId).flatMap(button => {
        if (seen.has(button.commandId)) return [];
        seen.add(button.commandId);
        return [{ commandId: button.commandId, title: button.title ?? commands.get(button.commandId)!.title,
          icon: "palette" as const, category: "plugin" }];
      });
      return items.length ? [{ id: groupId, items }] : [];
    })
  };
}
