import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import type { PluginManifest, PluginPanelReport } from "@chemdraft/plugin-api";
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

  // A hostile plugin can hand the host a self-referencing proposal: the patch interior is
  // deliberately passthrough() and structuredClone/postMessage both preserve cycles. Freezing that
  // graph without a visited set blew the stack, and the throw escaped through proposePatch /
  // listProposedPatches / rejectProposedPatch — the review tray calls the second during render with
  // no error boundary above it, so untrusted input crashed the whole app, repeatably after restart.
  it("survives a cyclic proposed patch instead of blowing the stack", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.hostile",
      name: "Hostile",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });

    const cyclic: Record<string, unknown> = { op: "updateObject", objectId: "obj_1" };
    cyclic.self = cyclic;
    cyclic.nested = { back: cyclic, list: [cyclic] };

    const queued = host.proposePatch("org.chemdraft.patch.hostile", {
      reason: "hostile-cycle",
      patch: cyclic as never
    });

    // Every queue operation stays usable, so the user can still see and dismiss the proposal.
    expect(() => host.listProposedPatches()).not.toThrow();
    expect(host.listProposedPatches("pending")).toHaveLength(1);
    expect(() => host.rejectProposedPatch(queued.id)).not.toThrow();
    expect(host.listProposedPatches("rejected")).toHaveLength(1);

    // And the snapshot is still frozen through the cycle.
    const [rejected] = host.listProposedPatches("rejected");
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(Object.isFrozen(rejected.proposal.patch)).toBe(true);
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

describe("PluginHost document boundary", () => {
  it("hands in-process plugins a frozen copy of the active document, never the live one", async () => {
    // The selection API deep-copies and freezes with the comment "never a live document reference".
    // getActiveDocument returned the provider's value untouched ten lines later, so an in-process
    // plugin -- a supported path; the MolScribe canary deliberately stays in-process -- could mutate
    // the host's own document object directly, bypassing the propose/review channel entirely.
    const live = createEmptyDocument({ now: timestamp });
    live.pages[0].objects.push(moleculeObject());

    const host = new PluginHost({ now: () => timestamp, getActiveDocument: () => live });
    host.registerPlugin({
      id: "org.test.docread",
      name: "Doc Reader",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"],
      contributes: { commands: [] }
    });

    const context = host.createCommandContext("org.test.docread");
    const handed = await context.documents.getActiveDocument();

    expect(handed).not.toBe(live);
    expect(handed).toEqual(live);
    expect(Object.isFrozen(handed)).toBe(true);
    expect(Object.isFrozen(handed?.pages[0].objects[0])).toBe(true);
    expect(() => {
      (handed as { title: string }).title = "hijacked";
    }).toThrow();
    expect(live.title).not.toBe("hijacked");
  });
});
