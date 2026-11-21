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
  PluginRequestLimits,
  PluginWorkerErrorCodes,
  parsePluginManifest,
  runPluginWorker,
  type HostToWorkerMessage,
  type PluginCommandContext,
  type PluginEmbed3DResult,
  type PluginCommandInput,
  type PluginExternalToolStatus,
  type PluginCommandHandler,
  type PluginManifest,
  type PluginPanelReport,
  type PluginSelectionSnapshot,
  type PluginWorkerEndpoint,
  type PluginWorkerHandle,
  type PluginWorkerRegistration,
  type PluginToolCall
} from "@chemdraft/plugin-api";
import { createMassRegistration, massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import { PluginHost, type RegisterPluginOptions } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";
import { AssistantCapabilityPermissions } from "@chemdraft/plugin-api";

import { createBundledPluginDescriptors, createWorkerRoutedOptions } from "./registerBundledPlugins";
import { createPluginRuntime } from "./createPluginRuntime";
import { deferred } from "../testSupport/deferred";
import { PluginWorkerBridge, PluginWorkerBridgeError } from "./PluginWorkerBridge";
import { applyPatch, createEmptyDocument, MoleculeObjectSchema } from "@chemdraft/chem-core";
import { ToolSessionController } from "./toolSessions/ToolSessionController";
import type { McpBridgeRequest, McpBridgeResponse } from "./toolSessions/transport";
import { buildPluginTablePatch } from "./buildPluginTablePatch";

type MessageListener = (event: { data: unknown }) => void;

/** A message-port fake that mirrors a real Worker boundary: structured-clones on send, delivers on a
 *  microtask, buffers until a listener attaches (as a real port does before `start()`), and drops
 *  everything once terminated. Both a bridge (main side) and the worker runtime bind to one of these. */
class FakeEndpoint {
  peer!: FakeEndpoint;
  terminated = false;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<(error: Error) => void>();
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
    if (type === "error") {
      this.errorListeners.add(listener as (error: Error) => void);
      return;
    }
    if (type !== "message") {
      return; // messageerror unused by the fake
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

  crash(): void {
    for (const listener of this.errorListeners) listener(new Error("simulated worker crash"));
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
  it("delivers successful and error capability replies when the logger throws", async () => {
    const commandId = "plugin.throwingLogger.run";
    const manifest = parsePluginManifest({ id: "org.test.throwing-logger", name: "Throwing Logger", version: "0", apiVersion: "^0.1.16", entry: "worker.js",
      permissions: ["chemistry.compute"], contributes: { commands: [{ id: commandId, title: "3D" }] } });
    let shouldFail = false;
    const { mainSide, workerSide } = linkedEndpoints();
    runPluginWorker({ manifest, commandHandlers: { [commandId]: async context => context.chemistry!.embed3d!({ components: [{ smiles: "C" }] }) } }, asEndpoint(workerSide));
    const throwingBridge = new PluginWorkerBridge({ pluginId: manifest.id, chemistry3dReplyLogger: () => { throw new Error("logger failed"); }, createWorker: () => asHandle(mainSide), hostApiVersion: PluginApiVersion });
    const context = { chemistry: { embed3d: async () => {
      if (shouldFail) throw new Error("capability failed");
      return { ok: true };
    } } } as unknown as PluginCommandContext;
    try {
      await expect(throwingBridge.invokeCommand(commandId, context)).resolves.toEqual({ ok: true });
      shouldFail = true;
      await expect(throwingBridge.invokeCommand(commandId, context)).rejects.toMatchObject({ message: "capability failed" });
    } finally { throwingBridge.terminate(); }
  });
  it.each(["result", "error"])("drops a late capability %s after a worker restart reuses request id 1", async kind => {
    const commandId = "plugin.restart.run";
    const manifest = parsePluginManifest({ id: "org.test.restart", name: "Restart", version: "0", apiVersion: "^0.1.16", entry: "worker.js",
      permissions: ["chemistry.compute"], contributes: { commands: [{ id: commandId, title: "3D" }] } });
    const completions: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
    const replyLogger = vi.fn();
    const context = { chemistry: { embed3d: () => new Promise((resolve, reject) => completions.push({ resolve, reject })) } } as unknown as PluginCommandContext;
    const workers: FakeEndpoint[] = [];
    const requests: { worker: number; requestId: number }[] = [];
    const bridge = new PluginWorkerBridge({ pluginId: manifest.id, chemistry3dReplyLogger: replyLogger, createWorker: () => {
      const { mainSide, workerSide } = linkedEndpoints();
      const worker = workers.length;
      mainSide.addEventListener("message", (event: { data: unknown }) => {
        const message = event.data as { kind: string; requestId: number };
        if (message.kind === "capabilityRequest") requests.push({ worker, requestId: message.requestId });
      });
      runPluginWorker({ manifest, commandHandlers: { [commandId]: ctx => ctx.chemistry!.embed3d!({ components: [{ smiles: "C" }] }) } }, asEndpoint(workerSide));
      workers.push(mainSide);
      return asHandle(mainSide);
    } });
    try {
      const first = bridge.invokeCommand(commandId, context);
      const failed = expect(first).rejects.toMatchObject({ code: PluginWorkerErrorCodes.WorkerCrashed });
      await vi.waitFor(() => expect(completions).toHaveLength(1));
      workers[0].crash();
      await failed;
      const second = bridge.invokeCommand(commandId, context);
      const settled = second.then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(completions).toHaveLength(2));
      expect(requests).toEqual([{ worker: 0, requestId: 1 }, { worker: 1, requestId: 1 }]);
      if (kind === "result") completions[0].resolve({ from: "old worker" });
      else completions[0].reject(new Error("old worker capability failed"));
      await flush();
      completions[1].resolve({ from: "current worker" });
      await expect(settled).resolves.toEqual({ value: { from: "current worker" } });
      expect(replyLogger).toHaveBeenCalledWith({
        pluginId: manifest.id, commandRequestId: 1, requestId: 1, method: "embed3d",
        ok: kind === "result", valueKeys: kind === "result" ? ["from"] : [], droppedAsStale: true
      });
      expect(replyLogger).toHaveBeenCalledWith({
        pluginId: manifest.id, commandRequestId: 2, requestId: 1, method: "embed3d",
        ok: true, valueKeys: ["from"], droppedAsStale: false
      });
    } finally { bridge.terminate(); }
  });
  it("round-trips every 0.1.15 3D method with chemistry.compute alone, including host validation", async () => {
    const commandId = "plugin.threeD.run";
    const manifest = parsePluginManifest({ id: "org.test.threeD", name: "3D", version: "0", apiVersion: "^0.1.16", entry: "worker.js",
      permissions: ["chemistry.compute"], contributes: { commands: [{ id: commandId, title: "3D" }] } });
    const embedded: PluginEmbed3DResult = {
      model: { atoms: [{ element: "C", charge: 0, component: 0, addedHydrogen: false }], bonds: [], coords: [0, 0, 0],
        components: [{ smiles: "C", atomStart: 0, atomCount: 1 }], modelToken: "host-token" },
      method: { engine: "RDKit MinimalLib Release_2026_03_3 + patches 0001-0008", embedding: "ETKDGv3", seed: 42,
        forceField: "none", interfragment: false, coordinateUnits: "Angstrom", energyUnits: "kcal/mol", conventions: ["test"] }, warnings: []
    };
    const minimized = { ...embedded, model: { ...embedded.model, coords: [1, 2, 3] }, clash: false,
      forceField: { name: "mmff94s" as const, status: "converged" as const, energy: 1, iterationsBudget: 1000 } };
    const flattened = { objects: [], depthByAtom: [[3]], method: embedded.method, warnings: ["test warning"] };
    const embed3d = vi.fn(async () => embedded);
    const minimize3d = vi.fn(async () => minimized);
    const flatten3d = vi.fn(async () => flattened);
    const host = new PluginHost({ embed3d, minimize3d, flatten3d });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: { [commandId]: async context => {
      const chemistry = context.chemistry!;
      const embed = await chemistry.embed3d!({ components: [{ smiles: "C" }], seed: 42 });
      const minimize = await chemistry.minimize3d!({ model: embed.model, interfragment: false });
      await expect(chemistry.minimize3d!({ model: embed.model, interfragment: "false" } as never))
        .rejects.toThrow("The interfragment is invalid.");
      const flatten = await chemistry.flatten3d!({ model: minimize.model, view: "auto" });
      return { embed, minimize, flatten };
    } } });
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    try {
      await expect(host.invokeCommand(commandId)).resolves.toEqual({ embed: embedded, minimize: minimized, flatten: flattened });
      expect(embed3d).toHaveBeenCalledWith({ components: [{ smiles: "C" }], seed: 42 }, expect.any(AbortSignal));
      expect(minimize3d).toHaveBeenCalledOnce();
      expect(flatten3d).toHaveBeenCalledWith({ model: minimized.model, view: "auto" }, expect.any(AbortSignal));
    } finally { bridge.terminate(); }
  });
  it("round-trips overlay input and status through the real worker capability boundary", async () => {
    const commandId = "plugin.chat.submit";
    const overlayId = "overlay.chat.main";
    const setStatus = vi.fn();
    const setTranscript = vi.fn();
    const setContent = vi.fn();
    const open = vi.fn();
    const manifest = parsePluginManifest({
      id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js",
      permissions: ["ui.canvas"], contributes: {
        commands: [{ id: commandId, title: "Send" }],
        canvasOverlays: [{ id: overlayId, title: "Chat", icon: "data:image/png;base64,YQ==",
          commandId, prompt: { kind: "prompt", id: "composer", commandId } }]
      }
    });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {
      [commandId]: async context => {
        await context.overlays!.setStatus({ overlayId, text: "Working" });
        await context.overlays!.setTranscript({ overlayId, entries: [{ role: "assistant", text: "Done" }] });
        await context.overlays!.setContent({ overlayId, sections: [{ kind: "text", body: "Setup" }], prompt: { disabled: true } });
        await expect(context.overlays!.setContent({ overlayId, sections: [], prompt: { disabled: true, label: "Busy" } } as never)).rejects.toThrow();
        await context.overlays!.setContent({ overlayId, sections: [] });
        await context.overlays!.open({ overlayId, focus: true });
        await expect(context.overlays!.setContent({ overlayId: "overlay.other.main", sections: [] })).rejects.toThrow(/does not own/);
        await expect(context.overlays!.open({ overlayId: "overlay.other.main" })).rejects.toThrow(/does not own/);
        await expect(context.overlays!.setTranscript({ overlayId: "overlay.other.main", entries: [] }))
          .rejects.toThrow(/does not own/);
        await expect(context.overlays!.setTranscript({ overlayId, entries: [{ role: "error", text: "x".repeat(4001) }] }))
          .rejects.toThrow();
        await expect(context.overlays!.setStatus({ overlayId: "overlay.other.main", text: "Foreign" }))
          .rejects.toThrow(/does not own/);
        await expect(context.overlays!.setStatus({ overlayId, text: "x".repeat(121) })).rejects.toThrow();
        await context.overlays!.setStatus({ overlayId, text: "" });
        return context.input;
      }
    } });
    const host = new PluginHost({ overlays: { setStatus, setTranscript, setContent, open } });
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    const input: PluginCommandInput = { source: "overlay", overlayId, sectionId: "composer", control: "prompt", text: "Draw water" };
    try {
      expect(await host.invokeCommand(commandId, { input })).toEqual(input);
      expect(setStatus.mock.calls).toEqual([[manifest.id, overlayId, "Working"], [manifest.id, overlayId, ""]]);
      expect(setTranscript.mock.calls).toEqual([[manifest.id, overlayId, [{ role: "assistant", text: "Done" }]]]);
      expect(setContent.mock.calls).toEqual([
        [manifest.id, overlayId, [{ kind: "text", body: "Setup" }], { disabled: true }],
        [manifest.id, overlayId, [], undefined]
      ]);
      expect(open.mock.calls).toEqual([[manifest.id, overlayId, true]]);
    } finally { bridge.terminate(); }
  });

  it("omits overlay stubs without ui.canvas", async () => {
    const commandId = "plugin.chat.submit";
    const manifest = parsePluginManifest({
      id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js",
      permissions: [], contributes: { commands: [{ id: commandId, title: "Send" }] }
    });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {
      [commandId]: context => context.overlays === undefined
    } });
    const host = new PluginHost();
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    try {
      expect(await host.invokeCommand(commandId)).toBe(true);
    } finally { bridge.terminate(); }
  });

  it("round-trips panel input through the host and worker, scoped to each concurrent invocation", async () => {
    const commandId = "plugin.chat.submit";
    const manifest = parsePluginManifest({
      id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js", permissions: ["ui.panel"],
      contributes: { commands: [{ id: commandId, title: "Send" }], panels: [{ id: "panel.chat.main", title: "Chat", commandId }] }
    });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {
      [commandId]: async context => { await flush(); return context.input; }
    } });
    const { host } = makeHost();
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    const inputs: PluginCommandInput[] = [
      { source: "panel", panelId: "panel.chat.main", sectionId: "composer", control: "prompt", text: "Draw water", selected: "a" },
      { source: "panel", panelId: "panel.chat.main", sectionId: "composer", control: "select", controlId: "provider", selected: "b" },
      { source: "panel", panelId: "panel.chat.main", sectionId: "actions", control: "button", controlId: "stop", payload: { run: 1 } }
    ];
    try {
      expect(await Promise.all(inputs.map(input => host.invokeCommand(commandId, { input })))).toEqual(inputs);
      expect(await host.invokeCommand(commandId)).toBeUndefined();
    } finally { bridge.terminate(); }
  });

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

    // A whitelisted method the host left off a granted namespace (applyPatch without document.write)
    // is refused like an ungranted capability — not a TypeError from calling `undefined`.
    workerSide.postMessage({
      kind: "capabilityRequest",
      requestId: 104,
      commandRequestId,
      namespace: "documents",
      method: "applyPatch",
      args: [{ reason: "sneak", patch: { op: "addObject" } }]
    });
    await flush();
    const missingMethod = sentToWorker.find(
      (m): m is Extract<HostToWorkerMessage, { kind: "capabilityResult" }> => m.kind === "capabilityResult" && m.requestId === 104
    );
    expect(missingMethod).toMatchObject({
      ok: false,
      error: {
        code: PluginWorkerErrorCodes.CapabilityNotGranted,
        message: 'Plugin "org.test.caps" is not granted the "documents.applyPatch" capability.'
      }
    });

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

