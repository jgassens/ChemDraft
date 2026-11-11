// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { MemoryStorage } from "../testSupport/memoryStorage";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import type { RuntimeTransport } from "./runtimeBrokerProtocol";

const native = vi.hoisted(() => ({ connect: vi.fn(), owner: vi.fn(), main: vi.fn(), editHistory: vi.fn() }));
vi.mock("./runtimeBrokerTransport", () => ({ connectNativeRuntimeTransport: native.connect }));
vi.mock("../MainWindow", () => { native.main(); return { MainWindow: () => null }; });
vi.mock("../editHistoryRouting", () => ({ installSecondaryWindowEditHistory: native.editHistory }));
vi.mock("./pluginStagingFs", async original => ({ ...await original<typeof import("./pluginStagingFs")>(), isTauriHost: () => true }));
vi.mock("./installPluginPackage", async original => ({ ...await original<typeof import("./installPluginPackage")>(),
  loadInstalledPlugins: async () => ({ installed: [], failures: [] }) }));
vi.mock("./pluginRuntimeOwner", async original => {
  const actual = await original<typeof import("./pluginRuntimeOwner")>();
  return { ...actual, createPluginRuntimeOwner: (providers: import("./pluginRuntimeOwner").PluginRuntimeProviders) => {
    native.owner(providers);
    const owner = actual.createPluginRuntimeOwner(providers);
    owner.runtime.registerPlugin({ id: "org.test.startup", name: "Startup fixture", version: "1.0.0", apiVersion: "^0.1.25", entry: "fixture.js",
      permissions: [], contributes: { commands: [{ id: "plugin.startup.run", title: "Run" }] }
    }, { commandHandlers: { "plugin.startup.run": () => "ready result" } });
    return owner;
  } };
});
import { App } from "../App";
import { createRuntimeDocumentSession } from "./runtimeDocumentSession";
import { RuntimeBroker } from "./runtimeBroker";
import { initializeRuntimeHost } from "./runtimeStartup";
import { bindRuntimeHostSession } from "./runtimeHostSession";
import { bindRuntimeCoreCommands } from "./runtimeCoreCommands";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
  window.dispatchEvent(new Event("pagehide"));
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

/** Native-shaped delivery timing and unavailable-peer errors, without the immediate embedding path. */
class PrivateChannels extends RuntimeTestChannels {
  private readonly connected = new Set<string>();
  override transport(label: string): RuntimeTransport {
    const transport = super.transport(label);
    return {
      immediate: false,
      subscribe: handler => {
        this.connected.add(label);
        const stop = transport.subscribe(handler);
        return () => { this.connected.delete(label); stop(); };
      },
      send: async (recipient, message) => {
        if (!this.connected.has(recipient)) throw new Error("Runtime broker recipient is not connected.");
        await Promise.resolve();
        await transport.send(recipient, message);
      }
    };
  }
}

it("starts the sole production owner on the hidden route after core definitions, while the document stays a view", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  const channels = new PrivateChannels();
  native.connect.mockImplementation(async (label: string) => channels.transport(label));
  const registry = new CommandRegistry();
  const draw = vi.fn(() => "drawing works");
  registry.register({ id: "core.draw", title: "Draw" }, draw);
  const drawing = createEmptyDocument();
  const port: RuntimeDocumentPort = {
    windowId: "main", commandRegistry: registry, activeTabId: () => "tab", read: () => ({ document: drawing, documentKey: "drawing" }),
    selection: () => ({ objectIds: [], molecules: [] }), runWrite: async (_tab, commit) => commit(),
    commit: () => { throw new Error("This fixture makes no document writes."); }
  };
  const session = createRuntimeDocumentSession({ documentPort: port, commandRegistry: registry });
  stops.push(session.dispose);
  expect(native.owner).not.toHaveBeenCalled();
  expect(session.client.read().isPluginCommand("plugin.startup.run")).toBe(true);
  await expect(session.client.runtime.invokeCommand("plugin.startup.run")).rejects.toThrow("Plugin runtime host is starting");
  await expect(session.client.runtime.invokeCommand("core.draw")).resolves.toBe("drawing works");
  window.history.replaceState(null, "", "/?window=runtime");
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  stops.push(() => { act(() => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(StrictMode, {}, createElement(App))));
  await vi.waitFor(() => expect(native.connect).toHaveBeenCalledWith("runtime"));
  await act(async () => { await session.client.ready; });
  expect(native.owner).toHaveBeenCalledTimes(1);
  const providers = native.owner.mock.calls[0]![0];
  expect(providers.dataOnly).toBe(true);
  expect(providers.commandRegistry.get("core.draw")?.title).toBe("Draw");
  expect(providers.documentPort).toBeUndefined();
  expect(providers.getActiveDocument()).toBeUndefined();
  expect(registry.get("plugin.startup.run")?.pluginId).toBe("org.test.startup");
  await expect(session.client.runtime.invokeCommand("plugin.startup.run")).resolves.toBe("ready result");
  const messages = channels.deliveries.length;
  await expect(session.client.runtime.invokeCommand("core.draw")).resolves.toBe("drawing works");
  await expect(session.client.runtime.prepareCommand!("core.draw")()).resolves.toBe("drawing works");
  expect(channels.deliveries).toHaveLength(messages);
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(App)));
  expect(native.owner).toHaveBeenCalledTimes(1);
  expect(container.innerHTML).toBe("");
  expect(native.main).not.toHaveBeenCalled();
  expect(native.editHistory).not.toHaveBeenCalled();
  expect(native.connect.mock.calls.map(([label]) => label)).toEqual(["main", "runtime"]);
});

