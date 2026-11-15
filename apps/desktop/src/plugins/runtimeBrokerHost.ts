import type { PluginInvocationDocumentProvider } from "@chemdraft/plugin-host";
import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { RuntimeBroker } from "./runtimeBroker";
import {
  invocationReference, RUNTIME_HOST_LABEL,
  type RuntimeContributions, type RuntimeInvocation
} from "./runtimeBrokerProtocol";

const providerInvocations = new WeakMap<PluginInvocationDocumentProvider["getDocument"], RuntimeInvocation>();
export const runtimeProviderInvocation = (provider: PluginInvocationDocumentProvider) => providerInvocations.get(provider.getDocument);

const runtimeOwners = new WeakSet<RuntimeBroker>();

/** Runtime-side binding: every closure captures one immutable composite target. No activation event
 * can replace it. AbortSignal stays in the host; endInvocation cancels the document's local signal. */
export function brokerDocumentProvider(broker: RuntimeBroker, raw: RuntimeInvocation): PluginInvocationDocumentProvider {
  const invocation = structuredClone(raw);
  const ref = invocationReference(invocation);
  const owner = invocation.target.windowId;
  const provider = Object.freeze({
    target: Object.freeze({ ...invocation.target }),
    getViewportRect: () => broker.call(owner, "getViewportRect", ref),
    getDocument: () => broker.call(owner, "getDocument", ref),
    getDocumentKey: () => invocation.documentKey,
    getSelection: options => broker.call(owner, "getSelection", { ...ref, ...options }),
    applyDocumentPatch: application => {
      application.signal?.throwIfAborted();
      const { signal, ...serializable } = application;
      const cancel = () => { void broker.call(owner, "endInvocation", ref).catch(() => undefined); };
      signal?.addEventListener("abort", cancel, { once: true });
      return broker.call(owner, "applyPatch", { invocation: ref,
        application: { ...serializable, writeScopeObjectIds: [...serializable.writeScopeObjectIds] } })
        .finally(() => signal?.removeEventListener("abort", cancel));
    }
  } satisfies PluginInvocationDocumentProvider);
  providerInvocations.set(provider.getDocument, invocation);
  return provider;
}

/** Owns exactly one runtime, constructed once independently of document clients. The factory is the
 * seam for the hidden route's owner hook (installs, updates and UI-state forwarding still need that
 * hook). Never construct one of these from a document-window render. */
export class RuntimeBrokerHost {
  readonly runtime: DesktopPluginRuntime;
  private revision = 0;
  private disposed = false;
  private readonly stop: Array<() => void> = [];
  private readonly running = new Map<string, RuntimeInvocation>();

  constructor(private readonly broker: RuntimeBroker, createRuntime: () => DesktopPluginRuntime,
    private readonly documentClients: () => readonly string[]) {
    if (broker.label !== RUNTIME_HOST_LABEL) throw new Error("Only the runtime host may own the plugin runtime.");
    if (runtimeOwners.has(broker)) throw new Error("This runtime host already owns its one plugin runtime.");
    runtimeOwners.add(broker);
    this.runtime = createRuntime();
    this.stop.push(
      broker.handle("getContributions", () => this.contributions()),
      broker.handle("invokeCommand", async ({ invocation, input }, sender) => {
        if (sender !== invocation.target.windowId) throw new Error("The plugin invocation does not belong to its source document window.");
        const command = this.runtime.host.commands.get(invocation.commandId);
        if (command?.source !== "plugin" || command.pluginId !== invocation.pluginId) {
          throw new Error("The plugin invocation does not belong to the registered plugin command.");
        }
        if (this.running.has(invocation.id)) throw new Error("The plugin command invocation is already running.");
        this.running.set(invocation.id, invocation);
        try {
          return await this.runtime.invokeCommand(invocation.commandId, { input,
            writeSelection: { objectIds: invocation.writeScopeObjectIds, molecules: [] },
            documentProvider: brokerDocumentProvider(broker, invocation) });
        } finally {
          this.running.delete(invocation.id);
          // Do not retain live writes after a handler returns without awaiting its capabilities.
          await broker.call(sender, "endInvocation", invocationReference(invocation)).catch(() => undefined);
        }
      }),
      // Runtime registration, including its ui.toolbar gate and whole-plugin rollback, completes
      // BEFORE this notification. Subscribing to bare host registration would expose half a plugin.
      this.runtime.onDidChange(() => {
        this.revision++;
        void broker.broadcastContributions(documentClients(), this.contributions()).catch(() => undefined);
      })
    );
  }

  contributions(): RuntimeContributions {
    return { revision: this.revision, plugins: this.runtime.host.listPlugins(),
      enabledCommandIds: this.runtime.host.commands.list().filter(command => command.source === "plugin" && command.pluginId && command.enabled).map(command => command.id) };
  }

  async broadcastContributions(): Promise<void> {
    if (this.disposed) throw new Error("The plugin runtime host is closed.");
    await this.broker.broadcastContributions(this.documentClients(), this.contributions());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stop) stop();
    for (const invocation of this.running.values()) {
      void this.broker.call(invocation.target.windowId, "endInvocation", invocationReference(invocation)).catch(() => undefined);
    }
    this.running.clear();
  }
}
