import type { PluginPanelReport } from "@chemdraft/plugin-api";

/**
 * Desktop-owned view state for a contributed panel. Plugins never provide UI components; they push a
 * declarative {@link PluginPanelReport}, and the desktop renders it. `title` and `commandId` are
 * resolved from the plugin's manifest panel contribution so the desktop can draw chrome (heading,
 * "Run again") without the plugin describing chrome.
 */
export interface OpenPluginPanel {
  pluginId: string;
  panelId: string;
  title: string;
  report: PluginPanelReport;
  /** From the panel contribution; enables a host-rendered "Run again" action when present. */
  commandId?: string;
  openedAt: string;
}

/** A controlled runtime diagnostic (e.g. a report for an unknown panel) surfaced instead of crashing. */
export interface PluginDiagnostic {
  code: string;
  message: string;
  at: string;
}
