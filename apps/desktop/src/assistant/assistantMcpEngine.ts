import { Channel, invoke } from "@tauri-apps/api/core";

import type { McpBridgeRequest, McpBridgeResponse, NativeToolCatalog, ToolSessionTransport } from "../plugins/toolSessions/transport";
export type { McpBridgeRequest, McpBridgeResponse } from "../plugins/toolSessions/transport";

export interface AssistantMcpEngine extends ToolSessionTransport {
  status(): Promise<{ listening: boolean; sessionCount: number }>;
}

export class TauriAssistantMcpEngine implements AssistantMcpEngine {
  constructor(private readonly call: typeof invoke = invoke, private readonly channel = () => new Channel<McpBridgeRequest>()) {}
  open(plugin: { id: string; name: string }, listener: (request: McpBridgeRequest) => void, catalog: NativeToolCatalog) {
    const onRequest = this.channel();
    onRequest.onmessage = listener;
    return this.call<{ sessionId: string; serverName: "chemdraft" }>("assistant_mcp_session_open", {
      pluginId: plugin.id, pluginName: plugin.name, onRequest, catalog
    });
  }
  close(sessionId: string) { return this.call<void>("assistant_mcp_session_close", { sessionId }); }
  respond(sessionId: string, requestId: string, response: McpBridgeResponse) {
    return this.call<void>("assistant_mcp_respond", { sessionId, requestId, response });
  }
  status() { return this.call<{ listening: boolean; sessionCount: number }>("assistant_mcp_status"); }
}

export class UnsupportedAssistantMcpEngine implements AssistantMcpEngine {
  async open(): Promise<never> { throw new Error("Assistant MCP sessions require the desktop app."); }
  async close(): Promise<void> {}
  async respond(): Promise<never> { throw new Error("Assistant MCP sessions require the desktop app."); }
  async status() { return { listening: false, sessionCount: 0 }; }
}
