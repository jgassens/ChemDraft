import { describe, expect, it } from "vitest";
import type { PluginSelectionSnapshot, PluginStorage } from "@chemdraft/plugin-api";
import { PluginHost } from "./index";

const commandIdFor = (id: string, action = "run"): string => `plugin.${id}.${action}`;

const manifestWith = (id: string, permissions: string[]) => ({
  id,
  name: "Selection Test Plugin",
  version: "1.0.0",
  apiVersion: "0.1.0",
  entry: "./index.ts",
  permissions,
  contributes: {
    commands: [{ id: commandIdFor(id), title: "Run" }]
  }
});

describe("plugin host selection + storage backends", () => {
  it("exposes the selection API only with selection.read", async () => {
    const snapshot = {
      objectIds: ["m1"],
      molecules: [
        { objectId: "m1", structureFormat: "smiles" as const, structure: "c1ccccc1", sourceFingerprint: "fp-m1" }
      ]
    };

    const granted = new PluginHost({ getSelection: () => snapshot });
    granted.registerPlugin(manifestWith("org.test.granted", ["selection.read"]), {
      commandHandlers: { [commandIdFor("org.test.granted")]: async (context) => context.selection?.getSelection() }
    });
    await expect(granted.invokeCommand(commandIdFor("org.test.granted"))).resolves.toMatchObject({
      objectIds: ["m1"],
      molecules: [{ structure: "c1ccccc1" }]
    });

    const denied = new PluginHost({ getSelection: () => snapshot });
    denied.registerPlugin(manifestWith("org.test.denied", []), {
      commandHandlers: { [commandIdFor("org.test.denied")]: async (context) => context.selection }
    });
    await expect(denied.invokeCommand(commandIdFor("org.test.denied"))).resolves.toBeUndefined();
  });

  it("hands plugins a deeply frozen, independent copy of the selection snapshot", async () => {
    const source: PluginSelectionSnapshot = {
      objectIds: ["m1"],
      molecules: [{ objectId: "m1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp" }]
    };
    const host = new PluginHost({ getSelection: () => source });
    host.registerPlugin(manifestWith("org.test.frozen", ["selection.read"]), {
      commandHandlers: { [commandIdFor("org.test.frozen")]: async (context) => context.selection?.getSelection() }
    });

    const first = await host.invokeCommand<PluginSelectionSnapshot>(commandIdFor("org.test.frozen"));
    const second = await host.invokeCommand<PluginSelectionSnapshot>(commandIdFor("org.test.frozen"));

    // Immutable: the returned snapshot and its nested objects are frozen.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.molecules)).toBe(true);
    expect(Object.isFrozen(first.molecules[0])).toBe(true);

    // Independent: not the live provider object, and a fresh copy each call.
    expect(first).not.toBe(source);
    expect(first.molecules[0]).not.toBe(source.molecules[0]);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
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
          { id: commandIdFor("org.test.panels", "show"), title: "Show" },
          { id: commandIdFor("org.test.panels", "showUndeclared"), title: "Show Undeclared" }
        ],
        panels: [{ id: "panel.test.nmrResults", title: "NMR Results" }]
      }
    };
    host.registerPlugin(manifest, {
      commandHandlers: {
        [commandIdFor("org.test.panels", "show")]: async (context) =>
          context.panels?.showReport("panel.test.nmrResults", {
            title: "Predicted 1H NMR",
            sections: [
              { kind: "keyValue", rows: [{ label: "Solvent", value: "CDCl3" }] },
              { kind: "svg", svg: "<svg xmlns='http://www.w3.org/2000/svg'/>" }
            ]
          }),
        [commandIdFor("org.test.panels", "showUndeclared")]: async (context) =>
          context.panels?.showReport("panel.test.notDeclared", { title: "Nope", sections: [] })
      }
    });

    await host.invokeCommand(commandIdFor("org.test.panels", "show"));
    expect(shown).toEqual([{ pluginId: "org.test.panels", panelId: "panel.test.nmrResults", title: "Predicted 1H NMR" }]);

    await expect(host.invokeCommand(commandIdFor("org.test.panels", "showUndeclared"))).rejects.toThrow(/does not declare panel/);
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
