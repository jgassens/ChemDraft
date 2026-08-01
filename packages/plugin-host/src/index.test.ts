import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import type { PluginManifest, PluginPanelReport, PluginPermission } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import {
  CommandRegistry,
  CommandRegistryError,
  PluginHost,
  PluginHostError,
  PluginPermissionError,
  validateTrustedPluginManifest
} from "./index";

const timestamp = "2026-05-29T00:00:00.000Z";

function moleculeObject(id = "mol_001"): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 80,
    y: 96,
    width: 160,
    height: 120,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: []
  };
}

describe("CommandRegistry", () => {
  it("registers, lists, and invokes a command definition", async () => {
    const registry = new CommandRegistry();

    registry.register({ id: "document.new", title: "New Document", source: "core" }, () => {
      return "new-document";
    });

    await expect(registry.invoke("document.new")).resolves.toBe("new-document");
    expect(registry.list()).toEqual([
      {
        id: "document.new",
        title: "New Document",
        source: "core",
        requiredPermissions: [],
        enabled: true
      }
    ]);
  });

  it("rejects duplicate, disabled, missing, and permission-gated commands", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "plugin.secure.run", title: "Run", requiredPermissions: ["native.execute"] }, () => "ok");
    registry.register({ id: "plugin.disabled.run", title: "Disabled", enabled: false }, () => "ok");

    expect(() => registry.register({ id: "plugin.secure.run", title: "Duplicate" }, () => "ok")).toThrow(
      CommandRegistryError
    );
    await expect(registry.invoke("plugin.missing.run")).rejects.toThrow(CommandRegistryError);
    await expect(registry.invoke("plugin.disabled.run")).rejects.toThrow(CommandRegistryError);
    await expect(registry.invoke("plugin.secure.run")).rejects.toThrow(PluginPermissionError);
    await expect(
      registry.invoke("plugin.secure.run", {
        permissions: new Set(["native.execute"])
      })
    ).resolves.toBe("ok");
  });
});