it("reports a specific startup failure to commands and status without constructing an owner or blocking core drawing", async () => {
  const registry = new CommandRegistry();
  registry.register({ id: "core.draw", title: "Draw" }, () => "still drawing");
  const before = native.owner.mock.calls.length;
  const status = vi.fn();
  const session = createRuntimeDocumentSession({ commandRegistry: registry, onPluginUpdateStatus: status,
    documentPort: { windowId: "main", commandRegistry: registry, activeTabId: () => "tab", read: () => undefined,
      selection: () => ({ objectIds: [], molecules: [] }), runWrite: async (_tab, commit) => commit(),
      commit: () => { throw new Error("No write expected."); } }
  }, async () => { throw new Error("Native runtime channel registration refused."); });
  stops.push(session.dispose);
  await expect(session.client.ready).rejects.toThrow("Plugin runtime host failed to start: Native runtime channel registration refused.");
  await expect(session.client.runtime.invokeCommand("plugin.startup.run")).rejects.toThrow("Plugin runtime host failed to start");
  expect(status).toHaveBeenCalledWith(expect.stringContaining("Drawing remains available."));
  expect(session.client.read().diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "runtime-host-startup-failed", message: expect.stringContaining("Native runtime channel registration refused.") })
  ]));
  expect(native.owner).toHaveBeenCalledTimes(before);
  await expect(session.client.runtime.invokeCommand("core.draw")).resolves.toBe("still drawing");
  await expect(session.client.runtime.prepareCommand!("core.draw")()).resolves.toBe("still drawing");
  registry.register({ id: "core.disabled", title: "Disabled", enabled: false }, () => { throw new Error("must not run"); });
  registry.register({ id: "core.protected", title: "Protected", requiredPermissions: ["document.write"] }, () => { throw new Error("must not run"); });
  registry.register({ id: "document.input", title: "Input" }, context => context.input);
  registry.register({ id: "plugin.coreOwned", title: "Core ownership wins" }, () => "local core");
  await expect(session.client.runtime.invokeCommand("core.disabled")).rejects.toThrow("disabled");
  await expect(session.client.runtime.invokeCommand("core.protected")).rejects.toThrow('requires permission "document.write"');
  const input = { source: "panel" as const, panelId: "panel.test.draw", sectionId: "actions", control: "button" as const, controlId: "draw" };
  await expect(session.client.runtime.invokeCommand("document.input", { input })).resolves.toEqual(input);
  await expect(session.client.runtime.invokeCommand("plugin.coreOwned")).resolves.toBe("local core");
  await expect(session.client.runtime.invokeCommand("document.missing")).rejects.toThrow("not registered");
});

it("retains a failed owner initialization receipt rather than constructing another runtime on retry", async () => {
  const channels = new PrivateChannels();
  const host = new RuntimeBroker("runtime", channels.transport("runtime"));
  const document = new RuntimeBroker("main", channels.transport("main"));
  const stopCore = bindRuntimeCoreCommands(document, new CommandRegistry());
  const factory = vi.fn(() => { throw new Error("Fixture host owner startup failed."); });
  const stopHost = bindRuntimeHostSession(host, factory);
  stops.push(() => document.dispose(), () => host.dispose(), stopCore, stopHost);
  await expect(initializeRuntimeHost(document)).rejects.toThrow("Fixture host owner startup failed.");
  await expect(initializeRuntimeHost(document)).rejects.toThrow("Fixture host owner startup failed.");
  expect(factory).toHaveBeenCalledTimes(1);
});

it("bounds readiness waits for an absent or unresponsive host; it never retries a plugin command", async () => {
  vi.useFakeTimers();
  const channels = new PrivateChannels();
  const broker = new RuntimeBroker("main", channels.transport("main"));
  stops.push(() => broker.dispose());
  const absent = expect(initializeRuntimeHost(broker, 100)).rejects.toThrow("Plugin runtime host failed to start");
  await vi.advanceTimersByTimeAsync(100); await absent;
  const host = new RuntimeBroker("runtime", channels.transport("runtime"));
  stops.push(() => host.dispose());
  host.handle("initializeRuntime", () => new Promise(() => {}));
  const hung = expect(initializeRuntimeHost(broker, 100)).rejects.toThrow("initializeRuntime timed out");
  await vi.advanceTimersByTimeAsync(100); await hung;
  expect(channels.deliveries.every(({ message }) => message.kind !== "request" || message.method === "initializeRuntime")).toBe(true);
});
