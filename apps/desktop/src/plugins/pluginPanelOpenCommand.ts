import type { PluginManifest } from "@chemdraft/plugin-api";

/** Resolve an explicit opener, or an unambiguous same-title menu supplied by older packages. */
export function pluginPanelOpenCommand(manifest: PluginManifest, panelId: string): string | undefined {
  const panel = manifest.contributes.panels.find(item => item.id === panelId);
  if (!panel) return undefined;
  const owns = (id: string) => manifest.contributes.commands.some(command => command.id === id);
  if (panel.commandId) return owns(panel.commandId) ? panel.commandId : undefined;
  const title = (value: string) => value.trim().replace(/(?:…|\.{3})$/, "").trim();
  const candidates = new Set(manifest.contributes.menus
    .filter(menu => title(menu.title) === title(panel.title) && owns(menu.commandId))
    .map(menu => menu.commandId));
  return candidates.size === 1 ? [...candidates][0] : undefined;
}
