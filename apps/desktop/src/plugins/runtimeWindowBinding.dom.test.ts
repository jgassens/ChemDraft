// @vitest-environment jsdom
import { createEmptyDocument } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { PluginPanelReportSchema, type PluginCommandContext, type PluginCommandInput } from "@chemdraft/plugin-api";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { RuntimeBroker } from "./runtimeBroker";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { createRuntimeDocumentSession } from "./runtimeDocumentSession";
import { bindRuntimeHostSession } from "./runtimeHostSession";
import { createPluginRuntimeOwner } from "./pluginRuntimeOwner";
import { resolvePluginPanelAction } from "./pluginPanelActions";
import { pluginPanelIdentityKey, pluginPanelWindowId, pluginPanelWindowLabel, parsePluginPanelWindowLabel } from "./panelBridge";

vi.mock("./pluginStagingFs", async original => ({ ...await original<typeof import("./pluginStagingFs")>(), isTauriHost: () => true }));
vi.mock("./installPluginPackage", async original => ({ ...await original<typeof import("./installPluginPackage")>(),
  loadInstalledPlugins: async () => ({ installed: [], failures: [] }) }));
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); vi.unstubAllGlobals(); });

async function fixture() {
  vi.stubGlobal("localStorage", new MemoryStorage());
  const channels = new RuntimeTestChannels();
  const transport = (label: string) => {
    const port = channels.transport(label);
    return { ...port, immediate: false, send: (recipient: string, message: Parameters<typeof port.send>[1]) => Promise.resolve().then(() => port.send(recipient, message)) };
  };
  const hostBroker = new RuntimeBroker("runtime", transport("runtime"));
  const closed = vi.fn();
  const contexts = new Map<string, PluginCommandContext>();
  const seen: Array<{ title: string; input?: PluginCommandInput }> = [];
  let owner!: ReturnType<typeof createPluginRuntimeOwner>;
  const create = vi.fn((providers: Parameters<typeof createPluginRuntimeOwner>[0]) => {
    owner = createPluginRuntimeOwner(providers);
    owner.runtime.registerPlugin({ id: "org.test.window", name: "Window fixture", version: "1", apiVersion: "^0.1.25", entry: "fixture.js",
      permissions: ["document.read", "selection.read", "ui.panel", "ui.canvas", "ui.toolbar"],
      contributes: {
        commands: [{ id: "plugin.window.open", title: "Open" }, { id: "plugin.window.send", title: "Send" }, { id: "plugin.window.prompt", title: "Prompt" }],
        menus: [{ id: "menu.window.open", title: "Open", commandId: "plugin.window.open", location: "plugins" }],
        panels: [{ id: "panel.window.report", title: "Report", commandId: "plugin.window.open" }],
        canvasOverlays: [{ id: "overlay.window.prompt", title: "Window", commandId: "plugin.window.send", icon: "data:image/png;base64,AA==",
          prompt: { kind: "prompt", id: "prompt", commandId: "plugin.window.send", placeholder: "Ask", submitLabel: "Send", maxLength: 100,
            select: { id: "provider", label: "Provider", value: "a", options: [{ value: "a", label: "A" }], commandId: "plugin.window.send" } } }],
        toolsets: [{ id: "plugin.window.tools", title: "Window", groups: [{ id: "actions", title: "Actions", items: [{ commandId: "plugin.window.open", title: "Open" }] }] }]
      }
    }, { onPanelClosed: closed, commandHandlers: {
      "plugin.window.prompt": context => context.dialogs!.promptText({ title: "Ask", label: "Value", maxLength: 100 }),
      "plugin.window.open": async context => {
        const document = await context.documents.getActiveDocument!();
        contexts.set(document!.title, context);
        await context.panels!.showReport("panel.window.report", PluginPanelReportSchema.parse({ title: "Report", sections: [
          { kind: "prompt", id: "prompt", commandId: "plugin.window.send", placeholder: "Ask", submitLabel: "Send", maxLength: 100,
            select: { id: "provider", label: "Provider", value: "a", options: [{ value: "a", label: "A" }], commandId: "plugin.window.send" } },
          { kind: "actions", id: "actions", buttons: [{ id: "go", label: "Go", commandId: "plugin.window.send" }] }
        ] }));
      },
      "plugin.window.send": async context => {
        const document = await context.documents.getActiveDocument!();
        seen.push({ title: document!.title, input: context.input });
        await context.overlays!.setStatus({ overlayId: "overlay.window.prompt", text: document!.title });
        await context.overlays!.setTranscript({ overlayId: "overlay.window.prompt", entries: [{ role: "user", text: document!.title }] });
        await context.overlays!.setContent({ overlayId: "overlay.window.prompt", sections: [{ kind: "text", body: document!.title }], prompt: { restoreDraft: document!.title } });
        await context.overlays!.open({ overlayId: "overlay.window.prompt", focus: false });
      }
    } });
    return owner;
  });
  const stopHost = bindRuntimeHostSession(hostBroker, create);
  stops.push(() => { stopHost(); hostBroker.dispose(); });
  const clients = ["main", "doc-b"].map(windowId => {
    const registry = new CommandRegistry();
    registry.register({ id: "core.which", title: "Which" }, () => windowId);
    let active = "same-tab";
    const tabs = new Map(["same-tab", "other-tab"].map(tabId => [tabId, { ...createEmptyDocument(), title: `${windowId}:${tabId}` }]));
    const port: RuntimeDocumentPort = { windowId, commandRegistry: registry, activeTabId: () => active,
      read: tabId => tabs.has(tabId) ? { document: tabs.get(tabId)!, documentKey: `${windowId}:${tabId}` } : undefined,
      selection: () => ({ objectIds: [], molecules: [] }), runWrite: async (_tab, commit) => commit(),
      commit: () => { throw new Error("This presentation fixture never writes."); } };
    const providers = { documentPort: port, commandRegistry: registry,
      documentTabs: [...tabs].map(([id, document]) => ({ id, title: document.title })) };
    const session = createRuntimeDocumentSession(providers, async label => transport(label));
    stops.push(session.dispose);
    return { session, registry, port, activate: (tabId: string) => { active = tabId; session.updateDocumentProviders(providers); } };
  });
  await Promise.all(clients.map(client => client.session.client.ready));
  return { clients, channels, create, contexts, seen, closed, runtime: owner.runtime };
}

