import { describe, expect, it, vi } from "vitest";
import { applyPatch, createEmptyDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import {
  PluginApiVersion, type PluginCommandContext, type PluginPermission, type PluginRequestResult, type PluginToolCallResult,
  type PluginToolDefinition, type PluginToolHandler
} from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { compatibilityTools } from "../../assistant/compatibilityToolCatalog";
import { listAssistantTools } from "../../assistant/assistantTools";
import { testContext } from "../../assistant/tools/testContext";
import { planRequestPageFit } from "../../pageEnlargement";
import { picturePngBase64 } from "../../testSupport/imageFixture";
import { ToolSessionController } from "./ToolSessionController";
import type { McpBridgeRequest, McpBridgeResponse, NativeToolCatalog } from "./transport";
import { toolDeadline } from "./deadlines";

const definition = (name: string): PluginToolDefinition => ({
  name, description: "Plugin definition", inputSchema: { type: "object" }
});
const nativeNames = listAssistantTools().map(tool => tool.name);
const unwrap = <T,>(result: PluginRequestResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(confirmPageSpace?: (signal: AbortSignal) => Promise<"enlarge" | "keep">) {
  const { context: services } = testContext();
  const channels = new Map<string, (message: McpBridgeRequest) => void>();
  const replies = new Map<string, (response: McpBridgeResponse) => void>();
  const open = vi.fn(async (_plugin: { id: string }, channel: (message: McpBridgeRequest) => void, _catalog: NativeToolCatalog) => {
    const sessionId: string = crypto.randomUUID();
    channels.set(sessionId, channel);
    return { sessionId, serverName: "chemdraft" as const };
  });
  const close = vi.fn(async (_session: string) => {});
  const controller = new ToolSessionController({ open, close, respond: async (_id, call, response) => {
    replies.get(call)?.(response); replies.delete(call);
  } }, compatibilityTools(() => services, !!confirmPageSpace));
  const openings = vi.spyOn(controller, "open");
  let active = "a";
  const docs = new Map(["a", "b"].map(key => [key, createEmptyDocument({ title: key })]));
  const verify = vi.fn(async (_before: ChemDraftDocument, draft: ChemDraftDocument) => draft);
  const host = new PluginHost({
    toolSessions: controller,
    requestPageSpace: confirmPageSpace && { plan: planRequestPageFit, confirm: confirmPageSpace },
    getActiveDocumentKey: () => active, getActiveDocument: () => docs.get(active),
    captureRequestDocument: () => {
      const key = active;
      return { key, read: () => docs.get(key) };
    },
    openRequestHistory: doc => ({ run: async commit => commit(), verify,
      write: (after, _, guard) => { guard(after); docs.set(doc.key, after); } })
  });
  function mcp(id: string, method: string, params: unknown, requestId: string = crypto.randomUUID()): Promise<McpBridgeResponse> {
    return new Promise(resolve => {
      replies.set(requestId, resolve);
      channels.get(id)!({ sessionId: id, requestId, method, params });
    });
  }
  async function start(id: string, handler?: PluginToolHandler, permissions: PluginPermission[] =
    ["document.read", "selection.read", "document.write", "chemistry.compute", "native.execute"]) {
    const command = `plugin.${id}.send`;
    const finish = deferred<void>();
    let ctx!: PluginCommandContext;
    host.registerPlugin({ id, name: id, apiVersion: `^${PluginApiVersion}`, version: "1", entry: "worker.js",
      permissions,
      contributes: { commands: [{ id: command, title: "Send" }] } },
    { onToolCall: handler, commandHandlers: { [command]: context => { ctx = context; return finish.promise; } } });
    const invocation = host.invokeCommand(command);
    const { requestId } = unwrap(await ctx.requests!.begin({ label: "Test tools" }));
    const openSession = async (definitions: PluginToolDefinition[], hostTools?: string[]) => {
      const result = unwrap(await ctx.toolSessions!.open({ requestId, definitions, ...(hostTools && { hostTools }) }));
      const owner = openings.mock.calls.find(([binding]) => binding.requestId === requestId)![0].owner;
      return { ...result, owner, call: (name: string, input: unknown = {}) => controller.call(owner, result.sessionId, name, input) };
    };
    return { ctx, requestId, openSession, end: () => ctx.requests!.end({ requestId }),
      finish: async () => { finish.resolve(); await invocation; } };
  }
  return { controller, channels, close, open, start, host, docs, verify, mcp, switchTo: (id: string) => { active = id; } };
}

describe("request tool sessions", () => {
  it("returns the legacy move_objects decline over MCP when the page question times out", async () => {
    vi.useFakeTimers();
    const late = deferred<"enlarge">();
    const confirm = vi.fn(() => late.promise);
    const f = fixture(confirm);
    const document = f.docs.get("a")!;
    const page = document.pages[0]!;
    const before = applyPatch(document, { op: "batch", patches: [
      { op: "addObject", pageId: page.id, object: { type: "plus", id: "mark", x: 40, y: 40,
        width: page.width + 40, height: 12, rotation: 0, style: {} } },
      { op: "setSelection", pageId: page.id, objectIds: ["mark"] }
    ] });
    f.docs.set("a", before);
    const request = await f.start("first");
    try {
      const session = await request.openSession([], ["move_objects"]);
      const pending = f.mcp(session.sessionId, "tools/call", { name: "move_objects",
        arguments: { objectIds: ["mark"], to: { arrange: "row" } } });
      await vi.advanceTimersByTimeAsync(0);
      expect(confirm).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(300_000);
      const reason = "declined: no answer to the enlarge-page question within 5 minutes";
      const result = { objectIds: [], summary: `Inserted 0 fitting objects; ${reason}: This content.`,
        warnings: [], declined: ["This content"], reason };
      expect(await pending).toEqual({ result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] } });
      late.resolve("enlarge");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.docs.get("a")).toBe(before);
    } finally { await request.finish(); vi.useRealTimers(); }
  });

  it("replaces all 15 default names and dispatches only the snapshotted definitions", async () => {
    const f = fixture();
    const seen: string[] = [];
    const request = await f.start("first", (_ctx, call) => {
      seen.push(call.name);
      return { ok: true, value: { plugin: "first", name: call.name } };
    });
    const definitions = nativeNames.map(definition);
    const session = await request.openSession(definitions);
    definitions[0]!.name = "changed";
    definitions[0]!.inputSchema.required = ["forged"];
    expect(session.tools).toEqual(nativeNames);
    const listing = await f.mcp(session.sessionId, "tools/list", {});
    expect(listing).toEqual({ result: { tools: nativeNames.map(definition) } });
    for (const name of nativeNames) {
      expect(await f.mcp(session.sessionId, "tools/call", { name })).toMatchObject({ result: { structuredContent: { plugin: "first", name } } });
    }
    expect(seen).toEqual(nativeNames);
    expect(f.open.mock.calls[0]![2].tools.every(tool => tool.deadline === "requestWrite")).toBe(true);
    await request.finish();
    expect(f.close).toHaveBeenCalledWith(session.sessionId);
  });

  it("combines selected providers once, rejects collisions atomically, and isolates two owners", async () => {
    const f = fixture();
    const one = await f.start("first", () => ({ ok: true, value: "first" }));
    const two = await f.start("second", () => ({ ok: true, value: "second" }));
    const read = definition("get_structure");
    const a = await one.openSession([read], ["get_document"]);
    const b = await two.openSession([read]);
    expect(a.tools).toEqual(["get_structure", "get_document"]);
    expect(await a.call("get_structure")).toMatchObject({ content: [{ text: "first" }] });
    expect(await b.call("get_structure")).toMatchObject({ content: [{ text: "second" }] });
    expect(await a.call("get_document")).toHaveProperty("structuredContent");
    await expect(b.call("get_document")).rejects.toThrow("Unknown session tool");
    expect(await f.mcp(b.sessionId, "tools/call", { name: "get_document" })).toMatchObject({ error: { code: -32602 } });
    expect(() => f.controller.list(b.owner, a.sessionId)).toThrow("Unknown tool session");
    await expect(f.controller.call(a.owner, b.sessionId, "get_structure", {})).rejects.toThrow("Unknown tool session");
    expect(await two.ctx.toolSessions!.close({ sessionId: a.sessionId })).toMatchObject({ ok: false, error: { code: "permission" } });
    for (const hostTools of [["get_structure"], ["missing"]]) {
      const result = await one.ctx.toolSessions!.open({ requestId: one.requestId, definitions: [read], hostTools });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    expect(f.open).toHaveBeenCalledTimes(2);
    await one.finish(); await two.finish();
  });

  it("uses the verified history and pinned document for both providers after switching tabs", async () => {
    const f = fixture();
    const request = await f.start("first", async (ctx, call) => {
      const context = unwrap(await ctx.requests!.getContext({ requestId: call.requestId }));
      if (call.name === "inspect") {
        expect(ctx.documents.applyRequestPatch).toBeUndefined();
        expect(ctx.hasPermission("document.write")).toBe(false);
        return { ok: true, value: context.documentKey };
      }
      const { pageId } = context.pages[0]!;
      const receipt = await ctx.documents.applyRequestPatch!({ requestId: call.requestId, patch: {
        op: "addObject", pageId, object: { type: "text", id: "note", text: "Worker note", spans: [],
          x: 40, y: 40, width: 80, height: 30, style: {}, rotation: 0 }
      } });
      return { ok: true, value: unwrap(receipt).insertions[0]!.objectId };
    });
    const session = await request.openSession([definition("write_note"), { ...definition("inspect"), readOnly: true }], ["insert_text"]);
    f.switchTo("b");
    expect(await session.call("inspect")).toMatchObject({ content: [{ text: "a" }] });
    expect(await session.call("write_note")).toHaveProperty("content");
    expect(await session.call("insert_text", { text: "Host note" })).toHaveProperty("structuredContent.objectIds");
    expect(f.docs.get("a")!.pages[0]!.objects.map(o => o.type === "text" && o.text)).toEqual(["Worker note", "Host note"]);
    expect(f.docs.get("b")!.pages[0]!.objects).toHaveLength(0);
    expect(f.verify).toHaveBeenCalledTimes(2);
    await request.finish();
  });

  it("rejects the whole catalog before opening when a selected write tool lacks a required permission", async () => {
    const f = fixture();
    const request = await f.start("first", () => ({ ok: true, value: "plugin" }),
      ["document.read", "selection.read", "document.write"]);
    try {
      expect(await request.ctx.toolSessions!.open({ requestId: request.requestId, definitions: [definition("lookup")],
        hostTools: ["get_document", "insert_text"] })).toEqual({
        ok: false, error: { code: "permission", message: 'Tool "insert_text" requires permission "chemistry.compute".' }
      });
      expect(f.open).not.toHaveBeenCalled();
      expect(f.channels.size).toBe(0);
      const session = await request.openSession([definition("lookup")], ["get_document"]);
      expect(session.tools).toEqual(["lookup", "get_document"]);
      expect(f.open).toHaveBeenCalledOnce();
    } finally { await request.finish(); }
  });

  it("validates arguments before dispatch and enforces JSON, schema and aggregate catalog limits", async () => {
    const f = fixture();
    const handler = vi.fn<PluginToolHandler>(() => ({ ok: true, value: true }));
    const request = await f.start("first", handler);
    const schema: PluginToolDefinition["inputSchema"] = { type: "object", properties: {
      codes: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1, maxLength: 1 } },
      count: { type: "integer", minimum: 1, maximum: 2 },
      mode: { type: "object", enum: [{ a: true, b: null }] }
    }, required: ["codes", "count", "mode"], additionalProperties: false };
    const session = await request.openSession([{ ...definition("check"), inputSchema: schema }]);
    const good = { codes: ["💧"], count: 2, mode: { b: null, a: true } };
    await session.call("check", good);
    for (const bad of [{}, { ...good, codes: [] }, { ...good, count: 1.5 }, { ...good, mode: { a: true } },
      { ...good, extra: true }, { ...good, codes: ["aa"] }, { data: "x".repeat(1024 * 1024) }]) {
      await expect(session.call("check", bad)).rejects.toThrow();
    }
    expect(await f.mcp(session.sessionId, "tools/call", { name: "check", arguments: null })).toHaveProperty("error");
    expect(handler).toHaveBeenCalledTimes(1);
    const large = { type: "object" as const, properties: { key: { type: "string" as const, enum: ["x".repeat(15_000)] } } };
    const deep = Array.from({ length: 34 }).reduce<unknown>(items => ({ type: "array", items }), { type: "string" });
    for (const defs of [
      Array.from({ length: 33 }, (_, i) => definition(`n_${i}`)),
      Array.from({ length: 10 }, (_, i) => ({ ...definition(`n_${i}`), inputSchema: large })),
      [{ ...definition("huge"), inputSchema: { type: "object", enum: ["é".repeat(9000)] } }],
      [{ ...definition("deep"), inputSchema: { type: "object", properties: { deep } } }]
    ]) expect(await request.ctx.toolSessions!.open({ requestId: request.requestId, definitions: defs as PluginToolDefinition[] }))
      .toMatchObject({ ok: false, error: { code: "limit" } });
    expect(f.open).toHaveBeenCalledTimes(1);
    await request.finish();
  });

  it("passes through MCP content and enforces the encoded result ceiling on direct calls", async () => {
    const f = fixture();
    const png = picturePngBase64;
    const request = await f.start("first", (_ctx, call): PluginToolCallResult => {
      if (call.name === "image") return { ok: true, value: { content: [{ type: "image", data: png, mimeType: "image/png" }] } };
      return { ok: true, value: { text: "x".repeat(5 * 1024 * 1024) } };
    });
    const session = await request.openSession([definition("image"), definition("large")]);
    expect(await session.call("image")).toEqual({ content: [{ type: "image", data: png, mimeType: "image/png" }] });
    await expect(session.call("large")).rejects.toMatchObject({ code: "limit" });
    await request.finish();
  });

  it("refuses malformed PNG chunks, dimensions, and payload sizes before replying over MCP", async () => {
    const f = fixture();
    let data = "";
    const request = await f.start("first", () => ({
      ok: true, value: { content: [{ type: "image", data, mimeType: "image/png" }] }
    }));
    try {
      const session = await request.openSession([definition("image")]);
      const png = Buffer.from(picturePngBase64, "base64");
      const header = png.subarray(0, 33);
      const tooWide = Buffer.from(png);
      tooWide.writeUInt32BE(2049, 16);
      const zeroHeight = Buffer.from(png);
      zeroHeight.writeUInt32BE(0, 20);
      const badCrc = Buffer.from(png);
      badCrc[badCrc.length - 13] ^= 1; // IDAT's CRC, just before IEND.
      const oversized = (bytes: number) => {
        const payload = Buffer.alloc(bytes);
        header.copy(payload);
        return payload.toString("base64");
      };
      for (const [candidate, message] of [
        ["iVBORw0KGgo=", "complete image header"],
        [Buffer.alloc(33).toString("base64"), "PNG signature"],
        [header.toString("base64"), "missing IEND"],
        [Buffer.concat([header, png.subarray(-12)]).toString("base64"), "missing IDAT"],
        [png.subarray(0, 45).toString("base64"), "truncated PNG chunk"],
        [png.subarray(0, -1).toString("base64"), "truncated PNG chunk"],
        [png.subarray(0, -12).toString("base64"), "missing IEND"],
        [Buffer.concat([png, Buffer.of(0)]).toString("base64"), "IEND must be last"],
        [badCrc.toString("base64"), "CRC"],
        [tooWide.toString("base64"), "dimensions"],
        [zeroHeight.toString("base64"), "dimensions"],
        [oversized(3 * 1024 * 1024 + 1), "Encoded PNG exceeds the 4 MiB"],
        [oversized(4 * 1024 * 1024 + 1), "Rendered PNG exceeds the 4 MiB"]
      ] as const) {
        data = candidate;
        expect(await f.mcp(session.sessionId, "tools/call", { name: "image" }))
          .toEqual({ error: { code: -32000, message: expect.stringContaining(message) } });
      }
    } finally { await request.finish(); }
  });

  it("closes a native session that finishes opening after the request ends", async () => {
    const f = fixture();
    const ready = deferred<{ sessionId: string; serverName: "chemdraft" }>();
    f.open.mockImplementationOnce(() => ready.promise);
    const request = await f.start("first");
    const opening = request.ctx.toolSessions!.open({ requestId: request.requestId, definitions: [], hostTools: ["get_selection"] });
    unwrap(await request.end());
    ready.resolve({ sessionId: "late", serverName: "chemdraft" });
    expect(await opening).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.close).toHaveBeenCalledWith("late");
    await request.finish();
  });

  it("discards late results, invalidates writes, and charges disconnected calls until the handlers settle", async () => {
    const f = fixture();
    const resume = deferred<void>();
    const signals: AbortSignal[] = [];
    const late = vi.fn();
    const one = await f.start("first", async (ctx, call, signal) => {
      signals.push(signal);
      await resume.promise;
      late(await ctx.requests!.getContext({ requestId: call.requestId }));
      return { ok: true, value: "late" };
    });
    const a = await one.openSession([definition("pending")]);
    const two = await f.start("second", () => ({ ok: true, value: "live" }));
    const b = await two.openSession([definition("another")]);
    const requests = Array.from({ length: 4 }, (_, i) => f.mcp(a.sessionId, "tools/call", { name: "pending" }, String(i)));
    f.channels.get(a.sessionId)!({ sessionId: a.sessionId, requestId: "0", method: "cancel", params: {} });
    expect(await requests[0]).toHaveProperty("error");
    expect(signals.map(signal => signal.aborted)).toEqual([true, false, false, false]);
    await expect(a.call("pending")).rejects.toMatchObject({ code: "busy" });
    unwrap(await one.end());
    expect(await Promise.all(requests)).toEqual(Array(4).fill(expect.objectContaining({ error: expect.anything() })));
    await expect(b.call("another")).rejects.toMatchObject({ code: "busy" });
    resume.resolve();
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(4));
    expect(late.mock.calls.every(([result]) => !result.ok && result.error.code === "cancelled")).toBe(true);
    expect(await b.call("another")).toMatchObject({ content: [{ text: "live" }] });
    f.host.unregisterPlugin("second");
    expect(f.close).toHaveBeenCalledWith(b.sessionId);
    await one.finish(); await two.finish();
  });

  it("bounds preparation, gesture and consent time independently under the native ceiling", () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const clock = toolDeadline("requestWrite", abort);
      vi.advanceTimersByTime(30_000);
      const resume = clock.enterWait("human");
      vi.advanceTimersByTime(299_000); resume();
      const ready = clock.enterWait("gesture"); vi.advanceTimersByTime(60_000); ready();
      expect(abort.signal.aborted).toBe(false);
      vi.advanceTimersByTime(30_001);
      expect(abort.signal.aborted).toBe(true);
      clock.stop();
      for (const [phase, ms] of [["gesture", 61_000], ["human", 300_000]] as const) {
        const abort = new AbortController();
        const clock = toolDeadline("requestWrite", abort); clock.enterWait(phase);
        vi.advanceTimersByTime(ms); expect(abort.signal.aborted).toBe(true); clock.stop();
      }
    } finally { vi.useRealTimers(); }
  });
});
