import { describe, expect, it, vi } from "vitest";
import type { ExternalToolsEngine } from "./externalToolsEngine";
import { ExternalToolsController } from "./ExternalToolsController";

const status = (consented = false) => ({ tool: "claude" as const, state: "installed" as const, pinnedVersion: "2", canInstall: true, consented, probedAt: "now" });
function engine(): ExternalToolsEngine {
  return { status: vi.fn(async () => status()), install: vi.fn(async () => ({})), cancelInstall: vi.fn(async () => undefined), uninstall: vi.fn(async () => undefined), signIn: vi.fn(async () => ({ launched: true, method: "terminal.command" as const })), consentSet: vi.fn(async () => undefined), consentList: vi.fn(async () => []), runStart: vi.fn(async () => ({ runId: "run", pid: 1, cwd: "/tmp", startedAt: "now" })), runPoll: vi.fn(async () => ({ lines: [], nextCursor: 0, droppedLines: 0, status: { state: "running" as const } })), runCancel: vi.fn(async () => undefined), conversationClear: vi.fn(async () => undefined) };
}
const plugin = { id: "plugin", name: "Plugin" };
const request = { tool: "claude" as const, conversationId: "conversation", prompt: "p", systemPrompt: "s", mcpSessionId: "" };
describe("ExternalToolsController", () => {
  it("grants consent before running and rejects a declined tool", async () => {
    const e = engine(); const controller = new ExternalToolsController(e, { consent: vi.fn(async () => "granted" as const), install: vi.fn() });
    await controller.run(plugin, request);
    expect(e.consentSet).toHaveBeenCalledWith("claude", "plugin", true);
    expect(e.runStart).toHaveBeenCalled();
    await expect(new ExternalToolsController(e, { consent: async () => "declined", install: vi.fn() }).run(plugin, request)).rejects.toThrow("declined");
  });
  it("enforces run ownership and cancels all owned runs on unregister", async () => {
    const e = engine(); vi.mocked(e.status).mockResolvedValue(status(true)); const controller = new ExternalToolsController(e);
    await controller.run(plugin, request);
    await expect(controller.poll({ id: "other", name: "Other" }, { runId: "run", cursor: 0 })).rejects.toThrow("notOwner");
    controller.cancelAllForPlugin("plugin");
    expect(e.runCancel).toHaveBeenCalledWith("run");
  });
});
