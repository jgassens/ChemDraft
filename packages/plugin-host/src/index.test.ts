import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
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