describe("PluginHost", () => {
  it("registers plugin commands and queues proposed patches for user review", async () => {
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin(
      {
        id: "org.chemdraft.ocsr.demo",
        name: "OCSR Demo",
        version: "0.0.1",
        apiVersion: "^1.0.0",
        entry: "dist/plugin.js",
        permissions: ["document.proposePatch", "image.read", "plugin.storage"],
        contributes: {
          commands: [
            {
              id: "plugin.ocsrDemo.recognize",
              title: "Recognize Image",
              requiredPermissions: ["document.proposePatch", "image.read"]
            }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.ocsrDemo.recognize": async (context) => {
            expect(context.hasPermission("image.read")).toBe(true);
            const storage = context.storage;
            await storage?.set("last-source", "fixture://benzene.png");

            return await context.documents.proposePatch({
              reason: "recognized-structure",
              patch: {
                op: "addObject",
                pageId: "page_001",
                object: moleculeObject()
              }
            });
          }
        }
      }
    );

    const receipt = await host.invokeCommand("plugin.ocsrDemo.recognize");
    expect(receipt).toMatchObject({
      id: "proposal_1",
      pluginId: "org.chemdraft.ocsr.demo",
      status: "pending",
      createdAt: timestamp
    });
    expect(host.listProposedPatches("pending")).toHaveLength(1);
    await expect(host.getStorage("org.chemdraft.ocsr.demo").get("last-source")).resolves.toBe(
      "fixture://benzene.png"
    );
  });

  it("applies an accepted proposed patch through chem-core", async () => {
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.demo",
      name: "Patch Demo",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });

    const queued = host.proposePatch("org.chemdraft.patch.demo", {
      reason: "recognized-structure",
      patch: {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      }
    });

    const document = createEmptyDocument({ now: timestamp });
    const updated = host.acceptProposedPatch(queued.id, document, { now: timestamp });

    expect(updated.pages[0].objects).toEqual([moleculeObject()]);
    expect(host.listProposedPatches("accepted")).toHaveLength(1);
    expect(() => host.acceptProposedPatch(queued.id, updated)).toThrow(PluginHostError);
  });

  // The proposal queue is the one place plugin-authored data is held pending a trusted `applyPatch`.
  // Handing out the stored object let a caller flip `status` behind the host's back, so that the
  // queue and `requirePendingProposal` disagreed about what was still pending.
  it("hands out proposals as frozen copies, so a caller cannot mutate the queue's own state", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.demo",
      name: "Patch Demo",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });
    const queued = host.proposePatch("org.chemdraft.patch.demo", {
      reason: "recognized-structure",
      patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
    });

    expect(Object.isFrozen(queued)).toBe(true);
    expect(() => {
      (queued as { status: string }).status = "accepted";
    }).toThrow(TypeError);

    // Mutating a listed copy must not reach the queue either.
    const [listed] = host.listProposedPatches("pending");
    expect(() => {
      (listed as { status: string }).status = "rejected";
    }).toThrow(TypeError);
    expect(host.listProposedPatches("pending")).toHaveLength(1);

    // The host's own transitions still work on its internal copy.
    expect(host.rejectProposedPatch(queued.id).status).toBe("rejected");
    expect(host.listProposedPatches("pending")).toHaveLength(0);
  });

  it("rejects proposed patches from plugins without document.proposePatch", () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.chemdraft.readonly",
      name: "Read Only",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"]
    });

    expect(() =>
      host.proposePatch("org.chemdraft.readonly", {
        reason: "not-allowed",
        patch: {
          op: "addObject",
          pageId: "page_001",
          object: moleculeObject()
        }
      })
    ).toThrow(PluginPermissionError);
  });

  it("keeps plugin storage scoped and permission-gated", async () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.chemdraft.storage.a",
      name: "Storage A",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["plugin.storage"]
    });
    host.registerPlugin({
      id: "org.chemdraft.storage.b",
      name: "Storage B",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["plugin.storage"]
    });
    host.registerPlugin({
      id: "org.chemdraft.no.storage",
      name: "No Storage",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: []
    });

    await host.getStorage("org.chemdraft.storage.a").set("token", "a-only");
    await host.getStorage("org.chemdraft.storage.b").set("token", "b-only");

    await expect(host.getStorage("org.chemdraft.storage.a").get("token")).resolves.toBe("a-only");
    await expect(host.getStorage("org.chemdraft.storage.b").get("token")).resolves.toBe("b-only");
    await expect(host.getStorage("org.chemdraft.storage.a").listKeys()).resolves.toEqual(["token"]);
    expect(() => host.getStorage("org.chemdraft.no.storage")).toThrow(PluginPermissionError);
  });

  it("keeps contributed commands disabled until handlers are registered", async () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.chemdraft.disabled.command",
      name: "Disabled Command",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: {
        commands: [{ id: "plugin.disabled.command", title: "Disabled Command" }]
      }
    });

    expect(host.commands.get("plugin.disabled.command")).toMatchObject({ enabled: false });
    await expect(host.invokeCommand("plugin.disabled.command")).rejects.toThrow(CommandRegistryError);
  });
});

function minimalManifest(id: string): PluginManifest {
  return {
    id,
    name: `Plugin ${id}`,
    version: "0.0.1",
    apiVersion: "^0.1.0",
    entry: "dist/plugin.js",
    permissions: [],
    contributes: {
      commands: [],
      menus: [],
      panels: [],
      toolbarButtons: [],
      toolsets: [],
      inspectors: [],
      templates: [],
      importers: [],
      exporters: [],
      analyzers: [],
      transformers: [],
      recognizers: []
    }
  };
}

