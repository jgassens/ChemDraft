import {
  PluginMcpToolResultSchema, PluginOpenToolSessionSchema, PluginRequestLimits, PluginToolCallResultSchema, PluginToolCallSchema, requestValidationCode,
  type PluginMcpToolResult, type PluginRequestArguments, type PluginRequestJsonObject, type PluginToolCall
} from "@chemdraft/plugin-api";
import { RequestWriteError, type PluginHostToolSessions, type RequestToolExecution, type ToolSessionBinding } from "@chemdraft/plugin-host";
import { validateMcpPng } from "../../assistant/mcpPng";
import { toolDeadline } from "./deadlines";
import { validateToolArguments } from "./toolArguments";
import { DesktopToolCalls, type McpBridgeRequest, type McpBridgeResponse, type ToolDeadlineClass, type ToolSessionTransport } from "./transport";

export interface ToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown> }
export type McpToolResult = PluginMcpToolResult;
export interface SessionTool {
  descriptor: ToolDescriptor;
  deadline: ToolDeadlineClass;
  validate(input: PluginRequestJsonObject): void;
  execute(call: PluginToolCall, signal: AbortSignal, timing: RequestToolExecution): Promise<McpToolResult>;
}
export type HostToolProvider = (binding: ToolSessionBinding, name: string) => SessionTool | undefined;

interface Session {
  binding: ToolSessionBinding;
  tools: Map<string, SessionTool>;
  pending: Map<string, AbortController>;
  release(): void;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function pluginTool(binding: ToolSessionBinding, definition: PluginRequestArguments<"toolSessions", "open">["definitions"][number]): SessionTool {
  const { name, description, inputSchema } = definition;
  const readOnly = definition.readOnly === true || !binding.plugin.permissions.includes("document.write") ||
    !binding.plugin.permissions.includes("chemistry.compute");
  return {
    descriptor: { name, description, inputSchema: { ...inputSchema } }, deadline: readOnly ? "readCompute" : "requestWrite",
    validate: input => validateToolArguments(inputSchema, input),
    execute: async (call, signal, timing) => {
      const raw = await binding.invoke(call, signal, readOnly, timing);
      signal.throwIfAborted();
      const result = PluginToolCallResultSchema.safeParse(raw);
      if (!result.success) throw new RequestWriteError(requestValidationCode(result.error), "Invalid tool result.");
      if (!result.data.ok) return { isError: true, content: [{ type: "text", text: result.data.error.message }] };
      const value = result.data.value;
      if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.content)) {
        const content = PluginMcpToolResultSchema.safeParse(value);
        if (content.success) {
          for (const block of content.data.content) {
            if (block.type === "image") validateMcpPng(block.data);
          }
          return content.data;
        }
      }
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
        ...(value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}) };
    }
  };
}

