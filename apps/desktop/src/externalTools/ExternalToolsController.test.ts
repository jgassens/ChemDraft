import { describe, expect, it, vi } from "vitest";
import type { ExternalToolsEngine } from "./externalToolsEngine";
import { ExternalToolsController, type ExternalToolsPresenter } from "./ExternalToolsController";

const status = (consented = false) => ({ tool: "claude" as const, publisher: "Anthropic", state: "installed" as const, pinnedVersion: "2", pinnedDownloadBytes: 274_675_680, freeDiskBytes: 4_000_000_000, canInstall: true, consented, probedAt: "now" });
function engine(): ExternalToolsEngine {
  return { status: vi.fn(async () => status()), install: vi.fn(async () => ({})), cancelInstall: vi.fn(async () => undefined), uninstall: vi.fn(async () => undefined), signIn: vi.fn(async () => ({ launched: true, method: "terminal.command" as const })), consentSet: vi.fn(async () => undefined), consentRevoke: vi.fn(async () => undefined), consentClearPlugin: vi.fn(async () => undefined), consentList: vi.fn(async () => []), runStart: vi.fn(async () => ({ runId: "run", pid: 1, cwd: "/tmp", startedAt: "now" })), runPoll: vi.fn(async () => ({ lines: [], nextCursor: 0, droppedLines: 0, status: { state: "running" as const } })), runCancel: vi.fn(async () => undefined), conversationClear: vi.fn(async () => undefined) };
}
const plugin = { id: "plugin", name: "Plugin" };
const request = { tool: "claude" as const, conversationId: "conversation", prompt: "p", systemPrompt: "s", mcpSessionId: "" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe("ExternalToolsController", () => {
  it("does not start after unloading during status discovery", async () => {
    const e = engine(); const pending = deferred<ReturnType<typeof status>>();
    vi.mocked(e.status).mockReturnValue(pending.promise);
    const presenter = { consent: vi.fn(), install: vi.fn() };
    const controller = new ExternalToolsController(e, presenter);
    const run = controller.run(plugin, request);
    controller.cancelAllForPlugin(plugin.id);
    pending.resolve(status());
    await expect(run).rejects.toThrow("plugin was unloaded");
    expect(presenter.consent).not.toHaveBeenCalled();
    expect(e.runStart).not.toHaveBeenCalled();
  });
  it("aborts consent and does not start after unloading during consent", async () => {
    const e = engine(); const pending = deferred<"granted">();
    const consent = vi.fn<ExternalToolsPresenter["consent"]>(() => pending.promise);
    const controller = new ExternalToolsController(e, { consent, install: vi.fn() });
    const run = controller.run(plugin, request);
    await vi.waitFor(() => expect(consent).toHaveBeenCalled());
    controller.cancelAllForPlugin(plugin.id);
    expect(consent.mock.calls[0][2].aborted).toBe(true);
    pending.resolve("granted");
    await expect(run).rejects.toThrow("plugin was unloaded");
    expect(e.consentSet).not.toHaveBeenCalled();
    expect(e.runStart).not.toHaveBeenCalled();
  });
  it("cancels a process returned after unloading while runStart is pending", async () => {
    const e = engine(); vi.mocked(e.status).mockResolvedValue(status(true));
    const pending = deferred<Awaited<ReturnType<ExternalToolsEngine["runStart"]>>>();
    vi.mocked(e.runStart).mockReturnValue(pending.promise);
    const controller = new ExternalToolsController(e);
    const run = controller.run(plugin, request);
    await vi.waitFor(() => expect(e.runStart).toHaveBeenCalled());
    controller.cancelAllForPlugin(plugin.id);
    pending.resolve({ runId: "late", pid: 1, cwd: "/tmp", startedAt: "now" });
    await expect(run).rejects.toThrow("plugin was unloaded");
    expect(e.runCancel).toHaveBeenCalledWith("late");
    await expect(controller.poll(plugin, { runId: "late", cursor: 0 })).rejects.toThrow("notOwner");
  });
  it("does not continue after unloading during consent persistence", async () => {
    const e = engine(); const pending = deferred<void>();
    vi.mocked(e.consentSet).mockReturnValue(pending.promise);
    const controller = new ExternalToolsController(e, { consent: async () => "granted", install: vi.fn() });
    const run = controller.run(plugin, request);
    await vi.waitFor(() => expect(e.consentSet).toHaveBeenCalled());
    controller.cancelAllForPlugin(plugin.id); pending.resolve();
    await expect(run).rejects.toThrow("plugin was unloaded");
    expect(e.runStart).not.toHaveBeenCalled();
  });
  it("rejects an install or sign-in completion after unload and allows a new generation", async () => {
    const e = engine(); vi.mocked(e.status).mockResolvedValue(status(true));
    const installing = deferred<ReturnType<typeof status>>();
    const signingIn = deferred<Awaited<ReturnType<ExternalToolsEngine["signIn"]>>>();
    vi.mocked(e.signIn).mockReturnValue(signingIn.promise);
    const install = vi.fn<ExternalToolsPresenter["install"]>(() => installing.promise);
    const controller = new ExternalToolsController(e, { consent: vi.fn(), install });
    const result = controller.install(plugin, { tool: "claude" }, new AbortController().signal);
    const signIn = controller.signIn(plugin, { tool: "claude" });
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    controller.cancelAllForPlugin(plugin.id);
    expect(install.mock.calls[0][2].aborted).toBe(true);
    installing.resolve(status(true)); signingIn.resolve({ launched: true, method: "terminal.command" });
    await expect(result).rejects.toThrow("plugin was unloaded");
    await expect(signIn).rejects.toThrow("plugin was unloaded");
    await expect(controller.run(plugin, request)).resolves.toMatchObject({ runId: "run" });
  });
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
  it("parses every checked-in status wire fixture", async () => {
    const fixtures = Object.values(import.meta.glob("./__fixtures__/wire/status-*.json", { eager: true, import: "default" }));
    const e = engine(); const controller = new ExternalToolsController(e);
    for (const fixture of fixtures) {
      vi.mocked(e.status).mockResolvedValueOnce(fixture as Awaited<ReturnType<ExternalToolsEngine["status"]>>);
      await expect(controller.status(plugin, { tool: (fixture as { tool: "claude" | "codex" }).tool, refresh: true })).resolves.toMatchObject(fixture as object);
    }
  });
});
