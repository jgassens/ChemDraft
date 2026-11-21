/**
 * Main-thread host bridge for the per-plugin Web Worker isolation boundary (ADR-0029, M34).
 *
 * A bridge owns one plugin's `Worker`, forwards command invocations into it, and services the
 * capability requests it sends back — by calling the *same real, permission-gated host capabilities*
 * used in-process today. It is constructed with a lazy worker factory (so a rarely-used plugin costs
 * nothing until first invoked) and is handed the real {@link PluginCommandContext} per invocation, so:
 *
 *  - **Declared-only enforcement falls out of the context itself.** The host builds a context whose
 *    `selection` / `analysis` / `storage` / `panels` objects are present only when the manifest grants
 *    the matching available permission (auto-granted; ADR-0029 is permissive — no consent gate). If the worker
 *    asks for a namespace the context does not carry, the bridge rejects the request. `documents` is
 *    always present; read/proposal methods re-check their permissions, while `applyPatch` is present
 *    only with `document.write` and remains bound to the active command invocation.
 *  - **Reverse signals** (`panelClosed`, `abort`) travel worker-ward so ADR-0012 panel-close
 *    cancellation works across the boundary.
 *  - **`terminate()` is a total teardown** — the mechanism M36 uninstall will call. After it, no
 *    capability request, panel push, or command result reaches the host.
 *
 * The bridge is framework-neutral (no React) and transport-agnostic: it drives a
 * {@link PluginWorkerHandle}, which a real `Worker` satisfies and tests supply as a linked fake.
 */

import { isRequestToolContext } from "@chemdraft/plugin-host";
import { DocumentObjectSchema } from "@chemdraft/chem-core";
import type { z } from "zod";
import {
  PLUGIN_WORKER_CAPABILITY_METHODS,
  PluginActiveDocumentChangedSchema,
  PluginEmptyRequestResultSchema,
  PluginPlanLayoutResultSchema,
  PluginReadRequestResultSchema,
  PluginRequestLimits,
  PluginToolCallResultSchema,
  PluginToolCallSchema,
  PluginWorkerErrorCodes,
  checkWorkerHandshake,
  getPluginRequestCapability,
  isPinnedRequestToolCapability,
  pluginRequestFailure,
  pluginRequestPermissions,
  requestValidationCode,
  supportsPluginRequestTools,
  type HostToWorkerMessage,
  type PluginActiveDocumentChanged,
  type PluginCommandContext,
  type PluginAssistantToolCall,
  type PluginAssistantToolResult,
  type PluginRequestResult,
  type PluginToolCall,
  type PluginToolCallResult,
  type PluginWorkerCapabilityNamespace,
  type PluginWorkerErrorPayload,
  type PluginWorkerFeatures,
  type PluginWorkerHandle,
  type WorkerToHostMessage
} from "@chemdraft/plugin-api";

