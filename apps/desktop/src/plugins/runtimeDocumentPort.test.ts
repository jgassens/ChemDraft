import { applyPatch, createEmptyDocument, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { CommandRegistry, type PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrawingIncarnations } from "../documentIdentity";
import { createPluginWriteGate } from "./applyPluginDocumentPatch";
import { applyRuntimeDocumentPatch, createRuntimeDocumentPort, type RuntimeWritePreparation } from "./runtimeDocumentPort";

const caption = (id: string): TextObject => ({ id, type: "text", text: id, spans: [],
  x: 30, y: 40, width: 100, height: 20, rotation: 0, style: {} });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

function fixture() {
  const initial = createEmptyDocument({ now: "2026-11-10T00:00:00Z" });
  const inserted = applyPatch(initial, { op: "addObject", pageId: initial.pages[0]!.id, object: caption("selected") });
  const before = applyPatch(inserted, { op: "setSelection", pageId: initial.pages[0]!.id, objectIds: ["selected"] });
  let document = before;
  let busy = false;
  let writable = true;
  const keys = new DrawingIncarnations();
  const gate = createPluginWriteGate({ isGestureActive: () => busy });
  cleanup.push(() => gate.dispose());
  const history: Array<{ before: ChemDraftDocument; after: ChemDraftDocument; label: string }> = [];
  const commit = vi.fn((write: RuntimeWritePreparation, after: ChemDraftDocument) => {
    history.push({ before: document, after, label: write.application.undoLabel });
    document = after;
  });
  let prepare = (write: RuntimeWritePreparation, accept: (document: ChemDraftDocument) => void): void | Promise<void> => accept(write.proposed);
  const port = createRuntimeDocumentPort({
    windowId: "main", commandRegistry: new CommandRegistry(), activeTabId: () => "source",
    read: tab => tab === "source" ? { document, documentKey: keys.key(tab) } : undefined,
    selection: () => ({ objectIds: document.selection.objectIds, molecules: [] }),
    getWriteGate: () => gate,
    assertWritable: () => { if (!writable) throw new Error("The document is closing."); },
    placement: () => ({}), normalize: document => document,
    prepare: (write, accept) => prepare(write, accept), commit
  });
  const application = (): PluginPatchApplicationRequest => ({
    plugin: { id: "org.test.broker", name: "Broker", version: "1" }, command: { id: "plugin.broker.run", title: "Run" },
    undoLabel: "Broker: Run", writeScopeObjectIds: ["selected"],
    patch: ProposedDocumentPatchSchema.parse({ reason: "Move caption", patch: { op: "moveObject", objectId: "selected", x: 70, y: 90 } })
  });
  return { port, application, keys, gate, history, commit, read: () => document,
    setDocument: (next: ChemDraftDocument) => { document = next; },
    setBusy: (next: boolean) => { busy = next; }, setWritable: (next: boolean) => { writable = next; },
    setPreparation: (next: typeof prepare) => { prepare = next; } };
}

describe("drawing incarnations", () => {
  it("survives edits/activation and never revives after replacement, removal or reuse of an id", () => {
    const keys = new DrawingIncarnations();
    const a = keys.key("a"), b = keys.key("b");
    expect(keys.key("a")).toBe(a); expect(keys.key("b")).toBe(b);
    keys.replace("a"); expect(keys.key("a")).not.toBe(a); expect(keys.key("b")).toBe(b);
    keys.remove("b"); expect(keys.key("b")).not.toBe(b);
  });
});

describe("real document write port", () => {
  it("uses the existing application/selection path and records exactly one labelled history entry", async () => {
    const f = fixture(), before = f.read();
    await expect(applyRuntimeDocumentPatch(f.port, f.application())).resolves.toEqual({ applied: true, objectIds: ["selected"] });
    expect(f.history).toHaveLength(1);
    expect(f.history[0]).toEqual({ before, after: f.read(), label: "Broker: Run" });
    expect(f.read().selection.objectIds).toEqual(["selected"]);
    expect(f.read().pages[0]!.objects[0]).toMatchObject({ x: 70, y: 90 });
  });

  it("prepares against the final gesture result, rather than the snapshot at enqueue time", async () => {
    const f = fixture(); f.setBusy(true);
    const work = applyRuntimeDocumentPatch(f.port, f.application());
    f.setDocument(applyPatch(f.read(), { op: "updateObject", objectId: "selected", changes: { text: "User edit" } }));
    f.setBusy(false); f.gate.flush();
    await work;
    expect(f.read().pages[0]!.objects[0]).toMatchObject({ text: "User edit", x: 70 });
    expect(f.history[0]!.before.pages[0]!.objects[0]).toMatchObject({ text: "User edit", x: 30 });
  });

  it.each(["replacement", "content edit", "abort", "quit", "indirect scope"] as const)("rechecks after asynchronous page preparation: %s", async change => {
    const f = fixture(), waiting = deferred(), resume = deferred(), stop = new AbortController();
    f.setPreparation(async (write, accept) => { waiting.resolve(); await resume.promise; accept(write.proposed); });
    const application = f.application();
    application.signal = stop.signal;
    const work = applyRuntimeDocumentPatch(f.port, application);
    await waiting.promise;
    if (change === "replacement") f.keys.replace("source");
    else if (change === "content edit") f.setDocument(applyPatch(f.read(), { op: "updateObject", objectId: "selected", changes: { text: "User edit" } }));
    else if (change === "abort") stop.abort();
    else if (change === "quit") f.setWritable(false);
    else {
      // Core removal would rewrite an unselected reaction reference too.
      application.patch = ProposedDocumentPatchSchema.parse({ reason: "Remove", patch: { op: "removeObject", objectId: "selected" } });
      f.setDocument(applyPatch(f.read(), { op: "addObject", pageId: f.read().pages[0]!.id,
        object: { id: "reaction", type: "reaction", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {},
          components: [{ objectId: "selected", role: "reactant" }], conditionsTextObjectIds: [], mappingState: "absent" } }));
    }
    resume.resolve();
    await expect(work).rejects.toThrow();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("refuses direct commits outside the local prepared-write callback", () => {
    const f = fixture(), application = f.application();
    expect(() => f.port.commit("source", f.read(), application, { id: "forged", target: { windowId: "main", tabId: "source" },
      documentKey: f.keys.key("source"), pluginId: application.plugin.id, commandId: application.command.id }))
      .toThrow("matching prepared document commit");
    expect(f.commit).not.toHaveBeenCalled();
  });
});
