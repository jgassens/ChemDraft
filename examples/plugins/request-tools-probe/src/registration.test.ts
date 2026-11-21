import { describe, expect, it, vi } from "vitest";
import { PluginManifestSchema } from "@chemdraft/plugin-api";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { commandId, manifest, panelId } from "./index";
import { createProbeRegistration } from "./register";

describe("Request Tools Probe", () => {
  it("declares a valid SDK 0.1.26 manifest", () => {
    const parsed = PluginManifestSchema.parse(manifest);
    expect(parsed.apiVersion).toBe("^0.1.26");
    expect(parsed.entry).toBe("entry.js");
  });

  it("registers one worker handler and one Plugins menu item per probe command", () => {
    const registered = createProbeRegistration();
    const names = [
      "pinnedRead", "insert", "outsideScope", "pageSpace", "openSession", "measure", "render", "events", "end"
    ];
    const ids = names.map(name => `plugin.requestToolsProbe.${name}`).sort();
    expect(registered.manifest).toBe(manifest);
    expect(Object.keys(registered.commandHandlers).sort()).toEqual(ids);
    expect(manifest.contributes.commands.map(command => command.id).sort()).toEqual(ids);
    expect(manifest.contributes.menus.map(menu => menu.commandId).sort()).toEqual(ids);
    expect(manifest.contributes.menus.every(menu => menu.location === "plugins")).toBe(true);
    for (const id of ids) expect(typeof registered.commandHandlers[id]).toBe("function");
    expect(typeof registered.onToolCall).toBe("function");
    expect(typeof registered.onActiveDocumentChanged).toBe("function");
  });

  it("releases a session when the pinned document closes, but not on a tab switch", async () => {
    const registration = createProbeRegistration();
    let closed = false;
    const ctx = {
      requests: { begin: vi.fn(async () => ({ ok: true, value: { requestId: "r" } })),
        getContext: vi.fn(async () => closed ? { ok: false, error: { code: "cancelled", message: "closed" } } :
          { ok: true, value: { documentKey: "a", pages: [], selection: [] } }),
        end: vi.fn(async () => ({ ok: true, value: { touched: [] } })) },
      toolSessions: { open: vi.fn(async () => ({ ok: true, value: { tools: [] } })) },
      panels: { showReport: vi.fn(async () => {}) }
    } as unknown as PluginCommandContext;
    const running = registration.commandHandlers[commandId("openSession")]!(ctx);
    await vi.waitFor(() => expect(ctx.panels!.showReport).toHaveBeenCalled());
    await registration.onActiveDocumentChanged!({ documentKey: "b", sequence: 1 });
    await vi.waitFor(() => expect(ctx.requests!.getContext).toHaveBeenCalledTimes(2));
    expect(ctx.requests!.end).not.toHaveBeenCalled();
    closed = true;
    await registration.onActiveDocumentChanged!({ documentKey: "b", sequence: 2 });
    await running;
    await registration.commandHandlers[commandId("measure")]!(ctx);
    expect(ctx.requests!.begin).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unanswered", true, "PASSED"], ["keep", true, "FAILED"], ["enlarge", true, "FAILED"],
    ["unanswered", false, "FAILED"]
  ])("checks timed cancellation with %s and end success %s", async (outcome, endOk, expected) => {
    vi.useFakeTimers();
    try {
      const registration = createProbeRegistration();
      let answer!: (result: unknown) => void;
      const reports: string[] = [];
      const ctx = {
        input: { source: "panel", panelId, controlId: "ask-and-end" },
        requests: { begin: async () => ({ ok: true, value: { requestId: "r" } }),
          getContext: async () => ({ ok: true, value: { documentKey: "a", pages: [{ pageId: "p", revision: "r", width: 100, height: 100 }], selection: [] } }),
          end: async () => endOk ? { ok: true, value: { touched: [] } } : { ok: false, error: { code: "cancelled", message: "failed" } },
          requestPageSpace: () => new Promise(resolve => { answer = resolve; }) },
        toolSessions: { open: async () => ({ ok: true, value: { tools: [] } }) },
        documents: { applyRequestPatch: vi.fn() },
        panels: { showReport: async (_id: string, report: unknown) => { reports.push(JSON.stringify(report)); } }
      } as unknown as PluginCommandContext;
      const running = registration.commandHandlers[commandId("pageSpace")]!(ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      answer({ ok: true, value: { outcome, decisionId: "d" } });
      await running;
      expect(reports.join()).toContain(expected);
      expect(ctx.documents.applyRequestPatch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