it("shares one production owner, proxies every contribution, and routes panel prompt/select/actions to their own window", async () => {
  const f = await fixture();
  for (const client of f.clients) {
    const view = client.session.client.read();
    expect(client.registry.get("plugin.window.open")?.pluginId).toBe("org.test.window");
    expect(view.pluginMenuItems.some(item => item.command.kind === "command" && item.command.commandId === "plugin.window.open")).toBe(true);
    expect(view.canvasOverlays.some(item => item.overlay.id === "overlay.window.prompt")).toBe(true);
    expect(view.runtime.listPluginToolsets().some(item => item.id === "plugin.window.tools")).toBe(true);
    await view.invokePluginCommand("plugin.window.open");
    await vi.waitFor(() => expect(client.session.client.read().detachedPanels).toHaveLength(1));
    const panel = client.session.client.read().detachedPanels[0]!;
    expect(panel.windowId ?? "main").toBe(client.port.windowId);
    expect(panel.documentName).toBe(`${client.port.windowId}:same-tab`);
    for (const request of [
      { panelId: panel.panelId, control: "prompt" as const, sectionId: "prompt", text: "ask" },
      { panelId: panel.panelId, control: "select" as const, sectionId: "prompt", controlId: "provider", selected: "a" },
      { panelId: panel.panelId, control: "button" as const, sectionId: "actions", controlId: "go" }
    ]) {
      const resolved = resolvePluginPanelAction(panel.report, request, id => client.registry.get(id)?.pluginId === panel.pluginId);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) await view.invokePluginCommand(resolved.commandId, { input: resolved.input });
    }
    await expect(view.invokePluginCommand("core.which")).resolves.toBe(client.port.windowId);
  }
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.seen.map(item => item.title)).toEqual(["main:same-tab", "main:same-tab", "main:same-tab", "doc-b:same-tab", "doc-b:same-tab", "doc-b:same-tab"]);
  for (const { session, port } of f.clients) {
    await vi.waitFor(() => expect(session.client.runtime.getCanvasOverlayStatuses().get("overlay.window.prompt")).toBe(`${port.windowId}:same-tab`));
    expect(session.client.runtime.getCanvasOverlayTranscripts().get("overlay.window.prompt")?.[0]?.text).toBe(`${port.windowId}:same-tab`);
    expect(session.client.runtime.getCanvasOverlayDraftRestore("overlay.window.prompt")?.text).toBe(`${port.windowId}:same-tab`);
    expect(session.client.runtime.getCanvasOverlayContents().get("overlay.window.prompt")?.[0]).toMatchObject({ body: `${port.windowId}:same-tab` });
  }
});

