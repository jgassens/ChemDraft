import { describe, expect, it, vi } from "vitest";
import type { Channel, invoke } from "@tauri-apps/api/core";
import { TauriAssistantMcpEngine, UnsupportedAssistantMcpEngine, type McpBridgeRequest } from "./assistantMcpEngine";

describe("assistant MCP native wire", () => {
  it("uses Rust command names, camelCase args, and the request Channel", async () => {
    const call = vi.fn(async () => ({ sessionId: "session", serverName: "chemdraft" }));
    const channel = { onmessage: (_request: McpBridgeRequest) => {} } as Channel<McpBridgeRequest>;
    const engine = new TauriAssistantMcpEngine(call as typeof invoke, () => channel);
    const listener = vi.fn();
    await expect(engine.open({ id: "plugin", name: "Plugin" }, listener)).resolves.toEqual({ sessionId: "session", serverName: "chemdraft" });
    expect(call).toHaveBeenLastCalledWith("assistant_mcp_session_open", { pluginId: "plugin", pluginName: "Plugin", onRequest: channel });
    const message = { sessionId: "session", requestId: "1", method: "tools/list", params: {} };
    channel.onmessage(message);
    expect(listener).toHaveBeenCalledWith(message);
    const response = { result: { tools: [] } };
    await engine.respond("session", "1", response);
    expect(call).toHaveBeenLastCalledWith("assistant_mcp_respond", { sessionId: "session", requestId: "1", response });
    await engine.close("session");
    expect(call).toHaveBeenLastCalledWith("assistant_mcp_session_close", { sessionId: "session" });
    await engine.status();
    expect(call).toHaveBeenLastCalledWith("assistant_mcp_status");
  });
  it("fails closed outside desktop without opening a listener", async () => {
    const engine = new UnsupportedAssistantMcpEngine();
    await expect(engine.open()).rejects.toThrow("desktop app");
    await expect(engine.status()).resolves.toEqual({ listening: false, sessionCount: 0 });
  });
});
