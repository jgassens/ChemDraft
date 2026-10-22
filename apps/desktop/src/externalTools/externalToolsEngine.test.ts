import { describe, expect, it, vi } from "vitest";
import { TauriExternalToolsEngine } from "./externalToolsEngine";

describe("TauriExternalToolsEngine", () => {
  it("uses Rust command and camelCase argument names, including an install Channel", async () => {
    const invoke = vi.fn(async <T>(command: string, args?: Record<string, unknown>) => {
      if (command === "external_tool_install") (args!.onProgress as { onmessage(value: unknown): void }).onmessage({ phase: "downloading", message: "Downloading", bytesDone: 1 });
      return {} as T;
    });
    let channel: { onmessage(value: unknown): void } | undefined;
    const engine = new TauriExternalToolsEngine(invoke as ConstructorParameters<typeof TauriExternalToolsEngine>[0], () => (channel = { onmessage: () => undefined }));
    const progress = vi.fn();
    await engine.install("claude", progress);
    expect(invoke).toHaveBeenCalledWith("external_tool_install", { tool: "claude", onProgress: channel });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "downloading" }));
    await engine.runPoll({ runId: "run", cursor: 2, maxLines: 3, waitMs: 4 });
    expect(invoke).toHaveBeenLastCalledWith("external_tool_run_poll", { runId: "run", cursor: 2, maxLines: 3, waitMs: 4 });
    await engine.runStart({ tool: "codex", pluginId: "plugin", conversationId: "conversation", prompt: "p", systemPrompt: "s", mcpSessionId: "" });
    expect(invoke).toHaveBeenLastCalledWith("external_tool_run_start", { request: expect.objectContaining({ pluginId: "plugin" }) });
  });
});
