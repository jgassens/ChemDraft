// @vitest-environment jsdom
import { applyPatch, createEmptyDocument, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { createLocalPluginRuntimeSession } from "./localPluginRuntime";
import { createPluginRuntimeOwner, type PluginRuntimeOwner } from "./pluginRuntimeOwner";
import { applyAcceptedPluginProposal } from "./applyPluginDocumentPatch";
import { RuntimeBroker } from "./runtimeBroker";
import { bindRuntimeCoreCommands, RuntimeCoreCommandRegistry } from "./runtimeCoreCommands";
import type { RuntimeTransport } from "./runtimeBrokerProtocol";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
class AsyncChannels extends RuntimeTestChannels {
  remote = false;
  override transport(label: string): RuntimeTransport {
    const transport = super.transport(label), channels = this;
    return { ...transport, get immediate() { return !channels.remote; },
      send: (recipient, message) => channels.remote ? Promise.resolve().then(() => transport.send(recipient, message)) : transport.send(recipient, message) };
  }
}
const caption: TextObject = { id: "caption", type: "text", text: "Reviewed", spans: [],
  x: 40, y: 50, width: 100, height: 20, rotation: 0, style: {} };

async function fixture() {
  vi.stubGlobal("localStorage", new MemoryStorage());
  let document = createEmptyDocument({ now: "2026-11-10T00:00:00Z" });
  const initial = document, channels = new AsyncChannels();
  let owner!: PluginRuntimeOwner;
  const session = createLocalPluginRuntimeSession({ commandRegistry: new CommandRegistry(), getActiveDocument: () => document,
    getActiveDocumentKey: () => "drawing", getActiveDocumentTab: () => ({ id: "tab-a" }), getDocumentTabTitle: () => "Drawing",
    getSelection: () => ({ objectIds: [], molecules: [] }) }, providers => {
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
    history.push({ before: document, after, label: "Proposal: Apply Proposal" }); document = after;
  };
  return { session, owner, channels, initial, proposal, history, commit, read: () => document };
}

describe("remote proposal acceptance", () => {
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
