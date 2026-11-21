import { parsePluginManifest } from "@chemdraft/plugin-api";

export const probeName = "Request Tools Probe";
export const panelId = "panel.requestToolsProbe.results";
export const actions = {
  pinnedRead: "Probe: Read pinned document",
  insert: "Probe: Insert text and molecule",
  outsideScope: "Probe: Attempt out-of-scope edit",
  pageSpace: "Probe: Request page space",
  openSession: "Probe: Open tool session",
  measure: "Probe: Measure selection",
  render: "Probe: Render selection PNG",
  events: "Probe: Print active-document events",
  end: "Probe: End request"
} as const;

export type Action = keyof typeof actions;
export const commandId = (action: Action) => `plugin.requestToolsProbe.${action}`;

const entries = Object.keys(actions) as Action[];
export const manifest = parsePluginManifest({
  id: "org.chemdraft.example.requestToolsProbe",
  name: probeName,
  version: "0.1.0",
  apiVersion: "^0.1.26",
  entry: "entry.js",
  description: "Test and demonstration commands for request-bound plugin tools.",
  permissions: ["document.read", "selection.read", "document.write", "chemistry.compute", "ui.menu", "ui.panel"],
  contributes: {
    commands: entries.map(action => ({ id: commandId(action), title: actions[action], category: "Plugins" })),
    menus: entries.map(action => ({
      id: `menu.requestToolsProbe.${action}`,
      title: actions[action],
      commandId: commandId(action),
      location: "plugins",
      requiredPermissions: ["ui.menu"]
    })),
    panels: [{ id: panelId, title: probeName, requiredPermissions: ["ui.panel"] }]
  }
});