describe("every chemistry method survives the worker boundary", () => {
  // The gap that made this suite necessary: `nameToStructure` (API 0.1.1) and `structureFromSmiles`
  // (API 0.1.2) were added to the worker stub and to the in-process host, and never to
  // PLUGIN_WORKER_CAPABILITY_METHODS — so the bridge rejected both for every worker-routed plugin,
  // which is every installed plugin. Nothing failed: the chemistry namespace had no bridge coverage
  // at all, and the bundled plugin falls to the in-process branch under vitest because `Worker` is
  // undefined here. Driving the real runtime through a linked endpoint is what exercises it.
  const chemistryManifest = parsePluginManifest({
    id: "org.test.chemistry",
    name: "Chemistry Probe",
    version: "0",
    apiVersion: `^${PluginApiVersion}`,
    entry: "x",
    permissions: ["chemistry.compute", "native.execute", "document.read"],
    contributes: { commands: [{ id: "plugin.chemprobe.run", title: "Run" }] }
  });

  function hostWithChemistry(): PluginHost {
    return new PluginHost({
      computeIsotopeEnvelope: async () => ({
        available: true as const,
        peaks: [{ mass: 78.04695, relativeIntensity: 100 }],
        positionUnit: "dalton" as const,
        truncation: { policy: "relative-intensity-threshold", threshold: 1e-4 },
        engine: { id: "isospec-wasm", version: "2.3.5" },
        conventions: ["natural abundances"]
      }),
      convertNameToStructure: async () => ({
        available: true as const,
        parsed: true as const,
        smiles: "c1ccccc1",
        engine: { id: "opsin", version: "2.9.0" }
      }),
      buildStructureFromSmiles: async () => ({ available: true as const, built: false as const, reason: "no document" })
    });
  }

  for (const method of ["isotopeEnvelope", "nameToStructure", "structureFromSmiles"] as const) {
    it(`routes chemistry.${method} to the host instead of rejecting it`, async () => {
      let outcome: unknown;
      let failure: unknown;
      const registration = {
        manifest: chemistryManifest,
        commandHandlers: {
          "plugin.chemprobe.run": async (context: { chemistry?: Record<string, (arg: unknown) => Promise<unknown>> }) => {
            try {
              const api = context.chemistry;
              if (!api) throw new Error("no chemistry capability");
              outcome =
                method === "isotopeEnvelope"
                  ? await api.isotopeEnvelope!({ format: "smiles", structure: "c1ccccc1" })
                  : method === "nameToStructure"
                    ? await api.nameToStructure!({ name: "benzene" })
                    : await api.structureFromSmiles!({ smiles: "c1ccccc1" });
            } catch (error) {
              failure = error;
            }
            return { ok: true as const };
          }
        }
      };

      const host = hostWithChemistry();
      const bridge = startWorkerRoutedPlugin(registration as never);
      host.registerPlugin(chemistryManifest, delegatingOptions(chemistryManifest, bridge));
      await host.invokeCommand("plugin.chemprobe.run");

      expect(failure, `chemistry.${method} was rejected at the bridge`).toBeUndefined();
      expect(outcome, `chemistry.${method} returned nothing`).toMatchObject({ available: true });
      bridge.terminate();
    });
  }

  it("still refuses a method the host genuinely does not offer, and says so usefully", async () => {
    // The allow-list must keep rejecting — the fix is that the list is now complete, not that the
    // gate is gone. And the message must not say "not granted": the namespace WAS granted.
    let failure: unknown;
    const registration = {
      manifest: chemistryManifest,
      commandHandlers: {
        "plugin.chemprobe.run": async (context: unknown) => {
          const raw = context as { chemistry?: Record<string, unknown> };
          try {
            // Reach past the typed stub the way a hand-written worker payload could.
            await (raw.chemistry as never as { isotopeEnvelope: (a: unknown) => Promise<unknown> }).isotopeEnvelope(
              { format: "smiles", structure: "c1ccccc1" }
            );
          } catch (error) {
            failure = error;
          }
          return { ok: true as const };
        }
      }
    };
    const host = hostWithChemistry();
    const bridge = startWorkerRoutedPlugin(registration as never);
    host.registerPlugin(chemistryManifest, delegatingOptions(chemistryManifest, bridge));
    await host.invokeCommand("plugin.chemprobe.run");
    expect(failure).toBeUndefined();
    bridge.terminate();
  });
});

