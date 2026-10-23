import { adoptDerivedDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { getAssistantHistoryPort, type AssistantHistoryPort } from "./historyPort";

export interface BeginAssistantTransaction {
  pluginId: string;
  runId: string;
  /** The user's request, before the host adds its label prefix. */
  label: string;
  tabId: string;
  sendSelection: { objectIds: readonly string[]; pageId?: string };
}

interface Transaction extends BeginAssistantTransaction {
  snapshot?: ChemDraftDocument;
  label: string;
  touched: Set<string>;
  openEntry: boolean;
  writes: number;
  split: boolean;
  ended: boolean;
  interrupted: boolean;
  after?: WeakRef<ChemDraftDocument>;
}

export interface AssistantTransactionResult {
  split: boolean;
  touchedIds: string[];
}

export class AssistantTransactions {
  private readonly transactions = new Map<string, Transaction>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly port: AssistantHistoryPort) {}

  private watchEdits(): void {
    this.unsubscribe ??= this.port.onUserEdit(tabId => {
      for (const tx of this.transactions.values()) {
        if (tx.tabId !== tabId || tx.ended) continue;
        if (tx.openEntry) tx.split = true;
        tx.openEntry = false;
        tx.interrupted = true;
        tx.snapshot = undefined;
      }
    });
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.transactions.clear(); }

  beginAssistantTransaction(input: BeginAssistantTransaction): string {
    for (const tx of this.transactions.values()) {
      if (!tx.ended && tx.tabId === input.tabId) throw new Error("An assistant request is already running in this tab.");
    }
    const snapshot = structuredClone(this.document(input.tabId));
    const txId = crypto.randomUUID();
    this.transactions.set(txId, {
      ...input, sendSelection: structuredClone(input.sendSelection), snapshot,
      label: `ChemDraft Assistant: ${input.label.slice(0, 60)}`,
      touched: new Set(), openEntry: false, writes: 0, split: false, ended: false, interrupted: false
    });
    this.watchEdits();
    // Retain only recent completed requests for the transcript's Undo button.
    const completed = [...this.transactions].filter(([, tx]) => tx.ended);
    for (const [id] of completed.slice(0, -100)) this.transactions.delete(id);
    return txId;
  }

  activeTransactionForPlugin(pluginId: string, tabId?: string): string | undefined {
    return [...this.transactions].find(([, tx]) => !tx.ended && tx.pluginId === pluginId &&
      (tabId === undefined || tx.tabId === tabId))?.[0];
  }

  /** Call only after the host has validated the patch and fixed write scope. No tool is retained. */
  writeAssistantTransaction(txId: string, after: ChemDraftDocument, touchedIds: readonly string[] = []): void {
    const tx = this.running(txId);
    const current = this.document(tx.tabId);
    if (after === current) return;
    const previous = new Map(current.pages.flatMap(page => page.objects.map(object => [object.id, object] as const)));
    for (const object of after.pages.flatMap(page => page.objects)) {
      const before = previous.get(object.id);
      if (before !== object && JSON.stringify(before) !== JSON.stringify(object)) tx.touched.add(object.id);
    }
    for (const id of touchedIds) tx.touched.add(id);
    // Select cumulatively on every write, so even an interrupted entry records its own selection.
    const selected = withTouchedSelection(after, tx.touched);
    if (tx.openEntry) this.port.amend(tx.tabId, selected, tx.label);
    else this.port.push(tx.tabId, tx.writes === 0 && !tx.interrupted ? tx.snapshot ?? current : current, selected, tx.label);
    tx.openEntry = true;
    tx.writes += 1;
    tx.snapshot = undefined; // History now owns the baseline; do not defeat its memory budget.
    tx.after = new WeakRef(this.document(tx.tabId));
  }

  endAssistantTransaction(txId: string, { touchedIds }: { touchedIds: readonly string[] }): AssistantTransactionResult {
    const tx = this.running(txId);
    const current = this.document(tx.tabId);
    for (const id of touchedIds) tx.touched.add(id);
    const selected = withTouchedSelection(current, tx.touched).selection.objectIds;
    // A user's edit after our last write owns the current entry and selection.
    if (tx.openEntry) {
      this.port.select(tx.tabId, selected, tx.label);
      tx.after = new WeakRef(this.document(tx.tabId));
    }
    tx.ended = true;
    tx.snapshot = undefined;
    if (![...this.transactions.values()].some(candidate => !candidate.ended)) {
      this.unsubscribe?.(); this.unsubscribe = undefined;
    }
    return { split: tx.split, touchedIds: selected };
  }

  undoOwnTransaction(txId: string): boolean {
    const tx = this.transactions.get(txId);
    const after = tx?.after?.deref();
    if (!tx?.ended || !after || tx.split) return false;
    return this.port.undo(tx.tabId, after);
  }

  private document(tabId: string): ChemDraftDocument {
    const document = this.port.read(tabId);
    if (!document) throw new Error("The assistant's document tab is closed; write refused.");
    return document;
  }

  private running(txId: string): Transaction {
    const tx = this.transactions.get(txId);
    if (!tx || tx.ended) throw new Error("The assistant transaction is no longer running.");
    return tx;
  }
}

function withTouchedSelection(document: ChemDraftDocument, ids: ReadonlySet<string>): ChemDraftDocument {
  const page = document.pages.find(candidate => candidate.objects.some(object => ids.has(object.id))) ??
    document.pages.find(candidate => candidate.id === document.selection.pageId) ?? document.pages[0];
  const existing = new Set(document.pages.flatMap(candidate => candidate.objects.map(object => object.id)));
  return adoptDerivedDocument(document, { ...document,
    selection: { ...(page ? { pageId: page.id } : {}), objectIds: [...ids].filter(id => existing.has(id)) } });
}

const managers = new WeakMap<AssistantHistoryPort, AssistantTransactions>();
export function getAssistantTransactions(port = getAssistantHistoryPort()): AssistantTransactions {
  let manager = managers.get(port);
  if (!manager) { manager = new AssistantTransactions(port); managers.set(port, manager); }
  return manager;
}

export const beginAssistantTransaction = (input: BeginAssistantTransaction): string =>
  getAssistantTransactions().beginAssistantTransaction(input);
export const writeAssistantTransaction = (txId: string, after: ChemDraftDocument, touchedIds?: readonly string[]): void =>
  getAssistantTransactions().writeAssistantTransaction(txId, after, touchedIds);
export const endAssistantTransaction = (txId: string, result: { touchedIds: readonly string[] }): AssistantTransactionResult =>
  getAssistantTransactions().endAssistantTransaction(txId, result);
export const undoOwnTransaction = (txId: string): boolean => getAssistantTransactions().undoOwnTransaction(txId);
