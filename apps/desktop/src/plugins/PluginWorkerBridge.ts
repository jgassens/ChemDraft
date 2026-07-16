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
 *    the matching permission (auto-granted; ADR-0029 is permissive — no consent gate). If the worker
 *    asks for a namespace the context does not carry, the bridge rejects the request. `documents` is
 *    always present but its methods re-check `document.read` / `document.proposePatch` and throw.
 *  - **Reverse signals** (`panelClosed`, `abort`) travel worker-ward so ADR-0012 panel-close
 *    cancellation works across the boundary.
 *  - **`terminate()` is a total teardown** — the mechanism M36 uninstall will call. After it, no
 *    capability request, panel push, or command result reaches the host.
 *
 * The bridge is framework-neutral (no React) and transport-agnostic: it drives a
 * {@link PluginWorkerHandle}, which a real `Worker` satisfies and tests supply as a linked fake.
 */

import {
  PLUGIN_WORKER_CAPABILITY_METHODS,
  PluginWorkerErrorCodes,
  checkWorkerHandshake,
  type HostToWorkerMessage,
  type PluginCommandContext,
  type PluginWorkerCapabilityNamespace,
  type PluginWorkerErrorPayload,
  type PluginWorkerHandle,
  type WorkerToHostMessage
} from "@chemdraft/plugin-api";

export interface PluginWorkerBridgeOptions {
  /** Plugin id this bridge fronts (for diagnostics). */
  pluginId: string;
  /** Lazily create the underlying worker. Called once, on first {@link ensureStarted}. */
  createWorker: () => PluginWorkerHandle;
  /** Host API version the worker's handshake is validated against. Defaults to the SDK's version. */
  hostApiVersion?: string;
}

interface PendingInvocation {
  context: PluginCommandContext;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** A capability object indexed by method name, for dynamic dispatch after the method whitelist check. */
type CapabilityMethods = Record<string, (...args: unknown[]) => unknown>;

export class PluginWorkerBridge {
  private readonly pluginId: string;
  private readonly createWorker: () => PluginWorkerHandle;
  private readonly hostApiVersion?: string;

  private worker: PluginWorkerHandle | undefined;
  private readyPromise: Promise<void> | undefined;
  private terminated = false;

  private nextCommandRequestId = 1;
  private readonly pending = new Map<number, PendingInvocation>();

  constructor(options: PluginWorkerBridgeOptions) {
    this.pluginId = options.pluginId;
    this.createWorker = options.createWorker;
    this.hostApiVersion = options.hostApiVersion;
  }

  /** Spawn the worker (if needed) and resolve once its startup handshake passes; reject loudly on a
   *  protocol/apiVersion mismatch or a crash. Safe to call repeatedly. */
  whenReady(): Promise<void> {
    return this.ensureStarted();
  }

  /**
   * Run a plugin command in the worker, servicing its capability calls against `context`. Resolves with
   * the command's return value (a `PluginCommandResult` for the proof plugins) or rejects if the worker
   * reports an error, is aborted, or is terminated.
   */
  async invokeCommand(commandId: string, context: PluginCommandContext): Promise<unknown> {
    if (this.terminated) {
      throw this.terminatedError();
    }
    await this.ensureStarted();
    if (this.terminated) {
      throw this.terminatedError();
    }
    const commandRequestId = this.nextCommandRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(commandRequestId, { context, resolve, reject });
      this.postToWorker({ kind: "invokeCommand", commandRequestId, commandId });
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

  /** Drop a specific in-flight command without tearing down the worker: settle it locally as cancelled
   *  and tell the worker to suppress its late settlement. */
  abortCommand(commandRequestId: number): void {
    const invocation = this.pending.get(commandRequestId);
    if (!invocation) {
      return;
    }
    this.pending.delete(commandRequestId);
    if (!this.terminated && this.worker) {
      this.postToWorker({ kind: "abort", commandRequestId });
    }
    invocation.reject(
      new PluginWorkerBridgeError({ code: PluginWorkerErrorCodes.Terminated, message: `Command ${commandRequestId} was aborted.` })
    );
  }

  /** Total teardown: terminate the worker thread and reject everything in flight. After this the bridge
   *  is inert — no message from the (now dead) worker is processed, and further invocations reject. */
  terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    try {
      this.worker?.terminate();
    } catch {
      /* already dead */
    }
    this.worker = undefined;
    for (const invocation of inFlight) {
      invocation.reject(this.terminatedError());
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.terminated) {
      return Promise.reject(this.terminatedError());
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let worker: PluginWorkerHandle;
      try {
        worker = this.createWorker();
      } catch (error) {
        reject(this.wrapCrash(error));
        return;
      }
      this.worker = worker;

      const settleReady = (message: WorkerToHostMessage): void => {
        if (message.kind !== "ready") {
          return;
        }
        const mismatch = checkWorkerHandshake(message, this.hostApiVersion);
        if (mismatch) {
          const error = new PluginWorkerBridgeError({ code: PluginWorkerErrorCodes.VersionMismatch, message: mismatch });
          this.failStartup(error);
          reject(error);
          return;
        }
        resolve();
      };

      worker.addEventListener("message", (event: { data: unknown }) => {
        const message = event.data as WorkerToHostMessage;
        // The very first message must be the handshake; route it there, then hand off to the router.
        if (message.kind === "ready") {
          settleReady(message);
          return;
        }
        this.handleWorkerMessage(message);
      });
      worker.addEventListener("error", (event: unknown) => {
        const error = this.wrapCrash(event);
        this.failStartup(error);
        reject(error);
      });
      worker.addEventListener("messageerror", (event: unknown) => {
        const error = this.wrapCrash(event);
        this.failStartup(error);
        reject(error);
      });
    });
    return this.readyPromise;
  }

  /** A startup/crash failure after the worker was created: reject every in-flight command and drop the
   *  worker so a later invocation restarts cleanly. */
  private failStartup(error: unknown): void {
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    try {
      this.worker?.terminate();
    } catch {
      /* already dead */
    }
    this.worker = undefined;
    this.readyPromise = undefined;
    for (const invocation of inFlight) {
      invocation.reject(error);
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
        if (!invocation) {
          return;
        }
        this.pending.delete(message.commandRequestId);
        if (message.ok) {
          invocation.resolve(message.value);
        } else {
          invocation.reject(new PluginWorkerBridgeError(message.error));
        }
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
    if (!invocation) {
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.NoActiveCommand,
        message: `No active command ${message.commandRequestId} for a ${message.namespace}.${message.method} request.`
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

    const allowedMethods = PLUGIN_WORKER_CAPABILITY_METHODS[message.namespace];
    if (!allowedMethods.includes(message.method)) {
      this.sendCapabilityError(message.requestId, {
        code: PluginWorkerErrorCodes.UnknownCapabilityMethod,
        message: `"${message.namespace}.${message.method}" is not a valid capability method.`
      });
      return;
    }

    const method = (capability as CapabilityMethods)[message.method];
    Promise.resolve()
      .then(() => method.apply(capability, [...message.args]))
      .then(
        (value) => this.sendCapabilityValue(message.requestId, value),
        (error: unknown) => this.sendCapabilityError(message.requestId, toErrorPayload(error))
      );
  }

  private resolveCapability(context: PluginCommandContext, namespace: PluginWorkerCapabilityNamespace): unknown {
    switch (namespace) {
      case "selection":
        return context.selection;
      case "analysis":
        return context.analysis;
      case "storage":
        return context.storage;
      case "panels":
        return context.panels;
      case "documents":
        return context.documents; // always present; its methods gate on document.* internally
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
