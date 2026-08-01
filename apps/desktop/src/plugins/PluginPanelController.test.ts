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
    [
      "plugin.b",
      [
        { id: "panel.b", title: "Panel B", commandId: "cmd.b" },
        { id: "panel.a", title: "Plugin B Shared ID", commandId: "cmd.b.shared" }
      ]
    ]
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

  it("detaches a panel without a close notification and frees the in-app slot (ADR-0030)", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.detachPanel("plugin.a", "panel.a");

    // Detaching is a surface change, not a close: the plugin must NOT get a cancellation signal.
    expect(notifyPanelClosed).not.toHaveBeenCalled();
    expect(controller.getOpenPanel()).toBeUndefined();
    expect(controller.getDetachedPanels().map((panel) => panel.panelId)).toEqual(["panel.a"]);

    // The freed slot serves another plugin without touching the detached panel.
    controller.showReport("plugin.b", "panel.b", { title: "B", sections: [] });
    expect(notifyPanelClosed).not.toHaveBeenCalled();
    expect(controller.getOpenPanel()?.panelId).toBe("panel.b");
    expect(controller.getDetachedPanels()).toHaveLength(1);
  });

  it("routes new reports for a detached panel to the detached entry, not the in-app slot", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "Pending", sections: [] });
    controller.detachPanel("plugin.a", "panel.a");
    controller.showReport("plugin.b", "panel.b", { title: "B", sections: [] });

    // The detached panel's plugin pushes its result; the in-app panel (plugin.b) must be untouched.
    controller.showReport("plugin.a", "panel.a", { title: "Result", sections: [], rerunCommandId: "cmd.proton" });

    expect(controller.getOpenPanel()?.panelId).toBe("panel.b");
    const detached = controller.getDetachedPanels().find((panel) => panel.panelId === "panel.a");
    expect(detached?.report.title).toBe("Result");
    expect(detached?.commandId).toBe("cmd.proton");
    expect(notifyPanelClosed).not.toHaveBeenCalled();
  });

  it("re-attaches a detached panel when its window never opened, without a close notification", () => {
    // "Open as window" detaches BEFORE the native open resolves, so a rejected open used to strand
    // the panel: off the in-app surface, no window rendering it, clearable only by disabling the
    // plugin. Re-attaching is a surface change back, so the plugin still gets no cancellation.
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.detachPanel("plugin.a", "panel.a");
    expect(controller.reattachPanel("plugin.a", "panel.a")).toBe(true);

    expect(notifyPanelClosed).not.toHaveBeenCalled();
    expect(controller.getOpenPanel()?.panelId).toBe("panel.a");
    expect(controller.getDetachedPanels()).toHaveLength(0);
  });

  it("refuses to re-attach when another panel already took the in-app slot", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.detachPanel("plugin.a", "panel.a");
    controller.showReport("plugin.b", "panel.b", { title: "B", sections: [] });

    // Re-attaching would evict the panel the user is now looking at, so the caller is told no and
    // closes this one properly instead of leaving an entry no surface can display.
    expect(controller.reattachPanel("plugin.a", "panel.a")).toBe(false);
    expect(controller.getOpenPanel()?.panelId).toBe("panel.b");
    expect(controller.getDetachedPanels()).toHaveLength(1);
    expect(notifyPanelClosed).not.toHaveBeenCalled();

    // Unknown ids are a no-op, matching closeDetachedPanel.
    expect(controller.reattachPanel("plugin.z", "panel.z")).toBe(false);
  });

  it("treats closing a detached panel as a real ADR-0012 close", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.detachPanel("plugin.a", "panel.a");
    controller.closeDetachedPanel("plugin.a", "panel.a");

    expect(notifyPanelClosed).toHaveBeenCalledOnce();
    expect(notifyPanelClosed).toHaveBeenCalledWith("plugin.a", "panel.a");
    expect(controller.getDetachedPanels()).toHaveLength(0);

    // Unknown/already-closed ids are no-ops, not throws.
    controller.closeDetachedPanel("plugin.a", "panel.a");
    expect(notifyPanelClosed).toHaveBeenCalledOnce();
  });

  it("keeps same-named panels from different plugins as distinct detached owners", () => {
    const { host, notifyPanelClosed } = hostWithPanels();
    const controller = new PluginPanelController(host, () => "t");

    controller.showReport("plugin.a", "panel.a", { title: "A", sections: [] });
    controller.detachPanel("plugin.a", "panel.a");
    controller.showReport("plugin.b", "panel.a", { title: "B", sections: [] });
    controller.detachPanel("plugin.b", "panel.a");

    expect(controller.getDetachedPanels()).toEqual([
      expect.objectContaining({ pluginId: "plugin.a", panelId: "panel.a", report: { title: "A", sections: [] } }),
      expect.objectContaining({ pluginId: "plugin.b", panelId: "panel.a", report: { title: "B", sections: [] } })
    ]);

    controller.closeDetachedPanel("plugin.a", "panel.a");
    expect(controller.getDetachedPanels()).toEqual([
      expect.objectContaining({ pluginId: "plugin.b", panelId: "panel.a" })
    ]);
    expect(notifyPanelClosed).toHaveBeenCalledExactlyOnceWith("plugin.a", "panel.a");
  });
});
