import { createEmptyDocument } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import {
  invocationReference, parseRuntimeMessage, RUNTIME_BROKER_VERSION,
  type RuntimeInvocation, type RuntimeRequest
} from "./runtimeBrokerProtocol";

const testInvocation = (): RuntimeInvocation => ({ id: "invocation-a", target: { windowId: "main", tabId: "tab-a" },
  documentKey: "drawing-a", pluginId: "org.test.broker", commandId: "plugin.broker.run", writeScopeObjectIds: ["selected"] });

describe("runtime broker protocol", () => {
  it("round-trips every document capability and both runtime methods over private serialized channels", async () => {
    const channels = new RuntimeTestChannels();
    const runtime = new RuntimeBroker("runtime", channels.transport("runtime"));
    const document = new RuntimeBroker("main", channels.transport("main"));
    const drawing = createEmptyDocument();
    const invocation = testInvocation(), reference = invocationReference(invocation);
    const selection = { objectIds: ["selected"], molecules: [] };
    const contribution = { revision: 0, plugins: [], enabledCommandIds: [] };
    const applied = vi.fn((_request: RuntimeRequest<"applyPatch">) => ({ applied: true as const, objectIds: ["selected"] }));
    const undo = vi.fn((_request: RuntimeRequest<"undoOwnTransaction">) => true);
    document.handle("getDocument", ref => { expect(ref).toEqual(reference); return drawing; });
    document.handle("getSelection", ref => { expect(ref).toEqual(reference); return selection; });
    document.handle("applyPatch", applied);
    document.handle("undoOwnTransaction", undo);
    document.handle("endInvocation", () => null);
    runtime.handle("invokeCommand", ({ invocation: received, input }, sender) => {
      expect(received).toEqual(invocation); expect(input).toBeUndefined(); expect(sender).toBe("main");
      return { ok: true };
    });
    runtime.handle("getContributions", () => contribution);
    try {
      await expect(runtime.call("main", "getDocument", reference)).resolves.toEqual(drawing);
      await expect(runtime.call("main", "getSelection", reference)).resolves.toEqual(selection);
      const application = { plugin: { id: invocation.pluginId, name: "Broker", version: "1" },
        command: { id: invocation.commandId, title: "Run" }, undoLabel: "Broker: Run", writeScopeObjectIds: ["selected"],
        patch: ProposedDocumentPatchSchema.parse({ patch: { op: "moveObject", objectId: "selected", x: 4, y: 5 }, reason: "Move" }) };
      await expect(runtime.call("main", "applyPatch", { invocation: reference, application })).resolves.toEqual({ applied: true, objectIds: ["selected"] });
      expect(applied.mock.calls[0]![0]).toMatchObject({ invocation: reference, application });
      await expect(runtime.call("main", "undoOwnTransaction", { invocation: reference, transactionId: "own-entry" })).resolves.toBe(true);
      expect(undo.mock.calls[0]![0]).toEqual({ invocation: reference, transactionId: "own-entry" });
      await expect(document.call("runtime", "invokeCommand", { invocation })).resolves.toEqual({ ok: true });
      await expect(document.call("runtime", "getContributions", {})).resolves.toEqual(contribution);
      await expect(runtime.call("main", "endInvocation", reference)).resolves.toBeNull();
      expect(new Set(channels.deliveries.filter(d => d.message.kind === "request").map(d =>
        d.message.kind === "request" ? d.message.method : ""))).toEqual(new Set([
        "getDocument", "getSelection", "applyPatch", "undoOwnTransaction", "endInvocation", "invokeCommand", "getContributions"
      ]));
    } finally { document.dispose(); runtime.dispose(); }
  });

  it.each(["toolset-core-main", "toolset-popover-core-main", "toolset-tooltip", "preferences", "plugin-panel-x", "dialog-main-export-1", "spin3d-debugger"])("refuses utility endpoint %s", label => {
    expect(() => new RuntimeBroker(label, new RuntimeTestChannels().transport(label))).toThrow("Utilities cannot connect");
  });

  it("validates version, target namespace, method, nested fields and payload size before delivery", () => {
    const message = { version: RUNTIME_BROKER_VERSION, kind: "request", id: "call", method: "getDocument", payload: invocationReference(testInvocation()) };
    expect(() => parseRuntimeMessage({ ...message, version: 2 })).toThrow();
    expect(() => parseRuntimeMessage({ ...message, method: "privateFunction" })).toThrow();
    expect(() => parseRuntimeMessage({ ...message, sender: "runtime" })).toThrow();
    expect(() => parseRuntimeMessage({ ...message, payload: { ...message.payload, target: { windowId: "runtime", tabId: "x" } } })).toThrow();
    expect(() => parseRuntimeMessage({ ...message, payload: { ...message.payload, target: { windowId: "doc-other\n", tabId: "x" } } })).toThrow();
    expect(() => parseRuntimeMessage({ ...message, payload: { ...message.payload, writeScopeObjectIds: ["stolen"] } })).toThrow();
    expect(() => parseRuntimeMessage({ ...message, payload: "x".repeat(32 * 1024 * 1024) })).toThrow("32 MiB");
  });

  it("correlates replies by authenticated sender, request id AND method and never listens to events", async () => {
    const channels = new RuntimeTestChannels();
    const runtime = new RuntimeBroker("runtime", channels.transport("runtime"));
    const call = runtime.call("main", "getDocument", invocationReference(testInvocation()));
    const message = channels.deliveries[0]!.message;
    if (message.kind !== "request") throw new Error("Expected request");
    const response = { version: RUNTIME_BROKER_VERSION, kind: "response", id: message.id, method: "getDocument", ok: true, value: undefined };
    let settled = false;
    void call.then(() => { settled = true; }, () => { settled = true; });
    channels.deliver("runtime", "doc-other", response);
    channels.deliver("runtime", "plugin-panel-x", response);
    channels.deliver("runtime", "main", { ...response, method: "undoOwnTransaction", value: true });
    channels.deliver("runtime", "main", { ...response, id: "unrelated" });
    await Promise.resolve(); expect(settled).toBe(false);
    channels.deliver("runtime", "main", response);
    await expect(call).resolves.toBeUndefined();
    runtime.dispose();
  });

  it("refuses direction errors and transports method failures with their specific message", async () => {
    const channels = new RuntimeTestChannels();
    const runtime = new RuntimeBroker("runtime", channels.transport("runtime"));
    const document = new RuntimeBroker("main", channels.transport("main"));
    expect(() => runtime.handle("getDocument", () => undefined)).toThrow("Wrong broker destination");
    await expect(document.call("doc-other", "getDocument", invocationReference(testInvocation()))).rejects.toThrow("require a runtime host");
    await expect(runtime.call("main", "invokeCommand", { invocation: testInvocation() })).rejects.toThrow("Wrong broker recipient");
    document.handle("getDocument", () => { throw new Error("The plugin command's document tab was closed; nothing was inserted."); });
    await expect(runtime.call("main", "getDocument", invocationReference(testInvocation()))).rejects.toThrow("document tab was closed");
    runtime.dispose(); document.dispose();
  });

  it("rejects in-flight calls on teardown and on deadlines instead of retaining them", async () => {
    vi.useFakeTimers();
    try {
      const channels = new RuntimeTestChannels();
      const runtime = new RuntimeBroker("runtime", channels.transport("runtime"), 10);
      const pending = runtime.call("main", "getDocument", invocationReference(testInvocation()));
      const timedOut = expect(pending).rejects.toThrow("getDocument timed out");
      await vi.advanceTimersByTimeAsync(10); await timedOut;
      const closing = runtime.call("main", "getDocument", invocationReference(testInvocation()));
      const refused = expect(closing).rejects.toThrow("connection closed");
      runtime.dispose(); await refused;
      await expect(runtime.call("main", "getDocument", invocationReference(testInvocation()))).rejects.toThrow("connection is closed");
    } finally { vi.useRealTimers(); }
  });
});
