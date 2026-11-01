import { describe, expect, it, vi } from "vitest";
import { AssistantCapabilityPermissions, type PluginAssistantAPI } from "@chemdraft/plugin-api";
import { PluginHost, type PluginHostAssistant } from "./index";

const manifest = { id: "org.test.assistant", name: "Assistant", version: "0", apiVersion: "^0.1.9", entry: "worker.js", permissions: [...AssistantCapabilityPermissions] };
function capability(): PluginHostAssistant {
  return { listTools: vi.fn(async () => []), callTool: vi.fn(async () => ({ content: [] })),
    beginRequest: vi.fn(async () => ({ requestId: "request" })),
    endRequest: vi.fn(async () => ({ touchedIds: [], summary: "done", split: false })),
    createToolSession: vi.fn(async () => ({ sessionId: "session", serverName: "chemdraft" as const, tools: [] })),
    closeToolSession: vi.fn(async () => {}), closeAllForPlugin: vi.fn() };
}
describe("assistant host gate", () => {
  it.each(AssistantCapabilityPermissions)("omits the capability without %s", permission => {
    // assistant.run alone requires native.execute at manifest validation too.
    const permissions = manifest.permissions.filter(p => p !== permission && !(permission === "native.execute" && p === "assistant.run"));
    const host = new PluginHost({ assistant: capability() });
    host.registerPlugin({ ...manifest, permissions });
    expect(host.createCommandContext(manifest.id).assistant).toBeUndefined();
  });
  it("forwards every method with plugin identity, rechecks every permission, and cleans up on unregister", async () => {
    const assistant = capability();
    const host = new PluginHost({ assistant });
    host.registerPlugin(manifest);
    const api = host.createCommandContext(manifest.id).assistant!;
    const args: { [K in keyof PluginAssistantAPI]: Parameters<PluginAssistantAPI[K]> } = {
      listTools: [], callTool: [{ name: "get_document", input: {} }], beginRequest: [{ prompt: "draw" }],
      endRequest: [{ requestId: "request" }], createToolSession: [{ requestId: "request" }], closeToolSession: [{ sessionId: "session" }]
    };
    for (const method of Object.keys(args) as (keyof PluginAssistantAPI)[]) {
      const call = api[method] as (...a: unknown[]) => Promise<unknown>;
      await call(...args[method]);
      expect(assistant[method]).toHaveBeenCalledWith(expect.objectContaining({ id: manifest.id, name: manifest.name }), ...args[method]);
      for (const permission of AssistantCapabilityPermissions) {
        const original = host.requirePermission.bind(host);
        const check = vi.spyOn(host, "requirePermission").mockImplementation((id, p) => {
          if (p === permission) throw new Error(`revoked ${permission}`);
          original(id, p);
        });
        await expect(call(...args[method])).rejects.toThrow(`revoked ${permission}`);
        check.mockRestore();
      }
    }
    host.unregisterPlugin(manifest.id);
    expect(assistant.closeAllForPlugin).toHaveBeenCalledWith(manifest.id);
    await expect(api.listTools()).rejects.toThrow();
  });
  it("reports unavailable implementation despite permission-based presence", async () => {
    const host = new PluginHost(); host.registerPlugin(manifest);
    await expect(host.createCommandContext(manifest.id).assistant!.listTools()).rejects.toThrow("no assistant tools");
  });
});
