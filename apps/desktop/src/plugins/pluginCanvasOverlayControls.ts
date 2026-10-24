import type { PluginCanvasOverlayContribution, PluginManifest, PluginOverlayContentSection, PluginPanelSection } from "@chemdraft/plugin-api";

export const OVERLAY_BUSY_MESSAGE = "Wait for the current request to finish, or press Stop.";

// The host synthesizes the internal prompt section from setContent's prompt override.
// Public content sections never admit a second composer or plugin-supplied prompt controls.
type CanvasOverlayPrompt = Extract<PluginPanelSection, { kind: "prompt" }> & {
  /** A new identity per setContent; rerenders must not replay a consumed restoration. */
  draftRestore?: { readonly text: string };
};
export type CanvasOverlayContentSection = PluginOverlayContentSection | CanvasOverlayPrompt;

export function canvasOverlayPrompt(overlay: PluginCanvasOverlayContribution, content: readonly CanvasOverlayContentSection[]): CanvasOverlayPrompt {
  const live = content.find(section => section.kind === "prompt" && section.id === overlay.prompt.id);
  return { ...(live?.kind === "prompt" ? live : overlay.prompt), commandId: overlay.commandId };
}

/** The overlay command is Send. Its opener is the owned, unambiguous same-title Plugins menu. */
export function pluginCanvasOverlayOpenCommand(manifest: PluginManifest, overlayId: string): string | undefined {
  const overlay = manifest.contributes.canvasOverlays?.find(item => item.id === overlayId);
  if (!overlay) return undefined;
  const title = (value: string) => value.trim().replace(/(?:…|\.{3})$/, "").trim();
  const candidates = new Set(manifest.contributes.menus.filter(menu => menu.location === "plugins"
    && title(menu.title) === title(overlay.title) && menu.commandId !== overlay.commandId
    && manifest.contributes.commands.some(command => command.id === menu.commandId)).map(menu => menu.commandId));
  return candidates.size === 1 ? [...candidates][0] : undefined;
}
