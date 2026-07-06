import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@chemdraft/plugin-api";
import { PluginHost } from "./index";

const manifestWith = (id: string, permissions: string[]) => ({
  id,
  name: "Selection Test Plugin",
  version: "1.0.0",
  apiVersion: "0.1.0",
  entry: "./index.ts",
  permissions,
  contributes: {
    commands: [{ id: `${id}.run`, title: "Run" }]
  }
});

describe("plugin host selection + storage backends", () => {
  it("exposes the selection API only with selection.read", async () => {
    const snapshot = {
      objectIds: ["m1"],
      molecules: [{ objectId: "m1", structureFormat: "smiles", structure: "c1ccccc1" }]
    };

    const granted = new PluginHost({ getSelection: () => snapshot });
    granted.registerPlugin(manifestWith("org.test.granted", ["selection.read"]), {
      commandHandlers: { "org.test.granted.run": async (context) => context.selection?.getSelection() }
    });
    await expect(granted.invokeCommand("org.test.granted.run")).resolves.toMatchObject({
      objectIds: ["m1"],
      molecules: [{ structure: "c1ccccc1" }]
    });

    const denied = new PluginHost({ getSelection: () => snapshot });
    denied.registerPlugin(manifestWith("org.test.denied", []), {
      commandHandlers: { "org.test.denied.run": async (context) => context.selection }
    });
    await expect(denied.invokeCommand("org.test.denied.run")).resolves.toBeUndefined();
  });

  it("uses the injected storage factory and caches one backend per plugin", async () => {
    const created: string[] = [];
    const backing = new Map<string, unknown>();
    const host = new PluginHost({
      createStorage: (pluginId): PluginStorage => {
        created.push(pluginId);
        return {
          get: async (key) => backing.get(key) as never,
          set: async (key, value) => {
            backing.set(key, value);
          },
          delete: async (key) => {
            backing.delete(key);
          },
          listKeys: async () => [...backing.keys()].sort()
        };
      }
    });

    host.registerPlugin(manifestWith("org.test.storage", ["plugin.storage"]));
    await host.getStorage("org.test.storage").set("calibration", 42);

    expect(await host.getStorage("org.test.storage").get("calibration")).toBe(42);
    expect(created).toEqual(["org.test.storage"]);
  });

  it("routes validated panel reports only to declared panels with ui.panel", async () => {
    const shown: Array<{ pluginId: string; panelId: string; title: string }> = [];
    const host = new PluginHost({
      showPanelReport: (pluginId, panelId, report) => {
        shown.push({ pluginId, panelId, title: report.title });
      }
    });
    const manifest = {
      ...manifestWith("org.test.panels", ["ui.panel"]),
      contributes: {
        commands: [
          { id: "org.test.panels.show", title: "Show" },
          { id: "org.test.panels.showUndeclared", title: "Show Undeclared" }
        ],
        panels: [{ id: "nmr.results", title: "NMR Results" }]
      }
    };
    host.registerPlugin(manifest, {
      commandHandlers: {
        "org.test.panels.show": async (context) =>
          context.panels?.showReport("nmr.results", {
            title: "Predicted 1H NMR",
            sections: [
              { kind: "keyValue", rows: [{ label: "Solvent", value: "CDCl3" }] },
              { kind: "svg", svg: "<svg xmlns='http://www.w3.org/2000/svg'/>" }
            ]
          }),
        "org.test.panels.showUndeclared": async (context) =>
          context.panels?.showReport("not.declared", { title: "Nope", sections: [] })
      }
    });

    await host.invokeCommand("org.test.panels.show");
    expect(shown).toEqual([{ pluginId: "org.test.panels", panelId: "nmr.results", title: "Predicted 1H NMR" }]);

    await expect(host.invokeCommand("org.test.panels.showUndeclared")).rejects.toThrow(/does not declare panel/);
  });

  it("fires onProposedPatchesChanged across the proposal lifecycle", () => {
    let changes = 0;
    const host = new PluginHost({ onProposedPatchesChanged: () => changes++ });
    host.registerPlugin(manifestWith("org.test.patches", ["document.proposePatch"]));

    const queued = host.proposePatch("org.test.patches", {
      patch: { op: "addObject" } as never,
      reason: "Test proposal"
    });
    expect(changes).toBe(1);

    host.rejectProposedPatch(queued.id);
    expect(changes).toBe(2);
  });
});