describe("PluginHost runtime enumeration, panels, and subscriptions", () => {
  it("rejects duplicate plugin registration", () => {
    const host = new PluginHost();
    host.registerPlugin(minimalManifest("org.test.dup"));
    expect(() => host.registerPlugin(minimalManifest("org.test.dup"))).toThrow(PluginHostError);
  });

  it("rejects core command ids at the manifest boundary without leaving a ghost plugin", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "document.save", title: "Save", source: "core" }, () => "core-save");
    const host = new PluginHost({ commandRegistry: registry });

    expect(() =>
      host.registerPlugin({
        id: "org.test.command-impersonation",
        name: "Command Impersonation",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "document.save", title: "Fake Save" }] }
      })
    ).toThrow(/Plugin command ids must use/);

    expect(host.getPlugin("org.test.command-impersonation")).toBeUndefined();
    await expect(registry.invoke("document.save")).resolves.toBe("core-save");
  });

  it("preflights shared-registry collisions before exposing plugin state", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "plugin.shared.run", title: "Existing", source: "core" }, () => "existing");
    const host = new PluginHost({ commandRegistry: registry });

    expect(() =>
      host.registerPlugin({
        id: "org.test.collision",
        name: "Collision",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "plugin.shared.run", title: "Colliding command" }] }
      })
    ).toThrow(CommandRegistryError);

    expect(host.getPlugin("org.test.collision")).toBeUndefined();
    expect(host.listPlugins()).toEqual([]);
    await expect(registry.invoke("plugin.shared.run")).resolves.toBe("existing");
  });

  it("rolls back only commands it registered when an unexpected registration failure occurs", () => {
    class FailingRegistry extends CommandRegistry {
      override register(definition: Parameters<CommandRegistry["register"]>[0], handler: Parameters<CommandRegistry["register"]>[1]): void {
        super.register(definition, handler);
        if (definition.id === "plugin.rollback.second") {
          throw new CommandRegistryError("synthetic registration failure");
        }
      }
    }

    const registry = new FailingRegistry();
    const host = new PluginHost({ commandRegistry: registry });
    expect(() =>
      host.registerPlugin({
        id: "org.test.rollback",
        name: "Rollback",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: {
          commands: [
            { id: "plugin.rollback.first", title: "First" },
            { id: "plugin.rollback.second", title: "Second" }
          ]
        }
      })
    ).toThrow("synthetic registration failure");

    expect(registry.has("plugin.rollback.first")).toBe(false);
    expect(registry.has("plugin.rollback.second")).toBe(false);
    expect(host.getPlugin("org.test.rollback")).toBeUndefined();
  });

  it("does not remove a command that is no longer owned by the plugin during unregister", async () => {
    const registry = new CommandRegistry();
    const host = new PluginHost({ commandRegistry: registry });
    host.registerPlugin({
      id: "org.test.ownership",
      name: "Ownership",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: { commands: [{ id: "plugin.ownership.run", title: "Run" }] }
    });

    registry.unregister("plugin.ownership.run");
    registry.register({ id: "plugin.ownership.run", title: "Replacement", source: "core" }, () => "replacement");
    host.unregisterPlugin("org.test.ownership");

    await expect(registry.invoke("plugin.ownership.run")).resolves.toBe("replacement");
  });

  it("notifies subscribers when plugins register and unregister, and stops after unsubscribe", () => {
    const host = new PluginHost();
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);

    host.registerPlugin(minimalManifest("org.test.sub.a"));
    host.unregisterPlugin("org.test.sub.a");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    host.registerPlugin(minimalManifest("org.test.sub.b"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects a menu contribution that references a command the plugin does not contribute", () => {
    const host = new PluginHost();
    expect(() =>
      host.registerPlugin({
        id: "org.test.badmenu",
        name: "Bad Menu",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["ui.menu"],
        contributes: {
          commands: [{ id: "plugin.badMenu.run", title: "Run" }],
          menus: [
            {
              id: "menu.badMenu.open",
              title: "Open",
              commandId: "plugin.badMenu.missing",
              location: "analyze",
              requiredPermissions: ["ui.menu"]
            }
          ]
        }
      })
    ).toThrow(PluginHostError);
  });

  it("enumerates contributions with their plugin id and filters menus by location", () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.test.analyze",
      name: "Analyze Plugin",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: ["ui.menu", "ui.panel"],
      contributes: {
        commands: [{ id: "plugin.analyze.run", title: "Run" }],
        menus: [
          {
            id: "menu.analyze.run",
            title: "Analyze",
            commandId: "plugin.analyze.run",
            location: "analyze",
            requiredPermissions: ["ui.menu"]
          }
        ],
        panels: [{ id: "panel.analyze.main", title: "Main", commandId: "plugin.analyze.run" }],
        analyzers: [{ id: "analyzer.analyze.main", title: "Analysis", commandId: "plugin.analyze.run" }]
      }
    });

    expect(host.listMenuContributions("analyze").map((entry) => entry.pluginId)).toEqual(["org.test.analyze"]);
    expect(host.listMenuContributions("file")).toHaveLength(0);
    expect(host.listPanelContributions()[0]).toMatchObject({
      pluginId: "org.test.analyze",
      contribution: { id: "panel.analyze.main" }
    });
    expect(host.listAnalyzerContributions()[0]?.contribution.id).toBe("analyzer.analyze.main");
    expect(host.listCommandContributions()[0]?.contribution.id).toBe("plugin.analyze.run");
  });

  it("serves chemistry.compute only when the plugin declares it AND the host provides an engine", async () => {
    // Two independent conditions, and the failure mode differs: an undeclared permission is a plugin
    // error, an absent engine is a host without that capability. Neither may look like the other, and
    // neither may surface as a call that throws — the plugin has to be able to say which.
    const computeIsotopeEnvelope = vi.fn(async () => ({
      available: true as const,
      peaks: [{ mass: 78.04695, relativeIntensity: 100 }],
      truncation: { policy: "relative-intensity-threshold", threshold: 1e-4 },
      engine: { id: "isospec-wasm", version: "2.3.5" },
      conventions: ["natural abundances from IsoSpec's built-in tables"]
    }));

    const manifest = (id: string, permissions: PluginPermission[]) => ({
      id,
      name: "Chem Plugin",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions,
      contributes: {
        commands: [{ id: `plugin.${id.split(".").pop()}.probe`, title: "Probe" }]
      }
    });

    // 1. Declared + provided → the capability is there and reaches the engine.
    const granted = new PluginHost({ computeIsotopeEnvelope });
    let seen: unknown;
    granted.registerPlugin(manifest("org.test.chemyes", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.chemyes.probe": async (context) => {
          seen = await context.chemistry?.isotopeEnvelope({ format: "smiles", structure: "c1ccccc1" });
        }
      }
    });
    await granted.invokeCommand("plugin.chemyes.probe");
    expect(computeIsotopeEnvelope).toHaveBeenCalledWith({ format: "smiles", structure: "c1ccccc1" });
    expect(seen).toMatchObject({ available: true });

    // 2. Provided but not declared → no API at all, rather than a permission error at call time.
    const undeclared = new PluginHost({ computeIsotopeEnvelope });
    let undeclaredApi: unknown = "unset";
    undeclared.registerPlugin(manifest("org.test.chemno", []), {
      commandHandlers: {
        "plugin.chemno.probe": (context) => {
          undeclaredApi = context.chemistry;
        }
      }
    });
    await undeclared.invokeCommand("plugin.chemno.probe");
    expect(undeclaredApi).toBeUndefined();

    // 3. Declared but the host has no engine → the API is STILL there and answers `available: false`.
    //    Presence tracks the permission, not the engine, because a worker-routed plugin builds its stub
    //    from its own manifest and cannot see what the host wired up. Gating presence on the engine
    //    would make the in-process and worker paths disagree on the same host.
    const engineless = new PluginHost();
    let englessAnswer: unknown;
    engineless.registerPlugin(manifest("org.test.chemhostless", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.chemhostless.probe": async (context) => {
          expect(context.chemistry).toBeDefined();
          englessAnswer = await context.chemistry?.isotopeEnvelope({ format: "smiles", structure: "CCO" });
        }
      }
    });
    await engineless.invokeCommand("plugin.chemhostless.probe");
    expect(englessAnswer).toEqual({ available: false, reason: "This host provides no isotope engine." });
  });

  it("serves name-to-structure under the same permission and the same presence rule", async () => {
    // A second capability on `chemistry.compute`, wired the same way on purpose: one permission, one
    // presence rule, and the engine's availability carried in the answer rather than in whether the
    // method exists. Anything else and a plugin would have to probe differently per capability.
    const convertNameToStructure = vi.fn(async () => ({
      available: true as const,
      parsed: true as const,
      smiles: "C1=CC=CC=C1",
      engine: { id: "opsin", version: "2.9.0" }
    }));

    const manifest = (id: string, permissions: PluginPermission[]) => ({
      id,
      name: "Name Plugin",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions,
      contributes: { commands: [{ id: `plugin.${id.split(".").pop()}.probe`, title: "Probe" }] }
    });

    const granted = new PluginHost({ convertNameToStructure });
    let seen: unknown;
    granted.registerPlugin(manifest("org.test.nameyes", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.nameyes.probe": async (context) => {
          seen = await context.chemistry?.nameToStructure?.({ name: "benzene" });
        }
      }
    });
    await granted.invokeCommand("plugin.nameyes.probe");
    expect(convertNameToStructure).toHaveBeenCalledWith({ name: "benzene" });
    expect(seen).toMatchObject({ available: true, parsed: true, smiles: "C1=CC=CC=C1" });

    // No engine → still present, still answers, and says the host has none rather than throwing.
    const engineless = new PluginHost();
    let englessAnswer: unknown;
    engineless.registerPlugin(manifest("org.test.namehostless", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.namehostless.probe": async (context) => {
          expect(context.chemistry?.nameToStructure).toBeDefined();
          englessAnswer = await context.chemistry?.nameToStructure?.({ name: "benzene" });
        }
      }
    });
    await engineless.invokeCommand("plugin.namehostless.probe");
    expect(englessAnswer).toEqual({
      available: false,
      reason: "This host provides no name-to-structure engine."
    });
  });

  it("hands a plugin a laid-out object but never inserts it", async () => {
    // The division that makes this capability safe: the host does the 2D layout a plugin cannot do,
    // and the plugin still has to go through proposePatch to get it into the document. If this method
    // inserted, it would be a write path that bypasses the review queue.
    const object = { id: "mol_plugin_1", type: "molecule", x: 0, y: 0 };
    const buildStructureFromSmiles = vi.fn(async () => ({
      available: true as const,
      built: true as const,
      object: object as never
    }));
    const host = new PluginHost({ buildStructureFromSmiles });
    let seen: unknown;
    host.registerPlugin(
      {
        id: "org.test.layout",
        name: "Layout Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.2",
        entry: "dist/plugin.js",
        permissions: ["chemistry.compute"],
        contributes: { commands: [{ id: "plugin.layout.probe", title: "Probe" }] }
      },
      {
        commandHandlers: {
          "plugin.layout.probe": async (context) => {
            seen = await context.chemistry?.structureFromSmiles?.({ smiles: "c1ccccc1", origin: "Test" });
          }
        }
      }
    );
    await host.invokeCommand("plugin.layout.probe");

    expect(buildStructureFromSmiles).toHaveBeenCalledWith({ smiles: "c1ccccc1", origin: "Test" });
    expect(seen).toMatchObject({ available: true, built: true, object });
    // Nothing reached the patch queue: building is not proposing.
    expect(host.listProposedPatches()).toHaveLength(0);
  });

  it("says the host has no layout engine rather than throwing", async () => {
    const host = new PluginHost();
    let answer: unknown;
    host.registerPlugin(
      {
        id: "org.test.nolayout",
        name: "Layout Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.2",
        entry: "dist/plugin.js",
        permissions: ["chemistry.compute"],
        contributes: { commands: [{ id: "plugin.nolayout.probe", title: "Probe" }] }
      },
      {
        commandHandlers: {
          "plugin.nolayout.probe": async (context) => {
            answer = await context.chemistry?.structureFromSmiles?.({ smiles: "c1ccccc1" });
          }
        }
      }
    );
    await host.invokeCommand("plugin.nolayout.probe");
    expect(answer).toEqual({ available: false, reason: "This host provides no 2D layout engine." });
  });

  it("rejects an empty name at the boundary rather than passing it to an engine", async () => {
    // The schema is the gate, as it is for the envelope request. An engine asked to parse "" answers
    // something unhelpful; refusing here keeps the failure at the boundary that can explain it.
    const convertNameToStructure = vi.fn();
    const host = new PluginHost({ convertNameToStructure });
    let thrown: unknown;
    host.registerPlugin(
      {
        id: "org.test.nameempty",
        name: "Name Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["chemistry.compute"],
        contributes: { commands: [{ id: "plugin.nameempty.probe", title: "Probe" }] }
      },
      {
        commandHandlers: {
          "plugin.nameempty.probe": async (context) => {
            try {
              await context.chemistry?.nameToStructure?.({ name: "" });
            } catch (error) {
              thrown = error;
            }
          }
        }
      }
    );
    await host.invokeCommand("plugin.nameempty.probe");
    expect(thrown).toBeDefined();
    expect(convertNameToStructure).not.toHaveBeenCalled();
  });

  it("routes a schema-validated panel report through showPanelReport for declared panels only", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    host.registerPlugin(
      {
        id: "org.test.panel",
        name: "Panel Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: {
          commands: [
            { id: "plugin.panel.show", title: "Show", requiredPermissions: ["ui.panel"] },
            { id: "plugin.panel.showUndeclared", title: "Show Undeclared", requiredPermissions: ["ui.panel"] }
          ],
          panels: [{ id: "panel.panel.main", title: "Main", commandId: "plugin.panel.show" }]
        }
      },
      {
        commandHandlers: {
          "plugin.panel.show": async (context) => {
            const report: PluginPanelReport = {
              title: "Result",
              sections: [{ kind: "text", body: "hello" }]
            };
            await context.panels?.showReport("panel.panel.main", report);
          },
          "plugin.panel.showUndeclared": async (context) => {
            await context.panels?.showReport("panel.panel.undeclared", {
              title: "Nope",
              sections: []
            });
          }
        }
      }
    );

    await host.invokeCommand("plugin.panel.show");
    expect(showPanelReport).toHaveBeenCalledTimes(1);
    expect(showPanelReport).toHaveBeenCalledWith(
      "org.test.panel",
      "panel.panel.main",
      expect.objectContaining({ title: "Result" })
    );

    await expect(host.invokeCommand("plugin.panel.showUndeclared")).rejects.toThrow(PluginHostError);
    expect(showPanelReport).toHaveBeenCalledTimes(1);
  });
});

describe("validateTrustedPluginManifest", () => {
  it("returns a parsed manifest with contribution defaults", () => {
    const manifest = validateTrustedPluginManifest({
      id: "org.chemdraft.demo",
      name: "Demo Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"]
    });

    expect(manifest.id).toBe("org.chemdraft.demo");
    expect(manifest.contributes.commands).toEqual([]);
  });
});

describe("PluginHost onPanelClosed hook", () => {
  it("invokes the plugin's onPanelClosed and drops it on unregister (ADR-0012)", () => {
    const host = new PluginHost();
    const closed: string[] = [];
    host.registerPlugin(minimalManifest("org.test.panelclose"), {
      onPanelClosed: (panelId) => closed.push(panelId)
    });

    host.notifyPanelClosed("org.test.panelclose", "panel.test.review");
    expect(closed).toEqual(["panel.test.review"]);

    host.notifyPanelClosed("org.unknown", "panel.test.review"); // unknown plugin → no-op

    host.unregisterPlugin("org.test.panelclose");
    host.notifyPanelClosed("org.test.panelclose", "panel.test.review"); // handler removed → no-op
    expect(closed).toEqual(["panel.test.review"]);
  });
});
