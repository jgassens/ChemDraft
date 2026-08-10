/**
 * Worker-side runtime for the per-plugin isolation boundary (ADR-0029, M34).
 *
 * Inside a Web Worker, {@link runPluginWorker} wires a bundled plugin's command handlers to a
 * {@link PluginCommandContext} whose capability objects are *async stubs*: each call posts a protocol
 * request to the main thread and resolves when the response returns. The plugin's own source is
 * unchanged — it still imports only `@chemdraft/plugin-api` and still calls
 * `context.selection.getSelection()`, `context.analysis.write(...)`, `context.panels.showReport(...)`
 * exactly as in-process. Only the *execution location* moves.
 *
 * The runtime mirrors the host's `createCommandContext` optionality (a capability object is present
 * only when the manifest declares its permission), so a plugin observes the identical context shape it
 * would in-process; the main-thread bridge additionally enforces declared-only access on every request.
 *
 * This file is framework-neutral and touches worker globals only through the injected endpoint, so it
 * unit-tests without a real Worker (a linked in-memory endpoint pair stands in).
 */

import type {
  PluginAnalysisAPI,
  PluginChemistryAPI,
  PluginCommandContext,
  PluginCommandHandler,
  PluginDocumentAPI,
  PluginManifest,
  PluginPanelAPI,
  PluginPermission,
  PluginSelectionAPI,
  PluginStorage
} from "./index";
import {
  PLUGIN_WORKER_PROTOCOL_VERSION,
  PluginWorkerErrorCodes,
  asHostToWorkerMessage,
  toPluginWorkerErrorPayload,
  type HostToWorkerMessage,
  type CapabilityMethodOf,
  type PluginWorkerCapabilityNamespace,
  type PluginWorkerEndpoint,
  type PluginWorkerErrorPayload,
  type WorkerToHostMessage
} from "./workerProtocol";

/** What a worker entry hands the runtime: the plugin's manifest (for identity + declared permissions),
 *  its command handlers, and its optional panel-close hook (ADR-0012 cancellation). This is exactly the
 *  data the in-process `host.registerPlugin(manifest, { commandHandlers, onPanelClosed })` consumes. */
export interface PluginWorkerRegistration {
  manifest: PluginManifest;
  commandHandlers: Record<string, PluginCommandHandler>;
  onPanelClosed?: (panelId: string) => void;
}

/** An error that carries a stable code across the boundary, so a rejected capability call surfaces to
 *  the plugin handler with the same `code`/`message` the host method would have thrown in-process. */
export class PluginWorkerCapabilityError extends Error {
  readonly code: string;

  constructor(payload: PluginWorkerErrorPayload | unknown) {
    // Normalized rather than destructured: a malformed failure frame must not throw here, because
    // the construction happens on the settle path and a throw would strand the pending capability.
    const normalized = toPluginWorkerErrorPayload(payload);
    super(normalized.message);
    this.name = "PluginWorkerCapabilityError";
    this.code = normalized.code;
  }
}

/** Upper bound on remembered aborted command ids (see `abortedCommands`). Large enough that a real
 *  abort/settle race always finds its id, small enough that a leak stays bounded. */
const MAX_REMEMBERED_ABORTED_COMMANDS = 1024;

function toErrorPayload(error: unknown): PluginWorkerErrorPayload {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : error.name, message: error.message };
  }
  return { code: "PLUGIN_WORKER_ERROR", message: String(error) };
}

/** The worker's global scope, viewed as an endpoint. Cast mirrors the existing conformer/NMR worker
 *  entries, which reach `postMessage` / `addEventListener("message")` off `globalThis`. */
function globalEndpoint(): PluginWorkerEndpoint {
  return globalThis as unknown as PluginWorkerEndpoint;
}

/**
 * Start the worker runtime for one plugin. Attaches the message listener, then announces readiness
 * with the protocol version and the plugin's declared API version (the host validates the handshake
 * and rejects a mismatch loudly). Returns nothing — the runtime lives for the worker's lifetime.
 */
