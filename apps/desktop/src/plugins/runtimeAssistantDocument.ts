import { applyPatch } from "@chemdraft/chem-core";
import { assertPluginPatchWriteScope, DirectWritePatchOps, writePatchOps } from "@chemdraft/plugin-host";
import { applyAssistantPageGrowth } from "../assistant/pageGrowthWrite";
import type { AssistantHistoryPort } from "../assistant/historyPort";
import { assistantDocumentContentUnchanged } from "../assistant/historyPort";
import type { AssistantTransactions } from "../assistant/assistantTransaction";
import { recheckNormalizedAssistantWrite } from "../assistant/normalizedWrite";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { PluginWriteGateTimeoutError } from "./applyPluginDocumentPatch";
import { RuntimeBroker } from "./runtimeBroker";
import type { RuntimeInvocationReference } from "./runtimeBrokerProtocol";
import type { RuntimeAssistantSession, RuntimeAssistantSnapshot } from "./runtimeAssistantProtocol";

export interface RuntimeAssistantDocumentPort {
  history: AssistantHistoryPort;
  transactions: AssistantTransactions;
  assertWritable(): void;
}

/** History, consent, gesture gate and the final mutation belong to the captured document window.
 * The runtime can prepare data, never install an undo callback or replace the local manager. */