export class ToolSessionController implements PluginHostToolSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<symbol, string>();
  constructor(private readonly transport: ToolSessionTransport, private readonly hostTool: HostToolProvider,
    private readonly calls = new DesktopToolCalls()) {}

  async open(binding: ToolSessionBinding, raw: PluginRequestArguments<"toolSessions", "open">) {
    binding.check();
    const parsed = PluginOpenToolSessionSchema.safeParse(raw);
    if (!parsed.success) throw new RequestWriteError(requestValidationCode(parsed.error), "Invalid tool catalog.");
    const input = parsed.data;
    if (input.requestId !== binding.requestId) throw new RequestWriteError("permission", "Request does not own this catalog.");
    if (input.definitions.length && !binding.hasHandler) throw new RequestWriteError("missingHandler", "No tool handler registered.");
    const catalog = input.definitions.map(definition => pluginTool(binding, definition));
    for (const name of input.hostTools ?? []) {
      const tool = this.hostTool(binding, name);
      if (!tool || tool.descriptor.name !== name) throw new RequestWriteError("invalid", `Unknown host tool "${name}".`);
      if (bytes(tool.descriptor.inputSchema) > PluginRequestLimits.schemaBytes || tool.descriptor.description.length > 1000) {
        throw new RequestWriteError("limit", "Host descriptor exceeds the session tool limits.");
      }
      catalog.push({ ...tool, descriptor: structuredClone(tool.descriptor) });
    }
    if (bytes(catalog.map(tool => tool.descriptor)) > PluginRequestLimits.catalogBytes) {
      throw new RequestWriteError("limit", "Tool catalog exceeds 128 KiB.");
    }
    const tools = new Map(catalog.map(tool => [tool.descriptor.name, tool]));
    const reservations = [...this.opening.values(), ...Array.from(this.sessions.values(), session => session.binding.plugin.id)];
    if (reservations.length >= 8 || reservations.filter(id => id === binding.plugin.id).length >= 2) {
      throw new RequestWriteError("limit", "MCP session limit reached.");
    }
    const reservation = Symbol();
    this.opening.set(reservation, binding.plugin.id);
    try {
      let liveId: string | undefined;
      const opened = await this.transport.open(binding.plugin, message => {
        if (message.sessionId === liveId) void this.bridge(binding.owner, message);
      }, { legacy: false, tools: catalog.map(tool => ({ name: tool.descriptor.name, deadline: tool.deadline })) });
      try {
        binding.signal.throwIfAborted();
        binding.check();
      } catch {
        await this.transport.close(opened.sessionId);
        throw new RequestWriteError("cancelled", "The request ended while opening its tool session.");
      }
      const id = opened.sessionId;
      const abandon = () => { void this.close(binding.owner, id).catch(() => {}); };
      binding.signal.addEventListener("abort", abandon, { once: true });
      this.sessions.set(id, { binding, tools, pending: new Map(), release: () => binding.signal.removeEventListener("abort", abandon) });
      liveId = id;
      return { sessionId: id, tools: [...tools.keys()] };
    } finally { this.opening.delete(reservation); }
  }

  private owned(owner: symbol, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.binding.owner !== owner) throw new RequestWriteError("permission", "Unknown tool session for this invocation.");
    return session;
  }

  async close(owner: symbol, id: string) {
    const session = this.owned(owner, id);
    this.sessions.delete(id);
    session.release();
    for (const abort of session.pending.values()) abort.abort(new RequestWriteError("cancelled", "Tool session closed."));
    await this.transport.close(id);
  }

  list(owner: symbol, sessionId: string) {
    const session = this.owned(owner, sessionId);
    session.binding.check();
    return [...session.tools.values()].map(tool => structuredClone(tool.descriptor));
  }

  async call(owner: symbol, sessionId: string, name: string, input: unknown, callId: string = crypto.randomUUID()): Promise<McpToolResult> {
    const session = this.owned(owner, sessionId);
    const { binding, pending } = session;
    binding.check();
    const tool = session.tools.get(name);
    if (!tool) throw new RequestWriteError("invalid", "Unknown session tool.");
    if (pending.size >= PluginRequestLimits.pendingToolCalls || pending.has(callId) || !this.calls.acquire()) {
      throw new RequestWriteError("busy", "At most four tool calls may run concurrently.");
    }
    const abort = new AbortController();
    pending.set(callId, abort);
    const timing = toolDeadline(tool.deadline, abort);
    const cancelled = new Promise<never>((_, reject) =>
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }));
    const work = (async () => {
      try {
        const parsed = PluginToolCallSchema.safeParse({ requestId: binding.requestId, sessionId, name, input });
        if (!parsed.success) throw new RequestWriteError(requestValidationCode(parsed.error), "Invalid tool call.");
        tool.validate(parsed.data.input);
        return await tool.execute(parsed.data, abort.signal, timing);
      } finally { pending.delete(callId); this.calls.release(); }
    })();
    try {
      const result = await Promise.race([work, cancelled]);
      abort.signal.throwIfAborted();
      this.owned(owner, sessionId);
      binding.check();
      if (bytes({ result }) > PluginRequestLimits.resultBytes) throw new RequestWriteError("limit", "MCP result exceeds 8 MiB.");
      return result;
    } finally { timing.stop(); }
  }

  private async bridge(owner: symbol, message: McpBridgeRequest) {
    let response: McpBridgeResponse;
    const { sessionId, requestId } = message;
    try {
      if (message.method === "cancel") {
        this.owned(owner, sessionId).pending.get(requestId)?.abort(new RequestWriteError("cancelled", "Tool call cancelled."));
        return;
      }
      if (message.method === "tools/list") response = { result: { tools: this.list(owner, sessionId) } };
      else if (message.method === "tools/call") {
        const params = message.params as { name?: unknown; arguments?: unknown } | null;
        if (typeof params?.name !== "string") throw new RequestWriteError("invalid", "A tool name is required.");
        response = { result: await this.call(owner, sessionId, params.name, Object.hasOwn(params, "arguments") ? params.arguments : {}, requestId) };
      } else throw new RequestWriteError("invalid", "Unsupported MCP method.");
    } catch (error) {
      response = { error: { code: error instanceof RequestWriteError && error.code === "invalid" ? -32602 : -32000,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) } };
    }
    try { await this.transport.respond(sessionId, requestId, response); } catch { /* The caller disconnected or closed the session. */ }
  }
}