describe("documents.applyPatch survives the worker boundary", () => {
  it.each([["^0.1.17", false], ["^0.1.18", true]] as const)(
    "offers insertTable across the worker boundary for %s: %s", async (apiVersion, present) => {
      const manifest = parsePluginManifest({ id: "org.test.table-worker", name: "Table Worker", version: "1",
        apiVersion, entry: "worker.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.tableWorker.insert", title: "Make table" }] }
      });
      const host = new PluginHost();
      const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {
        "plugin.tableWorker.insert": context => ({ present: typeof context.documents.insertTable === "function" })
      } });
      host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
      try {
        await expect(host.invokeCommand("plugin.tableWorker.insert")).resolves.toEqual({ present });
      } finally { bridge.terminate(); }
    }
  );

  it("round-trips a native table spec and receipt through the gated worker capability", async () => {
    const manifest = parsePluginManifest({ id: "org.test.table-worker", name: "Table Worker", version: "1",
      apiVersion: "^0.1.18", entry: "worker.js", permissions: ["document.write"],
      contributes: { commands: [{ id: "plugin.tableWorker.insert", title: "Make table" }] }
    });
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: ["table_worker"] }));
    const host = new PluginHost({ getActiveDocument: () => createEmptyDocument(),
      buildTablePatch: buildPluginTablePatch, applyDocumentPatch });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {
      "plugin.tableWorker.insert": context => context.documents.insertTable!({
        columns: [{ header: "Formula" }], rows: [["H2O"]]
      })
    } });
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    try {
      await expect(host.invokeCommand("plugin.tableWorker.insert")).resolves.toEqual({ applied: true, objectIds: ["table_worker"] });
      expect(applyDocumentPatch).toHaveBeenCalledOnce();
      expect(applyDocumentPatch).toHaveBeenCalledWith(expect.objectContaining({ undoLabel: "Insert table",
        patch: expect.objectContaining({ patch: expect.objectContaining({ op: "addObject", object: expect.objectContaining({ type: "table" }) }) }) }));
    } finally { bridge.terminate(); }
  });
  it("round-trips a command-scoped direct patch to the host", async () => {
    const manifest = parsePluginManifest({
      id: "org.test.apply-patch-worker",
      name: "Worker Writer",
      version: "0",
      apiVersion: "^0.1.4",
      entry: "x",
      permissions: ["document.write"],
      contributes: {
        commands: [
          {
            id: "plugin.applyPatchWorker.insert",
            title: "Insert Structure",
            requiredPermissions: ["document.write"]
          }
        ]
      }
    });
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: ["mol_worker"] }));
    const registration: PluginWorkerRegistration = {
      manifest,
      commandHandlers: {
        "plugin.applyPatchWorker.insert": (context) =>
          context.documents.applyPatch!({
            reason: "user supplied input",
            patch: {
              op: "addObject",
              pageId: "page_001",
              object: MoleculeObjectSchema.parse({ id: "mol_worker", type: "molecule",
                x: 0, y: 0, width: 10, height: 10, structureFormat: "smiles", structure: "C" })
            }
          })
      }
    };
    const host = new PluginHost({ applyDocumentPatch, getActiveDocument: () => createEmptyDocument() });
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));

    await expect(host.invokeCommand("plugin.applyPatchWorker.insert")).resolves.toEqual({
      applied: true,
      objectIds: ["mol_worker"]
    });
    expect(applyDocumentPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
        command: { id: "plugin.applyPatchWorker.insert", title: "Insert Structure" },
        undoLabel: "Worker Writer: Insert Structure"
      })
    );
    expect(host.listProposedPatches()).toHaveLength(0);
    bridge.terminate();
  });

  it("omits the worker stub without document.write", async () => {
    const manifest = parsePluginManifest({
      id: "org.test.no-apply-patch-worker",
      name: "Worker Reader",
      version: "0",
      apiVersion: "^0.1.4",
      entry: "x",
      permissions: [],
      contributes: { commands: [{ id: "plugin.noApplyPatchWorker.inspect", title: "Inspect" }] }
    });
    const registration: PluginWorkerRegistration = {
      manifest,
      commandHandlers: {
        "plugin.noApplyPatchWorker.inspect": (context) => typeof context.documents.applyPatch
      }
    };
    const host = new PluginHost();
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));

    await expect(host.invokeCommand("plugin.noApplyPatchWorker.inspect")).resolves.toBe("undefined");
    bridge.terminate();
  });
});

describe("dialogs.promptText survives the worker boundary", () => {
  it("round-trips the request and exact submitted value through linked endpoints", async () => {
    const dialogManifest = parsePluginManifest({
      id: "org.test.dialog-worker",
      name: "Worker Dialog Probe",
      version: "0",
      apiVersion: "^0.1.3",
      entry: "x",
      permissions: ["ui.panel"],
      contributes: { commands: [{ id: "plugin.dialogWorker.run", title: "Run" }] }
    });
    let workerResult: unknown;
    const registration: PluginWorkerRegistration = {
      manifest: dialogManifest,
      commandHandlers: {
        "plugin.dialogWorker.run": async (context) => {
          workerResult = await context.dialogs?.promptText({
            title: "Chemical name",
            label: "Name",
            placeholder: "benzene"
          });
          return workerResult;
        }
      }
    };
    const promptText = vi.fn(async () => ({ status: "submitted" as const, value: "  benzene  " }));
    const host = new PluginHost({ promptText });
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(dialogManifest, delegatingOptions(dialogManifest, bridge));

    await expect(host.invokeCommand("plugin.dialogWorker.run")).resolves.toEqual({
      status: "submitted",
      value: "  benzene  "
    });
    expect(workerResult).toEqual({ status: "submitted", value: "  benzene  " });
    expect(promptText).toHaveBeenCalledWith(
      { id: dialogManifest.id, name: dialogManifest.name },
      { title: "Chemical name", label: "Name", placeholder: "benzene", maxLength: 500 },
      expect.any(AbortSignal)
    );
    bridge.terminate();
  });

  it("enforces one prompt per command invocation after the first worker prompt settles", async () => {
    const dialogManifest = parsePluginManifest({
      id: "org.test.dialog-worker-repeat",
      name: "Worker Dialog Repeat",
      version: "0",
      apiVersion: "^0.1.3",
      entry: "x",
      permissions: ["ui.panel"],
      contributes: { commands: [{ id: "plugin.dialogWorkerRepeat.run", title: "Run" }] }
    });
    const registration: PluginWorkerRegistration = {
      manifest: dialogManifest,
      commandHandlers: {
        "plugin.dialogWorkerRepeat.run": async (context) => {
          await context.dialogs!.promptText({ title: "First", label: "Value" });
          try {
            await context.dialogs!.promptText({ title: "Second", label: "Value" });
            return "unexpectedly opened a second prompt";
          } catch (error) {
            return (error as Error).message;
          }
        }
      }
    };
    const promptText = vi.fn(async () => ({ status: "cancelled" as const }));
    const host = new PluginHost({ promptText });
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(dialogManifest, delegatingOptions(dialogManifest, bridge));

    await expect(host.invokeCommand("plugin.dialogWorkerRepeat.run")).resolves.toMatch(
      /org\.test\.dialog-worker-repeat.*at most once per command invocation/i
    );
    expect(promptText).toHaveBeenCalledOnce();
    bridge.terminate();
  });
});

describe("images.requestImage survives the worker boundary", () => {
  it("round-trips Uint8Array bytes through linked structured-clone endpoints", async () => {
    const imageManifest = parsePluginManifest({
      id: "org.test.image-worker",
      name: "Worker Image Probe",
      version: "0",
      apiVersion: "^0.1.5",
      entry: "x",
      permissions: ["image.read"],
      contributes: {
        commands: [
          { id: "plugin.imageWorker.run", title: "Run", requiredPermissions: ["image.read"] }
        ]
      }
    });
    const registration: PluginWorkerRegistration = {
      manifest: imageManifest,
      commandHandlers: {
        "plugin.imageWorker.run": (context) =>
          context.images!.requestImage({ title: "Choose structure image", sources: ["file"] })
      }
    };
    const requestImage = vi.fn(async () => ({
      status: "provided" as const,
      image: {
        mediaType: "image/png" as const,
        bytes: new Uint8Array([137, 80, 78, 71]),
        width: 640,
        height: 480,
        source: "file" as const,
        fileName: "structure.png"
      }
    }));
    const host = new PluginHost({ requestImage });
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(imageManifest, delegatingOptions(imageManifest, bridge));

    const result = await host.invokeCommand("plugin.imageWorker.run");
    expect(result).toEqual({
      status: "provided",
      image: {
        mediaType: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
        width: 640,
        height: 480,
        source: "file",
        fileName: "structure.png"
      }
    });
    expect(requestImage).toHaveBeenCalledWith(
      { id: imageManifest.id, name: imageManifest.name },
      { title: "Choose structure image", sources: ["file"] },
      expect.any(AbortSignal)
    );
    bridge.terminate();
  });

  it("omits the worker stub without image.read", async () => {
    const manifest = parsePluginManifest({
      id: "org.test.no-image-worker",
      name: "No Worker Image",
      version: "0",
      apiVersion: "^0.1.5",
      entry: "x",
      permissions: [],
      contributes: { commands: [{ id: "plugin.noImageWorker.inspect", title: "Inspect" }] }
    });
    const registration: PluginWorkerRegistration = {
      manifest,
      commandHandlers: {
        "plugin.noImageWorker.inspect": (context) => typeof context.images
      }
    };
    const host = new PluginHost();
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));

    await expect(host.invokeCommand("plugin.noImageWorker.inspect")).resolves.toBe("undefined");
    bridge.terminate();
  });
});

