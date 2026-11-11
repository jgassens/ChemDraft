// @vitest-environment jsdom
import { applyPatch, createDocumentHistory, createEmptyDocument, redo, undo, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { createLocalPluginRuntimeSession } from "./localPluginRuntime";
import { createPluginRuntimeOwner, type PluginRuntimeOwner } from "./pluginRuntimeOwner";
import { applyAcceptedPluginProposal } from "./applyPluginDocumentPatch";
import { RuntimeBroker } from "./runtimeBroker";
import { bindRuntimeCoreCommands, RuntimeCoreCommandRegistry } from "./runtimeCoreCommands";
import type { RuntimeMessage, RuntimeTransport } from "./runtimeBrokerProtocol";
import type { RuntimeViewClient } from "./runtimeViewClient";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
class AsyncChannels extends RuntimeTestChannels {
  remote = false;
  intercept?: (sender: string, recipient: string, message: RuntimeMessage) => boolean;
  override transport(label: string): RuntimeTransport {
    const transport = super.transport(label), channels = this;
    return { ...transport, get immediate() { return !channels.remote; },
      send: (recipient, message) => {
        if (channels.intercept?.(label, recipient, structuredClone(message))) return Promise.resolve();
        return channels.remote ? Promise.resolve().then(() => transport.send(recipient, message)) : transport.send(recipient, message);
      } };
  }
}
const caption: TextObject = { id: "caption", type: "text", text: "Reviewed", spans: [],
  x: 40, y: 50, width: 100, height: 20, rotation: 0, style: {} };

function retained(client: RuntimeViewClient) {
  const caches = client as unknown as { preparations: Map<string, unknown>; proposalReceipts: Map<string, unknown>;
    committedProposals: Map<string, unknown> };
  return [caches.preparations.size, caches.proposalReceipts.size, caches.committedProposals.size];
}

async function fixture() {
  vi.stubGlobal("localStorage", new MemoryStorage());
  let document = createEmptyDocument({ now: "2026-11-10T00:00:00Z" });
  let drawingKey = "drawing", closed = false;
  let undoHistory = createDocumentHistory(document);
  const registry = new CommandRegistry();
  registry.register({ id: "edit.undo", title: "Undo" }, () => { undoHistory = undo(undoHistory); document = undoHistory.present; });
  registry.register({ id: "edit.redo", title: "Redo" }, () => { undoHistory = redo(undoHistory); document = undoHistory.present; });
  const initial = document, channels = new AsyncChannels();
  let owner!: PluginRuntimeOwner;
  const providers = { commandRegistry: registry, getActiveDocument: () => closed ? undefined : document,
    getActiveDocumentKey: () => drawingKey, getActiveDocumentTab: () => ({ id: "tab-a" }), getDocumentTabTitle: () => "Drawing",
    getSelection: () => ({ objectIds: [], molecules: [] }) };
  const session = createLocalPluginRuntimeSession(providers, providers => {
      owner = createPluginRuntimeOwner(providers);
      owner.runtime.registerPlugin({ id: "org.test.proposal", name: "Proposal", version: "1", apiVersion: "^0.1.25", entry: "test.js",
        permissions: ["document.proposePatch"], contributes: { commands: [{ id: "plugin.proposal.run", title: "Propose" }] } },
      { commandHandlers: { "plugin.proposal.run": context => context.documents.proposePatch({ reason: "Reviewed caption",
        patch: { op: "addObject", pageId: "page_001", object: caption } }) } });
      return owner;
    }, channels);
  cleanup.push(() => session.dispose());
  await session.client.runtime.invokeCommand("plugin.proposal.run");
  const proposal = session.client.runtime.host.listProposedPatches("pending")[0]!;
  const history: Array<{ before: ChemDraftDocument; after: ChemDraftDocument; label: string }> = [];
  const commit = () => {
    const after = applyAcceptedPluginProposal(document, proposal.proposal, { now: "2026-11-10T00:00:00Z" }).document;
    undoHistory = { past: [...undoHistory.past, document], present: after, future: [] };
    history.push({ before: document, after, label: "Proposal: Apply Proposal" }); document = after;
  };
  return { session, owner, channels, initial, proposal, history, commit, read: () => document,
    replace: () => { drawingKey = "replacement"; document = initial; undoHistory = createDocumentHistory(initial); session.updateDocumentProviders(providers); },
    close: () => { closed = true; session.updateDocumentProviders(providers); } };
}

describe("remote proposal acceptance", () => {
  it.each(["lost", "delayed"])("reconciles a %s commit acknowledgement before allowing a retry", async acknowledgement => {
    const f = await fixture(); f.channels.remote = true;
    vi.useFakeTimers();
    let reply: RuntimeMessage | undefined;
    f.channels.intercept = (sender, _recipient, message) => {
      if (!reply && sender === "main" && message.kind === "response" && message.method === "commitProposal") {
        reply = message; return true;
      }
      return false;
    };
    const outcome = f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit).catch(error => error);
    await vi.waitFor(() => expect(f.history).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(300_001);
    await outcome;
    if (acknowledgement === "delayed") f.channels.deliver("runtime", "main", reply!);
    await f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit).catch(() => undefined);
    expect(f.history).toHaveLength(1);
    expect(f.read().pages[0]!.objects).toEqual([caption]);
    expect(f.read().selection.objectIds).toEqual([caption.id]);
    expect(f.owner.runtime.host.listProposedPatches("pending")).toEqual([]);
  });

  it("keeps an ambiguous reservation until a retry can reconcile the document receipt", async () => {
    const f = await fixture(); f.channels.remote = true;
    vi.useFakeTimers();
    f.channels.intercept = (sender, _recipient, message) => sender === "main" && message.kind === "response" && message.method === "commitProposal";
    const outcome = f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit).catch(error => error);
    await vi.waitFor(() => expect(f.history).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(600_001); await outcome;
    expect(retained(f.session.client)).toEqual([0, 1, 1]);
    expect(() => f.owner.runtime.host.rejectProposedPatch(f.proposal.id)).toThrow("already in progress");
    f.channels.intercept = undefined;
    await f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit);
    expect(f.history).toHaveLength(1);
    expect(f.owner.runtime.host.listProposedPatches("pending")).toEqual([]);
    expect(retained(f.session.client)).toEqual([0, 0, 0]);
  });

  it("revokes an undelivered commit during reconciliation so a late delivery cannot insert again", async () => {
    const f = await fixture(); f.channels.remote = true;
    vi.useFakeTimers();
    let held: RuntimeMessage | undefined;
    f.channels.intercept = (sender, _recipient, message) => {
      if (!held && sender === "runtime" && message.kind === "request" && message.method === "commitProposal") {
        held = message; return true;
      }
      return false;
    };
    const outcome = f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit).catch(error => error);
    await vi.waitFor(() => expect(held).toBeDefined());
    await vi.advanceTimersByTimeAsync(300_001); await outcome;
    expect(f.history).toHaveLength(0);
    await f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit);
    f.channels.deliver("main", "runtime", held!);
    expect(f.history).toHaveLength(1);
    // A settled preparation has been retired, so even its successful commit is now refused.
    const committed = f.channels.deliveries.find(({ message }) => message.kind === "request" && message.method === "commitProposal" &&
      !(message.payload as { reconcile?: true }).reconcile)!;
    f.channels.deliver("main", "runtime", { ...committed.message, id: "replay" });
    expect(f.history).toHaveLength(1);
    await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "response" &&
      message.id === "replay" && !message.ok)).toBe(true));
  });

  it("retires many successful and failed attempts without weakening replay protection or Undo", async () => {
    const f = await fixture(); f.channels.remote = true;
    const target = { windowId: "main", tabId: "tab-a" };
    for (let i = 0; i < 40; i++) {
      if (i) await f.session.client.runtime.invokeCommand("plugin.proposal.run");
      const proposal = f.session.client.runtime.host.listProposedPatches("pending")[0]!;
      // Several failed preparations of the same still-pending proposal must not accumulate.
      for (let j = 0; j < 3; j++) {
        await expect(f.session.client.runtime.acceptPreparedProposal(proposal.id, target, "drawing",
          () => { throw new Error("The drawing changed during review"); })).rejects.toThrow("drawing changed");
        expect(retained(f.session.client)).toEqual([0, 0, 0]);
      }
      if (i % 2) {
        f.owner.runtime.host.rejectProposedPatch(proposal.id);
      } else {
        const before = f.read();
        await f.session.client.runtime.acceptPreparedProposal(proposal.id, target, "drawing", f.commit);
        const after = f.read(), count = f.history.length;
        expect(retained(f.session.client)).toEqual([0, 0, 0]);
        await f.session.client.runtime.invokeCommand("edit.undo");
        expect(f.read()).toEqual(before);
        const delivered = f.channels.deliveries.filter(({ message }) => message.kind === "request" && message.method === "commitProposal").at(-1)!;
        f.channels.deliver("main", "runtime", { ...delivered.message, id: `settled-replay-${i}` });
        await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "response" &&
          message.id === `settled-replay-${i}` && !message.ok)).toBe(true));
        expect(f.read()).toEqual(before); expect(f.history).toHaveLength(count);
        await expect(f.session.client.runtime.acceptPreparedProposal(proposal.id, target, "drawing", f.commit)).rejects.toThrow();
        await f.session.client.runtime.invokeCommand("edit.redo");
        expect(f.read()).toEqual(after);
        await f.session.client.runtime.invokeCommand("edit.undo");
      }
      expect(retained(f.session.client)).toEqual([0, 0, 0]);
    }
    expect(f.history).toHaveLength(20);
    expect(f.owner.runtime.host.listProposedPatches()).toEqual([]);
  });

  it.each(["close", "replace"] as const)("revokes an undelivered preparation on drawing %s", async action => {
    const f = await fixture(); f.channels.remote = true;
    let held: RuntimeMessage | undefined;
    f.channels.intercept = (sender, _recipient, message) => {
      if (!held && sender === "runtime" && message.kind === "request" && message.method === "commitProposal") {
        held = message; return true;
      }
      return false;
    };
    const outcome = f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit).catch(error => error);
    await vi.waitFor(() => expect(held).toBeDefined());
    expect(retained(f.session.client)).toEqual([1, 0, 0]);
    f[action]();
    expect(retained(f.session.client)).toEqual([0, 0, 0]);
    f.channels.deliver("main", "runtime", held!);
    expect(await outcome).toBeInstanceOf(Error);
    expect(f.history).toEqual([]);
    expect(retained(f.session.client)).toEqual([0, 0, 0]);
  });

  it.each(["close", "replace"] as const)("retires an unresolved receipt on drawing %s and refuses stale deliveries", async action => {
    const f = await fixture(); f.channels.remote = true; vi.useFakeTimers();
    let commitRequest: RuntimeMessage | undefined;
    f.channels.intercept = (sender, _recipient, message) => {
      if (sender === "runtime" && message.kind === "request" && message.method === "commitProposal" &&
        !(message.payload as { reconcile?: boolean }).reconcile) commitRequest = message;
      return sender === "main" && message.kind === "response" && message.method === "commitProposal";
    };
    const outcome = f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit).catch(error => error);
    await vi.waitFor(() => expect(f.history).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(600_001); await outcome;
    expect(retained(f.session.client)).toEqual([0, 1, 1]);
    f.session.client.refreshProposalDocuments();
    expect(retained(f.session.client)).toEqual([0, 1, 1]);
    f[action]();
    expect(retained(f.session.client)).toEqual([0, 0, 0]);
    const before = f.read(); f.channels.intercept = undefined;
    f.channels.deliver("main", "runtime", { ...commitRequest!, id: "stale-drawing" });
    await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "response" &&
      message.id === "stale-drawing" && !message.ok)).toBe(true));
    f.channels.deliver("main", "runtime", { ...commitRequest!, id: "stale-reconciliation",
      payload: { ...(commitRequest as { payload: object }).payload, reconcile: true } });
    await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "response" &&
      message.id === "stale-reconciliation" && message.ok && message.value === false)).toBe(true));
    expect(retained(f.session.client)).toEqual([0, 0, 0]);
    expect(f.history).toHaveLength(1); expect(f.read()).toBe(before);
  });

  it("commits exactly once through asynchronous messages, with the same history, label and selection", async () => {
    const f = await fixture();
    const expected = applyAcceptedPluginProposal(f.initial, f.proposal.proposal, { now: "2026-11-10T00:00:00Z" }).document;
    const legacy = vi.spyOn(f.owner.runtime.host, "acceptProposedPatch");
    f.channels.remote = true;
    await f.session.client.runtime.acceptPreparedProposal(f.proposal.id, { tabId: "tab-a", windowId: "main" }, "drawing", f.commit);
    expect(f.history).toEqual([{ before: f.initial, after: expected, label: "Proposal: Apply Proposal" }]);
    expect(f.read().selection.objectIds).toEqual(["caption"]);
    expect(f.owner.runtime.host.listProposedPatches()).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
    await expect(f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-a" }, "drawing", f.commit)).rejects.toThrow();
    expect(f.history).toHaveLength(1);
    const requests = f.channels.deliveries.filter(({ message }) => message.kind === "request").map(({ message }) => message.kind === "request" && message.method);
    expect(requests).toContain("acceptPreparedProposal"); expect(requests).toContain("commitProposal");
    expect(JSON.stringify(f.channels.deliveries)).not.toMatch(/"apply":|"commit":|"signal":/);
  });

  it("keeps a failed or stale document commit pending and permits a later retry", async () => {
    const f = await fixture(); f.channels.remote = true;
    await expect(f.session.client.runtime.acceptPreparedProposal(f.proposal.id, { windowId: "main", tabId: "tab-a" }, "drawing",
      () => { throw new Error("The drawing changed during review"); })).rejects.toThrow("drawing changed");
    expect(f.owner.runtime.host.listProposedPatches("pending")).toHaveLength(1); expect(f.history).toEqual([]);
    await f.session.client.runtime.acceptPreparedProposal(f.proposal.id, { windowId: "main", tabId: "tab-a" }, "drawing", f.commit);
    expect(f.history).toHaveLength(1);
  });

  it("refuses another tab/window and prevents rejection or a second acceptance during commit", async () => {
    const f = await fixture(); f.channels.remote = true;
    await expect(f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "doc-other", tabId: "tab-a" }, "drawing", f.commit)).rejects.toThrow("document target");
    await expect(f.session.client.runtime.acceptPreparedProposal(f.proposal.id,
      { windowId: "main", tabId: "tab-other" }, "drawing", f.commit)).rejects.toThrow("document target");
    await f.session.client.runtime.acceptPreparedProposal(f.proposal.id, { windowId: "main", tabId: "tab-a" }, "drawing", () => {
      expect(() => f.owner.runtime.host.rejectProposedPatch(f.proposal.id)).toThrow("already in progress");
      expect(() => f.owner.runtime.host.reserveProposedPatchAcceptance(f.proposal.id)).toThrow("already in progress");
      f.commit();
    });
    expect(f.history).toHaveLength(1);
  });

  it("never accepts a forged or reused document preparation receipt", async () => {
    const f = await fixture(); f.channels.remote = true;
    // Inject an authenticated owner request with no matching locally retained preparation.
    // Its error response is observable, and no document callback can be supplied over the channel.
    f.channels.deliver("main", "runtime", { version: 1, kind: "request", id: "forged", method: "commitProposal",
      payload: { proposalId: f.proposal.id, target: { windowId: "main", tabId: "tab-a" }, documentKey: "drawing", preparationId: crypto.randomUUID() } });
    await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "response" && message.id === "forged" && !message.ok)).toBe(true));
    expect(f.history).toEqual([]); expect(f.owner.runtime.host.listProposedPatches("pending")).toHaveLength(1);
  });
});

