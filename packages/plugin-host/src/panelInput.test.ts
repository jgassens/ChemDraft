import { describe, expect, it, vi } from "vitest";
import { PluginPanelReportSchema, type PluginCommandContext, type PluginCommandInput } from "@chemdraft/plugin-api";
import { PluginHost } from "./index";

const commandId = "plugin.chat.submit";
const panelId = "panel.chat.main";
const input: PluginCommandInput = { source: "panel", panelId, sectionId: "composer", control: "prompt", text: "Draw water", selected: "provider", payload: { run: 1 } };
const manifest = {
  id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js",
  permissions: ["ui.panel"],
  contributes: {
    commands: [{ id: commandId, title: "Send" }, { id: "plugin.chat.stop", title: "Stop" }],
    panels: [{ id: panelId, title: "Chat", commandId }]
  }
};

describe("PluginHost panel input", () => {
  it("delivers input only to its invocation and snapshots the caller's payload", async () => {
    const host = new PluginHost();
    const handler = vi.fn((ctx: PluginCommandContext) => ctx.input);
    host.registerPlugin(manifest, { commandHandlers: { [commandId]: handler } });
    const submitted = structuredClone(input);
    const result = host.invokeCommand(commandId, { input: submitted });
    submitted.text = "Changed";
    expect(await result).toEqual(input);
    expect(await host.invokeCommand(commandId)).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0].input).not.toBe(submitted);
  });

  it.each([
    { ...input, text: "x".repeat(20001) },
    { ...input, panelId: "panel.other.main" },
    { ...input, panelId: undefined },
    { ...input, source: "overlay", panelId: undefined, overlayId: "overlay.chat.main" },
    { ...input, payload: JSON.parse('{"__proto__":{"polluted":true}}') }
  ])("refuses invalid, undeclared or unsupported input before running a handler %#", async raw => {
    const host = new PluginHost();
    const handler = vi.fn();
    host.registerPlugin(manifest, { commandHandlers: { [commandId]: handler } });
    await expect(host.invokeCommand(commandId, { input: raw as PluginCommandInput })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses input sent to core commands or a different plugin", async () => {
    const host = new PluginHost();
    const coreHandler = vi.fn();
    const otherHandler = vi.fn();
    host.commands.register({ id: "document.new", title: "New" }, coreHandler);
    host.registerPlugin(manifest);
    host.registerPlugin({ ...manifest, id: "org.test.other", contributes: {
      commands: [{ id: "plugin.other.submit", title: "Send" }],
      panels: [{ id: "panel.other.main", title: "Other" }]
    } }, { commandHandlers: { "plugin.other.submit": otherHandler } });
    await expect(host.invokeCommand("document.new", { input })).rejects.toThrow(/own command/);
    await expect(host.invokeCommand("plugin.other.submit", { input })).rejects.toThrow(/does not declare panel/);
    expect(coreHandler).not.toHaveBeenCalled();
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it("validates input even when invoked through the shared registry", async () => {
    const host = new PluginHost();
    const handler = vi.fn();
    host.registerPlugin(manifest, { commandHandlers: { [commandId]: handler } });
    await expect(host.commands.invoke(commandId, { input: { ...input, panelId: "panel.other.main" } }))
      .rejects.toThrow(/does not declare panel/);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("PluginHost panel control ownership", () => {
  it("accepts own commands in prompts, selects and action buttons", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    const report = PluginPanelReportSchema.parse({ title: "Chat", sections: [
      { kind: "prompt", id: "composer", commandId, select: { id: "provider", label: "Provider", value: "a", options: [{ value: "a", label: "A" }], commandId: "plugin.chat.stop" } },
      { kind: "actions", id: "controls", buttons: [{ id: "stop", label: "Stop", commandId: "plugin.chat.stop", disabled: true }] }
    ] });
    host.registerPlugin(manifest, { commandHandlers: {
      [commandId]: ctx => ctx.panels!.showReport(panelId, report), "plugin.chat.stop": () => {}
    } });
    await host.invokeCommand(commandId);
    expect(showPanelReport).toHaveBeenCalledWith(manifest.id, panelId, report);
  });

  it.each(["prompt", "select", "button"])("refuses foreign and unregistered commands on a %s control", async control => {
    for (const foreignId of ["plugin.other.submit", "plugin.missing.run"]) {
      const showPanelReport = vi.fn();
      const host = new PluginHost({ showPanelReport });
      host.registerPlugin({ ...manifest, id: "org.test.other", contributes: { commands: [{ id: "plugin.other.submit", title: "Other" }] } },
        { commandHandlers: { "plugin.other.submit": () => {} } });
      const prompt = { kind: "prompt", id: "composer", commandId: control === "prompt" ? foreignId : commandId,
        ...(control === "select" ? { select: { id: "provider", label: "Provider", value: "a", options: [{ value: "a", label: "A" }], commandId: foreignId } } : {}) };
      const report = PluginPanelReportSchema.parse({ title: "Chat", sections: control === "button"
        ? [{ kind: "actions", id: "controls", buttons: [{ id: "stop", label: "Stop", commandId: foreignId }] }]
        : [prompt] });
      host.registerPlugin(manifest, { commandHandlers: { [commandId]: ctx => ctx.panels!.showReport(panelId, report) } });
      await expect(host.invokeCommand(commandId)).rejects.toThrow(/own commands/);
      expect(showPanelReport).not.toHaveBeenCalled();
    }
  });

  it("refuses a declared command if its registry owner changed", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    host.registerPlugin(manifest);
    host.commands.unregisterOwnedByPlugin("plugin.chat.stop", manifest.id);
    host.commands.register({ id: "plugin.chat.stop", title: "Other", pluginId: "org.test.other" }, () => {});
    const report = PluginPanelReportSchema.parse({ title: "Chat", sections: [{ kind: "prompt", id: "composer", commandId: "plugin.chat.stop" }] });
    await expect(host.createCommandContext(manifest.id).panels!.showReport(panelId, report)).rejects.toThrow(/own commands/);
    expect(showPanelReport).not.toHaveBeenCalled();
  });
});