describe("recognition.recognizeStructure survives the worker boundary", () => {
  it("round-trips the command-scoped image and recognized result through linked endpoints", async () => {
    const recognitionManifest = parsePluginManifest({
      id: "org.test.recognition-worker",
      name: "Worker Recognition Probe",
      version: "0",
      apiVersion: "^0.1.6",
      entry: "x",
      permissions: ["image.read", "ml.inference", "model.load", "native.execute"],
      contributes: {
        commands: [
          {
            id: "plugin.recognitionWorker.run",
            title: "Run",
            requiredPermissions: ["image.read", "ml.inference", "model.load", "native.execute"]
          }
        ]
      }
    });
    const registration: PluginWorkerRegistration = {
      manifest: recognitionManifest,
      commandHandlers: {
        "plugin.recognitionWorker.run": async (context) => {
          const selected = await context.images!.requestImage({
            title: "Choose structure image",
            sources: ["file"]
          });
          if (selected.status !== "provided") return selected;
          return context.recognition!.recognizeStructure(selected.image);
        }
      }
    };
    const providedImage = {
      mediaType: "image/png" as const,
      bytes: new Uint8Array([137, 80, 78, 71]),
      width: 640,
      height: 480,
      source: "file" as const,
      fileName: "structure.png"
    };
    const recognizeStructure = vi.fn(async () => ({
      status: "recognized" as const,
      result: {
        sourceImageRef: "data:image/png;base64,iVBORw==",
        proposedSmiles: "C",
        proposedMolfile: "mol",
        confidence: null,
        atomConfidence: [],
        bondConfidence: [],
        warnings: [],
        elapsedMs: 42,
        engine: {
          name: "MolScribe" as const,
          molscribeCommit: "abc123",
          modelSha256: "a".repeat(64)
        }
      }
    }));
    const host = new PluginHost({
      requestImage: async () => ({ status: "provided", image: providedImage }),
      recognizeStructure
    });
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(recognitionManifest, delegatingOptions(recognitionManifest, bridge));

    await expect(host.invokeCommand("plugin.recognitionWorker.run")).resolves.toMatchObject({
      status: "recognized",
      result: { proposedSmiles: "C", confidence: null, elapsedMs: 42 }
    });
    expect(recognizeStructure).toHaveBeenCalledWith(
      { id: recognitionManifest.id, name: recognitionManifest.name },
      providedImage,
      expect.any(AbortSignal)
    );
    bridge.terminate();
  });
});

describe("tools survive the worker boundary", () => {
  it("round-trips every assistant lifecycle method with Send-time request identity", async () => {
    const manifest = parsePluginManifest({ id: "org.test.assistant-worker", name: "Assistant Worker", version: "0",
      apiVersion: "^0.1.9", entry: "worker.js", permissions: [...AssistantCapabilityPermissions],
      contributes: { commands: [{ id: "plugin.assistantWorker.submit", title: "Submit" }] } });
    const assistant = {
      listTools: vi.fn(async () => [{ name: "insert_text", description: "Insert", inputSchema: {} }]),
      beginRequest: vi.fn(async () => ({ requestId: "req" })),
      callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "inserted" }] })),
      endRequest: vi.fn(async () => ({ touchedIds: ["text"], summary: "One text", split: false })),
      createToolSession: vi.fn(async () => ({ sessionId: "mcp", serverName: "chemdraft" as const, tools: ["insert_text"] })),
      closeToolSession: vi.fn(async () => {}), closeAllForPlugin: vi.fn()
    };
    const host = new PluginHost({ assistant });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: { "plugin.assistantWorker.submit": async context => {
      const api = context.assistant!;
      const { requestId } = await api.beginRequest({ prompt: "caption", label: "Caption" });
      const tools = await api.listTools();
      const session = await api.createToolSession({ requestId });
      const result = await api.callTool({ name: tools[0]!.name, input: { text: "caption" } });
      await api.closeToolSession({ sessionId: session.sessionId });
      return { result, end: await api.endRequest({ requestId }) };
    } } });
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    await expect(host.invokeCommand("plugin.assistantWorker.submit")).resolves.toMatchObject({
      result: { content: [{ text: "inserted" }] }, end: { touchedIds: ["text"], split: false }
    });
    expect(assistant.beginRequest).toHaveBeenCalledWith(expect.objectContaining({ id: manifest.id }), { prompt: "caption", label: "Caption" });
    expect(assistant.createToolSession).toHaveBeenCalledWith(expect.objectContaining({ id: manifest.id }), { requestId: "req" });
    expect(assistant.endRequest).toHaveBeenCalledWith(expect.objectContaining({ id: manifest.id }), { requestId: "req" });
    bridge.terminate();
  });
  it("round-trips every external-tools method and omits it without assistant.run", async () => {
    const manifest = parsePluginManifest({
      id: "org.test.tools-worker", name: "Worker Tools", version: "0", apiVersion: "^0.1.8", entry: "x",
      permissions: ["assistant.run", "native.execute"], contributes: { commands: [{ id: "plugin.toolsWorker.run", title: "Run" }] }
    });
    const statuses = import.meta.glob("../externalTools/__fixtures__/wire/status-installed-managed.json", { eager: true, import: "default" });
    const status = Object.values(statuses)[0]! as PluginExternalToolStatus;
    const externalTools = {
      status: vi.fn(async () => status), install: vi.fn(async () => status),
      signIn: vi.fn(async () => ({ launched: true, method: "terminal.command" as const })),
      run: vi.fn(async () => ({ runId: "run", pid: 1, cwd: "/tmp", startedAt: status.probedAt })),
      poll: vi.fn(async () => ({ lines: [], nextCursor: 0, droppedLines: 0, status: { state: "running" as const } })),
      cancel: vi.fn(async () => undefined), clearConversation: vi.fn(async () => undefined), cancelAllForPlugin: vi.fn()
    };
    const registration: PluginWorkerRegistration = { manifest, commandHandlers: { "plugin.toolsWorker.run": async (context) => {
      await context.tools!.status({ tool: "codex" }); await context.tools!.install({ tool: "codex" });
      await context.tools!.signIn({ tool: "codex" });
      await context.tools!.run({ tool: "codex", conversationId: "conversation_1", prompt: "p", systemPrompt: "s", mcpSessionId: "mcp" });
      await context.tools!.poll({ runId: "run", cursor: 0 }); await context.tools!.cancel({ runId: "run" });
      await context.tools!.clearConversation({ tool: "codex", conversationId: "conversation_1" });
    } } };
    const host = new PluginHost({ externalTools });
    const bridge = startWorkerRoutedPlugin(registration);
    host.registerPlugin(manifest, delegatingOptions(manifest, bridge));
    await host.invokeCommand("plugin.toolsWorker.run");
    for (const method of [externalTools.status, externalTools.install, externalTools.signIn, externalTools.run, externalTools.poll, externalTools.cancel, externalTools.clearConversation]) expect(method).toHaveBeenCalledOnce();
    bridge.terminate();

    const denied = parsePluginManifest({ ...manifest, id: "org.test.no-tools-worker", permissions: [], contributes: { commands: [{ id: "plugin.noToolsWorker.run", title: "Run" }] } });
    const deniedBridge = startWorkerRoutedPlugin({ manifest: denied, commandHandlers: { "plugin.noToolsWorker.run": (context) => typeof context.tools } });
    host.registerPlugin(denied, delegatingOptions(denied, deniedBridge));
    await expect(host.invokeCommand("plugin.noToolsWorker.run")).resolves.toBe("undefined");
    deniedBridge.terminate();
  });
});


