import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginInvocationDocumentProvider } from "@chemdraft/plugin-host";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { AssistantTransactionResult } from "../assistant/assistantTransaction";
import type { RuntimeAssistantPreparedWrite, RuntimeAssistantSession, RuntimeAssistantSnapshot, RuntimeAssistantWritePlan } from "./runtimeAssistantProtocol";
import { RuntimeBroker } from "./runtimeBroker";
import { brokerDocumentProvider, runtimeProviderInvocation } from "./runtimeBrokerHost";
import { invocationReference } from "./runtimeBrokerProtocol";

export interface RuntimeAssistantBinding {
  withToolInvocation<T>(name: string, scope: readonly string[], run: (provider: PluginInvocationDocumentProvider) => Promise<T>): Promise<T>;
  requestId: string;
  tabId: string;
  selection: string[];
  read(): ChemDraftDocument;
  viewport(): RuntimeAssistantSnapshot["viewport"];
  refresh(): Promise<void>;
  write(after: ChemDraftDocument, touchedIds: readonly string[], selectionDocument: ChemDraftDocument): void;
  runWrite<T>(apply: () => T | Promise<T>, plan: RuntimeAssistantWritePlan, signal: AbortSignal): Promise<T>;
  consent(platform?: ShortcutPlatform): { confirm(signal?: AbortSignal): Promise<"enlarge" | "keep" | "unanswered"> };
  end(touchedIds: readonly string[]): Promise<AssistantTransactionResult>;
}

/** All callbacks stay in the owner. A one-use write id lets the document ask for preparation
 * against its gate-time snapshot; the only response is checked document data. */
export function createRuntimeAssistantClient(broker: RuntimeBroker) {
  const writes = new Map<string, { session: RuntimeAssistantSession; prepare(snapshot: RuntimeAssistantSnapshot): Promise<RuntimeAssistantPreparedWrite> }>();
  const stop = broker.handle("prepareAssistantWrite", ({ session, writeId, snapshot }, sender) => {
    const pending = writes.get(writeId);
    if (!pending || sender !== session.target.windowId || JSON.stringify(session) !== JSON.stringify(pending.session)) {
      throw new Error("This assistant write has no matching owner preparation.");
    }
    writes.delete(writeId);
    return pending.prepare(snapshot);
  });
  return {
    dispose: () => { stop(); writes.clear(); },
    async begin(provider: PluginInvocationDocumentProvider, label: string): Promise<RuntimeAssistantBinding> {
      const invocation = runtimeProviderInvocation(provider);
      if (!invocation) throw new Error("The assistant requires a captured document invocation.");
      const opened = await broker.call(invocation.target.windowId, "assistantBegin", { invocation: invocationReference(invocation), label });
      const { session, selection } = opened;
      let snapshot = opened.snapshot;
      let prepared: RuntimeAssistantPreparedWrite | undefined;
      const binding: RuntimeAssistantBinding = {
        async withToolInvocation(name, scope, run) {
          const invocation = await broker.call(session.target.windowId, "assistantOpenInvocation",
            { session, commandId: name, writeScopeObjectIds: [...scope] });
          try { return await run(brokerDocumentProvider(broker, invocation)); }
          finally { await broker.call(session.target.windowId, "endInvocation", invocationReference(invocation)).catch(() => undefined); }
        },
        requestId: session.requestId, tabId: session.target.tabId, selection,
        read: () => snapshot.document, viewport: () => snapshot.viewport,
        refresh: async () => { snapshot = await broker.call(session.target.windowId, "assistantRead", session); },
        write: (after, touchedIds, selectionDocument) => { prepared = { after, touchedIds: [...touchedIds], selectionDocument }; },
        async runWrite<T>(apply: () => T | Promise<T>, plan: RuntimeAssistantWritePlan, signal: AbortSignal): Promise<T> {
          signal.throwIfAborted();
          const writeId = crypto.randomUUID();
          let result!: T;
          writes.set(writeId, { session, prepare: async current => {
            signal.throwIfAborted();
            snapshot = current;
            prepared = undefined;
            result = await apply();
            if (!prepared) throw new Error("The assistant write has no transaction preparation.");
            return prepared;
          } });
          const cancel = () => { void broker.call(session.target.windowId, "cancelAssistantWrite", { session, writeId }).catch(() => undefined); };
          signal.addEventListener("abort", cancel, { once: true });
          try { snapshot = await broker.call(session.target.windowId, "assistantWrite", { session, writeId, plan }); return result; }
          finally { writes.delete(writeId); signal.removeEventListener("abort", cancel); }
        },
        consent: platform => ({ confirm: async signal => {
          signal?.throwIfAborted();
          const decisionId = crypto.randomUUID();
          const cancel = () => { void broker.call(session.target.windowId, "cancelAssistantConsent", { session, decisionId }).catch(() => undefined); };
          signal?.addEventListener("abort", cancel, { once: true });
          try { return await broker.call(session.target.windowId, "assistantConsent", { session, decisionId, platform }); }
          finally { signal?.removeEventListener("abort", cancel); }
        } }),
        end: touchedIds => broker.call(session.target.windowId, "assistantEnd", { session, touchedIds: [...touchedIds] })
      };
      return binding;
    }
  };
}
