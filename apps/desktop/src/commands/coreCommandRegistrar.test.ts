import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createCoreCommandRegistrar, type CoreCommandBinding } from "./coreCommandRegistrar";

const binding = (id: string, run: () => void | Promise<void>, enabled = true): [string, CoreCommandBinding] => [
  id,
  { spec: { id, title: id, enabled }, run }
];

describe("createCoreCommandRegistrar", () => {
  it("dispatches core commands through the registry", async () => {
    const registry = new CommandRegistry();
    let live = new Map<string, CoreCommandBinding>();
    const sync = createCoreCommandRegistrar(registry, () => live);

    const calls: string[] = [];
    live = new Map([binding("document.new", () => {
      calls.push("new");
    })]);
    sync(live);

    await registry.invoke("document.new");
    expect(calls).toEqual(["new"]);
  });

  it("runs the latest closure after re-sync without recreating the registry", async () => {
    const registry = new CommandRegistry();
    let live = new Map<string, CoreCommandBinding>();
    const sync = createCoreCommandRegistrar(registry, () => live);

    let seen = "";
    live = new Map([binding("edit.undo", () => { seen = "first"; })]);
    sync(live);
    // Rebuild the bindings (as every render does) with a fresh closure for the same id.
    live = new Map([binding("edit.undo", () => { seen = "second"; })]);
    sync(live);

    await registry.invoke("edit.undo");
    expect(seen).toBe("second");
  });

  it("keeps plugin commands registered directly into the registry across re-syncs", async () => {
    const registry = new CommandRegistry();
    let live = new Map<string, CoreCommandBinding>();
    const sync = createCoreCommandRegistrar(registry, () => live);

    live = new Map([binding("tool.select", () => undefined)]);
    sync(live);

    // A plugin registers straight into the shared registry (what PluginHost does in Phase 2).
    let pluginRan = false;
    registry.register({ id: "plugin.demo.run", title: "Run", enabled: true }, async () => {
      pluginRan = true;
      return { ok: true };
    });

    // Core bindings churn on subsequent renders; the plugin command must survive.
    live = new Map([binding("tool.select", () => undefined), binding("tool.bond", () => undefined)]);
    sync(live);

    expect(registry.has("plugin.demo.run")).toBe(true);
    await registry.invoke("plugin.demo.run");
    expect(pluginRan).toBe(true);
  });

  it("unregisters core commands dropped from the bindings map", () => {
    const registry = new CommandRegistry();
    let live = new Map<string, CoreCommandBinding>();
    const sync = createCoreCommandRegistrar(registry, () => live);

    live = new Map([binding("tool.select", () => undefined), binding("core.temporary", () => undefined)]);
    sync(live);
    expect(registry.has("core.temporary")).toBe(true);

    live = new Map([binding("tool.select", () => undefined)]);
    sync(live);
    expect(registry.has("core.temporary")).toBe(false);
    expect(registry.has("tool.select")).toBe(true);
  });

  it("honours the live enabled flag even though the registered definition stays enabled", async () => {
    const registry = new CommandRegistry();
    let live = new Map<string, CoreCommandBinding>();
    const sync = createCoreCommandRegistrar(registry, () => live);

    live = new Map([binding("layout.group", () => undefined, false)]);
    sync(live);

    await expect(registry.invoke("layout.group")).rejects.toThrow(/disabled/);
  });
});