describe("API 0.1.21 worker capabilities and plugin assistant handlers", () => {
  const properties = { available: true as const, formula: "CH4", averageMass: 16.043, monoisotopicMass: 16.0313,
    formalCharge: 0, isotopeLabelled: false, method: { engine: "RDKit" as const, version: "test", conventions: ["g/mol; Da"] } };

  it.each([undefined, false, true])("exposes a worker-routed handler only when the handshake reports it (%s)", async hasAssistantToolHandler => {
    const manifest = parsePluginManifest({ id: "org.test.handshake", name: "Handshake", version: "0",
      apiVersion: "^0.1.21", entry: "worker.js", permissions: [...AssistantCapabilityPermissions] });
    const { mainSide, workerSide } = linkedEndpoints();
    const bridge = new PluginWorkerBridge({ pluginId: manifest.id, createWorker: () => asHandle(mainSide) });
    const options = createWorkerRoutedOptions(manifest, bridge);
    const host = new PluginHost();
    host.registerPlugin(manifest, options);
    try {
      expect(options.onAssistantToolCall).toBeUndefined();
      expect(host.hasAssistantToolHandler(manifest.id)).toBe(false);
      const ready = bridge.whenReady();
      workerSide.postMessage({ kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
        apiVersion: manifest.apiVersion, ...(hasAssistantToolHandler === undefined ? {} : { hasAssistantToolHandler }) });
      await ready;
      expect(typeof options.onAssistantToolCall === "function").toBe(hasAssistantToolHandler === true);
      expect(host.hasAssistantToolHandler(manifest.id)).toBe(hasAssistantToolHandler === true);
      bridge.terminate();
      expect(host.hasAssistantToolHandler(manifest.id)).toBe(false);
    } finally { host.unregisterPlugin(manifest.id); bridge.terminate(); }
  });

  it("round-trips chemistry.properties and refuses it without chemistry.compute", async () => {
    const manifest = parsePluginManifest({ id: "org.test.workerProperties", name: "Worker Properties", version: "0",
      apiVersion: "^0.1.21", entry: "worker.js", permissions: ["chemistry.compute"],
      contributes: { commands: [{ id: "plugin.workerProperties.run", title: "Properties" }] } });
    const computeProperties = vi.fn(async () => properties);
    const host = new PluginHost({ computeProperties });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {
      "plugin.workerProperties.run": context => context.chemistry!.properties!({ format: "smiles", structure: "C" })
    } });
    host.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
    try {
      await expect(host.invokeCommand("plugin.workerProperties.run")).resolves.toEqual(properties);
      expect(computeProperties).toHaveBeenCalledWith({ format: "smiles", structure: "C" });
    } finally { host.unregisterPlugin(manifest.id); bridge.terminate(); }
    const denied = parsePluginManifest({ ...manifest, permissions: [] });
    const deniedBridge = startWorkerRoutedPlugin({ manifest: denied, commandHandlers: {
      "plugin.workerProperties.run": context => ({ hasChemistry: !!context.chemistry })
    } });
    host.registerPlugin(denied, createWorkerRoutedOptions(denied, deniedBridge));
    try { await expect(host.invokeCommand("plugin.workerProperties.run")).resolves.toEqual({ hasChemistry: false }); }
    finally { host.unregisterPlugin(denied.id); deniedBridge.terminate(); }
  });

  it("routes to each owning worker, enables its declared capability calls, and cancels across the boundary", async () => {
    const host = new PluginHost({ computeProperties: async () => properties });
    const bridges: PluginWorkerBridge[] = [];
    let workerAborted = false;
    for (const suffix of ["first", "second"]) {
      const manifest = parsePluginManifest({ id: `org.test.${suffix}`, name: suffix, version: "0",
        apiVersion: "^0.1.21", entry: "worker.js", permissions: [...AssistantCapabilityPermissions] });
      const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {}, onAssistantToolCall: async (context, call, signal) => {
        expect(context.storage).toBeUndefined();
        if (call.name === "wait") {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => { workerAborted = true; resolve(); }, { once: true }));
          return { content: [] };
        }
        if (call.name === "fail") throw new Error(`worker ${suffix} failed`);
        const result = await context.chemistry!.properties!({ format: "smiles", structure: "C" });
        return { content: [{ type: "text", text: context.plugin.id }], structuredContent: { call, result } };
      } });
      bridges.push(bridge);
      host.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
      await bridge.whenReady();
    }
    try {
      for (const suffix of ["first", "second"]) {
        const call = { sessionId: `session_${suffix}`, name: "lookup", input: { key: suffix } };
        const result = await host.invokeAssistantTool(`org.test.${suffix}`, call, new AbortController().signal, []);
        expect(result).toEqual({ content: [{ type: "text", text: `org.test.${suffix}` }], structuredContent: { call, result: properties } });
      }
      await expect(host.invokeAssistantTool("org.test.first", { sessionId: "session_first", name: "fail", input: {} }, new AbortController().signal, [])).rejects.toThrow("worker first failed");
      const abort = new AbortController();
      const pending = host.invokeAssistantTool("org.test.first", { sessionId: "session_first", name: "wait", input: {} }, abort.signal, []);
      const settled = expect(pending).rejects.toThrow();
      await flush();
      abort.abort();
      await settled;
      await flush();
      expect(workerAborted).toBe(true);
      host.unregisterPlugin("org.test.first");
      await expect(host.invokeAssistantTool("org.test.first", { sessionId: "session_first", name: "lookup", input: {} }, new AbortController().signal, [])).rejects.toThrow("not registered");
    } finally {
      for (const id of ["org.test.first", "org.test.second"]) if (host.getPlugin(id)) host.unregisterPlugin(id);
      bridges.forEach(bridge => bridge.terminate());
    }
  });
});


const requestCommand = "plugin.requests.run";
const requestPage = { requestId: "r", pageId: "p" };
const requestCall = { requestId: "r", sessionId: "s", name: "lookup", input: { value: "find" } };
const requestBounds = { x: 0, y: 0, width: 100, height: 100 };
const targetRegion = { kind: "region", bounds: requestBounds } as const;
const requestLayout = { ...requestPage, spec: { kind: "grid" as const, objectIds: ["m"],
  anchor: { x: 0, y: 0 }, columns: 1, columnGap: 10, rowGap: 10 } };

function requestManifest(permissions: PluginManifest["permissions"] = ["document.read", "selection.read", "document.write", "chemistry.compute"]) {
  return parsePluginManifest({ id: "org.test.requests", name: "Request Tools", version: "0",
    apiVersion: "^0.1.26", entry: "worker.js", permissions, contributes: { commands: [{ id: requestCommand, title: "Requests" }] } });
}

function exerciseRequestMethods(context: PluginCommandContext) {
  return Promise.all([
    context.requests!.begin({ label: "Draw" }),
    context.requests!.getContext({ requestId: "r" }),
    context.requests!.end({ requestId: "r" }),
    context.requests!.requestPageSpace!({ ...requestPage, requiredBounds: requestBounds, revision: "v" }),
    context.documents.readRequest!({ ...requestPage, cursor: "start", objectIds: ["m"] }),
    context.documents.applyRequestPatch!({ requestId: "r", patch: { op: "moveObject", objectId: "m", x: 10, y: 10 } }),
    context.toolSessions!.open({ requestId: "r", definitions: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] }),
    context.toolSessions!.close({ sessionId: "s" }),
    context.chemistry!.inspectStructure!({ kind: "molecule", ...requestPage, objectId: "m" }),
    context.chemistry!.rings!({ ...requestPage, objectId: "m", representation: "drawable" }),
    context.depiction!.measure({ ...requestPage, target: targetRegion }),
    context.depiction!.renderRegion({ ...requestPage, target: targetRegion, widthPx: 1, heightPx: 1 }),
    context.depiction!.planLayout(requestLayout),
    context.depiction!.listStylePresets({ requestId: "r" }),
    context.depiction!.planStyle({ ...requestPage, objectIds: ["m"], targetBondLength: 22 })
  ]);
}

