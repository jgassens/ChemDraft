import type { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import { PluginPanelController } from "./PluginPanelController";

function hostWithPanels() {
  const panels = new Map([
    [
      "plugin.a",
      [
        { id: "panel.a", title: "Panel A", commandId: "cmd.a" },
        { id: "panel.a.secondary", title: "Panel A Secondary", commandId: "cmd.a.secondary" }
      ]
    ],
    ["plugin.b", [{ id: "panel.b", title: "Panel B", commandId: "cmd.b" }]]
  ]);
  const notifyPanelClosed = vi.fn();
  const host = {
    getPlugin: (pluginId: string) => {
      const contributedPanels = panels.get(pluginId);
      return contributedPanels ? { manifest: { contributes: { panels: contributedPanels } } } : undefined;
    },
    notifyPanelClosed
  } as unknown as PluginHost;
  return { host, notifyPanelClosed };
}

describe("PluginPanelController", () => {
  it("uses a report's rerunCommandId for Run again, falling back to the panel's default command", () => {
    const { host } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "R", sections: [] });
    expect(controller.getOpenPanel()?.commandId).toBe("cmd.a");

    // A ¹H report names the ¹H command so "Run again" repeats ¹H, not the panel's default (¹³C).
    controller.showReport("plugin.a", "panel.a", { title: "R", sections: [], rerunCommandId: "cmd.proton" });
    expect(controller.getOpenPanel()?.commandId).toBe("cmd.proton");
  });

  it("treats pending and result reports for the same panel as updates without a false close", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const times = ["opened", "should-not-be-used"];
    const controller = new PluginPanelController(host, () => times.shift() ?? "unexpected");

    controller.showReport("plugin.a", "panel.a", { title: "Pending", sections: [] });
    controller.showReport("plugin.a", "panel.a", { title: "Result", sections: [] });

    expect(notifyPanelClosed).not.toHaveBeenCalled();
    expect(controller.getOpenPanel()).toMatchObject({
      pluginId: "plugin.a",
      panelId: "panel.a",
      openedAt: "opened",
      report: { title: "Result" }
    });
  });

  it("closes the previous plugin panel when another panel replaces it", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.showReport("plugin.a", "panel.a.secondary", { title: "A2", sections: [] });
    expect(notifyPanelClosed).toHaveBeenLastCalledWith("plugin.a", "panel.a");

    controller.showReport("plugin.b", "panel.b", { title: "B", sections: [] });
    expect(notifyPanelClosed).toHaveBeenLastCalledWith("plugin.a", "panel.a.secondary");
    expect(notifyPanelClosed).toHaveBeenCalledTimes(2);
    expect(controller.getOpenPanel()).toMatchObject({ pluginId: "plugin.b", panelId: "panel.b" });
  });

  it("still notifies the owning plugin when the open panel is explicitly closed", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.closePanel();

    expect(notifyPanelClosed).toHaveBeenCalledOnce();
    expect(notifyPanelClosed).toHaveBeenCalledWith("plugin.a", "panel.a");
    expect(controller.getOpenPanel()).toBeUndefined();
  });
});
