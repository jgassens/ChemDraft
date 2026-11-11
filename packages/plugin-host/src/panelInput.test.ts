import { describe, expect, it, vi } from "vitest";
import { PluginPanelReportLimits, PluginPanelReportSchema, type PluginCommandContext, type PluginCommandInput, type PluginPanelPayload, type PluginPanelReport } from "@chemdraft/plugin-api";
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
  it("rejects exotic arrays on first show and updates without calling their iterator", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    const getter = vi.fn(function* () { while (true) yield { kind: "text", body: "unbounded" }; });
    const iteratorGetter = vi.fn(() => getter);
    const exotic: PluginPanelReport = { title: "Unbounded", sections: [] };
    Object.defineProperty(exotic.sections, Symbol.iterator, { get: iteratorGetter });
    let report = exotic;
    host.registerPlugin(manifest, { commandHandlers: {
      [commandId]: ctx => ctx.panels!.showReport(panelId, report)
    } });
    await expect(host.invokeCommand(commandId)).rejects.toThrow("symbol keys");
    expect(showPanelReport).not.toHaveBeenCalled();
    report = { title: "Valid", sections: [{ kind: "text", body: "Existing result" }] };
    await host.invokeCommand(commandId);
    report = exotic;
    await expect(host.invokeCommand(commandId)).rejects.toThrow("symbol keys");
    expect(showPanelReport).toHaveBeenCalledTimes(1);
    expect(showPanelReport.mock.calls[0]![2]).toEqual({ title: "Valid", sections: [{ kind: "text", body: "Existing result" }] });
    expect(iteratorGetter).toHaveBeenCalledTimes(0);
    expect(getter).toHaveBeenCalledTimes(0);
  });

  it("forwards detached snapshots on first show and updates, including Proxy action payloads", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    host.registerPlugin(manifest);
    const panels = host.createCommandContext(manifest.id).panels!;
    for (const title of ["First report", "Updated report"]) {
      const target = { nested: { value: "original" }, list: ["original"] };
      const get = vi.fn(Reflect.get);
      const payload = new Proxy(target, { get });
      const report: PluginPanelReport = { title, sections: [{ kind: "actions", id: "controls", buttons: [{
        id: "send", label: "Send", commandId, payload, disabled: false, tone: "default"
      }] }] };
      const expected = { title, sections: [{ kind: "actions", id: "controls", buttons: [{
        id: "send", label: "Send", commandId, payload: { nested: { value: "original" }, list: ["original"] }, disabled: false, tone: "default"
      }] }] };
      await panels.showReport(panelId, report);
      expect(get).toHaveBeenCalledTimes(0);
      const forwarded: PluginPanelReport = showPanelReport.mock.lastCall![2];
      expect(forwarded).toEqual(expected);
      expect(forwarded).not.toBe(report);
      target.nested.value = "changed";
      target.list.push("x".repeat(PluginPanelReportLimits.serializedBytes));
      report.title = "Changed";
      report.sections.length = 0;
      expect(forwarded).toEqual(expected);
      expect(new TextEncoder().encode(JSON.stringify(forwarded)).byteLength).toBeLessThan(PluginPanelReportLimits.serializedBytes);
    }
    expect(showPanelReport).toHaveBeenCalledTimes(2);
    expect(showPanelReport.mock.calls[0]![2].title).toBe("First report");
    expect(showPanelReport.mock.calls[1]![2].title).toBe("Updated report");
  }, 60_000);

  it("rejects an oversized report through the existing command failure path before updating the panel", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    let report: PluginPanelReport = { title: "Valid", sections: [{ kind: "text", body: "Existing result" }] };
    host.registerPlugin(manifest, { commandHandlers: {
      [commandId]: ctx => ctx.panels!.showReport(panelId, report)
    } });
    await host.invokeCommand(commandId);
    expect(showPanelReport).toHaveBeenCalledTimes(1);
    report = { title: "Oversized", sections: [{
      kind: "linkedFigure", spectrum: { nucleus: "1H", domain: { min: 0, max: 12 },
        peaks: Array(PluginPanelReportLimits.peaks + 1).fill({ id: "p", ppm: 1, intensity: 1, atomIndices: [] }) }
    }] };
    await expect(host.invokeCommand(commandId)).rejects.toThrow(
      "linkedFigure peaks: 50001 exceeds the limit of 50000"
    );
    expect(showPanelReport).toHaveBeenCalledTimes(1);
    expect(showPanelReport.mock.calls[0]![2].title).toBe("Valid");
    report = { title: "Non-finite", sections: [{
      kind: "linkedFigure", spectrum: { nucleus: "1H", domain: { min: 0, max: Infinity }, peaks: [] }
    }] };
    await expect(host.invokeCommand(commandId)).rejects.toThrow("Infinity must be finite");
    expect(showPanelReport).toHaveBeenCalledTimes(1);
  }, 60_000);

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

