import { parsePluginManifest } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import { pluginPanelOpenCommand } from "./pluginPanelOpenCommand";

const panelId = "panel.example.chat";
const open = "plugin.example.open";
const other = "plugin.example.other";
function manifest() {
  return parsePluginManifest({
    id: "org.example", name: "Example", version: "1.0.0", apiVersion: "^0.1.10", entry: "entry.js",
    permissions: ["ui.menu", "ui.panel"], contributes: {
      commands: [{ id: open, title: "Open" }, { id: other, title: "Other" }],
      panels: [{ id: panelId, title: "Example" }],
      menus: [{ id: "menu.example.open", title: "Example…", commandId: open, location: "plugins" }]
    }
  });
}

describe("pluginPanelOpenCommand", () => {
  it("prefers the declared panel command over menu compatibility", () => {
    const plugin = manifest(); plugin.contributes.panels[0]!.commandId = other;
    expect(pluginPanelOpenCommand(plugin, panelId)).toBe(other);
  });
  it("uses a same-title menu with either ellipsis spelling", () => {
    const plugin = manifest();
    expect(pluginPanelOpenCommand(plugin, panelId)).toBe(open);
    plugin.contributes.menus[0]!.title = "Example...";
    expect(pluginPanelOpenCommand(plugin, panelId)).toBe(open);
  });
  it("does not guess among different commands or unrelated menus", () => {
    const plugin = manifest();
    plugin.contributes.menus.push({ ...plugin.contributes.menus[0]!, id: "menu.example.other", commandId: other });
    expect(pluginPanelOpenCommand(plugin, panelId)).toBeUndefined();
    plugin.contributes.menus = [{ ...plugin.contributes.menus[0]!, title: "Delete everything" }];
    expect(pluginPanelOpenCommand(plugin, panelId)).toBeUndefined();
    expect(pluginPanelOpenCommand(plugin, "panel.example.unknown")).toBeUndefined();
  });
  it("never resolves a command owned by a different plugin", () => {
    const plugin = manifest(); plugin.contributes.menus[0]!.commandId = "plugin.foreign.open";
    expect(pluginPanelOpenCommand(plugin, panelId)).toBeUndefined();
    plugin.contributes.panels[0]!.commandId = "plugin.foreign.open";
    expect(pluginPanelOpenCommand(plugin, panelId)).toBeUndefined();
  });
});