function parseNativeObject(value: unknown) {
  const parsed = DocumentObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseNativeObjectResult<Result extends { objects: unknown[] }>(
  response: z.SafeParseReturnType<unknown, PluginRequestResult<Result>>,
  label: string,
  parseEntry: (entry: Result["objects"][number]) => unknown
) {
  if (!response.success) return pluginRequestFailure(requestValidationCode(response.error), `Invalid ${label} result.`);
  const result = response.data;
  if (!result.ok) return result;
  const objects: unknown[] = [];
  for (const entry of result.value.objects) {
    const parsed = parseEntry(entry);
    if (parsed === undefined) return pluginRequestFailure("invalid", `Invalid ${label} native object.`);
    objects.push(parsed);
  }
  return { ...result, value: { ...result.value, objects } };
}

export interface PluginWorkerBridgeOptions {
  /** Plugin id this bridge fronts (for diagnostics). */
  pluginId: string;
  /** Lazily create the underlying worker. Called once, on first {@link ensureStarted}. */
  createWorker: () => PluginWorkerHandle;
  /** Host API version the worker's handshake is validated against. Defaults to the SDK's version. */
  hostApiVersion?: string;
  /** Maximum time to wait for the worker's protocol handshake. Defaults to 10 seconds. */
  startupTimeoutMs?: number;
  /** Optional, metadata-only diagnostic sink for plugin 3D chemistry replies. */
  chemistry3dReplyLogger?: PluginChemistry3dReplyLogger;
}

export type PluginChemistry3dReplyLogger = (reply: {
  pluginId: string;
  commandRequestId: number;
  requestId: number;
  method: "embed3d" | "minimize3d" | "flatten3d";
  ok: boolean;
  valueKeys: string[];
  droppedAsStale: boolean;
}) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
let defaultChemistry3dReplyLogger: PluginChemistry3dReplyLogger | undefined;

/** Set once by the persistent desktop runtime; undefined keeps normal plugin traffic allocation-free. */
export function configureChemistry3dReplyLogger(logger: PluginChemistry3dReplyLogger | undefined): void {
  defaultChemistry3dReplyLogger = logger;
}

interface PendingInvocation {
  context: PluginCommandContext;
  boundRequest?: string;
  tool: "external" | "request" | undefined;
  aborted: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

type ToolInvocation = { kind: "invokeAssistantTool"; call: PluginAssistantToolCall } |
  { kind: "invokeTool"; call: PluginToolCall };

interface InvocationState {
  dispatch?: { commandId: string; context: PluginCommandContext; tool?: ToolInvocation };
  commandRequestId?: number;
}

/** Public cancellation handle for one bridge invocation. Callers never need the bridge's private
 * numeric protocol id; `abort()` works both while startup is pending and after dispatch. */
export interface PluginWorkerInvocation<Result = unknown> {
  promise: Promise<Result>;
  abort: () => void;
}

/** A capability object indexed by method name, for dynamic dispatch after the method whitelist check. */
type CapabilityMethods = Record<string, (...args: unknown[]) => unknown>;

export class PluginWorkerBridge {
  private readonly pluginId: string;
  private readonly createWorker: () => PluginWorkerHandle;
  private readonly hostApiVersion?: string;
  private readonly startupTimeoutMs: number;
  private readonly chemistry3dReplyLogger: PluginChemistry3dReplyLogger | undefined;

  private worker: PluginWorkerHandle | undefined;
  private readyPromise: Promise<void> | undefined;
  private readonly documentChangeReady = new Set<() => void>();
  private rejectStartup: ((error: unknown) => void) | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private terminated = false;
  private assistantToolHandler = false;
  private features: Record<keyof PluginWorkerFeatures, boolean> | undefined;

  private nextCommandRequestId = 1;
  private pendingToolCalls = 0;
  private readonly pending = new Map<number, PendingInvocation>();
  private readonly pendingRequestCapabilities = new Map<number, object>();
  private readonly documentChanges = new Map<number, (result: PluginRequestResult<null>) => void>();

  constructor(options: PluginWorkerBridgeOptions) {
    this.pluginId = options.pluginId;
    this.createWorker = options.createWorker;
    this.hostApiVersion = options.hostApiVersion;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.chemistry3dReplyLogger = options.chemistry3dReplyLogger ?? defaultChemistry3dReplyLogger;
  }

  /** Spawn the worker (if needed) and resolve once its startup handshake passes; reject loudly on a
   *  protocol/apiVersion mismatch or a crash. Safe to call repeatedly. */
  whenReady(): Promise<void> {
    return this.ensureStarted();
  }

  hasAssistantToolHandler(): boolean {
    return this.assistantToolHandler;
  }

  hasToolHandler(): boolean {
    return this.features?.toolCalls === true;
  }

  hasActiveDocumentChangedHandler(): boolean {
    return this.features?.activeDocumentChanged === true;
  }

  onDocumentChangeReady(listener: () => void): () => void {
    if (!this.terminated) this.documentChangeReady.add(listener);
    return () => { this.documentChangeReady.delete(listener); };
  }

  /**
   * Run a plugin command in the worker, servicing its capability calls against `context`. Resolves with
   * the command's return value (a `PluginCommandResult` for the proof plugins) or rejects if the worker
   * reports an error, is aborted, or is terminated.
   */
  async invokeCommand(commandId: string, context: PluginCommandContext): Promise<unknown> {
    return this.invokeCommandCancellable(commandId, context).promise;
  }

  async invokeAssistantTool(context: PluginCommandContext, call: PluginAssistantToolCall, signal: AbortSignal): Promise<PluginAssistantToolResult> {
    signal.throwIfAborted();
    const invocation = this.invokeCommandCancellable(call.name, context, call);
    const cancel = () => invocation.abort();
    signal.addEventListener("abort", cancel, { once: true });
    try { return await invocation.promise as PluginAssistantToolResult; }
    finally { signal.removeEventListener("abort", cancel); }
  }

  async invokeTool(context: PluginCommandContext, call: PluginToolCall, signal: AbortSignal): Promise<PluginToolCallResult> {
    if (signal.aborted) return pluginRequestFailure("cancelled", "The tool call was cancelled.");
    if (this.pendingToolCalls >= PluginRequestLimits.pendingToolCalls) {
      return pluginRequestFailure("limit", "Too many pending tool calls.");
    }
    this.pendingToolCalls++;
    try {
      const parsed = PluginToolCallSchema.safeParse(call);
      if (!parsed.success) return pluginRequestFailure(requestValidationCode(parsed.error), "Invalid tool call.");
      const invocation = this.invokeCancellable(parsed.data.name, context, { kind: "invokeTool", call: parsed.data });
      const cancel = () => invocation.abort();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) cancel();
        return await invocation.promise as PluginToolCallResult;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } catch {
      return signal.aborted ? pluginRequestFailure("cancelled", "The tool call was cancelled.") :
        pluginRequestFailure("failed", "The worker could not complete the tool call.");
    } finally {
      this.pendingToolCalls--;
    }
  }

  /** Invoke with a usable cancellation handle instead of exposing an internal request id. */
  invokeCommandCancellable(commandId: string, context: PluginCommandContext, tool?: PluginAssistantToolCall): PluginWorkerInvocation {
    return this.invokeCancellable(commandId, context, tool ? { kind: "invokeAssistantTool", call: tool } : undefined);
  }

  private invokeCancellable(commandId: string, context: PluginCommandContext, tool?: ToolInvocation): PluginWorkerInvocation {
    const state: InvocationState = { dispatch: { commandId, context, tool } };
    let rejectBeforeDispatch!: (error: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectBeforeDispatch = reject;
    });
    const execution = this.startInvocation(state);
    const promise = Promise.race([execution, cancelled]);
    return {
      promise,
      abort: () => {
        if (state.commandRequestId !== undefined) {
          this.abortCommand(state.commandRequestId);
        } else if (state.dispatch) {
          // Release the queued payload even if the worker's shared startup promise is still pending.
          state.dispatch = undefined;
          rejectBeforeDispatch(this.abortedError("before dispatch"));
        }
      }
    };
  }

  private async startInvocation(state: InvocationState): Promise<unknown> {
    if (this.terminated) {
      throw this.terminatedError();
    }
    await this.ensureStarted();
    if (this.terminated) {
      throw this.terminatedError();
    }
    const dispatch = state.dispatch;
    state.dispatch = undefined;
    if (!dispatch) {
      throw this.abortedError("before dispatch");
    }
    const { commandId, context, tool } = dispatch;
    if (tool?.kind === "invokeTool" && !this.hasToolHandler()) {
      return this.features?.requestCapabilities
        ? pluginRequestFailure("missingHandler", "This worker registered no request tool handler.")
        : pluginRequestFailure("unsupported", "This worker does not support request tool calls.");
    }
    const commandRequestId = this.nextCommandRequestId++;
    state.commandRequestId = commandRequestId;
    return new Promise<unknown>((resolve, reject) => {
      const toolType = tool?.kind === "invokeTool" ? "request" : tool ? "external" : undefined;
      this.pending.set(commandRequestId, { context, resolve, reject, tool: toolType,
        boundRequest: tool?.kind === "invokeTool" ? tool.call.requestId : undefined, aborted: false });
      try {
        if (tool?.kind === "invokeTool") this.postToWorker({ kind: "invokeTool", commandRequestId, call: tool.call,
          ...(!context.hasPermission("document.write") && { readOnly: true as const }) });
        else if (tool) this.postToWorker({ kind: "invokeAssistantTool", commandRequestId, ...tool.call });
        else this.postToWorker({ kind: "invokeCommand", commandRequestId, commandId, ...(context.input === undefined ? {} : { input: context.input }) });
      } catch (error) {
        this.pending.delete(commandRequestId);
        reject(this.wrapCrash(error));
      }
    });
  }

  /** Forward a panel-close to the worker (ADR-0012). The plugin's `onPanelClosed` runs in the worker and
   *  aborts its in-flight work; a late result can no longer revive the dismissed panel. */
  notifyPanelClosed(panelId: string): void {
    if (this.terminated || !this.worker) {
      return;
    }
    this.postToWorker({ kind: "panelClosed", panelId });
  }

  /** Notify a running worker that opted in. No command context or capability token is issued. */
  async notifyActiveDocumentChanged(event: PluginActiveDocumentChanged): Promise<PluginRequestResult<null>> {
    if (!this.hasActiveDocumentChangedHandler() || !this.worker) {
      return this.features?.requestCapabilities
        ? pluginRequestFailure("missingHandler", "This worker has no document-change subscription.")
        : pluginRequestFailure("unsupported", "This worker does not support document-change notifications.");
    }
    if (this.documentChanges.size >= PluginRequestLimits.pendingCapabilities) {
      return pluginRequestFailure("limit", "Too many pending document-change notifications.");
    }
    const parsed = PluginActiveDocumentChangedSchema.safeParse(event);
    if (!parsed.success) return pluginRequestFailure(requestValidationCode(parsed.error), "Invalid document change.");
    const notificationId = this.nextCommandRequestId++;
    return new Promise(resolve => {
      this.documentChanges.set(notificationId, resolve);
      try {
        this.postToWorker({ kind: "activeDocumentChanged", notificationId, event: parsed.data });
      } catch {
        this.documentChanges.delete(notificationId);
        resolve(pluginRequestFailure("failed", "Could not deliver the document change."));
      }
    });
  }

  /** Cancel capabilities immediately. Tool invocations stay pending until the worker
   *  handler settles, so callers can account for work that ignores its abort signal. */
  abortCommand(commandRequestId: number): void {
    const invocation = this.pending.get(commandRequestId);
    if (!invocation || invocation.aborted) {
      return;
    }
    invocation.aborted = true;
    if (!invocation.tool) this.pending.delete(commandRequestId);
    if (!this.terminated && this.worker) {
      this.postToWorker({ kind: "abort", commandRequestId });
    }
    if (!invocation.tool) invocation.reject(this.abortedError(String(commandRequestId)));
  }

  /** Total teardown: terminate the worker thread and reject everything in flight. After this the bridge
   *  is inert — no message from the (now dead) worker is processed, and further invocations reject. */
  terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.documentChangeReady.clear();
    this.assistantToolHandler = false;
    this.clearRequestTransport();
    const error = this.terminatedError();
    this.clearStartupTimer();
    const rejectStartup = this.rejectStartup;
    this.rejectStartup = undefined;
    this.readyPromise = undefined;
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    try {
      this.worker?.terminate();
    } catch {
      /* already dead */
    }
    this.worker = undefined;
    rejectStartup?.(error);
    for (const invocation of inFlight) {
      invocation.reject(error);
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.terminated) {
      return Promise.reject(this.terminatedError());
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    let resolveStartup!: () => void;
    let rejectStartup!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    this.readyPromise = readyPromise;
    this.rejectStartup = rejectStartup;

    let worker: PluginWorkerHandle;
    try {
      worker = this.createWorker();
    } catch (error) {
      this.failStartup(this.wrapCrash(error));
      return readyPromise;
    }
    this.worker = worker;

    const settleReady = (message: WorkerToHostMessage): void => {
      if (message.kind !== "ready" || this.worker !== worker || this.terminated || !this.rejectStartup) {
        return;
      }
      const mismatch = typeof message.apiVersion === "string" ? checkWorkerHandshake(message, this.hostApiVersion) :
        "The plugin worker did not declare an API version.";
      if (mismatch) {
        this.failStartup(
          new PluginWorkerBridgeError({ code: PluginWorkerErrorCodes.VersionMismatch, message: mismatch })
        );
        return;
      }
      this.clearStartupTimer();
      this.rejectStartup = undefined;
      this.assistantToolHandler = message.hasAssistantToolHandler === true;
      if (supportsPluginRequestTools(message.apiVersion) &&
          (this.hostApiVersion === undefined || supportsPluginRequestTools(this.hostApiVersion))) {
        const features = message.features;
        const optedIn = (key: keyof PluginWorkerFeatures) =>
          typeof features === "object" && features !== null && Object.getOwnPropertyDescriptor(features, key)?.value === true;
        this.features = {
          requestCapabilities: optedIn("requestCapabilities"),
          toolCalls: optedIn("toolCalls"),
          activeDocumentChanged: optedIn("activeDocumentChanged")
        };
      }
      resolveStartup();
      if (this.hasActiveDocumentChangedHandler()) {
        for (const listener of this.documentChangeReady) listener();
      }
    };

    this.startupTimer = setTimeout(() => {
      if (this.worker !== worker || this.terminated) return;
      this.failStartup(
        new PluginWorkerBridgeError({
          code: PluginWorkerErrorCodes.WorkerCrashed,
          message: `Plugin worker for "${this.pluginId}" did not complete its startup handshake within ${this.startupTimeoutMs} ms.`
        })
      );
    }, this.startupTimeoutMs);

    worker.addEventListener("message", (event: { data: unknown }) => {
      if (this.worker !== worker || this.terminated) {
        return;
      }
      const message = event.data as WorkerToHostMessage;
      if (typeof message !== "object" || message === null) return;
      // The very first message must be the handshake; route it there, then hand off to the router.
      if (message.kind === "ready") {
        settleReady(message);
        return;
      }
      this.handleWorkerMessage(message);
    });
    worker.addEventListener("error", (event: unknown) => {
      if (this.worker === worker) {
        this.failStartup(this.wrapCrash(event));
      }
    });
    worker.addEventListener("messageerror", (event: unknown) => {
      if (this.worker === worker) {
        this.failStartup(this.wrapCrash(event));
      }
    });
    return readyPromise;
  }

  /** A startup/crash failure after the worker was created: reject every in-flight command and drop the
   *  worker so a later invocation restarts cleanly. */
  private failStartup(error: unknown): void {
    this.assistantToolHandler = false;
    this.clearRequestTransport();
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    this.clearStartupTimer();
    const rejectStartup = this.rejectStartup;
    this.rejectStartup = undefined;
    try {
      this.worker?.terminate();
    } catch {
      /* already dead */
    }
    this.worker = undefined;
    this.readyPromise = undefined;
    rejectStartup?.(error);
    for (const invocation of inFlight) {
      invocation.reject(error);
    }
  }

  private clearRequestTransport(): void {
    this.features = undefined;
    this.pendingRequestCapabilities.clear();
    for (const settle of this.documentChanges.values()) settle(pluginRequestFailure("cancelled", "The worker stopped."));
    this.documentChanges.clear();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
  }

  private handleWorkerMessage(message: WorkerToHostMessage): void {
    if (this.terminated) {
      return;
    }
    switch (message.kind) {
      case "capabilityRequest":
        this.serviceCapability(message);
        return;
      case "commandSettled": {
        const invocation = this.pending.get(message.commandRequestId);
        if (!invocation || invocation.tool === "request") {
          return;
        }
        this.pending.delete(message.commandRequestId);
        if (invocation.aborted) {
          invocation.reject(this.abortedError(String(message.commandRequestId)));
        } else if (message.ok) {
          invocation.resolve(message.value);
        } else {
          invocation.reject(new PluginWorkerBridgeError(message.error));
        }
        return;
      }
      case "toolCallSettled": {
        const invocation = this.pending.get(message.commandRequestId);
        if (invocation?.tool !== "request") return;
        this.pending.delete(message.commandRequestId);
        if (invocation.aborted) {
          invocation.resolve(pluginRequestFailure("cancelled", "The tool call was cancelled."));
        } else {
          const parsed = PluginToolCallResultSchema.safeParse(message.result);
          invocation.resolve(parsed.success ? parsed.data :
            pluginRequestFailure(requestValidationCode(parsed.error), "Invalid tool call result."));
        }
        return;
      }
      case "activeDocumentChangedSettled": {
        const settle = this.documentChanges.get(message.notificationId);
        if (!settle) return;
        this.documentChanges.delete(message.notificationId);
        const parsed = PluginEmptyRequestResultSchema.safeParse(message.result);
        settle(parsed.success ? parsed.data : pluginRequestFailure(requestValidationCode(parsed.error), "Invalid document-change result."));
        return;
      }
      case "ready":
        return; // handshake already consumed
    }
  }

  /**
   * The heart of the boundary: map a worker capability request to the real host capability and reply.
   * Enforces (1) the request belongs to a live invocation, (2) the capability is one the plugin's
   * manifest granted — absent on the context ⇒ rejected here — and (3) the method is whitelisted.
   */
  private serviceCapability(message: Extract<WorkerToHostMessage, { kind: "capabilityRequest" }>): void {
    const invocation = this.pending.get(message.commandRequestId);
    if (!invocation || invocation.aborted) {
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.NoActiveCommand,
        message: `No active command ${message.commandRequestId} for a ${message.namespace}.${message.method} request.`
      });
      return;
    }

    if (typeof message.namespace !== "string" || typeof message.method !== "string" || !Array.isArray(message.args)) {
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.MalformedMessage, message: "Invalid capability request frame."
      });
      return;
    }
    const requestCapability = getPluginRequestCapability(message.namespace, message.method);
    if (requestCapability) {
      void this.serviceRequestCapability(message, invocation, requestCapability);
      return;
    }
    const requestTool = invocation.tool === "request";
    if (requestTool && (!isPinnedRequestToolCapability(message.namespace, message.method) || !invocation.boundRequest ||
        !isRequestToolContext(invocation.context, invocation.boundRequest))) {
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.CapabilityNotGranted, message: "This invocation only supports request capabilities."
      });
      return;
    }

    const capability = this.resolveCapability(invocation.context, message.namespace);
    if (!capability) {
      // The plugin's manifest does not grant this capability, so the host never built it onto the
      // context. Refuse the request at the bridge (ADR-0029: only declared capabilities are provided).
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.CapabilityNotGranted,
        message: `Plugin "${this.pluginId}" is not granted the "${message.namespace}" capability.`
      });
      return;
    }

    // Widened deliberately. The map keeps literal method names so the worker-side stub is typed
    // against it (see `CapabilityMethodOf`), which makes each namespace's entry a distinct tuple type;
    // indexing with a UNION namespace therefore gives a union of tuples, and `.includes` narrows its
    // parameter to their intersection — `never`. This is a runtime membership test on a string that
    // arrived over the wire, so `readonly string[]` is the honest type for it.
    const allowedMethods: readonly string[] = PLUGIN_WORKER_CAPABILITY_METHODS[message.namespace];
    if (!allowedMethods.includes(message.method)) {
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.UnknownCapabilityMethod,
        // Says "this host does not offer it", not "you were not granted it". The namespace WAS
        // granted — the method is either a typo or one this host predates, and a plugin author
        // reading "not granted" goes looking at their manifest for a permission that is already there.
        message:
          `"${message.namespace}.${message.method}" is not a capability method this host offers. ` +
          `Available on "${message.namespace}": ${allowedMethods.join(", ")}.`
      });
      return;
    }

    const method = (capability as CapabilityMethods)[message.method];
    if (typeof method !== "function") {
      // The namespace is granted but this method is not: the host builds a method onto the context only
      // when the plugin declared what it costs (`documents.applyPatch` needs `document.write`,
      // `chemistry.nameToStructure` needs `native.execute`). Same refusal as an ungranted namespace,
      // rather than a raw TypeError from calling `undefined`.
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.CapabilityNotGranted,
        message: `Plugin "${this.pluginId}" is not granted the "${message.namespace}.${message.method}" capability.`
      });
      return;
    }
    const release = requestTool ? this.reserveRequestCapability(message, () => {
      this.sendCapabilityError(message.requestId, { code: "limit", message: "Too many pending request capabilities." });
    }) : undefined;
    if (requestTool && !release) return;
    // A restarted runtime begins capability ids at 1 again. A promise owned by
    // the old worker must never send its late result/error to the current worker.
    const worker = this.worker;
    const isCurrent = () => this.worker === worker && this.pending.get(message.commandRequestId) === invocation && !invocation.aborted;
    const chemistry3dMethod = this.chemistry3dReplyLogger && message.namespace === "chemistry" &&
      (message.method === "embed3d" || message.method === "minimize3d" || message.method === "flatten3d")
      ? message.method : undefined;
    Promise.resolve()
      .then(() => method.apply(capability, [...message.args]))
      .then(
        (value) => {
          const droppedAsStale = !isCurrent();
          if (chemistry3dMethod && this.chemistry3dReplyLogger) {
            try {
              this.chemistry3dReplyLogger({
                pluginId: this.pluginId,
                commandRequestId: message.commandRequestId,
                requestId: message.requestId,
                method: chemistry3dMethod,
                ok: true,
                valueKeys: value !== null && typeof value === "object" ? Object.keys(value) : [],
                droppedAsStale
              });
            } catch { /* Diagnostics must never affect reply delivery. */ }
          }
          if (!droppedAsStale) this.sendCapabilityValue(message.requestId, value);
        },
        (error: unknown) => {
          const droppedAsStale = !isCurrent();
          if (chemistry3dMethod && this.chemistry3dReplyLogger) {
            try {
              this.chemistry3dReplyLogger({
                pluginId: this.pluginId,
                commandRequestId: message.commandRequestId,
                requestId: message.requestId,
                method: chemistry3dMethod,
                ok: false,
                valueKeys: [],
                droppedAsStale
              });
            } catch { /* Diagnostics must never affect reply delivery. */ }
          }
          if (!droppedAsStale) this.sendCapabilityError(message.requestId, toErrorPayload(error));
        }
      ).finally(release);
  }

  private reserveRequestCapability(
    message: Extract<WorkerToHostMessage, { kind: "capabilityRequest" }>, onLimit: () => void
  ): (() => void) | undefined {
    const { requestId } = message;
    if (!Number.isSafeInteger(requestId) || requestId < 1 || this.pendingRequestCapabilities.has(requestId)) return;
    if (this.pendingRequestCapabilities.size >= PluginRequestLimits.pendingCapabilities) {
      onLimit();
      return;
    }
    this.pendingRequestCapabilities.set(requestId, message);
    return () => {
      if (this.pendingRequestCapabilities.get(requestId) === message) this.pendingRequestCapabilities.delete(requestId);
    };
  }

  private async serviceRequestCapability(
    message: Extract<WorkerToHostMessage, { kind: "capabilityRequest" }>,
    invocation: PendingInvocation,
    capability: NonNullable<ReturnType<typeof getPluginRequestCapability>>
  ): Promise<void> {
    const { namespace, method, requestId, commandRequestId, args } = message;
    const send = (value: unknown) => this.sendCapabilityValue(requestId, value);
    if (this.features?.requestCapabilities !== true) {
      send(pluginRequestFailure("unsupported", "This worker did not negotiate request capabilities."));
      return;
    }
    const release = this.reserveRequestCapability(message, () => send(pluginRequestFailure("limit", "Too many pending request capabilities.")));
    if (!release) return;
    const label = `${namespace}.${method}`;
    const worker = this.worker;
    try {
      const parsed = capability.request.safeParse(args.length === 1 ? args[0] : undefined);
      if (!parsed.success) {
        send(pluginRequestFailure(requestValidationCode(parsed.error), `Invalid ${label} arguments.`));
        return;
      }
      const target = this.resolveCapability(invocation.context, namespace) as CapabilityMethods | undefined;
      const handler = target?.[method];
      if (typeof handler !== "function" || !pluginRequestPermissions(namespace, method, parsed.data).every(
        permission => invocation.context.hasPermission(permission)
      )) {
        send(pluginRequestFailure("permission", `Permission denied for ${label}.`));
        return;
      }
      const value = await handler.call(target, parsed.data);
      if (this.worker !== worker || this.pending.get(commandRequestId) !== invocation || invocation.aborted) return;
      if (namespace === "documents" && method === "readRequest") {
        send(parseNativeObjectResult(PluginReadRequestResultSchema.safeParse(value), label, entry => {
          const object = parseNativeObject(entry.object);
          return object && { ...entry, object };
        }));
        return;
      }
      if (namespace === "depiction" && method === "planLayout") {
        send(parseNativeObjectResult(PluginPlanLayoutResultSchema.safeParse(value), label, parseNativeObject));
        return;
      }
      const response = capability.result.safeParse(value);
      send(response.success ? response.data : pluginRequestFailure(requestValidationCode(response.error), `Invalid ${label} result.`));
    } catch {
      if (this.worker === worker && this.pending.get(commandRequestId) === invocation && !invocation.aborted) {
        send(pluginRequestFailure("failed", `${label} could not be completed.`));
      }
    } finally {
      release();
    }
  }

  private resolveCapability(context: PluginCommandContext, namespace: PluginWorkerCapabilityNamespace): unknown {
    switch (namespace) {
      case "selection":
        return context.selection;
      case "analysis":
        return context.analysis;
      case "storage":
        return context.storage;
      case "overlays":
        return context.overlays;
      case "panels":
        return context.panels;
      case "documents":
        return context.documents; // always present; individual methods remain permission-gated
      case "chemistry":
        return context.chemistry;
      case "dialogs":
        return context.dialogs;
      case "images":
        return context.images;
      case "recognition":
        return context.recognition;
      case "tools":
        return context.tools;
      case "assistant":
        return context.assistant;
      case "requests":
        return context.requests;
      case "toolSessions":
        return context.toolSessions;
      case "depiction":
        return context.depiction;
    }
  }

  private sendCapabilityValue(requestId: number, value: unknown): void {
    if (this.terminated || !this.worker) {
      return;
    }
    try {
      this.postToWorker({ kind: "capabilityResult", requestId, ok: true, value });
    } catch (error) {
      // The value was not structured-clone-safe (e.g. a live document object). Surface it as an error
      // instead of crashing the bridge; the proof plugins never hit this, but a future one might.
      this.sendCapabilityError(requestId, {
        code: "PLUGIN_WORKER_UNCLONEABLE_RESULT",
        message: error instanceof Error ? error.message : "Capability result was not serializable."
      });
    }
  }

  private sendCapabilityError(requestId: number, error: PluginWorkerErrorPayload): void {
    if (this.terminated || !this.worker) {
      return;
    }
    this.postToWorker({ kind: "capabilityResult", requestId, ok: false, error });
  }

  private postToWorker(message: HostToWorkerMessage): void {
    this.worker?.postMessage(message);
  }

  private terminatedError(): PluginWorkerBridgeError {
    return new PluginWorkerBridgeError({
      code: PluginWorkerErrorCodes.Terminated,
      message: `Plugin worker for "${this.pluginId}" has been terminated.`
    });
  }

  private abortedError(command: string): PluginWorkerBridgeError {
    return new PluginWorkerBridgeError({
      code: PluginWorkerErrorCodes.Terminated,
      message: `Plugin command ${command} was aborted.`
    });
  }

  private wrapCrash(cause: unknown): PluginWorkerBridgeError {
    const detail = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : "unknown error";
    return new PluginWorkerBridgeError({ code: PluginWorkerErrorCodes.WorkerCrashed, message: `Plugin worker for "${this.pluginId}" crashed: ${detail}` });
  }
}

/** An error crossing back from the worker boundary, carrying the stable code from its payload. */
export class PluginWorkerBridgeError extends Error {
  readonly code: string;

  constructor(payload: PluginWorkerErrorPayload) {
    super(payload.message);
    this.name = "PluginWorkerBridgeError";
    this.code = payload.code;
  }
}

function toErrorPayload(error: unknown): PluginWorkerErrorPayload {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : error.name, message: error.message };
  }
  return { code: "PLUGIN_WORKER_ERROR", message: String(error) };
}