describe("canvas content uses the bounded report snapshot", () => {
  function setup() {
    const overlayId = "overlay.chat.main";
    const setContent = vi.fn();
    const host = new PluginHost({ overlays: { setStatus: vi.fn(), setContent } });
    host.registerPlugin({ ...manifest, permissions: ["ui.panel", "ui.canvas"], contributes: {
      ...manifest.contributes, canvasOverlays: [{ id: overlayId, title: "Chat", icon: "data:image/png;base64,YQ==",
        commandId, prompt: { kind: "prompt", id: "composer", commandId } }]
    } });
    return { overlayId, setContent, api: host.createCommandContext(manifest.id).overlays! };
  }

  it("accepts 60 KiB of overlay text unchanged", async () => {
    const { overlayId, setContent, api } = setup();
    const sections = [{ kind: "text" as const, body: "x".repeat(60 * 1024) }];
    await api.setContent({ overlayId, sections });
    expect(setContent.mock.calls[0]![2]).toEqual(sections);
    expect(setContent.mock.calls[0]![2]).not.toBe(sections);
  });

  it("accepts image data at the overlay JSON cap and names that cap at one byte over", async () => {
    const { overlayId, setContent, api } = setup();
    const section = { kind: "image" as const, alt: "", dataUri: "data:image/png;base64," };
    const overhead = Buffer.byteLength(JSON.stringify([section]));
    section.dataUri += "A".repeat(Math.floor((64 * 1024 - overhead) / 4) * 4);
    section.alt = "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify([section])));
    const sections = [section];
    expect(Buffer.byteLength(JSON.stringify(sections))).toBe(64 * 1024);
    await api.setContent({ overlayId, sections });
    expect(setContent.mock.calls[0]![2]).toEqual(sections);
    section.alt += "x";
    await expect(api.setContent({ overlayId, sections })).rejects.toThrow("Overlay content must be at most 64 KiB of UTF-8 JSON.");
    expect(setContent).toHaveBeenCalledTimes(1);
  });

  it("rejects getters and exotic iterators before Zod reads plugin data", async () => {
    const { overlayId, setContent, api } = setup();
    const getter = vi.fn(() => []);
    await expect(api.setContent({ overlayId, get sections() { return getter(); } })).rejects.toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled();
    const sections: [] = [];
    const iterate = vi.fn(function* () { while (true) yield { kind: "text", body: "unbounded" }; });
    const iteratorGetter = vi.fn(() => iterate);
    Object.defineProperty(sections, Symbol.iterator, { get: iteratorGetter });
    await expect(api.setContent({ overlayId, sections } as unknown as Parameters<typeof api.setContent>[0])).rejects.toThrow(/symbol keys/);
    expect(getter).not.toHaveBeenCalled();
    expect(iteratorGetter).not.toHaveBeenCalled();
    expect(iterate).not.toHaveBeenCalled();
    expect(setContent).not.toHaveBeenCalled();
  });

  it("detaches nested action payloads on every update, including proxy references", async () => {
    const { overlayId, setContent, api } = setup();
    for (const value of ["first", "update"]) {
      const payload = { nested: { value } };
      const request = { overlayId, sections: [{ kind: "actions" as const, id: "send-actions", buttons: [
        { id: "send", label: "Send", commandId, payload: new Proxy(payload, {}) }
      ] }] };
      await api.setContent(request);
      payload.nested.value = "mutated";
      expect(setContent.mock.calls.at(-1)![2][0].buttons[0].payload).toEqual({ nested: { value } });
    }
  });

  it("forwards a detached 1,900-level payload and refuses a 4,002-character payload", async () => {
    const { overlayId, setContent, api } = setup();
    const content = (depth: number) => ({ overlayId, sections: [{ kind: "actions" as const, id: "send-actions", buttons: [
      { id: "send", label: "Send", commandId, payload: JSON.parse("[".repeat(depth) + "]".repeat(depth)) }
    ] }] });
    const request = content(1_900);
    await api.setContent(request);
    const received = setContent.mock.calls[0]![2][0].buttons[0].payload;
    expect(received).not.toBe(request.sections[0]!.buttons[0]!.payload);
    expect(JSON.stringify(received)).toBe(JSON.stringify(request.sections[0]!.buttons[0]!.payload));
    await expect(api.setContent(content(2_001))).rejects.toThrow("Panel payload must be JSON-serializable, at most 4000 characters");
    expect(setContent).toHaveBeenCalledTimes(1);
  });

  it("bounds malformed depth before schema parsing and never forwards it", async () => {
    const { overlayId, setContent, api } = setup();
    let payload: PluginPanelPayload = {};
    for (let n = 0; n < PluginPanelReportLimits.payloadDepth + 1; n++) payload = { nested: payload };
    await expect(api.setContent({ overlayId, sections: [{ kind: "actions", id: "send-actions", buttons: [
      { id: "send", label: "Send", commandId, payload }
    ] }] })).rejects.toThrow(/depth/);
    expect(setContent).not.toHaveBeenCalled();
  });
});
