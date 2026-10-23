import { describe, expect, it, vi } from "vitest";
import type { PluginCommandContext, PluginCommandInput, PluginPermission } from "@chemdraft/plugin-api";
import { PluginHost } from "./index";

const commandId = "plugin.chat.submit";
const overlayId = "overlay.chat.main";
const manifest = {
  id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js",
  permissions: ["ui.canvas"], contributes: {
    commands: [{ id: commandId, title: "Send" }],
    canvasOverlays: [{ id: overlayId, title: "Chat", icon: "data:image/png;base64,YQ==",
      commandId, prompt: { kind: "prompt", id: "composer", commandId } }]
  }
};
const input: PluginCommandInput = { source: "overlay", overlayId, sectionId: "composer", control: "prompt", text: "Draw water" };

describe("PluginHost canvas overlays", () => {
  it("validates, snapshots and gates transcripts on every call", async () => {
    const setTranscript = vi.fn();
    const host = new PluginHost({ overlays: { setStatus: vi.fn(), setTranscript } });
    host.registerPlugin(manifest);
    const api = host.createCommandContext(manifest.id).overlays!;
    const entries = [{ role: "assistant" as const, text: "Hello" }];
    await api.setTranscript({ overlayId, entries });
    entries[0]!.text = "Mutated";
    expect(setTranscript).toHaveBeenLastCalledWith(manifest.id, overlayId, [{ role: "assistant", text: "Hello" }]);
    await expect(api.setTranscript({ overlayId: "overlay.other.main", entries })).rejects.toThrow(/does not own/);
    await expect(api.setTranscript({ overlayId, entries: [{ role: "error", text: "x".repeat(4001) }] })).rejects.toThrow();
    await expect(api.setTranscript({ overlayId, entries: Array(51).fill({ role: "notice", text: "" }) })).rejects.toThrow();
    await expect(api.setTranscript({ overlayId, entries: Array(17).fill({ role: "tool", text: "x".repeat(4000) }) })).rejects.toThrow();
    expect(setTranscript).toHaveBeenCalledTimes(1);
    await api.setTranscript({ overlayId, entries: [] });
    const permissions = host.getPlugin(manifest.id)!.permissions as Set<PluginPermission>;
    permissions.delete("ui.canvas");
    expect(host.createCommandContext(manifest.id).overlays).toBeUndefined();
    await expect(api.setTranscript({ overlayId, entries })).rejects.toThrow(/ui.canvas/);
    permissions.add("ui.canvas");
    host.unregisterPlugin(manifest.id);
    await expect(api.setTranscript({ overlayId, entries })).rejects.toThrow(/not registered/);
    expect(setTranscript).toHaveBeenCalledTimes(2);
    const noSink = new PluginHost({ overlays: { setStatus: vi.fn() } });
    noSink.registerPlugin(manifest);
    await expect(noSink.createCommandContext(manifest.id).overlays!.setTranscript({ overlayId, entries: [] }))
      .rejects.toThrow(/provides no canvas transcripts/);
  });
  it("lists owned overlays and refuses a duplicate id without registering commands", () => {
    const host = new PluginHost();
    host.registerPlugin(manifest);
    expect(host.listCanvasOverlays()).toMatchObject([{ pluginId: manifest.id, overlay: { id: overlayId } }]);
    expect(() => host.registerPlugin({ ...manifest, id: "org.test.other", contributes: {
      commands: [{ id: "plugin.other.submit", title: "Other" }],
      canvasOverlays: [{ ...manifest.contributes.canvasOverlays[0], commandId: "plugin.other.submit",
        prompt: { kind: "prompt", id: "composer", commandId: "plugin.other.submit" } }]
    } })).toThrow(/already contributed/);
    expect(host.commands.has("plugin.other.submit")).toBe(false);
    host.unregisterPlugin(manifest.id);
    expect(host.listCanvasOverlays()).toEqual([]);
  });

  it("delivers only owned overlay input through host and shared registry", async () => {
    const host = new PluginHost();
    const handler = vi.fn((ctx: PluginCommandContext) => ctx.input);
    host.registerPlugin(manifest, { commandHandlers: { [commandId]: handler } });
    expect(await host.invokeCommand(commandId, { input })).toEqual(input);
    expect(await host.commands.invoke(commandId, { input })).toEqual(input);
    const before = handler.mock.calls.length;
    for (const invoke of [
      () => host.invokeCommand(commandId, { input: { ...input, overlayId: "overlay.other.main" } }),
      () => host.commands.invoke(commandId, { input: { ...input, overlayId: "overlay.other.main" } })
    ]) await expect(invoke()).rejects.toThrow(/does not declare overlay/);
    expect(handler).toHaveBeenCalledTimes(before);
    host.registerPlugin({ ...manifest, id: "other", permissions: [], contributes: {
      commands: [{ id: "plugin.other.submit", title: "Other" }]
    } }, { commandHandlers: { "plugin.other.submit": handler } });
    await expect(host.invokeCommand("plugin.other.submit", { input })).rejects.toThrow(/ui.canvas/);
  });

  it("gates status capability presence and re-checks permissions and ownership on every call", async () => {
    const setStatus = vi.fn();
    const host = new PluginHost({ overlays: { setStatus } });
    host.registerPlugin(manifest);
    const api = host.createCommandContext(manifest.id).overlays!;
    await api.setStatus({ overlayId, text: "Working" });
    await api.setStatus({ overlayId, text: "" });
    expect(setStatus.mock.calls).toEqual([[manifest.id, overlayId, "Working"], [manifest.id, overlayId, ""]]);
    await expect(api.setStatus({ overlayId: "overlay.other.main", text: "Foreign" })).rejects.toThrow(/does not own/);
    await expect(api.setStatus({ overlayId, text: "x".repeat(121) })).rejects.toThrow();
    expect(setStatus).toHaveBeenCalledTimes(2);
    // Simulate permission revocation while a plugin retains its capability reference.
    const permissions = host.getPlugin(manifest.id)!.permissions as Set<PluginPermission>;
    permissions.delete("ui.canvas");
    expect(host.createCommandContext(manifest.id).overlays).toBeUndefined();
    await expect(api.setStatus({ overlayId, text: "Late" })).rejects.toThrow(/ui.canvas/);
    expect(setStatus).toHaveBeenCalledTimes(2);
    permissions.add("ui.canvas");
    host.unregisterPlugin(manifest.id);
    await expect(api.setStatus({ overlayId, text: "After uninstall" })).rejects.toThrow(/not registered/);
  });

  it("rejects a call when the embedding host provides no overlay sink", async () => {
    const host = new PluginHost();
    host.registerPlugin(manifest);
    await expect(host.createCommandContext(manifest.id).overlays!.setStatus({ overlayId, text: "" }))
      .rejects.toThrow(/provides no canvas overlays/);
  });

  it("refuses overlay commands not declared by their plugin at registration", () => {
    const host = new PluginHost();
    expect(() => host.registerPlugin({ ...manifest, contributes: {
      ...manifest.contributes, commands: []
    } })).toThrow(/does not contribute/);
    expect(host.listPlugins()).toEqual([]);
  });
});