it("shows and answers a broker prompt only in its source window", async () => {
  const { clients } = await fixture();
  const [a, b] = clients;
  const pending = b!.session.client.runtime.invokeCommand("plugin.window.prompt");
  await vi.waitFor(() => expect(b!.session.client.read().openTextPrompt).toBeDefined());
  expect(a!.session.client.read().openTextPrompt).toBeUndefined();
  const id = b!.session.client.read().openTextPrompt!.id;
  await expect(Promise.resolve(a!.session.client.read().submitTextPrompt(id, "Wrong"))).rejects.toThrow(/another document window/);
  await b!.session.client.read().submitTextPrompt(id, "Correct");
  await expect(pending).resolves.toEqual({ status: "submitted", value: "Correct" });
});

it("captures Send before a queue/focus change, closes only the source panels, and refuses late presentation resurrection", async () => {
  const f = await fixture();
  const [a, b] = f.clients;
  for (const client of f.clients) await client.session.client.runtime.invokeCommand("plugin.window.open");
  const run = a!.session.client.runtime.prepareCommand!("plugin.window.send");
  a!.activate("other-tab"); b!.activate("other-tab");
  await run();
  expect(f.seen).toMatchObject([{ title: "main:same-tab" }]);
  await a!.session.client.runtime.panels.closeDetachedPanel("org.test.window", "panel.window.report");
  await vi.waitFor(() => expect(f.runtime.panels.getDetachedPanels("main")).toHaveLength(0));
  expect(f.runtime.panels.getDetachedPanels("doc-b")).toHaveLength(1);
  expect(f.closed).toHaveBeenCalledTimes(1);
  // Native disconnect/destruction emits this same authenticated private request.
  f.channels.deliver("runtime", "doc-b", { version: 1, kind: "request", id: "native-close-b", method: "runtimeDocumentClosed", payload: {} });
  await vi.waitFor(() => expect(f.runtime.panels.getDetachedPanels("doc-b")).toHaveLength(0));
  expect(f.closed).toHaveBeenCalledTimes(2);
  await f.contexts.get("doc-b:same-tab")!.panels!.showReport("panel.window.report", { title: "Late", sections: [] });
  await f.contexts.get("doc-b:same-tab")!.overlays!.setStatus({ overlayId: "overlay.window.prompt", text: "Late" });
  expect(f.runtime.panels.getDetachedPanels("doc-b")).toHaveLength(0);
  expect(f.runtime.getCanvasOverlayStatuses("doc-b").size).toBe(0);
});

it("keeps main labels/keys and makes non-main labels reversible and independent", () => {
  const main = { pluginId: "a", panelId: "b" };
  expect(pluginPanelWindowId("a", "b")).toBe("v1x61x62");
  expect(pluginPanelIdentityKey("a", "b")).toBe("1:ab");
  for (const windowId of ["doc-b", "doc-c"]) {
    const identity = { ...main, windowId };
    expect(parsePluginPanelWindowLabel(pluginPanelWindowLabel(identity))).toEqual(identity);
    expect(pluginPanelWindowLabel(identity)).not.toBe(pluginPanelWindowLabel(main));
    expect(pluginPanelIdentityKey("a", "b", windowId)).not.toBe(pluginPanelIdentityKey("a", "b"));
  }
  expect(parsePluginPanelWindowLabel("plugin-panel-v2x6d61696ex61x62")).toBeUndefined();
});
