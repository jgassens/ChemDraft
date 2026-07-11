import type { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";

import { PluginPanelController } from "./PluginPanelController";

function hostWithPanel(defaultCommandId: string): PluginHost {
  return {
    getPlugin: () => ({
      manifest: { contributes: { panels: [{ id: "panel.x", title: "Panel X", commandId: defaultCommandId }] } }
    }),
    notifyPanelClosed: () => undefined
  } as unknown as PluginHost;
}

describe("PluginPanelController", () => {
  it("uses a report's rerunCommandId for Run again, falling back to the panel's default command", () => {
    const controller = new PluginPanelController(hostWithPanel("cmd.default"), () => "t");

    controller.showReport("plugin.x", "panel.x", { title: "R", sections: [] });
    expect(controller.getOpenPanel()?.commandId).toBe("cmd.default");

    // A ¹H report names the ¹H command so "Run again" repeats ¹H, not the panel's default (¹³C).
    controller.showReport("plugin.x", "panel.x", { title: "R", sections: [], rerunCommandId: "cmd.proton" });
    expect(controller.getOpenPanel()?.commandId).toBe("cmd.proton");
  });
});
