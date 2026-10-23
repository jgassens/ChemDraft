import { describe, expect, it, vi } from "vitest";
import {
  applyPatch, createEmptyDocument, createDocumentHistory, undo, redo,
  type TextObject
} from "@chemdraft/chem-core";
import { AssistantTransactions } from "./assistantTransaction";
import type { AssistantHistoryPort } from "./historyPort";

function text(id: string): TextObject {
  return { id, type: "text", x: 50, y: 60, width: 100, height: 20, rotation: 0, style: {}, text: id, spans: [] };
}

function fixture() {
  let history = createDocumentHistory(createEmptyDocument({ now: "2026-10-22T00:00:00Z" }));
  let closed = false;
  const listeners = new Set<(tabId: string) => void>();
  const requireOpen = () => { if (closed) throw new Error("closed"); };
  const port: AssistantHistoryPort = {
    read: tab => !closed && tab === "tab" ? history.present : undefined,
    push: (_tab, before, after) => { requireOpen(); history = { past: [...history.past, before], present: after, future: [] }; },
    amend: (_tab, after) => { requireOpen(); history = { ...history, present: after }; },
    select: (_tab, ids) => { history = { ...history, present: { ...history.present, selection: { pageId: history.present.pages[0].id, objectIds: [...ids] } } }; },
    onUserEdit: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    undo: (_tab, expected) => { if (history.present !== expected || !history.past.length) return false; history = undo(history); return true; }
  };
  const transactions = new AssistantTransactions(port);
  const begin = (label = "Draw three captions") => transactions.beginAssistantTransaction({
    pluginId: "assistant", runId: "run", label, tabId: "tab", sendSelection: { objectIds: [] }
  });
  const add = (tx: string, id: string) => transactions.writeAssistantTransaction(tx,
    applyPatch(history.present, { op: "addObject", pageId: history.present.pages[0].id, object: text(id) }));
  return {
    transactions, begin, add, port,
    history: () => history,
    close: () => { closed = true; },
    userEdit: () => {
      for (const listener of listeners) listener("tab");
      history = { past: [...history.past, history.present], present: { ...history.present, title: "User edit" }, future: [] };
    },
    undo: () => { history = undo(history); },
    redo: () => { history = redo(history); }
  };
}

describe("assistant request history", () => {
  it("groups three writes into one entry; undo restores the exact snapshot", () => {
    const f = fixture();
    const before = structuredClone(f.history().present);
    const tx = f.begin();
    for (const id of ["one", "two", "three"]) f.add(tx, id);
    const result = f.transactions.endAssistantTransaction(tx, { touchedIds: [] });
    expect(result).toEqual({ split: false, touchedIds: ["one", "two", "three"] });
    expect(f.history().past).toHaveLength(1);
    f.undo();
    expect(f.history().present).toEqual(before);
  });

  it("redo makes no provider or tool call and restores the same ids, contents and selection", async () => {
    const f = fixture();
    const provider = { run: vi.fn(async () => {
      const tx = f.begin();
      for (const id of ["one", "two", "three"]) tool.apply(tx, id);
      f.transactions.endAssistantTransaction(tx, { touchedIds: [] });
    }) };
    const tool = { apply: vi.fn(f.add) };
    await provider.run();
    const final = structuredClone(f.history().present);
    provider.run.mockClear(); tool.apply.mockClear();
    f.undo(); f.redo();
    expect(f.history().present).toEqual(final);
    expect(provider.run).not.toHaveBeenCalled();
    expect(tool.apply).not.toHaveBeenCalled();
  });

  it("splits around a user edit without undoing that edit in the later segment", () => {
    const f = fixture();
    const tx = f.begin(); f.add(tx, "one"); f.userEdit();
    const userState = structuredClone(f.history().present);
    f.add(tx, "two"); f.add(tx, "three");
    expect(f.transactions.endAssistantTransaction(tx, { touchedIds: [] }).split).toBe(true);
    expect(f.history().past).toHaveLength(3);
    f.undo(); expect(f.history().present).toEqual(userState);
  });

  it("preserves user edits made before the first write", () => {
    const f = fixture(); const tx = f.begin(); f.userEdit();
    const userState = structuredClone(f.history().present);
    f.add(tx, "one"); f.undo(); expect(f.history().present).toEqual(userState);
  });

  it("refuses writes and completion after the bound tab closes", () => {
    const f = fixture(); const tx = f.begin(); const after = structuredClone(f.history().present);
    f.close();
    expect(() => f.transactions.writeAssistantTransaction(tx, after)).toThrow(/tab is closed/);
    expect(() => f.transactions.endAssistantTransaction(tx, { touchedIds: [] })).toThrow(/tab is closed/);
    expect(() => f.begin()).toThrow();
    expect(f.history().past).toHaveLength(0);
  });

  it("labels the entry with exactly the first 60 request characters on push and amendment", () => {
    const f = fixture(); const push = vi.spyOn(f.port, "push"); const amend = vi.spyOn(f.port, "amend");
    const select = vi.spyOn(f.port, "select");
    const label = "a".repeat(60) + "omitted";
    const tx = f.begin(label); f.add(tx, "one"); f.add(tx, "two");
    f.transactions.endAssistantTransaction(tx, { touchedIds: [] });
    expect(push.mock.calls[0]?.[3]).toBe(`ChemDraft Assistant: ${"a".repeat(60)}`);
    expect(amend.mock.calls[0]?.[2]).toBe(push.mock.calls[0]?.[3]);
    expect(select.mock.calls[0]?.[2]).toBe(push.mock.calls[0]?.[3]);
  });

  it("selects changed and created objects, excluding removed and missing ids", () => {
    const f = fixture(); const tx = f.begin(); f.add(tx, "one"); f.add(tx, "two");
    const changed = applyPatch(f.history().present, { op: "updateObject", objectId: "two", changes: { text: "updated" } });
    f.transactions.writeAssistantTransaction(tx, changed);
    f.transactions.writeAssistantTransaction(tx, applyPatch(f.history().present, { op: "removeObject", objectId: "one" }));
    expect(f.transactions.endAssistantTransaction(tx, { touchedIds: ["one", "missing"] }).touchedIds).toEqual(["two"]);
    expect(f.history().present.selection.objectIds).toEqual(["two"]);
  });

  it("does not add an entry for a read-only request and refuses writes after end", () => {
    const f = fixture(); const tx = f.begin();
    f.transactions.endAssistantTransaction(tx, { touchedIds: [] });
    expect(f.history().past).toHaveLength(0);
    expect(() => f.add(tx, "late")).toThrow(/no longer running/);
  });

  it("Undo this request only restores a completed, newest, unsplit request", () => {
    const f = fixture(); const before = structuredClone(f.history().present);
    const tx = f.begin(); f.add(tx, "one");
    expect(f.transactions.undoOwnTransaction(tx)).toBe(false);
    f.transactions.endAssistantTransaction(tx, { touchedIds: [] });
    expect(f.transactions.undoOwnTransaction(tx)).toBe(true);
    expect(f.history().present).toEqual(before);
    expect(f.transactions.undoOwnTransaction(tx)).toBe(false);
    f.redo(); f.userEdit(); expect(f.transactions.undoOwnTransaction(tx)).toBe(false);
  });
});
