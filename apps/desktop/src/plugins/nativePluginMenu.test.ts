import { describe, expect, it } from "vitest";

import type { PluginAppMenuItem } from "../appMenu";
import { pluginAnalyzeItemsForNativeMenu } from "./nativePluginMenu";

function analyzeItem(commandId: string, label: string, enabled = true): PluginAppMenuItem {
  return {
    location: "analyze",
    command: { kind: "command", id: `menu.${commandId}`, commandId, label, enabled, pluginContributed: true }
  };
}

describe("pluginAnalyzeItemsForNativeMenu", () => {
  it("maps analyze-location plugin commands to native menu items keyed by command id", () => {
    const items = pluginAnalyzeItemsForNativeMenu([
      analyzeItem("plugin.massFragment.analyzeSelectedStructure", "Analyze Mass / m/z"),
      analyzeItem("plugin.runtime.showDiagnostics", "Bundled Plugins…", false)
    ]);

    expect(items).toEqual([
      { id: "plugin.massFragment.analyzeSelectedStructure", label: "Analyze Mass / m/z", enabled: true },
      { id: "plugin.runtime.showDiagnostics", label: "Bundled Plugins…", enabled: false }
    ]);
  });

  it("excludes plugin items outside the Analyze location", () => {
    const structureItem: PluginAppMenuItem = {
      location: "structure",
      command: { kind: "command", id: "menu.x", commandId: "plugin.x.run", label: "X", enabled: true, pluginContributed: true }
    };
    expect(pluginAnalyzeItemsForNativeMenu([structureItem, analyzeItem("plugin.a.run", "A")])).toEqual([
      { id: "plugin.a.run", label: "A", enabled: true }
    ]);
  });
});
