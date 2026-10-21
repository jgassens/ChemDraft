import type { CommandDefinition } from "@chemdraft/plugin-host";
import type { PluginAppMenuItem } from "../appMenu";

/** Host-owned aliases for existing official commands; no plugin release is needed. */
export const OFFICIAL_PLUGIN_MENUS = [
  { commandId: "plugin.orthonymNaming.insertName", title: "Convert Structure to Name" },
  { commandId: "plugin.opsinNameToStructure.convert", title: "Convert Name to Structure…" }
] as const;

export function buildOfficialPluginMenuItems(
  getCommand: (commandId: string) => CommandDefinition | undefined
): PluginAppMenuItem[] {
  return OFFICIAL_PLUGIN_MENUS.flatMap(({ commandId, title }) => {
    const registered = getCommand(commandId);
    if (!registered?.pluginId || !registered.enabled) return [];
    return [{
      location: "structure",
      command: {
        kind: "command" as const,
        id: `menu.official.structure.${commandId}`,
        commandId,
        label: title,
        enabled: true,
        pluginContributed: true
      }
    }];
  });
}
