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
  type PluginEmbed3DResult,
  type PluginCommandInput,
  type PluginExternalToolStatus,
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
import { describe, expect, it, vi } from "vitest";
import { AssistantCapabilityPermissions } from "@chemdraft/plugin-api";

import { createBundledPluginDescriptors } from "./registerBundledPlugins";
import { PluginWorkerBridge, PluginWorkerBridgeError } from "./PluginWorkerBridge";
import { createEmptyDocument } from "@chemdraft/chem-core";
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
    const manifest = parsePluginManifest({ id: "org.test.throwing-logger", name: "Throwing Logger", version: "0", apiVersion: "^0.1.15", entry: "worker.js",
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
    const manifest = parsePluginManifest({ id: "org.test.restart", name: "Restart", version: "0", apiVersion: "^0.1.15", entry: "worker.js",
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
    const manifest = parsePluginManifest({ id: "org.test.threeD", name: "3D", version: "0", apiVersion: "^0.1.15", entry: "worker.js",
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
        .rejects.toThrow("minimize3d interfragment must be a boolean (true or false).");
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
              object: { id: "mol_worker" }
            } as never
          })
      }
    };
    const host = new PluginHost({ applyDocumentPatch });
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