describe("document-owned core commands", () => {
  it.each(["macos", "windows"])("preserves core history/selection and plugin isolation on %s", async () => {
    const channels = new RuntimeTestChannels();
    const runtime = new RuntimeBroker("runtime", channels.transport("runtime")), document = new RuntimeBroker("main", channels.transport("main"));
    const registry = new CommandRegistry(), owner = new RuntimeCoreCommandRegistry(runtime, "main");
    const initial = createEmptyDocument({ now: "2026-11-10T00:00:00Z" });
    let current = initial;
    const history: Array<{ before: ChemDraftDocument; after: ChemDraftDocument; label: string }> = [];
    registry.register({ id: "core.insert", title: "Insert" }, () => {
      const before = current;
      current = applyPatch(current, { op: "addObject", pageId: "page_001", object: caption });
      current = applyPatch(current, { op: "setSelection", pageId: "page_001", objectIds: [caption.id] });
      history.push({ before, after: current, label: "Insert" });
      return caption.id;
    });
    registry.register({ id: "plugin.private.run", title: "Private", source: "plugin", pluginId: "private" }, () => "forbidden");
    const stop = bindRuntimeCoreCommands(document, registry);
    cleanup.push(() => { stop(); document.dispose(); runtime.dispose(); });
    expect(owner.list().map(command => command.id)).toEqual(["core.insert"]);
    expect(() => owner.register({ id: "core.insert", title: "Collision" }, () => {})).toThrow("already registered");
    await expect(owner.invoke("core.insert")).resolves.toBe(caption.id);
    expect(history).toEqual([{ before: initial, after: current, label: "Insert" }]);
    expect(current.selection.objectIds).toEqual([caption.id]);
    await expect(owner.invoke("plugin.private.run")).rejects.toThrow("unavailable");
    registry.unregister("core.insert"); registry.register({ id: "core.insert", title: "Insert", enabled: false }, () => { throw new Error("must not invoke"); });
    await expect(owner.invoke("core.insert")).rejects.toThrow("disabled"); expect(history).toHaveLength(1);
  });
});
