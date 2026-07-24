/**
 * M34 isolation-boundary tests (ADR-0029): drive the real {@link PluginWorkerBridge} against the real
 * `@chemdraft/plugin-api` worker runtime over an in-memory transport that structured-clones every
 * message (so any non-serializable payload fails loudly, proving the "data only across postMessage"
 * rule). Node has no `Worker`, so the worker runtime runs in-process here, connected to the bridge by a
 * linked endpoint pair — exercising the full protocol round-trip without a real thread.
 *
 * Covers the acceptance criteria: behavioral equivalence for the mass analyzer, cross-boundary
 * panel-close cancellation, declared-only capability enforcement, the version handshake, and total
 * teardown via terminate().
 */
import {
  PLUGIN_WORKER_PROTOCOL_VERSION,
  PluginApiVersion,
  PluginWorkerErrorCodes,
  parsePluginManifest,
  runPluginWorker,
  type HostToWorkerMessage,
  type PluginCommandContext,
  type PluginCommandHandler,
  type PluginManifest,
  type PluginPanelReport,
  type PluginSelectionSnapshot,
  type PluginWorkerEndpoint,
  type PluginWorkerHandle,
  type PluginWorkerRegistration
} from "@chemdraft/plugin-api";
import { createMassRegistration, massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import { PluginHost, type RegisterPluginOptions } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";

import { createBundledPluginDescriptors } from "./registerBundledPlugins";
import { PluginWorkerBridge, PluginWorkerBridgeError } from "./PluginWorkerBridge";

type MessageListener = (event: { data: unknown }) => void;

/** A message-port fake that mirrors a real Worker boundary: structured-clones on send, delivers on a
 *  microtask, buffers until a listener attaches (as a real port does before `start()`), and drops
 *  everything once terminated. Both a bridge (main side) and the worker runtime bind to one of these. */
class FakeEndpoint {
  peer!: FakeEndpoint;
  terminated = false;
  private readonly messageListeners = new Set<MessageListener>();
  private buffer: unknown[] = [];

  postMessage(message: unknown): void {
    if (this.terminated) {
      return;
    }
    const data = structuredClone(message);
    queueMicrotask(() => this.peer.receive(data));
  }

  private receive(data: unknown): void {
    if (this.terminated) {
      return;
    }
    if (this.messageListeners.size === 0) {
      this.buffer.push(data);
      return;
    }
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }

  addEventListener(type: string, listener: unknown): void {
    if (type !== "message") {
      return; // error/messageerror unused by the fake
    }
    const messageListener = listener as MessageListener;
    this.messageListeners.add(messageListener);
    if (this.buffer.length > 0) {
      const pending = this.buffer;
      this.buffer = [];
      for (const data of pending) {
        messageListener({ data });
      }
    }
  }

  removeEventListener(type: string, listener: unknown): void {
    if (type === "message") {
      this.messageListeners.delete(listener as MessageListener);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function linkedEndpoints(): { mainSide: FakeEndpoint; workerSide: FakeEndpoint } {
  const mainSide = new FakeEndpoint();
  const workerSide = new FakeEndpoint();
  mainSide.peer = workerSide;
  workerSide.peer = mainSide;
  return { mainSide, workerSide };
}

const asHandle = (endpoint: FakeEndpoint): PluginWorkerHandle => endpoint as unknown as PluginWorkerHandle;
const asEndpoint = (endpoint: FakeEndpoint): PluginWorkerEndpoint => endpoint as unknown as PluginWorkerEndpoint;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const BENZENE: PluginSelectionSnapshot = {
  objectIds: ["m1"],
  molecules: [
    { objectId: "m1", documentId: "doc1", pageId: "p1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp-benzene" }
  ]
};

function makeHost(): { host: PluginHost; reports: { panelId: string; report: PluginPanelReport }[] } {
  const reports: { panelId: string; report: PluginPanelReport }[] = [];
  const host = new PluginHost({
    getSelection: () => BENZENE,
    showPanelReport: (_pluginId, panelId, report) => {
      reports.push({ panelId, report });
    },
    now: () => "2020-01-01T00:00:00.000Z",
    createId: () => "record-fixed-id"
  });
  return { host, reports };
}

/** The delegating registration the desktop wires: each contributed command runs in the worker via the
 *  bridge, panel-close forwards to the worker. Mirrors `createWorkerRoutedOptions` in the desktop. */
function delegatingOptions(manifest: PluginManifest, bridge: PluginWorkerBridge): RegisterPluginOptions {
  const commandHandlers: Record<string, PluginCommandHandler> = {};
  for (const command of manifest.contributes.commands) {
    commandHandlers[command.id] = (context) => bridge.invokeCommand(command.id, context);
  }
  return { commandHandlers, onPanelClosed: (panelId) => bridge.notifyPanelClosed(panelId) };
}

/** Spin up a worker runtime + bridge pair for a plugin, returning the bridge. */
function startWorkerRoutedPlugin(registration: PluginWorkerRegistration): PluginWorkerBridge {
  const { mainSide, workerSide } = linkedEndpoints();
  runPluginWorker(registration, asEndpoint(workerSide));
  return new PluginWorkerBridge({
    pluginId: registration.manifest.id,
    createWorker: () => asHandle(mainSide),
    hostApiVersion: PluginApiVersion
  });
}

describe("PluginWorkerBridge — M34 isolation boundary", () => {
  it("mass analyzer: the worker path writes the same analysis record and renders the same report as in-process", async () => {
    const inProcess = makeHost();
    inProcess.host.registerPlugin(massFragmentManifest, { commandHandlers: createMassRegistration().commandHandlers });
    const inProcessResult = await inProcess.host.invokeCommand(massAnalyzeCommandId);

    const viaWorker = makeHost();
    const bridge = startWorkerRoutedPlugin({ manifest: massFragmentManifest, commandHandlers: createMassRegistration().commandHandlers });
    viaWorker.host.registerPlugin(massFragmentManifest, delegatingOptions(massFragmentManifest, bridge));
    const workerResult = await viaWorker.host.invokeCommand(massAnalyzeCommandId);

    expect(workerResult).toEqual(inProcessResult);
    expect(viaWorker.host.listAnalysis()).toEqual(inProcess.host.listAnalysis());
    expect(viaWorker.reports).toEqual(inProcess.reports);
    expect(viaWorker.reports.length).toBeGreaterThan(0);
    bridge.terminate();
  });

  it("closing a panel across the worker boundary aborts the in-flight command (ADR-0012): not-ok, no record", async () => {
    let observedStart!: () => void;
    const started = new Promise<void>((resolve) => {
      observedStart = resolve;
    });
    // A worker-side registration whose command hangs until the panel-close abort — routed through the
    // bridge — is the only thing that settles it. This is the shape every cancellable analyzer (e.g.
    // an installed long-running predictor) follows: onPanelClosed fires an AbortController.
    const manifest = parsePluginManifest({
      id: "org.test.cancellable",
      name: "Cancellable Analyzer",
      version: "0",
      apiVersion: "^0.1.0",
      entry: "x",
      permissions: ["selection.read", "analysis.write", "ui.panel"],
      contributes: {
        commands: [{ id: "plugin.cancellable.run", title: "Run", requiredPermissions: ["selection.read"] }],
        panels: [{ id: "panel.cancellable.result", title: "Result", requiredPermissions: ["ui.panel"] }]
      }
    });
    let abort: AbortController | undefined;
    const registration: PluginWorkerRegistration = {
      manifest,
      commandHandlers: {
        "plugin.cancellable.run": async (context) => {
          abort = new AbortController();
          await context.panels!.showReport("panel.cancellable.result", { title: "Working…", sections: [] });
          try {
            await new Promise((_resolve, reject) => {
              const fail = (): void => reject(new Error("Command was cancelled."));
              if (abort!.signal.aborted) {
                fail();
                return;
              }
              abort!.signal.addEventListener("abort", fail, { once: true });
              observedStart();
            });
            return { ok: true };
          } catch {
            return { ok: false, error: { code: "command-cancelled", message: "Command was cancelled." } };
          }
        }
      },
      onPanelClosed: (panelId) => {
        if (panelId === "panel.cancellable.result") {
          abort?.abort();
        }
      }
    };

    const viaWorker = makeHost();
    const bridge = startWorkerRoutedPlugin(registration);
    viaWorker.host.registerPlugin(manifest, delegatingOptions(manifest, bridge));

    const invocation = viaWorker.host.invokeCommand("plugin.cancellable.run");
    await started; // the worker has shown the pending report and is awaiting the abort

    bridge.notifyPanelClosed("panel.cancellable.result"); // host → worker → onPanelClosed → AbortController.abort()

    const result = await invocation;
    expect(result).toMatchObject({ ok: false, error: { code: "command-cancelled" } });
    expect(viaWorker.host.listAnalysis()).toHaveLength(0); // no record written for the cancelled run
    // The pending report crossed the boundary, but the aborted run never pushed a final report.
    expect(viaWorker.reports).toHaveLength(1);
    bridge.terminate();
  });

  it("provides only declared capabilities: an undeclared capability is refused at the bridge, a declared one succeeds — no consent gate exists", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const sentToWorker: HostToWorkerMessage[] = [];
    workerSide.addEventListener("message", (event: { data: unknown }) => sentToWorker.push(event.data as HostToWorkerMessage));

    const bridge = new PluginWorkerBridge({ pluginId: "org.test.caps", createWorker: () => asHandle(mainSide), hostApiVersion: PluginApiVersion });
    const ready = bridge.whenReady();
    workerSide.postMessage({ kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: "^0.1.0" });
    await ready;

    // A context granting selection.read but NOT analysis.write — exactly what the host builds for a
    // manifest that declares the former and not the latter (permissive: no prompt, just the capability).
    let selectionCalls = 0;
    const context = {
      plugin: { id: "org.test.caps", name: "Caps", version: "0", permissions: ["selection.read"] },
      documents: { getActiveDocument: async () => undefined, proposePatch: async () => ({}) as never },
      selection: {
        getSelection: async () => {
          selectionCalls += 1;
          return { objectIds: [], molecules: [] };
        }
      },
      hasPermission: (permission: string) => permission === "selection.read",
      requirePermission: () => undefined
    } as unknown as PluginCommandContext;

    const invocation = bridge.invokeCommand("cmd", context);
    await flush();
    const invoke = sentToWorker.find((m): m is Extract<HostToWorkerMessage, { kind: "invokeCommand" }> => m.kind === "invokeCommand");
    expect(invoke).toBeDefined();
    const commandRequestId = invoke!.commandRequestId;

    // Ungranted capability → the bridge refuses it (no analysis object on the context).
    workerSide.postMessage({ kind: "capabilityRequest", requestId: 101, commandRequestId, namespace: "analysis", method: "write", args: [{}] });
    await flush();
    const denial = sentToWorker.find(
      (m): m is Extract<HostToWorkerMessage, { kind: "capabilityResult" }> => m.kind === "capabilityResult" && m.requestId === 101
    );
    expect(denial).toMatchObject({ ok: false, error: { code: PluginWorkerErrorCodes.CapabilityNotGranted } });

    // A method outside the capability whitelist is also refused.
    workerSide.postMessage({ kind: "capabilityRequest", requestId: 102, commandRequestId, namespace: "selection", method: "wipe", args: [] });
    await flush();
    const badMethod = sentToWorker.find(
      (m): m is Extract<HostToWorkerMessage, { kind: "capabilityResult" }> => m.kind === "capabilityResult" && m.requestId === 102
    );
    expect(badMethod).toMatchObject({ ok: false, error: { code: PluginWorkerErrorCodes.UnknownCapabilityMethod } });

    // Granted capability → serviced against the real implementation.
    workerSide.postMessage({ kind: "capabilityRequest", requestId: 103, commandRequestId, namespace: "selection", method: "getSelection", args: [] });
    await flush();
    const grant = sentToWorker.find(
      (m): m is Extract<HostToWorkerMessage, { kind: "capabilityResult" }> => m.kind === "capabilityResult" && m.requestId === 103
    );
    expect(grant).toMatchObject({ ok: true, value: { objectIds: [], molecules: [] } });
    expect(selectionCalls).toBe(1);

    workerSide.postMessage({ kind: "commandSettled", commandRequestId, ok: true, value: { ok: true } });
    await expect(invocation).resolves.toEqual({ ok: true });
    bridge.terminate();
  });

  it("fails worker startup loudly on a protocol version mismatch", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const bridge = new PluginWorkerBridge({ pluginId: "org.test.proto", createWorker: () => asHandle(mainSide), hostApiVersion: PluginApiVersion });
    const ready = bridge.whenReady();
    workerSide.postMessage({ kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION + 1, apiVersion: "^0.1.0" });
    await expect(ready).rejects.toThrow(/protocol version/i);
  });

  it("fails worker startup loudly on an incompatible plugin apiVersion", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const bridge = new PluginWorkerBridge({ pluginId: "org.test.api", createWorker: () => asHandle(mainSide), hostApiVersion: PluginApiVersion });
    const ready = bridge.whenReady();
    workerSide.postMessage({ kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: "^9.9.9" });
    await expect(ready).rejects.toThrow(/api version/i);
  });

  it("times out and terminates a worker that never completes its startup handshake", async () => {
    const { mainSide } = linkedEndpoints();
    const bridge = new PluginWorkerBridge({
      pluginId: "org.test.silent",
      createWorker: () => asHandle(mainSide),
      hostApiVersion: PluginApiVersion,
      startupTimeoutMs: 5
    });

    await expect(bridge.whenReady()).rejects.toThrow(/startup handshake within 5 ms/i);
    expect(mainSide.terminated).toBe(true);
  });

  it("terminate() settles a readiness wait even when the worker has not handshaken", async () => {
    const { mainSide } = linkedEndpoints();
    const bridge = new PluginWorkerBridge({
      pluginId: "org.test.terminated-during-startup",
      createWorker: () => asHandle(mainSide),
      hostApiVersion: PluginApiVersion,
      startupTimeoutMs: 1_000
    });
    const ready = bridge.whenReady();

    bridge.terminate();

    await expect(ready).rejects.toMatchObject({ code: PluginWorkerErrorCodes.Terminated });
    expect(mainSide.terminated).toBe(true);
  });

  it("returns a cancellation handle that aborts without exposing the private request id", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const sentToWorker: HostToWorkerMessage[] = [];
    workerSide.addEventListener("message", (event: { data: unknown }) => {
      sentToWorker.push(event.data as HostToWorkerMessage);
    });
    const bridge = new PluginWorkerBridge({
      pluginId: "org.test.cancellable-handle",
      createWorker: () => asHandle(mainSide),
      hostApiVersion: PluginApiVersion
    });
    const invocation = bridge.invokeCommandCancellable("plugin.cancellableHandle.run", {} as PluginCommandContext);
    workerSide.postMessage({
      kind: "ready",
      protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
      apiVersion: "^0.1.0"
    });
    await flush();
    expect(sentToWorker.some((message) => message.kind === "invokeCommand")).toBe(true);

    invocation.abort();

    await expect(invocation.promise).rejects.toMatchObject({ code: PluginWorkerErrorCodes.Terminated });
    expect(sentToWorker.some((message) => message.kind === "abort")).toBe(true);
    bridge.terminate();
  });

  it("cancels immediately during startup and never dispatches the command after a late handshake", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const sentToWorker: HostToWorkerMessage[] = [];
    workerSide.addEventListener("message", (event: { data: unknown }) => {
      sentToWorker.push(event.data as HostToWorkerMessage);
    });
    const bridge = new PluginWorkerBridge({
      pluginId: "org.test.cancel-before-ready",
      createWorker: () => asHandle(mainSide),
      hostApiVersion: PluginApiVersion
    });
    const invocation = bridge.invokeCommandCancellable("plugin.cancelBeforeReady.run", {} as PluginCommandContext);
    invocation.abort();
    await expect(invocation.promise).rejects.toMatchObject({ code: PluginWorkerErrorCodes.Terminated });

    workerSide.postMessage({
      kind: "ready",
      protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
      apiVersion: "^0.1.0"
    });
    await flush();
    expect(sentToWorker.some((message) => message.kind === "invokeCommand")).toBe(false);
    bridge.terminate();
  });

  it("terminate() fully stops the plugin: the pending invocation rejects and no later capability call reaches the host", async () => {
    let reportsSeen = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const manifest = parsePluginManifest({
      id: "org.test.teardown",
      name: "Teardown",
      version: "0",
      apiVersion: "^0.1.0",
      entry: "x",
      permissions: ["ui.panel"],
      contributes: {
        commands: [{ id: "plugin.teardown.run", title: "C", requiredPermissions: ["ui.panel"] }],
        panels: [{ id: "panel.teardown.result", title: "P", requiredPermissions: ["ui.panel"] }]
      }
    });
    const registration: PluginWorkerRegistration = {
      manifest,
      commandHandlers: {
        "plugin.teardown.run": async (context) => {
          await context.panels!.showReport("panel.teardown.result", { title: "first", sections: [] }); // reaches host
          await gate; // stall until after teardown
          await context.panels!.showReport("panel.teardown.result", { title: "second", sections: [] }); // must NOT reach host
          return { ok: true };
        }
      }
    };
    const bridge = startWorkerRoutedPlugin(registration);
    const context = {
      plugin: { id: manifest.id, name: "Teardown", version: "0", permissions: ["ui.panel"] },
      documents: { getActiveDocument: async () => undefined, proposePatch: async () => ({}) as never },
      panels: {
        showReport: async () => {
          reportsSeen += 1;
        }
      },
      hasPermission: () => true,
      requirePermission: () => undefined
    } as unknown as PluginCommandContext;

    const invocation = bridge.invokeCommand("plugin.teardown.run", context);
    // Attach the settlement handler immediately so terminate()'s rejection is never momentarily
    // unhandled (it fires before the assertion below would otherwise attach a handler).
    const settled = invocation.then(
      () => ({ rejected: false }) as const,
      (error: unknown) => ({ rejected: true, error }) as const
    );
    for (let i = 0; i < 50 && reportsSeen === 0; i += 1) {
      await flush();
    }
    expect(reportsSeen).toBe(1);

    bridge.terminate();
    releaseGate(); // the worker handler proceeds to its second showReport, which must not be serviced
    await flush();
    await flush();

    expect(reportsSeen).toBe(1);
    const outcome = await settled;
    expect(outcome.rejected).toBe(true);
    expect(outcome.rejected && outcome.error).toBeInstanceOf(PluginWorkerBridgeError);
  });

  it("desktop routing: createBundledPluginDescriptors uses a worker bridge when a factory is supplied, and in-process otherwise", () => {
    const factories = new Map([[massFragmentManifest.id, () => asHandle(linkedEndpoints().mainSide)]]);
    const routed = createBundledPluginDescriptors({ pluginWorkerFactories: factories });
    expect(routed.find((d) => d.manifest.id === massFragmentManifest.id)?.bridge).toBeInstanceOf(PluginWorkerBridge);

    // Default path: node has no `Worker`, so the analyzer runs in-process (no bridge), which is why
    // the existing suite is unaffected.
    const inProcess = createBundledPluginDescriptors();
    expect(inProcess.find((d) => d.manifest.id === massFragmentManifest.id)?.bridge).toBeUndefined();
  });
});
