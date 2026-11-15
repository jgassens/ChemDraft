import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { AppliedPatchReceipt } from "@chemdraft/plugin-api";
import { assertPluginPatchWriteScope, type PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { assistantDocumentContentUnchanged } from "../assistant/historyPort";
import {
  applyPluginDocumentPatch, type AppliedPluginDocumentPatch, type PluginPatchPlacementOptions,
  type PluginWriteGate
} from "./applyPluginDocumentPatch";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import type { RuntimeInvocationReference } from "./runtimeBrokerProtocol";

export interface RuntimeWritePreparation {
  tabId: string;
  before: ChemDraftDocument;
  applied: AppliedPluginDocumentPatch;
  proposed: ChemDraftDocument;
  application: PluginPatchApplicationRequest;
  /** Includes the drawing incarnation, command cancellation and content preconditions. */
  isCurrent(): boolean;
}

export interface RuntimeDocumentPortOptions extends Pick<RuntimeDocumentPort,
  "assistant" | "windowId" | "commandRegistry" | "activeTabId" | "read" | "selection" | "viewportRect"> {
  assertWritable(): void;
  getWriteGate(): PluginWriteGate | undefined;
  placement(tabId: string, before: ChemDraftDocument, application: PluginPatchApplicationRequest): PluginPatchPlacementOptions;
  normalize(document: ChemDraftDocument): ChemDraftDocument;
  willWrite?(tabId: string, application: PluginPatchApplicationRequest): void;
  /** All callbacks stay in the committing document. Only application data crosses the broker.
   * Invoke accept synchronously after the final page-fit/consent wait, exactly once. */
  prepare(write: RuntimeWritePreparation, accept: (document: ChemDraftDocument) => void): void | Promise<void>;
  commit(write: RuntimeWritePreparation, document: ChemDraftDocument, invocation: RuntimeInvocationReference): void;
  didCommit?(write: RuntimeWritePreparation): void;
}

/** The real desktop application path shared by the document broker and the pre-cutover caller.
 * The broker's commit callback performs its independent invocation/scope recheck. This port also
 * retains the desktop's content/page-fit preconditions, with no await before history mutation. */
export function createRuntimeDocumentPort(options: RuntimeDocumentPortOptions): RuntimeDocumentPort {
  const prepared = new WeakMap<PluginPatchApplicationRequest,
    { write: RuntimeWritePreparation; document: ChemDraftDocument }>();
  const read = (tabId: string) => {
    const state = options.read(tabId);
    if (!state) throw new Error("The plugin command's document tab was closed; nothing was inserted.");
    return state;
  };
  const port: RuntimeDocumentPort = {
    assistant: options.assistant,
    windowId: options.windowId,
    commandRegistry: options.commandRegistry,
    activeTabId: options.activeTabId,
    read: options.read,
    selection: options.selection,
    viewportRect: options.viewportRect,
    async runWrite<T>(tabId: string, commit: () => T, application: PluginPatchApplicationRequest): Promise<T> {
      options.assertWritable();
      const documentKey = read(tabId).documentKey;
      options.willWrite?.(tabId, application);
      const gate = options.getWriteGate();
      if (!gate) throw new Error("The document window is closing; nothing was inserted.");
      const current = () => {
        application.signal?.throwIfAborted();
        options.assertWritable();
        const state = read(tabId);
        if (state.documentKey !== documentKey) {
          throw new Error("The document changed while the plugin was running; nothing was inserted.");
        }
        return state.document;
      };
      return await gate.run(async () => {
        const before = current();
        assertPluginPatchWriteScope(before, application.patch, application.writeScopeObjectIds);
        const applied = applyPluginDocumentPatch(before, application.patch, options.placement(tabId, before, application));
        const proposed = options.normalize(applied.document);
        const write: RuntimeWritePreparation = { tabId, before, applied, proposed, application,
          isCurrent: () => {
            try { return assistantDocumentContentUnchanged(before, current()); }
            catch { return false; }
          } };
        let accepted = false;
        let result!: T;
        await options.prepare(write, document => {
          if (accepted) throw new Error("The prepared plugin write was already committed.");
          accepted = true;
          prepared.set(application, { write, document });
          try { result = commit(); }
          finally { prepared.delete(application); }
        });
        if (!accepted) throw new Error("The plugin write was not committed; nothing was inserted.");
        options.didCommit?.(write);
        return result;
      });
    },
    commit: (tabId, before, application, invocation): AppliedPatchReceipt => {
      const pending = prepared.get(application);
      if (!pending || pending.write.tabId !== tabId || invocation.target.windowId !== options.windowId ||
        invocation.target.tabId !== tabId || invocation.documentKey !== read(tabId).documentKey ||
        invocation.pluginId !== application.plugin.id || invocation.commandId !== application.command.id) {
        throw new Error("The plugin write has no matching prepared document commit.");
      }
      application.signal?.throwIfAborted();
      options.assertWritable();
      if (!pending.write.isCurrent() || !assistantDocumentContentUnchanged(before, read(tabId).document)) {
        throw new Error("The document changed while the plugin prepared its write; nothing was inserted.");
      }
      assertPluginPatchWriteScope(read(tabId).document, application.patch, application.writeScopeObjectIds);
      // No asynchronous call may be introduced between these checks and the history commit.
      options.commit(pending.write, pending.document, invocation);
      return pending.write.applied.receipt;
    }
  };
  return port;
}

/** Temporary local caller while runtime ownership is cut over. The host still performs all its
 * permission, invocation-lifetime and scope checks; this uses the same port as broker writes. */
export function applyRuntimeDocumentPatch(port: RuntimeDocumentPort, application: PluginPatchApplicationRequest): Promise<AppliedPatchReceipt> {
  const tabId = port.activeTabId();
  const state = port.read(tabId);
  if (!state) throw new Error("The plugin command's document tab was closed; nothing was inserted.");
  const invocation: RuntimeInvocationReference = { id: crypto.randomUUID(), target: { windowId: port.windowId, tabId },
    documentKey: state.documentKey, pluginId: application.plugin.id, commandId: application.command.id };
  return port.runWrite(tabId, () => {
    const current = port.read(tabId);
    if (!current || current.documentKey !== invocation.documentKey) {
      throw new Error("The document changed while the plugin was running; nothing was inserted.");
    }
    return port.commit(tabId, current.document, application, invocation);
  }, application);
}
