import type { PluginMenuContribution } from "@chemdraft/plugin-api";
import type { RegisteredContribution } from "@chemdraft/plugin-host";

import type { AppMenuCommand, PluginAppMenuItem } from "../appMenu";

/**
 * Desktop-runtime pseudo-command that opens the bundled-plugin diagnostics view. It is not a plugin
 * command (it is not in the host registry); `MainWindow` handles it directly. Marked
 * `pluginContributed` so it is excluded from the native-menu drift comparison.
 */
export const PLUGIN_DIAGNOSTICS_COMMAND_ID = "plugin.runtime.showDiagnostics";

/** Convert one host menu contribution into a web app-menu command bound to the plugin's command. */
export function pluginMenuContributionToAppMenuCommand(
  entry: RegisteredContribution<PluginMenuContribution>,
  commandEnabled = true
): AppMenuCommand {
  return {
    kind: "command",
    id: entry.contribution.id,
    commandId: entry.contribution.commandId,
    label: entry.contribution.title,
    enabled: commandEnabled,
    pluginContributed: true
  };
}

/**
 * Build the plugin-runtime items appended to the app menu: every registered menu contribution in its
 * declared location, plus the always-available "Bundled Plugins…" diagnostics opener under Analyze.
 */
export function buildPluginMenuItems(
  menuContributions: readonly RegisteredContribution<PluginMenuContribution>[],
  isCommandEnabled: (commandId: string) => boolean = () => true
): PluginAppMenuItem[] {
  const items: PluginAppMenuItem[] = menuContributions.map((entry) => ({
    location: entry.contribution.location,
    command: pluginMenuContributionToAppMenuCommand(entry, isCommandEnabled(entry.contribution.commandId))
  }));

  items.push({
    location: "analyze",
    command: {
      kind: "command",
      id: PLUGIN_DIAGNOSTICS_COMMAND_ID,
      commandId: PLUGIN_DIAGNOSTICS_COMMAND_ID,
      label: "Bundled Plugins…",
      enabled: true,
      pluginContributed: true
    }
  });

  return items;
}
