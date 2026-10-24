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
  it("validates and snapshots prompt overrides before forwarding them to the embedding host", async () => {
    const setContent = vi.fn();
    const host = new PluginHost({ overlays: { setStatus: vi.fn(), setContent } });
    host.registerPlugin(manifest);
    const api = host.createCommandContext(manifest.id).overlays!;
    const prompt = { disabled: true, restoreDraft: "draw aspirin" };
    await api.setContent({ overlayId, sections: [], prompt });
    prompt.disabled = false;
    prompt.restoreDraft = "mutated";
    expect(setContent).toHaveBeenLastCalledWith(manifest.id, overlayId, [], { disabled: true, restoreDraft: "draw aspirin" });
    await expect(api.setContent({ overlayId, sections: [], prompt: { disabled: true, label: "Busy" } } as never)).rejects.toThrow();
    expect(setContent).toHaveBeenCalledOnce();
    await api.setContent({ overlayId, sections: [] });
    expect(setContent).toHaveBeenLastCalledWith(manifest.id, overlayId, [], undefined);
  });

  it("enforces the contributed prompt's maxLength for draft restoration", async () => {
    const setContent = vi.fn();
    const host = new PluginHost({ overlays: { setStatus: vi.fn(), setContent } });
    host.registerPlugin({ ...manifest, contributes: { ...manifest.contributes, canvasOverlays: [{
      ...manifest.contributes.canvasOverlays[0], prompt: { kind: "prompt", id: "composer", commandId, maxLength: 12 }
    }] } });
    const api = host.createCommandContext(manifest.id).overlays!;
    await api.setContent({ overlayId, sections: [], prompt: { restoreDraft: "draw aspirin" } });
    await expect(api.setContent({ overlayId, sections: [], prompt: { restoreDraft: "draw aspirin!" } })).rejects.toThrow(/12 character limit/);
    expect(setContent).toHaveBeenCalledOnce();
  });

  it("bounds content, snapshots it, and checks permissions, ownership and report control rules", async () => {
    const setContent = vi.fn();
    const host = new PluginHost({ overlays: { setStatus: vi.fn(), setContent } });
    host.registerPlugin(manifest);
    const api = host.createCommandContext(manifest.id).overlays!;
    const sections = [{ kind: "actions" as const, id: "setup", buttons: [{ id: "go", label: "Go", commandId }] }];
    await api.setContent({ overlayId, sections });
    sections[0]!.buttons[0]!.label = "mutated";
    expect(setContent.mock.calls[0]![2][0].buttons[0].label).toBe("Go");
    await expect(api.setContent({ overlayId: "overlay.other.main", sections: [] })).rejects.toThrow(/does not own/);
    await expect(api.setContent({ overlayId, sections: Array(21).fill({ kind: "text", body: "" }) })).rejects.toThrow();
    await expect(api.setContent({ overlayId, sections: [{ kind: "text", body: "界".repeat(22000) }] })).rejects.toThrow(/64 KiB/);
    await expect(api.setContent({ overlayId, sections: [...sections, ...sections] })).rejects.toThrow(/Duplicate/);
    await expect(api.setContent({ overlayId, sections: [{ ...sections[0]!, id: "composer" }] })).rejects.toThrow(/Duplicate/);
    await expect(api.setContent({ overlayId, sections: [{ kind: "actions", id: "actions", buttons: [
      { id: "foreign", label: "Foreign", commandId: "plugin.other.run" }
    ] }] })).rejects.toThrow(/own commands/);
    // Non-overlay report kinds must not slip through the shared renderer's larger vocabulary.
    await expect(api.setContent({ overlayId, sections: [{ kind: "svg", svg: "<svg/>" }] } as never)).rejects.toThrow();
    expect(setContent).toHaveBeenCalledTimes(1);
    await api.setContent({ overlayId, sections: [] });
    const permissions = host.getPlugin(manifest.id)!.permissions as Set<PluginPermission>;
    permissions.delete("ui.canvas");
    await expect(api.setContent({ overlayId, sections: [] })).rejects.toThrow(/ui.canvas/);
    permissions.add("ui.canvas");
    host.unregisterPlugin(manifest.id);
    await expect(api.setContent({ overlayId, sections: [] })).rejects.toThrow(/not registered/);
    const noSink = new PluginHost(); noSink.registerPlugin(manifest);
    await expect(noSink.createCommandContext(manifest.id).overlays!.setContent({ overlayId, sections: [] }))
      .rejects.toThrow(/no canvas content/);
  });

  it("opens only an owned overlay during its plugin's live command, with explicit focus", async () => {
    const open = vi.fn();
    const host = new PluginHost({ overlays: { setStatus: vi.fn(), open } });
    let retained: PluginCommandContext;
    host.registerPlugin(manifest, { commandHandlers: { [commandId]: async ctx => {
      retained = ctx;
      await ctx.overlays!.open({ overlayId });
      await ctx.overlays!.open({ overlayId, focus: true });
      await expect(ctx.overlays!.open({ overlayId: "overlay.other.main" })).rejects.toThrow(/does not own/);
      await expect(ctx.overlays!.open({ overlayId, focus: "true" } as never)).rejects.toThrow();
      const permissions = host.getPlugin(manifest.id)!.permissions as Set<PluginPermission>;
      permissions.delete("ui.canvas");
      await expect(ctx.overlays!.open({ overlayId })).rejects.toThrow(/ui.canvas/);
      permissions.add("ui.canvas");
    } } });
    await expect(host.createCommandContext(manifest.id).overlays!.open({ overlayId })).rejects.toThrow(/own command/);
    await host.invokeCommand(commandId);
    expect(open.mock.calls).toEqual([[manifest.id, overlayId, false], [manifest.id, overlayId, true]]);
    await expect(retained!.overlays!.open({ overlayId })).rejects.toThrow(/own command/);
    const noSink = new PluginHost();
    noSink.registerPlugin(manifest, { commandHandlers: { [commandId]: ctx => ctx.overlays!.open({ overlayId }) } });
    await expect(noSink.invokeCommand(commandId)).rejects.toThrow(/cannot open canvas/);
  });
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
