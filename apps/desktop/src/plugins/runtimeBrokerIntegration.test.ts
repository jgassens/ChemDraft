import {
  applyPatch, createEmptyDocument, type BracketObject, type ChemDraftDocument, type DocumentObject, type ReactionObject
} from "@chemdraft/chem-core";
import { parsePluginManifest, ProposedDocumentPatchSchema, type PluginCommandContext, type ProposedDocumentPatch } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { applyPluginDocumentPatch } from "./applyPluginDocumentPatch";
import { createPluginRuntime } from "./createPluginRuntime";
import { fixturePluginManifest, createFixturePluginOptions } from "./fixturePlugin";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerDocument, type RuntimeDocumentPort, type RuntimeDocumentState } from "./runtimeBrokerDocument";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { invocationReference, type RuntimeInvocation } from "./runtimeBrokerProtocol";

const text = (id: string): DocumentObject => ({ id, type: "text", x: 10, y: 10, width: 10, height: 10, rotation: 0, style: {}, text: id, spans: [] });
const bracket = (id: string, side: "open" | "close", pairId = "pair"): BracketObject => ({
  id, type: "bracket", bracketKind: "square", pairId, side, containedObjectIds: [], bracketUsage: "sru", repeatUnit: true,
  x: side === "open" ? 0 : 50, y: 0, width: 10, height: 50, rotation: 0, style: {}, ...(side === "close" ? { label: "n" } : {})
});
const reaction = (reference: "components" | "conditions" | "arrows" | "plusses" | "metadata"): ReactionObject => ({
  id: "step", type: "reaction", x: 0, y: 0, width: 100, height: 30, rotation: 0, style: {}, mappingState: "absent",
  components: reference === "components" ? [{ role: "agent", objectId: "selected" }] : [],
  conditionsTextObjectIds: reference === "conditions" ? ["selected"] : [],
  arrowObjectIds: reference === "arrows" ? ["selected"] : [], plusObjectIds: reference === "plusses" ? ["selected"] : [],
  ...(reference === "metadata" ? { compatibility: { warnings: [], unknown: { cdxmlStepReferences: { ReactionStepObjectsAboveArrow: ["selected"] } } } } : {})
});
function drawing(selected: string[], objects: DocumentObject[] = []): ChemDraftDocument {
  const document = createEmptyDocument({ now: "2026-11-10T00:00:00.000Z" });
  return { ...document, pages: [{ ...document.pages[0]!, objects: [text("selected"), text("unselected"), ...objects] }],
    selection: { pageId: document.pages[0]!.id, objectIds: selected } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture(run: (ctx: PluginCommandContext) => unknown | Promise<unknown>, selected = ["selected"], objects: DocumentObject[] = []) {
  const channels = new RuntimeTestChannels();
  const hostBroker = new RuntimeBroker("runtime", channels.transport("runtime"));
  const createRuntime = vi.fn(() => {
    const runtime = createPluginRuntime({
      getActiveDocument: () => { throw new Error("Unbound document provider used"); },
      getSelection: () => { throw new Error("Unbound selection provider used"); },
      computeIsotopeEnvelope: null, buildStructureFromSmiles: null, convertNameToStructure: null
    });
    runtime.registerPlugin({ id: "org.test.broker", name: "Broker", version: "1", apiVersion: "^0.1.25", entry: "worker.js",
      permissions: ["document.read", "document.write", "selection.read"],
      contributes: { commands: [{ id: "plugin.broker.run", title: "Run" }] }
    }, { commandHandlers: { "plugin.broker.run": run } });
    return runtime;
  });
  const host = new RuntimeBrokerHost(hostBroker, createRuntime, () => ["main", "doc-second"]);
  const clients = ["main", "doc-second"].map(windowId => {
    const broker = new RuntimeBroker(windowId, channels.transport(windowId));
    const tabs = new Map<string, RuntimeDocumentState>([
      ["tab-a", { documentKey: `${windowId}-drawing-a`, document: drawing(selected, objects) }],
      ["tab-b", { documentKey: `${windowId}-drawing-b`, document: drawing(["unselected"]) }]
    ]);
    let active = "tab-a";
    const registry = new CommandRegistry();
    const port: RuntimeDocumentPort = {
      windowId, commandRegistry: registry, activeTabId: () => active,
      read: tabId => tabs.get(tabId),
      selection: tabId => ({ objectIds: tabs.get(tabId)!.document.selection.objectIds, molecules: [] }),
      runWrite: async (_tabId, commit) => commit(),
      commit: vi.fn((tabId, before, application) => {
        const result = applyPluginDocumentPatch(before, application.patch);
        tabs.set(tabId, { ...tabs.get(tabId)!, document: result.document });
        return result.receipt;
      })
    };
    const client = new RuntimeBrokerDocument(broker, port);
    cleanups.push(() => { client.dispose(); broker.dispose(); });
    return { broker, client, port, registry, tabs, activate: (tabId: string) => { active = tabId; } };
  });
  cleanups.push(() => { host.dispose(); hostBroker.dispose(); });
  await Promise.all(clients.map(({ client }) => client.refreshContributions()));
  const invocation = () => {
    const message = channels.deliveries.find(({ message }) => message.kind === "request" && message.method === "invokeCommand")?.message;
    if (!message || message.kind !== "request") throw new Error("No invocation sent");
    return (message.payload as { invocation: RuntimeInvocation }).invocation;
  };
  return { host, hostBroker, clients, channels, createRuntime, invocation };
}

describe("one broker runtime and two document clients", () => {
  it("creates one runtime and broadcasts every contribution to plugin-marked proxies in both registries", async () => {
    const f = await fixture(async ctx => (await ctx.documents.getActiveDocument())?.id);
    f.host.runtime.registerPlugin({ ...fixturePluginManifest, permissions: [...fixturePluginManifest.permissions, "ui.canvas"], contributes: {
      ...fixturePluginManifest.contributes,
      menus: [{ id: "menu.fixture.ping", title: "Ping", commandId: "plugin.fixture.ping" }],
      toolbarButtons: [{ id: "fixture-ping", commandId: "plugin.fixture.ping" }],
      canvasOverlays: [{ id: "overlay.fixture.main", title: "Fixture", icon: "data:image/png;base64,YQ==", commandId: "plugin.fixture.ping",
        prompt: { kind: "prompt", id: "composer", commandId: "plugin.fixture.ping" } }]
    } }, createFixturePluginOptions());
    await f.host.broadcastContributions();
    expect(f.createRuntime).toHaveBeenCalledOnce();
    expect(() => new RuntimeBrokerHost(f.hostBroker, f.createRuntime, () => ["main", "doc-second"]))
      .toThrow("already owns its one plugin runtime");
    expect(f.createRuntime).toHaveBeenCalledOnce();
    for (const { registry, client } of f.clients) {
      expect(registry.get("plugin.broker.run")).toMatchObject({ source: "plugin", pluginId: "org.test.broker", enabled: true });
      expect(registry.get("plugin.fixture.ping")).toMatchObject({ source: "plugin", pluginId: "org.chemdraft.fixture" });
      const contributes = client.getContributions()?.plugins.find(plugin => plugin.id === "org.chemdraft.fixture")?.contributes;
      expect(contributes?.toolsets).toHaveLength(1);
      expect(contributes?.menus).toHaveLength(1);
      expect(contributes?.toolbarButtons).toHaveLength(1);
      expect(contributes?.panels).toHaveLength(1);
      expect(contributes?.canvasOverlays).toHaveLength(1);
      await expect(client.invokeCommand("plugin.fixture.ping")).resolves.toMatchObject({ ok: true });
    }
    f.host.runtime.unregisterPlugin("org.chemdraft.fixture");
    await f.host.broadcastContributions();
    for (const { registry } of f.clients) expect(registry.has("plugin.fixture.ping")).toBe(false);
    expect(f.createRuntime).toHaveBeenCalledOnce();
  });

  it("keeps overlapped invocations in their source windows and leaves no global active-document binding", async () => {
    const start = deferred(), resume = deferred();
    let arrived = 0;
    const f = await fixture(async ctx => {
      const before = await ctx.documents.getActiveDocument();
      if (++arrived === 2) start.resolve();
      await resume.promise;
      const read = await ctx.selection!.getSelection();
      const receipt = await ctx.documents.applyPatch!({ reason: "Move selected", patch: { op: "moveObject", objectId: read.objectIds[0]!, x: 30, y: 40 } });
      return { title: before?.title, ids: read.objectIds, receipt };
    });
    f.clients[1]!.tabs.get("tab-a")!.document.selection.objectIds = ["unselected"];
    const a = f.clients[0]!.client.invokeCommand("plugin.broker.run");
    const b = f.clients[1]!.client.invokeCommand("plugin.broker.run");
    await start.promise;
    f.clients[0]!.activate("tab-b");
    f.clients[1]!.activate("tab-b");
    resume.resolve();
    await expect(a).resolves.toMatchObject({ ids: ["selected"] });
    await expect(b).resolves.toMatchObject({ ids: ["unselected"] });
    for (const { port, tabs } of f.clients) {
      expect(port.commit).toHaveBeenCalledOnce();
      expect(vi.mocked(port.commit).mock.calls[0]![0]).toBe("tab-a");
      expect(tabs.get("tab-b")!.document.pages[0]!.objects[0]!.x).toBe(10);
    }
    expect(f.createRuntime).toHaveBeenCalledOnce();
  });

  it("collects selection warnings in the source invocation without transferring its collector or mixing concurrent tabs", async () => {
    const started = deferred(), resume = deferred();
    let arrived = 0;
    const f = await fixture(async context => {
      if (++arrived === 2) started.resolve();
      await resume.promise;
      await context.selection!.getSelection();
      return context.selection!.getSelection();
    });
    const owner = f.clients[0]!;
    owner.port.selection = (tabId, warnings) => {
      warnings?.push(`Selection warning for ${tabId}`);
      return { objectIds: owner.tabs.get(tabId)!.document.selection.objectIds, molecules: [] };
    };
    const aWarnings: string[] = [], bWarnings: string[] = [];
    const a = owner.client.invokeCommand("plugin.broker.run", undefined, { selectionWarnings: aWarnings });
    owner.activate("tab-b");
    const b = owner.client.invokeCommand("plugin.broker.run", undefined, { selectionWarnings: bWarnings });
    await started.promise;
    expect(aWarnings).toEqual([]); expect(bWarnings).toEqual([]);
    resume.resolve();
    await Promise.all([a, b]);
    expect(aWarnings).toEqual(["Selection warning for tab-a", "Selection warning for tab-a"]);
    expect(bWarnings).toEqual(["Selection warning for tab-b", "Selection warning for tab-b"]);
    await owner.client.invokeCommand("plugin.broker.run"); // An uncollected read stays silent.
    expect(aWarnings).toHaveLength(2); expect(bWarnings).toHaveLength(2);
  });

  it.each(["closed", "replaced", "handed off"] as const)("refuses a %s drawing specifically without changing the newly active tab", async mode => {
    const started = deferred(), resume = deferred();
    const f = await fixture(async ctx => {
      started.resolve(); await resume.promise;
      return ctx.documents.applyPatch!({ reason: "Move", patch: { op: "moveObject", objectId: "selected", x: 30, y: 40 } });
    });
    const owner = f.clients[0]!;
    const result = owner.client.invokeCommand("plugin.broker.run");
    await started.promise;
    owner.activate("tab-b");
    if (mode === "closed") owner.tabs.delete("tab-a");
    else owner.tabs.set("tab-a", { documentKey: "replacement-or-handoff", document: drawing(["selected"]) });
    resume.resolve();
    await expect(result).rejects.toThrow(mode === "closed" ? "document tab was closed" : "The document changed while the plugin was running");
    expect(owner.port.commit).not.toHaveBeenCalled();
  });

  it("keeps toolbar gates, rejects core-command collisions, ignores old revisions and preserves existing proxies on failure", async () => {
    const f = await fixture(() => undefined);
    const { client, registry } = f.clients[0]!;
    registry.register({ id: "plugin.core.reserved", title: "Reserved", source: "core" }, () => undefined);
    const revision = f.host.contributions().revision + 1;
    const toolbar = parsePluginManifest(fixturePluginManifest);
    await expect(Promise.resolve().then(() => client.registerContributions({ revision,
      plugins: [{ ...toolbar, permissions: ["ui.panel"] }], enabledCommandIds: [] }))).rejects.toThrow("ui.toolbar");
    const collision = parsePluginManifest({ ...fixturePluginManifest, contributes: { commands: [{ id: "plugin.core.reserved", title: "Collision" }] } });
    expect(() => client.registerContributions({ revision, plugins: [collision], enabledCommandIds: [] })).toThrow("already registered");
    expect(registry.get("plugin.core.reserved")?.source).toBe("core");
    expect(registry.has("plugin.broker.run")).toBe(true);
    client.registerContributions({ revision: 0, plugins: [], enabledCommandIds: [] });
    expect(registry.has("plugin.broker.run")).toBe(true);
    const original = registry.register.bind(registry);
    vi.spyOn(registry, "register").mockImplementationOnce((definition, handler) => {
      original(definition, handler); throw new Error("Injected registry failure after mutation");
    });
    expect(() => client.registerContributions({ revision, plugins: [toolbar], enabledCommandIds: [] })).toThrow("Injected");
    expect(registry.has("plugin.fixture.ping")).toBe(false);
    expect(registry.get("plugin.broker.run")).toMatchObject({ source: "plugin", pluginId: "org.test.broker" });
  });

  it("refuses the runtime host as a document client", async () => {
    const f = await fixture(() => undefined);
    expect(() => new RuntimeBrokerDocument(f.hostBroker, { ...f.clients[0]!.port, windowId: "runtime" })).toThrow("owner mismatch");
  });

  it("rejects forged source/target pairs and cross-plugin command ownership", async () => {
    const f = await fixture(() => undefined);
    const invocation: RuntimeInvocation = { id: "forged", target: { windowId: "main", tabId: "tab-a" }, documentKey: "main-drawing-a",
      pluginId: "org.test.broker", commandId: "plugin.broker.run", writeScopeObjectIds: [] };
    await expect(f.clients[1]!.broker.call("runtime", "invokeCommand", { invocation })).rejects.toThrow("source document window");
    await expect(f.clients[0]!.broker.call("runtime", "invokeCommand", { invocation: { ...invocation, pluginId: "org.other.plugin" } }))
      .rejects.toThrow("registered plugin command");
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
  });
});

describe("#364 scope across the broker", () => {
  it.each(["moveObject", "updateObject", "removeObject", "setObjectOrder"] as const)("refuses out-of-scope %s without a partial commit", async op => {
    const f = await fixture(ctx => ctx.documents.applyPatch!({ reason: "Out of scope", patch:
      op === "moveObject" ? { op, objectId: "unselected", x: 30, y: 40 } :
      op === "updateObject" ? { op, objectId: "unselected", changes: { text: "changed" } } :
      op === "removeObject" ? { op, objectId: "unselected" } :
      { op, pageId: f.clients[0]!.tabs.get("tab-a")!.document.pages[0]!.id, objectIds: ["selected", "unselected"] }
    }));
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).rejects.toThrow("unselected was not selected when the command started");
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
  });

  it("does not grant insertion scope from a refused batch or from an earlier invocation", async () => {
    const f = await fixture(async ctx => {
      const pageId = (await ctx.documents.getActiveDocument())!.pages[0]!.id;
      await expect(ctx.documents.applyPatch!({ reason: "Refused batch", patch: { op: "batch", patches: [
        { op: "addObject", pageId, object: text("not-inserted") },
        { op: "moveObject", objectId: "unselected", x: 30, y: 40 }
      ] } })).rejects.toThrow("not selected");
      await expect(ctx.documents.applyPatch!({ reason: "Leaked scope", patch: { op: "moveObject", objectId: "not-inserted", x: 30, y: 40 } }))
        .rejects.toThrow("not-inserted was not selected");
    });
    await f.clients[0]!.client.invokeCommand("plugin.broker.run");
    await f.clients[0]!.client.invokeCommand("plugin.broker.run");
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
  });

  it("does not grant insertion scope after an application failure", async () => {
    const f = await fixture(async ctx => {
      const pageId = (await ctx.documents.getActiveDocument())!.pages[0]!.id;
      await expect(ctx.documents.applyPatch!({ reason: "Failed insert", patch: { op: "addObject", pageId, object: text("not-inserted") } }))
        .rejects.toThrow("Commit failed");
      return ctx.documents.applyPatch!({ reason: "Leaked scope", patch: { op: "moveObject", objectId: "not-inserted", x: 30, y: 40 } });
    });
    vi.mocked(f.clients[0]!.port.commit).mockImplementationOnce(() => { throw new Error("Commit failed"); });
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).rejects.toThrow("not-inserted was not selected");
    expect(f.clients[0]!.port.commit).toHaveBeenCalledOnce();
  });

  it("allows unchanged repeated unselected ids through the document-side atomic scope check", async () => {
    const f = await fixture(ctx => ctx.documents.applyPatch!({ reason: "Move selected", patch: { op: "moveObject", objectId: "selected", x: 30, y: 40 } }),
      ["selected"], [text("duplicate"), { ...text("duplicate"), x: 100 }]);
    const before = f.clients[0]!.tabs.get("tab-a")!.document.pages[0]!.objects.filter(object => object.id === "duplicate");
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).resolves.toMatchObject({ applied: true });
    expect(f.clients[0]!.tabs.get("tab-a")!.document.pages[0]!.objects.filter(object => object.id === "duplicate")).toEqual(before);
  });

  it("rechecks a queued write after plugin unregistration aborts its command", async () => {
    const waiting = deferred(), resume = deferred();
    const f = await fixture(ctx => ctx.documents.applyPatch!({ reason: "Move selected", patch: { op: "moveObject", objectId: "selected", x: 30, y: 40 } }));
    const owner = f.clients[0]!;
    owner.port.runWrite = async (_tabId, commit) => { waiting.resolve(); await resume.promise; return commit(); };
    const result = owner.client.invokeCommand("plugin.broker.run");
    await waiting.promise;
    f.host.runtime.unregisterPlugin("org.test.broker");
    resume.resolve();
    await expect(result).rejects.toThrow(/command ended|binding is no longer available/);
    expect(owner.port.commit).not.toHaveBeenCalled();
  });

  it("captures selection at command start; later selection and activation do not widen it", async () => {
    const started = deferred(), resume = deferred();
    const f = await fixture(async ctx => {
      started.resolve(); await resume.promise;
      return ctx.documents.applyPatch!({ reason: "Out of scope", patch: { op: "moveObject", objectId: "unselected", x: 30, y: 40 } });
    });
    const result = f.clients[0]!.client.invokeCommand("plugin.broker.run");
    await started.promise;
    f.clients[0]!.tabs.get("tab-a")!.document.selection.objectIds = ["unselected"];
    f.clients[0]!.activate("tab-b"); resume.resolve();
    await expect(result).rejects.toThrow("unselected was not selected when the command started");
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
  });

  it.each(["insert", "annotation", "edit", "remove", "batch", "colliding insertion"] as const)("allows in-scope %s and preserves one labelled commit per applyPatch", async operation => {
    const f = await fixture(async ctx => {
      const document = (await ctx.documents.getActiveDocument())!;
      const pageId = document.pages[0]!.id;
      const patch: ProposedDocumentPatch["patch"] = operation === "insert" || operation === "colliding insertion" ?
        { op: "addObject", pageId, object: text(operation === "insert" ? "new" : "unselected") } :
        operation === "annotation" ? { op: "addAnnotation", pageId, annotation: { id: "note", type: "annotation", x: 0, y: 0, width: 10, height: 10, rotation: 0, style: {}, targetObjectIds: [], message: "note" } } :
        operation === "edit" ? { op: "updateObject", objectId: "selected", changes: { text: "changed" } } :
        operation === "remove" ? { op: "removeObject", objectId: "selected" } :
          { op: "batch", patches: [{ op: "addObject", pageId, object: text("new") }, { op: "moveObject", objectId: "new", x: 70, y: 80 }, { op: "removeObject", objectId: "selected" }] };
      return ctx.documents.applyPatch!({ reason: "Scoped change", patch });
    });
    const beforeUnselected = f.clients[0]!.tabs.get("tab-a")!.document.pages[0]!.objects[1];
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).resolves.toMatchObject({ applied: true });
    expect(f.clients[0]!.port.commit).toHaveBeenCalledOnce();
    expect(vi.mocked(f.clients[0]!.port.commit).mock.calls[0]![2].undoLabel).toBe("Broker: Run");
    expect(f.clients[0]!.tabs.get("tab-a")!.document.pages[0]!.objects.find(object => object.id === "unselected")).toEqual(beforeUnselected);
  });

  it("grows scope only from a successful receipt, including rebased insertions", async () => {
    const f = await fixture(async ctx => {
      const pageId = (await ctx.documents.getActiveDocument())!.pages[0]!.id;
      const inserted = await ctx.documents.applyPatch!({ reason: "Insert", patch: { op: "addObject", pageId, object: text("unselected") } });
      expect(inserted.objectIds[0]).not.toBe("unselected");
      return ctx.documents.applyPatch!({ reason: "Move new object", patch: { op: "moveObject", objectId: inserted.objectIds[0]!, x: 70, y: 80 } });
    });
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).resolves.toMatchObject({ applied: true });
    expect(f.clients[0]!.port.commit).toHaveBeenCalledTimes(2);
  });

  it.each(["components", "conditions", "arrows", "plusses", "metadata"] as const)("refuses indirect reaction removal changes through %s", async reference => {
    const f = await fixture(ctx => ctx.documents.applyPatch!({ reason: "Remove", patch: { op: "removeObject", objectId: "selected" } }), ["selected"], [reaction(reference)]);
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).rejects.toThrow("would change reaction step");
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
  });

  it.each(["remove partner", "pair hijack"] as const)("refuses indirect bracket changes: %s", async operation => {
    const f = await fixture(ctx => ctx.documents.applyPatch!({ reason: "Edit bracket", patch: operation === "remove partner" ?
      { op: "removeObject", objectId: "open" } :
      { op: "updateObject", objectId: "open", changes: { pairId: "other-pair" } }
    }), ["open"], [bracket("open", "open"), bracket("close", "close"), bracket("other-open", "open", "other-pair"), bracket("other-close", "close", "other-pair")]);
    await expect(f.clients[0]!.client.invokeCommand("plugin.broker.run")).rejects.toThrow(/not selected/);
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
  });

  it.each(["scope changed", "target replaced", "tab closed", "command ended"] as const)("rechecks immediately at commit after a gesture wait: %s", async change => {
    const waiting = deferred(), resume = deferred();
    const f = await fixture(ctx => ctx.documents.applyPatch!({ reason: "Remove selected", patch: { op: "removeObject", objectId: "selected" } }));
    const owner = f.clients[0]!;
    owner.port.runWrite = async (_tabId, commit) => { waiting.resolve(); await resume.promise; return commit(); };
    const result = owner.client.invokeCommand("plugin.broker.run");
    await waiting.promise;
    if (change === "scope changed") {
      const state = owner.tabs.get("tab-a")!;
      state.document = applyPatch(state.document, { op: "addObject", pageId: state.document.pages[0]!.id, object: reaction("metadata") });
    } else if (change === "target replaced") owner.tabs.get("tab-a")!.documentKey = "replacement";
    else if (change === "tab closed") owner.tabs.delete("tab-a");
    else owner.client.invalidateTab("tab-a");
    resume.resolve();
    await expect(result).rejects.toThrow(change === "scope changed" ? "would change reaction step" :
      change === "target replaced" ? "The document changed" : change === "tab closed" ? "document tab was closed" : /command ended|binding is no longer available/);
    expect(owner.port.commit).not.toHaveBeenCalled();
  });

  it("rejects a scope widened on the wire even when the runtime would permit the supplied ids", async () => {
    const started = deferred(), resume = deferred();
    const f = await fixture(async () => { started.resolve(); await resume.promise; });
    const result = f.clients[0]!.client.invokeCommand("plugin.broker.run");
    await started.promise;
    const invocation = invocationReference(f.invocation());
    await expect(f.hostBroker.call("main", "applyPatch", { invocation, application: {
      plugin: { id: invocation.pluginId, name: "Broker", version: "1" }, command: { id: invocation.commandId, title: "Run" },
      undoLabel: "Forged scope", writeScopeObjectIds: ["selected", "unselected"],
      patch: ProposedDocumentPatchSchema.parse({ reason: "Move", patch: { op: "moveObject", objectId: "unselected", x: 30, y: 40 } })
    } })).rejects.toThrow("unselected was not selected when the command started");
    expect(f.clients[0]!.port.commit).not.toHaveBeenCalled();
    resume.resolve(); await result;
  });

  it("routes undo only to an entry locally recorded for this invocation and consumes it once", async () => {
    const started = deferred(), resume = deferred();
    const f = await fixture(async () => { started.resolve(); await resume.promise; });
    const result = f.clients[0]!.client.invokeCommand("plugin.broker.run");
    await started.promise;
    const invocation = f.invocation(), ref = invocationReference(invocation);
    const undo = vi.fn(() => true);
    f.clients[0]!.client.recordOwnTransaction(invocation.id, "own", undo);
    await expect(f.hostBroker.call("main", "undoOwnTransaction", { invocation: ref, transactionId: "foreign" })).rejects.toThrow("does not belong");
    await expect(f.hostBroker.call("main", "undoOwnTransaction", { invocation: { ...ref, target: { windowId: "doc-second", tabId: "tab-a" } }, transactionId: "own" })).rejects.toThrow("binding");
    await expect(f.hostBroker.call("main", "undoOwnTransaction", { invocation: ref, transactionId: "own" })).resolves.toBe(true);
    await expect(f.hostBroker.call("main", "undoOwnTransaction", { invocation: ref, transactionId: "own" })).rejects.toThrow("does not belong");
    expect(undo).toHaveBeenCalledOnce();
    resume.resolve(); await result;
    await expect(f.hostBroker.call("main", "getDocument", ref)).rejects.toThrow("binding");
  });
});