export function runPluginWorker(
  registration: PluginWorkerRegistration,
  endpoint: PluginWorkerEndpoint = globalEndpoint()
): void {
  const permissions = new Set<PluginPermission>(registration.manifest.permissions);
  const has = (permission: PluginPermission): boolean => permissions.has(permission);

  let nextCapabilityId = 1;
  const pendingCapabilities = new Map<
    number,
    { commandRequestId: number; resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  /** Commands the host aborted/terminated: their eventual settlement is suppressed, and their pending
   *  capability calls are rejected so a handler cannot hang forever.
   *
   *  Entries are normally removed when the aborted handler finally settles, but a handler that
   *  swallows its rejection and never settles would leak its id forever. The set is therefore bounded
   *  and evicts oldest-first (`Set` preserves insertion order): over a long session of misbehaving
   *  handlers it stays flat instead of growing without limit. Eviction is safe because the host mints
   *  `commandRequestId` monotonically, so an evicted id is never reissued. */
  const abortedCommands = new Set<number>();
  const rememberAbortedCommand = (commandRequestId: number): void => {
    abortedCommands.add(commandRequestId);
    while (abortedCommands.size > MAX_REMEMBERED_ABORTED_COMMANDS) {
      const oldest = abortedCommands.values().next();
      if (oldest.done) {
        break;
      }
      abortedCommands.delete(oldest.value);
    }
  };

  const post = (message: WorkerToHostMessage): void => {
    endpoint.postMessage(message);
  };

  const callCapability = (
    commandRequestId: number,
    namespace: PluginWorkerCapabilityNamespace,
    method: string,
    args: readonly unknown[]
  ): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      if (abortedCommands.has(commandRequestId)) {
        reject(new PluginWorkerCapabilityError({ code: PluginWorkerErrorCodes.Terminated, message: "Command was aborted." }));
        return;
      }
      const requestId = nextCapabilityId++;
      pendingCapabilities.set(requestId, { commandRequestId, resolve, reject });
      post({ kind: "capabilityRequest", requestId, commandRequestId, namespace, method, args });
    });

  const buildContext = (commandRequestId: number): PluginCommandContext => {
    // `method` is typed against PLUGIN_WORKER_CAPABILITY_METHODS rather than being a bare `string`, so
    // the stub and the host bridge's allow-list are one list instead of two. This is the fix for the
    // real defect: `nameToStructure` and `structureFromSmiles` were added here, and to the in-process
    // host, and never to the map — so the bridge rejected both for every worker-routed plugin while
    // the compiler said nothing. Offering a method the host will not accept is now a type error.
    const call = <N extends PluginWorkerCapabilityNamespace>(
      namespace: N,
      method: CapabilityMethodOf<N>,
      args: readonly unknown[]
    ): Promise<unknown> => callCapability(commandRequestId, namespace, method, args);

    const documents: PluginDocumentAPI = {
      getActiveDocument: () => call("documents", "getActiveDocument", []) as ReturnType<PluginDocumentAPI["getActiveDocument"]>,
      proposePatch: (proposal) => call("documents", "proposePatch", [proposal]) as ReturnType<PluginDocumentAPI["proposePatch"]>
    };

    // The capability objects are transport stubs: each method forwards to the boundary and resolves on
    // the response. The generic methods (`storage.get<T>`, `analysis.write<T>`) can't be expressed with
    // `ReturnType`, so each stub object is cast to its interface — type safety lives at the plugin's own
    // call site (its declared payload types), exactly as it would in-process.
    const storage: PluginStorage | undefined = has("plugin.storage")
      ? ({
          get: (key: string) => call("storage", "get", [key]),
          set: (key: string, value: unknown) => call("storage", "set", [key, value]),
          delete: (key: string) => call("storage", "delete", [key]),
          listKeys: () => call("storage", "listKeys", [])
        } as unknown as PluginStorage)
      : undefined;

    const selection: PluginSelectionAPI | undefined = has("selection.read")
      ? { getSelection: () => call("selection", "getSelection", []) as ReturnType<PluginSelectionAPI["getSelection"]> }
      : undefined;

    const panels: PluginPanelAPI | undefined = has("ui.panel")
      ? { showReport: (panelId, report) => call("panels", "showReport", [panelId, report]) as ReturnType<PluginPanelAPI["showReport"]> }
      : undefined;

    // Gated on the permission alone, exactly like the others. The host still decides whether it can
    // actually serve the call: a host with no chemistry engine resolves the stub's request with
    // `available: false` rather than the plugin having to guess from the capability's presence.
    const chemistry: PluginChemistryAPI | undefined = has("chemistry.compute")
      ? {
          isotopeEnvelope: (request) =>
            call("chemistry", "isotopeEnvelope", [request]) as ReturnType<PluginChemistryAPI["isotopeEnvelope"]>,
          // Present in the stub for the same reason: a worker-routed plugin must see the same shape
          // an in-process one does, or the two paths disagree about what this host can do — which is
          // why `nameToStructure` carries the SAME extra condition the host applies. It spawns a JVM
          // on the desktop, so it needs `native.execute` as well as `chemistry.compute`; offering the
          // stub without it would put a method on the context that the host would then refuse.
          ...(has("native.execute")
            ? {
                nameToStructure: (request: Parameters<NonNullable<PluginChemistryAPI["nameToStructure"]>>[0]) =>
                  call("chemistry", "nameToStructure", [request]) as ReturnType<
                    NonNullable<PluginChemistryAPI["nameToStructure"]>
                  >
              }
            : {}),
          // Same rule as the host: this one lays out against the active document, so it needs
          // `document.read` too. Keeping the two conditions identical is what keeps the in-process and
          // worker paths agreeing about what the host offers.
          ...(has("document.read")
            ? {
                structureFromSmiles: (
                  request: Parameters<NonNullable<PluginChemistryAPI["structureFromSmiles"]>>[0]
                ) =>
                  call("chemistry", "structureFromSmiles", [request]) as ReturnType<
                    NonNullable<PluginChemistryAPI["structureFromSmiles"]>
                  >
              }
            : {})
        }
      : undefined;

    const analysis: PluginAnalysisAPI | undefined = has("analysis.write")
      ? ({
          write: (input: unknown) => call("analysis", "write", [input]),
          list: (query: unknown) => call("analysis", "list", [query]),
          getLatest: (query: unknown) => call("analysis", "getLatest", [query])
        } as unknown as PluginAnalysisAPI)
      : undefined;

    return {
      plugin: {
        id: registration.manifest.id,
        name: registration.manifest.name,
        version: registration.manifest.version,
        permissions: registration.manifest.permissions
      },
      documents,
      storage,
      selection,
      panels,
      analysis,
      chemistry,
      hasPermission: has,
      requirePermission: (permission) => {
        if (!has(permission)) {
          throw new PluginWorkerCapabilityError({
            code: "PLUGIN_PERMISSION_DENIED",
            message: `Plugin "${registration.manifest.id}" requires permission "${permission}".`
          });
        }
      }
    };
  };

  const invoke = (commandRequestId: number, commandId: string): void => {
    const handler = registration.commandHandlers[commandId];
    if (!handler) {
      post({
        kind: "commandSettled",
        commandRequestId,
        ok: false,
        error: { code: PluginWorkerErrorCodes.UnknownCommand, message: `Command "${commandId}" has no handler in this plugin worker.` }
      });
      return;
    }
    // Defer to a microtask so a synchronous throw is captured as a rejection, mirroring the host.
    Promise.resolve()
      .then(() => handler(buildContext(commandRequestId)))
      .then(
        (value) => {
          if (abortedCommands.has(commandRequestId)) {
            abortedCommands.delete(commandRequestId);
            return; // host already settled this command (abort/terminate); suppress the late result
          }
          try {
            post({ kind: "commandSettled", commandRequestId, ok: true, value });
          } catch (error) {
            // `postMessage` synchronously throws DataCloneError for functions, symbols, and other
            // non-cloneable results. Report a clone-safe failure so the host invocation rejects
            // instead of waiting forever for a settlement that could never cross the boundary.
            post({
              kind: "commandSettled",
              commandRequestId,
              ok: false,
              error: {
                code: PluginWorkerErrorCodes.UncloneableResult,
                message:
                  error instanceof Error && error.message
                    ? `Plugin command result could not be serialized: ${error.message}`
                    : "Plugin command result could not be serialized."
              }
            });
          }
        },
        (error: unknown) => {
          if (abortedCommands.has(commandRequestId)) {
            abortedCommands.delete(commandRequestId);
            return;
          }
          post({ kind: "commandSettled", commandRequestId, ok: false, error: toErrorPayload(error) });
        }
      );
  };

  const handle = (message: HostToWorkerMessage): void => {
    switch (message.kind) {
      case "invokeCommand":
        invoke(message.commandRequestId, message.commandId);
        return;
      case "capabilityResult": {
        const pending = pendingCapabilities.get(message.requestId);
        if (!pending) {
          return; // unknown / superseded / already-settled id
        }
        pendingCapabilities.delete(message.requestId);
        if (message.ok) {
          pending.resolve(message.value);
        } else {
          pending.reject(new PluginWorkerCapabilityError(message.error));
        }
        return;
      }
      case "panelClosed":
        registration.onPanelClosed?.(message.panelId);
        return;
      case "abort":
        rememberAbortedCommand(message.commandRequestId);
        // Reject any capability calls still in flight for this command so the handler unwinds.
        for (const [requestId, pending] of pendingCapabilities) {
          if (pending.commandRequestId !== message.commandRequestId) {
            continue;
          }
          pending.reject(new PluginWorkerCapabilityError({ code: PluginWorkerErrorCodes.Terminated, message: "Command was aborted." }));
          pendingCapabilities.delete(requestId);
        }
        return;
    }
  };

  endpoint.addEventListener("message", (event: { data: unknown }) => {
    const message = asHostToWorkerMessage(event.data);
    if (!message) {
      return; // not a protocol frame: drop it rather than throwing inside the message listener
    }
    handle(message);
  });

  // Announce readiness last, so the listener is attached before the host can send an invocation.
  post({ kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: registration.manifest.apiVersion });
}