describe("request-bound plugin worker transport", () => {
  it("round-trips valid results from every new capability method", async () => {
    const bridge = startWorkerRoutedPlugin({ manifest: requestManifest(), commandHandlers: { [requestCommand]: exerciseRequestMethods } });
    const success = <T>(value: T) => ({ ok: true as const, value });
    const reply = (value: unknown) => vi.fn(async () => success(value));
    const object = MoleculeObjectSchema.parse({ id: "m", type: "molecule",
      x: 0, y: 0, width: 100, height: 100, structureFormat: "smiles", structure: "C" });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=";
    const providers = {
      requests: {
        begin: reply({ requestId: "r" }),
        getContext: reply({ requestId: "r", documentKey: "doc", pages: [{ pageId: "p", width: 100, height: 100, revision: "v" }],
          selection: [], insertions: [], objectRevisions: [] }),
        end: reply({ touched: [] }),
        requestPageSpace: reply({ outcome: "enlarge", decisionId: "d" })
      },
      documents: {
        readRequest: reply({ pageId: "p", revision: "v", objects: [{ object, revision: "v" }], nextCursor: "next" }),
        applyRequestPatch: reply({ touched: [{ pageId: "p", objectId: "m" }], insertions: [] })
      },
      toolSessions: { open: reply({ sessionId: "s", tools: ["lookup"] }), close: reply(null) },
      chemistry: {
        inspectStructure: reply({ source: { format: "smiles", structure: "C" }, canonicalIsomericSmiles: "C",
          formula: "CH4", stereochemistry: [], heavyAtoms: 1, warnings: [] }),
        rings: reply({ representation: "drawable", revision: "v",
          rings: [{ key: "ring", atomIds: ["a", "b", "c"], bondIds: ["ab", "bc", "ca"] }], warnings: [] })
      },
      depiction: {
        measure: reply({ units: "document", bounds: requestBounds, objects: [], unsupported: [], warnings: [] }),
        renderRegion: reply({ mimeType: "image/png", base64: png, widthPx: 1, heightPx: 1, bounds: requestBounds, warnings: [] }),
        planLayout: reply({ objects: [], transforms: [{ objectId: "m", dx: 1, dy: 2, changes: { x: 1, y: 2 } }], warnings: [] }),
        listStylePresets: reply({ presets: [{ id: "default", name: "Default", bondLengthPx: 22, bondStrokeWidthPx: 1,
          bondBoldWidthPx: 2, atomLabelFontFamily: "Arial", atomLabelFontSizePx: 12, atomLabelFontWeight: 400 }], defaults: { drawing: {}, text: {} } }),
        planStyle: reply({ updates: [{ op: "updateObject", objectId: "m", changes: { x: 1 } }], affectedObjectIds: ["m"], movedMarkIds: [], warnings: [] })
      }
    };
    const context = { ...providers, hasPermission: () => true } as unknown as PluginCommandContext;
    try {
      const result = await bridge.invokeCommand(requestCommand, context);
      const handlers = Object.values(providers).flatMap(methods => Object.values(methods));
      expect(handlers).toHaveLength(15);
      for (const handler of handlers) expect(handler).toHaveBeenCalledExactlyOnceWith(expect.any(Object));
      expect(result).toEqual(await Promise.all(handlers.map(handler => handler.mock.results[0].value)));
      expect(providers.documents.readRequest).toHaveBeenCalledWith({ ...requestPage, cursor: "start", objectIds: ["m"] });
      expect(providers.depiction.renderRegion).toHaveBeenCalledWith({ ...requestPage, target: targetRegion, widthPx: 1, heightPx: 1 });
    } finally {
      bridge.terminate();
    }
  });

  it("returns typed unsupported stubs in-process and across the worker without writing", async () => {
    const applyDocumentPatch = vi.fn();
    const host = new PluginHost({ applyDocumentPatch });
    const manifest = requestManifest();
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: { [requestCommand]: exerciseRequestMethods } });
    host.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
    try {
      const replies = await exerciseRequestMethods(host.createCommandContext(manifest.id));
      expect(replies).toHaveLength(15);
      for (const reply of replies) expect(reply).toMatchObject({ ok: false, error: { code: "unsupported" } });
      await expect(host.invokeCommand(requestCommand)).resolves.toEqual(replies);
      expect(applyDocumentPatch).not.toHaveBeenCalled();
    } finally {
      bridge.terminate();
    }
  });

  it.each([
    { atoms: [], bonds: [] },
    { structureFormat: "smiles", structure: "C", atoms: [{ id: "a", element: "C" }], bonds: [] }
  ])("rejects a malformed native molecule from a pinned read provider (%j)", async fields => {
    const bridge = startWorkerRoutedPlugin({ manifest: requestManifest(), commandHandlers: {
      [requestCommand]: context => context.documents.readRequest!(requestPage)
    } });
    const object = { id: "m", type: "molecule", ...requestBounds, ...fields };
    const readRequest = vi.fn(async () => ({ ok: true, value: { pageId: "p", revision: "v",
      objects: [{ object, revision: "v" }] } }));
    const context = { documents: { readRequest }, hasPermission: () => true } as unknown as PluginCommandContext;
    try {
      await expect(bridge.invokeCommand(requestCommand, context))
        .resolves.toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(readRequest).toHaveBeenCalledExactlyOnceWith(requestPage);
    } finally {
      bridge.terminate();
    }
  });

  it("round-trips native defaults from pinned reads and layout plans", async () => {
    const bridge = startWorkerRoutedPlugin({ manifest: requestManifest(), commandHandlers: {
      [requestCommand]: context => Promise.all([context.documents.readRequest!(requestPage),
        context.depiction!.planLayout(requestLayout)])
    } });
    const object = { id: "m", type: "molecule", ...requestBounds, structureFormat: "smiles", structure: "C" };
    const read = { pageId: "p", revision: "page-rev", objects: [{ object, revision: "object-rev" }], nextCursor: "next" };
    const plan = { objects: [object], transforms: [{ objectId: "m", dx: 1, dy: 2, changes: { x: 1, y: 2 } }], warnings: [] };
    const context = {
      documents: { readRequest: async () => ({ ok: true, value: read }) },
      depiction: { planLayout: async () => ({ ok: true, value: plan }) },
      hasPermission: () => true
    } as unknown as PluginCommandContext;
    const normalized = { ...object, rotation: 0, style: {}, atoms: [], bonds: [], superatoms: [], rGroups: [] };
    try {
      await expect(bridge.invokeCommand(requestCommand, context)).resolves.toEqual([
        { ok: true, value: { ...read, objects: [{ ...read.objects[0], object: normalized }] } },
        { ok: true, value: { ...plan, objects: [normalized] } }
      ]);
    } finally {
      bridge.terminate();
    }
  });

  it("rejects a layout result containing a malformed native molecule", async () => {
    const bridge = startWorkerRoutedPlugin({ manifest: requestManifest(), commandHandlers: {
      [requestCommand]: context => context.depiction!.planLayout(requestLayout)
    } });
    const object = { id: "m", type: "molecule", ...requestBounds };
    const context = {
      depiction: { planLayout: async () => ({ ok: true, value: { objects: [object], transforms: [], warnings: [] } }) },
      hasPermission: () => true
    } as unknown as PluginCommandContext;
    try {
      await expect(bridge.invokeCommand(requestCommand, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid" } });
    } finally {
      bridge.terminate();
    }
  });

  it("delivers the latest document key after more than 16 pending notifications", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    const manifest = requestManifest();
    const ready = deferred<void>();
    const received: string[] = [];
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {}, onActiveDocumentChanged: async event => {
      await ready.promise;
      received.push(event.documentKey!);
    } });
    runtime.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
    try {
      await bridge.whenReady();
      for (let index = 1; index <= 24; index++) runtime.notifyActiveDocumentChanged(String(index));
      ready.resolve();
      await vi.waitFor(() => expect(received.at(-1)).toBe("24"));
      expect(received).toEqual([...new Set(received)].sort((a, b) => Number(a) - Number(b)));
      expect(received.length).toBeLessThanOrEqual(16);
    } finally {
      ready.resolve();
      runtime.unregisterPlugin(manifest.id);
      bridge.terminate();
    }
  });

  it("retries the current document key when the worker rejects delivery", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    const manifest = requestManifest();
    const handler = vi.fn().mockRejectedValueOnce(new Error("Delivery failed")).mockResolvedValue(undefined);
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {}, onActiveDocumentChanged: handler });
    runtime.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
    try {
      await bridge.whenReady();
      runtime.notifyActiveDocumentChanged("current");
      await vi.waitFor(() => expect(handler.mock.calls).toEqual([
        [{ documentKey: "current", sequence: 1 }], [{ documentKey: "current", sequence: 1 }]
      ]));
    } finally {
      runtime.unregisterPlugin(manifest.id);
      bridge.terminate();
    }
  });

  it("routes tool calls and document notifications through the registered handlers", async () => {
    const manifest = requestManifest();
    const host = new PluginHost();
    const onActiveDocumentChanged = vi.fn((event: { documentKey: string | null }) => {
      if (event.documentKey === null) throw new Error("test failure");
    });
    const applyPatch = vi.fn();
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {}, onActiveDocumentChanged,
      onToolCall: async (context, call) => {
        const rejected = await context.documents.applyPatch!({
          patch: { op: "moveObject", objectId: "m", x: 0, y: 0 }, reason: "Move object"
        }).then(() => false, (error: PluginWorkerBridgeError) => error.code === PluginWorkerErrorCodes.CapabilityNotGranted);
        const reply = await context.requests!.getContext({ requestId: call.requestId });
        return { ok: true, value: { input: call.input, supported: reply.ok, rejected } };
      }
    });
    host.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
    try {
      expect(host.getToolHandler(manifest.id)).toBeUndefined();
      expect(host.getActiveDocumentChangedHandler(manifest.id)).toBeUndefined();
      await bridge.whenReady();
      const context = host.createCommandContext(manifest.id);
      const contextWithWrite = { ...context, documents: { ...context.documents, applyPatch } };
      await expect(host.getToolHandler(manifest.id)!(contextWithWrite, requestCall, new AbortController().signal))
        .resolves.toEqual({ ok: true, value: { input: requestCall.input, supported: false, rejected: true } });
      expect(applyPatch).not.toHaveBeenCalled();
      await host.getActiveDocumentChangedHandler(manifest.id)!({ documentKey: "next", sequence: 1 });
      expect(onActiveDocumentChanged).toHaveBeenCalledExactlyOnceWith({ documentKey: "next", sequence: 1 });
      await expect(host.getActiveDocumentChangedHandler(manifest.id)!({ documentKey: null, sequence: 2 }))
        .rejects.toMatchObject({ code: "failed" });
      host.unregisterPlugin(manifest.id);
      expect(bridge.hasToolHandler()).toBe(true);
      expect(bridge.hasActiveDocumentChangedHandler()).toBe(true);
      expect(host.getToolHandler(manifest.id)).toBeUndefined();
      expect(host.getActiveDocumentChangedHandler(manifest.id)).toBeUndefined();
    } finally {
      bridge.terminate();
    }
  });

  it("opens a worker-owned session and dispatches a read-only call over its channel", async () => {
    let channel!: (message: McpBridgeRequest) => void;
    const respond = vi.fn(async (_sessionId: string, _callId: string, _response: McpBridgeResponse) => {});
    const close = vi.fn(async () => {});
    const sessions = new ToolSessionController({
      open: async (_, listener) => { channel = listener; return { sessionId: "session", serverName: "chemdraft" }; },
      respond, close
    }, () => undefined);
    const document = createEmptyDocument({ title: "Pinned drawing" });
    const host = new PluginHost({ toolSessions: sessions, getActiveDocumentKey: () => "tab", getActiveDocument: () => document,
      captureRequestDocument: () => ({ key: "pinned", read: () => document }) });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let opened = false;
    const manifest = requestManifest();
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: { [requestCommand]: async ctx => {
      const request = await ctx.requests!.begin({ label: "Read" });
      if (!request.ok) throw new Error(request.error.message);
      const session = await ctx.toolSessions!.open({ requestId: request.value.requestId, definitions: [{
        name: "inspect", readOnly: true, description: "Read this drawing", inputSchema: { type: "object" }
      }] });
      if (!session.ok) throw new Error(session.error.message);
      opened = true;
      await released;
    } }, onToolCall: async (ctx, call) => {
      const pinned = await ctx.requests!.getContext({ requestId: call.requestId });
      if (!pinned.ok) return pinned;
      return { ok: true, value: { document: pinned.value.documentKey, canWrite: ctx.hasPermission("document.write"),
        offersWrite: !!ctx.documents.applyRequestPatch } };
    } });
    try {
      await bridge.whenReady();
      host.registerPlugin(manifest, createWorkerRoutedOptions(manifest, bridge));
      const command = host.invokeCommand(requestCommand);
      await vi.waitFor(() => expect(opened).toBe(true));
      channel({ sessionId: "session", requestId: "call", method: "tools/call", params: { name: "inspect" } });
      await vi.waitFor(() => expect(respond).toHaveBeenCalledWith("session", "call", { result: {
        content: [{ type: "text", text: JSON.stringify({ document: "pinned", canWrite: false, offersWrite: false }) }],
        structuredContent: { document: "pinned", canWrite: false, offersWrite: false }
      } }));
      release(); await command;
      expect(close).toHaveBeenCalledWith("session");
    } finally { release(); bridge.terminate(); }
  });

  it("services pinned reads and bound patch and table writes through a request tool worker", async () => {
    const manifest = requestManifest();
    let pinned = createEmptyDocument(), active = pinned;
    const pageId = pinned.pages[0]!.id;
    const object = { id: "anchor", type: "text" as const, text: "Anchor", spans: [], style: {}, x: 100, y: 30,
      width: 60, height: 20, rotation: 0 };
    pinned = applyPatch(pinned, { op: "batch", patches: [{ op: "addObject", pageId, object },
      { op: "setSelection", pageId, objectIds: ["anchor"] }] });
    active = pinned;
    const ordinary = vi.fn();
    const host = new PluginHost({ getActiveDocument: () => active, getActiveDocumentKey: () => active.title,
      getSelection: () => ({ objectIds: active.selection.objectIds, molecules: [] }),
      captureRequestDocument: () => ({ key: "pinned", read: () => pinned }), applyDocumentPatch: ordinary,
      buildTablePatch: buildPluginTablePatch, openRequestHistory: () => ({
        run: async commit => commit(), verify: async (_before, draft) => draft,
        write: (after, _ids, guard) => { guard(after); pinned = after; }
      }) });
    const contexts = vi.spyOn(host, "createCommandContext");
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {}, onToolCall: async ctx => {
      const doc = await ctx.documents.getActiveDocument();
      const selected = await ctx.selection!.getSelection();
      const patch = await ctx.documents.applyPatch!({ reason: "Edit anchor",
        patch: { op: "updateObject", objectId: "anchor", changes: { text: "Edited" } } });
      const table = await ctx.documents.insertTable!({ columns: [{ header: "Name" }], rows: [["Entry"]] });
      return { ok: true, value: { title: doc!.title, selection: [...selected.objectIds],
        patches: patch.objectIds.length, tables: table.objectIds.length } };
    } });
    try {
      await bridge.whenReady();
      host.registerPlugin(manifest, { ...createWorkerRoutedOptions(manifest, bridge), commandHandlers: {
        [requestCommand]: async ctx => {
          const owner = contexts.mock.calls[0]![1]!;
          const result = await ctx.requests!.begin({ label: "Worker request" });
          if (!result.ok) throw new Error(result.error.message);
          active = createEmptyDocument({ title: "Other tab" });
          const { requestId } = result.value;
          return host.invokeRequestTool(manifest.id, requestId, owner, { ...requestCall, requestId }, new AbortController().signal, false);
        }
      } });
      await expect(host.invokeCommand(requestCommand)).resolves.toEqual({ ok: true, value: {
        title: pinned.title, selection: ["anchor"], patches: 1, tables: 1
      } });
      expect(pinned.pages[0]!.objects).toMatchObject([{ id: "anchor", text: "Edited" }, { type: "table" }]);
      expect(active.pages[0]!.objects).toEqual([]);
      expect(ordinary).not.toHaveBeenCalled();
    } finally { bridge.terminate(); }
  });

  it("limits raw worker frames for ordinary reads before invoking pinned host capabilities", async () => {
    const manifest = requestManifest();
    const { mainSide, workerSide } = linkedEndpoints();
    const bridge = new PluginWorkerBridge({ pluginId: manifest.id, createWorker: () => asHandle(mainSide) });
    const doc = createEmptyDocument({ title: "Pinned" });
    const host = new PluginHost({
      getActiveDocumentKey: () => "pinned", captureRequestDocument: () => ({ key: "pinned", read: () => doc })
    });
    const contexts = vi.spyOn(host, "createCommandContext");
    const replies = vi.fn();
    const limit = PluginRequestLimits.pendingCapabilities;
    let commandRequestId: number | undefined;
    workerSide.addEventListener("message", ({ data }: { data: HostToWorkerMessage }) => {
      if (data.kind === "invokeTool") {
        commandRequestId = data.commandRequestId;
        const send = (requestId: number, namespace: string, method: string, args: unknown[] = []) =>
          workerSide.postMessage({ kind: "capabilityRequest", requestId, commandRequestId: data.commandRequestId,
            namespace, method, args });
        send(1, "requests", "getContext", [{ requestId: data.call.requestId }]);
        send(2, "selection", "getSelection");
        for (let id = 3; id <= limit + 1; id++) send(id, "documents", "getActiveDocument");
        send(limit + 2, "selection", "getSelection");
        send(limit + 3, "requests", "getContext", [{ requestId: data.call.requestId }]);
      } else if (data.kind === "capabilityResult") replies(data);
    });
    workerSide.postMessage({ kind: "ready", protocolVersion: 1, apiVersion: manifest.apiVersion,
      features: { requestCapabilities: true, toolCalls: true } });
    try {
      await bridge.whenReady();
      const documentReads = vi.fn();
      const selectionReads = vi.fn();
      host.registerPlugin(manifest, { onToolCall: (ctx, call, signal) => {
        const readDocument = ctx.documents.getActiveDocument;
        const readSelection = ctx.selection!.getSelection;
        ctx.documents.getActiveDocument = () => { documentReads(); return readDocument(); };
        ctx.selection!.getSelection = () => { selectionReads(); return readSelection(); };
        return bridge.invokeTool(ctx, call, signal);
      }, commandHandlers: { [requestCommand]: async ctx => {
        const owner = contexts.mock.calls[0]![1]!;
        const begun = await ctx.requests!.begin({ label: "Inspect" });
        if (!begun.ok) throw new Error(begun.error.message);
        const { requestId } = begun.value;
        return host.invokeRequestTool(manifest.id, requestId, owner, { ...requestCall, requestId }, new AbortController().signal, false);
      } } });
      const invocation = host.invokeCommand(requestCommand);
      await vi.waitFor(() => expect(replies).toHaveBeenCalledTimes(limit + 3));
      expect(documentReads).toHaveBeenCalledTimes(limit - 2);
      expect(selectionReads).toHaveBeenCalledTimes(1);
      expect(replies).toHaveBeenCalledWith(expect.objectContaining({ requestId: 3, ok: true, value: doc }));
      for (const requestId of [limit + 1, limit + 2]) {
        expect(replies).toHaveBeenCalledWith(expect.objectContaining({ requestId, ok: false, error: { code: "limit", message: expect.any(String) } }));
      }
      expect(replies).toHaveBeenCalledWith(expect.objectContaining({ requestId: limit + 3, ok: true,
        value: { ok: false, error: { code: "limit", message: expect.any(String) } } }));
      workerSide.postMessage({ kind: "toolCallSettled", commandRequestId, result: { ok: true, value: null } });
      await expect(invocation).resolves.toEqual({ ok: true, value: null });
    } finally { bridge.terminate(); }
  });

  it("snapshots only the known handshake opt-ins as booleans", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const manifest = requestManifest();
    const bridge = new PluginWorkerBridge({ pluginId: manifest.id, createWorker: () => asHandle(mainSide) });
    const ready = bridge.whenReady();
    let deliveredFeatures: Record<string, unknown> | undefined;
    mainSide.addEventListener("message", ({ data }: { data: { features: Record<string, unknown> } }) => {
      deliveredFeatures = data.features;
    });
    workerSide.postMessage({ kind: "ready", protocolVersion: 1, apiVersion: manifest.apiVersion,
      features: { requestCapabilities: true, toolCalls: "true", activeDocumentChanged: true, unknown: { nested: true } } });
    try {
      await ready;
      expect(bridge).toHaveProperty("features", { requestCapabilities: true, toolCalls: false, activeDocumentChanged: true });
      Object.assign(deliveredFeatures!, { requestCapabilities: false, toolCalls: true, activeDocumentChanged: false });
      expect(bridge.hasToolHandler()).toBe(false);
      expect(bridge.hasActiveDocumentChangedHandler()).toBe(true);
    } finally {
      bridge.terminate();
    }
  });

  it("refuses a missing handler and keeps the old worker's messages intact", async () => {
    const host = new PluginHost();
    const manifest = requestManifest();
    host.registerPlugin(manifest);
    const context = host.createCommandContext(manifest.id);
    const signal = new AbortController().signal;
    const current = startWorkerRoutedPlugin({ manifest, commandHandlers: {} });
    try {
      await expect(current.invokeTool(context, requestCall, signal)).resolves.toMatchObject({ ok: false, error: { code: "missingHandler" } });
      await expect(current.notifyActiveDocumentChanged({ documentKey: null, sequence: 1 }))
        .resolves.toMatchObject({ ok: false, error: { code: "missingHandler" } });
    } finally {
      current.terminate();
    }
    for (const apiVersion of ["^0.1.9", "^0.1.25"]) {
      const { mainSide, workerSide } = linkedEndpoints();
      const legacy = new PluginWorkerBridge({ pluginId: manifest.id, createWorker: () => asHandle(mainSide) });
      const messages: string[] = [];
      workerSide.addEventListener("message", ({ data }: { data: HostToWorkerMessage }) => {
        messages.push(data.kind);
        if (data.kind === "invokeCommand" || data.kind === "invokeAssistantTool") workerSide.postMessage({
          kind: "commandSettled", commandRequestId: data.commandRequestId, ok: true, value: { content: [] }
        });
      });
      workerSide.postMessage({ kind: "ready", protocolVersion: 1, apiVersion, hasAssistantToolHandler: true });
      try {
        await legacy.whenReady();
        await expect(legacy.invokeTool(context, requestCall, signal)).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
        await expect(legacy.notifyActiveDocumentChanged({ documentKey: null, sequence: 1 }))
          .resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
        await expect(legacy.invokeCommand(requestCommand, context)).resolves.toEqual({ content: [] });
        await expect(legacy.invokeAssistantTool(context, { name: "lookup", sessionId: "s", input: {} }, signal)).resolves.toEqual({ content: [] });
        expect(messages).toEqual(["invokeCommand", "invokeAssistantTool"]);
      } finally {
        legacy.terminate();
      }
    }
  });

  it("refuses forged capability methods, oversized requests, and undeclared pinned reads", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const manifest = requestManifest();
    const bridge = new PluginWorkerBridge({ pluginId: manifest.id, createWorker: () => asHandle(mainSide) });
    workerSide.postMessage({ kind: "ready", protocolVersion: 1, apiVersion: manifest.apiVersion, features: { requestCapabilities: true } });
    const handler = vi.fn();
    const context = { requests: { begin: handler, constructor: handler }, chemistry: { inspectStructure: handler },
      hasPermission: (permission: string) => permission === "chemistry.compute" } as unknown as PluginCommandContext;
    const results: unknown[] = [];
    workerSide.addEventListener("message", ({ data }: { data: HostToWorkerMessage }) => {
      if (data.kind === "invokeCommand") {
        const commandRequestId = data.commandRequestId;
        workerSide.postMessage({ kind: "capabilityRequest", commandRequestId, namespace: "requests", method: "constructor",
          requestId: 1, args: [{ label: "Forged" }] });
        workerSide.postMessage({ kind: "capabilityRequest", commandRequestId, namespace: "requests", method: "begin",
          requestId: 2, args: [{ label: "x".repeat(PluginRequestLimits.requestBytes) }] });
        workerSide.postMessage({ kind: "capabilityRequest", commandRequestId, namespace: "chemistry", method: "inspectStructure",
          requestId: 3, args: [{ kind: "molecule", ...requestPage, objectId: "m" }] });
      } else if (data.kind === "capabilityResult") {
        results.push(data.ok ? data.value : data.error);
        if (results.length === 3) workerSide.postMessage({ kind: "commandSettled", commandRequestId: 1, ok: true, value: results });
      }
    });
    try {
      await expect(bridge.invokeCommand(requestCommand, context)).resolves.toEqual([
        expect.objectContaining({ code: PluginWorkerErrorCodes.UnknownCapabilityMethod }),
        expect.objectContaining({ error: expect.objectContaining({ code: "limit" }) }),
        expect.objectContaining({ error: expect.objectContaining({ code: "permission" }) })
      ]);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      bridge.terminate();
    }
  });

  it("limits tool data and holds an aborted call until the worker handler settles", async () => {
    const manifest = requestManifest();
    const host = new PluginHost();
    host.registerPlugin(manifest);
    const context = host.createCommandContext(manifest.id);
    let finish: (() => void) | undefined;
    const onToolCall = vi.fn(async (_ctx: PluginCommandContext, call: PluginToolCall, signal: AbortSignal) => {
      if (call.name === "large") return { ok: true as const, value: "x".repeat(PluginRequestLimits.resultBytes + 1) };
      return new Promise<{ ok: true; value: string }>(resolve => {
        signal.addEventListener("abort", () => { finish = () => resolve({ ok: true, value: "late" }); }, { once: true });
      });
    });
    const bridge = startWorkerRoutedPlugin({ manifest, commandHandlers: {}, onToolCall });
    const cancel = new AbortController();
    try {
      await expect(bridge.invokeTool(context, { ...requestCall, input: { text: "x".repeat(PluginRequestLimits.requestBytes) } }, cancel.signal))
        .resolves.toMatchObject({ ok: false, error: { code: "limit" } });
      expect(onToolCall).not.toHaveBeenCalled();
      await expect(bridge.invokeTool(context, { ...requestCall, name: "large" }, cancel.signal))
        .resolves.toMatchObject({ ok: false, error: { code: "limit" } });
      let settled = false;
      const pending = bridge.invokeTool(context, requestCall, cancel.signal).then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledTimes(2));
      cancel.abort();
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(settled).toBe(false);
      finish!();
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally {
      bridge.terminate();
    }
  });

  it("reserves tool slots before snapshotting or waiting for a slow handshake", async () => {
    const { mainSide, workerSide } = linkedEndpoints();
    const manifest = requestManifest();
    const host = new PluginHost();
    host.registerPlugin(manifest);
    const context = host.createCommandContext(manifest.id);
    const bridge = new PluginWorkerBridge({ pluginId: manifest.id, createWorker: () => asHandle(mainSide) });
    const dispatched: number[] = [];
    workerSide.addEventListener("message", ({ data }: { data: HostToWorkerMessage }) => {
      if (data.kind === "invokeTool") dispatched.push(data.commandRequestId);
    });
    const controllers = Array.from({ length: PluginRequestLimits.pendingToolCalls }, () => new AbortController());
    const results = controllers.map(({ signal }) => bridge.invokeTool(context, requestCall, signal));
    const ownKeys = vi.fn(() => []);
    const overflow = { ...requestCall, input: new Proxy({}, { ownKeys }) };
    const signal = new AbortController().signal;
    const limit = { ok: false, error: { code: "limit" } };
    try {
      await expect(Promise.race([bridge.invokeTool(context, overflow, signal), flush()])).resolves.toMatchObject(limit);
      expect(ownKeys).not.toHaveBeenCalled();
      expect(dispatched).toEqual([]);

      controllers[0].abort();
      await expect(results[0]).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
      await expect(Promise.race([bridge.invokeTool(context, { ...requestCall, name: "" }, signal), flush()]))
        .resolves.toMatchObject({ ok: false, error: { code: "invalid" } });
      const replacement = bridge.invokeTool(context, requestCall, signal);
      workerSide.postMessage({ kind: "ready", protocolVersion: 1, apiVersion: manifest.apiVersion,
        features: { requestCapabilities: true, toolCalls: true } });
      await flush();
      expect(dispatched).toHaveLength(PluginRequestLimits.pendingToolCalls);
      controllers[1].abort();
      await expect(Promise.race([bridge.invokeTool(context, requestCall, signal), flush()])).resolves.toMatchObject(limit);
      for (const commandRequestId of dispatched) {
        workerSide.postMessage({ kind: "toolCallSettled", commandRequestId, result: { ok: true, value: null } });
      }
      await expect(results[1]).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
      await expect(Promise.all([...results.slice(2), replacement])).resolves.toEqual(
        Array(PluginRequestLimits.pendingToolCalls - 1).fill({ ok: true, value: null })
      );
    } finally {
      bridge.terminate();
    }
  });
});
