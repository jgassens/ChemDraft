import { parsePluginManifest } from "@chemdraft/plugin-api";

const name = "Request Tools Legacy Fixture";
export const panelId = "panel.requestToolsLegacyFixture.results";
export const actions = {
  readDocument: "Legacy Fixture: Read active document",
  readSelection: "Legacy Fixture: Read selection",
  beginRequest: "Legacy Fixture: Attempt to start request",
  events: "Legacy Fixture: Show document-change events"
} as const;

export const commandId = (action: keyof typeof actions) => `plugin.requestToolsLegacyFixture.${action}`;

const entries = Object.keys(actions) as (keyof typeof actions)[];
export const manifest = parsePluginManifest({
  id: "org.chemdraft.example.requestToolsLegacyFixture",
  name,
  version: "0.1.0",
  apiVersion: "^0.1.25",
  entry: "entry.js",
  description: "Compatibility test fixture for the previous plugin API.",
  permissions: ["document.read", "selection.read", "ui.menu", "ui.panel"],
  contributes: {
    commands: entries.map(action => ({ id: commandId(action), title: actions[action], category: "Plugins" })),
    menus: entries.map(action => ({
      id: `menu.requestToolsLegacyFixture.${action}`,
      title: actions[action],
      commandId: commandId(action),
      location: "plugins",
      requiredPermissions: ["ui.menu"]
    })),
    panels: [{ id: panelId, title: name, requiredPermissions: ["ui.panel"] }]
  }
});
