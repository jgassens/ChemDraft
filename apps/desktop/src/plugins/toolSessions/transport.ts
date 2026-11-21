export type ToolDeadlineClass = "readCompute" | "requestWrite" | "render" | "naming";
export interface NativeToolCatalog {
  legacy: boolean;
  tools: { name: string; deadline: ToolDeadlineClass }[];
}
export interface McpBridgeRequest {
  sessionId: string;
  requestId: string;
  method: string;
  params: unknown;
}
export type McpBridgeResponse = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
export interface ToolSessionTransport {
  open(plugin: { id: string; name: string }, listener: (request: McpBridgeRequest) => void,
    catalog: NativeToolCatalog): Promise<{ sessionId: string; serverName: "chemdraft" }>;
  close(sessionId: string): Promise<void>;
  respond(sessionId: string, requestId: string, response: McpBridgeResponse): Promise<void>;
}

/** Shared by both session APIs in the document window. */
export class DesktopToolCalls {
  private active = 0;
  acquire(): boolean {
    if (this.active >= 4) return false;
    this.active++;
    return true;
  }
  release(): void { this.active--; }
}