export function bindRuntimeAssistantDocument(broker: RuntimeBroker, port: RuntimeDocumentPort,
  capture: (ref: RuntimeInvocationReference) => readonly string[]) {
  const sessions = new Map<string, { session: RuntimeAssistantSession; scope: Set<string>; ended: boolean;
    pending: Map<string, AbortController>; writes: Promise<void> }>();
  const authority = (writable = true) => {
    if (!port.assistant) throw new Error("The document window provides no assistant history port.");
    if (writable) port.assistant.assertWritable();
    return port.assistant;
  };
  const current = (session: RuntimeAssistantSession, ended = false) => {
    const binding = sessions.get(session.requestId);
    if (!binding || JSON.stringify(binding.session) !== JSON.stringify(session) || (binding.ended && !ended)) {
      throw new Error("The assistant request has ended or belongs to another document target.");
    }
    const state = port.read(session.target.tabId);
    if (session.target.windowId !== port.windowId || !state || state.documentKey !== session.documentKey) {
      throw new Error("The assistant's document tab is closed or replaced; write refused.");
    }
    return { binding, state };
  };
  const snapshot = (session: RuntimeAssistantSession): RuntimeAssistantSnapshot => ({
    document: current(session).state.document, viewport: port.viewportRect?.(session.target.tabId)
  });
  const stops = [
    broker.handle("assistantBegin", ({ invocation, label }) => {
      const selection = [...capture(invocation)];
      const local = authority();
      const requestId = local.transactions.beginAssistantTransaction({ pluginId: invocation.pluginId,
        runId: crypto.randomUUID(), tabId: invocation.target.tabId, label, sendSelection: { objectIds: selection } });
      const session = { requestId, pluginId: invocation.pluginId, documentKey: invocation.documentKey, target: invocation.target };
      sessions.set(requestId, { session, scope: new Set(selection), ended: false, pending: new Map(), writes: Promise.resolve() });
      const completed = [...sessions].filter(([, binding]) => binding.ended);
      for (const [id] of completed.slice(0, -100)) sessions.delete(id);
      return { session, snapshot: snapshot(session), selection };
    }),
    broker.handle("assistantRead", snapshot),
    broker.handle("assistantWrite", async ({ session, writeId, plan }) => {
      const local = authority();
      const { binding } = current(session);
      if (binding.pending.has(writeId)) throw new Error("This assistant write is already pending.");
      const abort = new AbortController();
      binding.pending.set(writeId, abort);
      const check = () => {
        abort.signal.throwIfAborted();
        authority();
        const { state } = current(session);
        for (const op of writePatchOps(plan.patch)) {
          if (!(DirectWritePatchOps as readonly string[]).includes(op.op)) throw new Error(`Unsupported assistant write: ${op.op}.`);
        }
        assertPluginPatchWriteScope(state.document, { patch: plan.patch, reason: "Assistant", warnings: [], requiresUserApproval: true }, [...binding.scope]);
        return state.document;
      };
      const previousWrite = binding.writes;
      let release!: () => void;
      binding.writes = new Promise<void>(resolve => { release = resolve; });
      try {
        await previousWrite;
        check();
        if (!local.history.runWrite) throw new Error("The document window provides no assistant write gate.");
        return await local.history.runWrite(async () => {
          const before = check();
          const prepared = await broker.call("runtime", "prepareAssistantWrite", { session, writeId, snapshot: snapshot(session) });
          return await local.history.runWrite!(() => {
            const latest = check();
            if (!assistantDocumentContentUnchanged(before, latest)) {
              throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
            }
            const scope = new Set(binding.scope);
            for (const op of writePatchOps(plan.patch)) {
              if (op.op === "addObject") scope.add(op.object.id);
              if (op.op === "addAnnotation") scope.add(op.annotation.id);
            }
            const normalized = recheckNormalizedAssistantWrite(latest, applyPatch(latest, plan.patch), scope,
              plan.verified, plan.plannedDocument);
            if (!assistantDocumentContentUnchanged(normalized, prepared.selectionDocument)) {
              throw new Error("The assistant write does not match its checked document preparation.");
            }
            // The owner already checked chemistry, dependencies, page consent and plugin permissions.
            // These local checks repeat the scope/normalization/lifetime checks after the final await.
            const after = applyAssistantPageGrowth(latest, normalized, plan.growth);
            if (!assistantDocumentContentUnchanged(after, prepared.after)) {
              throw new Error("The assistant write does not match its checked page preparation.");
            }
            const touched = writePatchOps(plan.patch).flatMap(op => op.op === "addObject" ? [op.object.id] :
              op.op === "addAnnotation" ? [op.annotation.id] : "objectId" in op ? [op.objectId] : op.op === "setObjectOrder" ? op.objectIds : []);
            if (JSON.stringify(touched) !== JSON.stringify(prepared.touchedIds)) throw new Error("The assistant write has inconsistent touched ids.");
            local.transactions.writeAssistantTransaction(session.requestId, after, touched, normalized);
            for (const id of prepared.touchedIds) binding.scope.add(id);
            return snapshot(session);
          });
        });
      } catch (error) {
        if (error instanceof PluginWriteGateTimeoutError) throw new Error("The drawing is being edited; try again");
        throw error;
      } finally { release(); binding.pending.delete(writeId); }
    }),
    broker.handle("cancelAssistantWrite", ({ session, writeId }) => { current(session, true).binding.pending.get(writeId)?.abort(); return null; }),
    broker.handle("assistantConsent", async ({ session, decisionId, platform }) => {
      const { binding } = current(session);
      const abort = new AbortController();
      if (binding.pending.has(decisionId)) throw new Error("This assistant decision is already pending.");
      binding.pending.set(decisionId, abort);
      try { return await authority().transactions.pageEnlargementConsent(session.requestId, platform).confirm(abort.signal); }
      finally { binding.pending.delete(decisionId); }
    }),
    broker.handle("cancelAssistantConsent", ({ session, decisionId }) => { current(session, true).binding.pending.get(decisionId)?.abort(); return null; }),
    broker.handle("assistantEnd", ({ session, touchedIds }) => {
      const { binding } = current(session);
      binding.ended = true;
      binding.pending.forEach(abort => abort.abort());
      return authority(false).transactions.endAssistantTransaction(session.requestId, { touchedIds });
    }),
    broker.handle("assistantUndo", session => { current(session, true); return authority(false).transactions.undoOwnTransaction(session.requestId); })
  ];
  return Object.assign(() => {
    for (const stop of stops) stop();
    for (const { session, ended, pending } of sessions.values()) {
      pending.forEach(abort => abort.abort());
      if (!ended) { try { port.assistant?.transactions.endAssistantTransaction(session.requestId, { touchedIds: [] }); } catch { /* Closed tab. */ } }
    }
    sessions.clear();
  }, {
    scope(session: RuntimeAssistantSession): readonly string[] { return [...current(session).binding.scope]; },
    recordApplied(invocation: RuntimeInvocationReference, objectIds: readonly string[]) {
      for (const { session, scope, ended } of sessions.values()) {
        if (!ended && session.pluginId === invocation.pluginId && session.documentKey === invocation.documentKey &&
          session.target.windowId === invocation.target.windowId && session.target.tabId === invocation.target.tabId) {
          for (const id of objectIds) scope.add(id);
        }
      }
    }
  });
}
