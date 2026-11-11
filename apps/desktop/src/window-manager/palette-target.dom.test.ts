// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaletteTarget } from "./paletteTarget";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  return {
    listeners,
    emit: vi.fn(async (name: string, payload: unknown) => {
      for (const listener of listeners.get(name) ?? []) listener({ payload });
    }),
    listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(listener); listeners.set(name, handlers);
      return () => { handlers.delete(listener); };
    })
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bus.listen, emit: bus.emit }));
const A = { windowId: "A", tabId: "tab-a" };
const B = { windowId: "B", tabId: "tab-b" };

// Each import graph represents one webview's module state. The native bus is shared; their DOMs
// are not, so document clients attach to the native listener here, as in separate real windows.
async function webview(target?: PaletteTarget) {
  vi.resetModules();
  const manager = await import("./index");
  const routing = await import("./paletteTarget");
  const events = await import("./tauriEvents");
  const tabs = new Set(target ? [target.tabId] : []);
  let current = target;
  const revisions = new Map<string, number>();
  const refused = vi.fn();
  const release = target ? routing.bindPaletteDocument({ getTarget: () => current!, hasTab: id => tabs.has(id),
    getRevision: id => revisions.get(id) ?? 0, onRefused: refused }) : undefined;
  routing.setActivePaletteWindow("A");
  return { manager, routing, events, tabs, release, revisions, refused, activate: (next: PaletteTarget) => { current = next; } };
}
afterEach(() => {
  bus.listeners.clear(); bus.emit.mockClear(); native.invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("palette document targets", () => {
  it("delivers inactive-tab actions on both transports, but reports closed and replaced drawings", async () => {
    vi.stubGlobal("__TAURI__", {});
    const target = { ...A, documentRevision: 0 };
    const a = await webview(target);
    const next = { ...A, tabId: "next-tab", documentRevision: 0 };
    a.tabs.add(next.tabId); a.activate(next);
    for (const kind of ["preview", "commit", "cancel"]) {
      const event = `chemdraft://palette-command-${kind}`;
      const native = vi.fn(), dom = vi.fn();
      const stopNative = await a.events.listenTauriEvent(event, native);
      const stopDom = await (kind === "preview" ? a.manager.listenForPaletteCommandPreviews
        : kind === "commit" ? a.manager.listenForPaletteCommandCommits : a.manager.listenForPaletteCommandCancels)(dom);
      const payload = { target, commandId: "object.opacity:0.4" };
      await bus.emit(event, payload);
      window.dispatchEvent(new CustomEvent(event, { detail: payload }));
      expect(native).toHaveBeenCalledOnce();
      expect(dom).toHaveBeenCalledTimes(2);
      expect(dom).toHaveBeenLastCalledWith(payload.commandId, target);
      stopNative(); stopDom();
    }
    expect(a.refused).not.toHaveBeenCalled();
    a.revisions.set(target.tabId, 1);
    expect(a.routing.acceptsPaletteEvent("chemdraft://palette-command-commit", { target })).toBe(false);
    expect(a.refused).toHaveBeenLastCalledWith("revision");
    a.tabs.delete(target.tabId);
    expect(a.routing.acceptsPaletteEvent("chemdraft://palette-command-commit", { target })).toBe(false);
    expect(a.refused).toHaveBeenLastCalledWith("closed");
    a.release?.();
  });

  it.each(["commit", "cancel", "settled commit"])("settles a preview in A after B activates: %s", async ending => {
    vi.stubGlobal("__TAURI__", {});
    const a = await webview(A), b = await webview(B), palette = await webview();
    const receivedA = vi.fn(), receivedB = vi.fn();
    for (const kind of ["preview", "commit", "cancel"]) {
      const event = `chemdraft://palette-command-${kind}`;
      await a.events.listenTauriEvent(event, receivedA);
      await b.events.listenTauriEvent(event, receivedB);
    }
    await palette.manager.listenForToolsetActiveTool(() => undefined);
    await a.manager.broadcastToolsetActiveTool("tool.select");
    await palette.manager.sendPaletteCommandPreview("object.opacity:0.4");
    for (const client of [a, b, palette]) client.routing.setActivePaletteWindow("B");
    await b.manager.broadcastToolsetActiveTool("tool.text");
    expect(palette.routing.currentPaletteTarget()).toEqual(B);
    if (ending === "settled commit") {
      native.invoke.mockImplementation(async (command, payload) => {
        expect(command).toBe("route_toolset_command");
        await bus.emit("chemdraft://palette-command-commit", payload);
      });
      await palette.manager.sendPaletteCommandCommit("object.opacity:0.4", { settleBeforeForward: true });
      expect(native.invoke).toHaveBeenCalledWith("route_toolset_command", {
        commandId: "object.opacity:0.4", commit: true, target: A
      });
    } else if (ending === "commit") {
      await palette.manager.sendPaletteCommandCommit("object.opacity:0.4");
    } else {
      await palette.manager.sendPaletteCommandCancel("palette.preview.cancel");
    }
    expect(receivedA).toHaveBeenCalledTimes(2);
    expect(receivedA.mock.calls.map(([event]) => event.payload.target)).toEqual([A, A]);
    expect(receivedB).not.toHaveBeenCalled();
    // The next gesture uses B, not the released capture.
    await palette.manager.sendPaletteCommandPreview("object.opacity:0.7");
    await palette.manager.sendPaletteCommandCancel("palette.preview.cancel");
    expect(receivedB).toHaveBeenCalledTimes(2);
    expect(receivedB.mock.calls[0][0].payload.target).toEqual(B);
    a.release?.(); b.release?.();
  });

  it("filters stale, foreign and malformed targets in generic native listeners and the DOM fallback", async () => {
    vi.stubGlobal("__TAURI__", {});
    const a = await webview(A);
    const received = vi.fn();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const event = "chemdraft://palette-command-preview";
    await a.events.listenTauriEvent(event, received);
    const dom = vi.fn();
    const stop = await a.manager.listenForPaletteCommandPreviews(dom);
    for (const target of [B, { ...A, tabId: "closed-tab" }, undefined]) {
      const payload = { commandId: "object.opacity:0.4", target };
      await bus.emit(event, payload);
      window.dispatchEvent(new CustomEvent(event, { detail: payload }));
    }
    expect(received).not.toHaveBeenCalled(); expect(dom).not.toHaveBeenCalled();
    a.tabs.delete(A.tabId);
    await bus.emit(event, { commandId: "object.opacity:0.4", target: A });
    expect(received).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("stale tab"));
    stop(); a.release?.(); debug.mockRestore();
  });

  it("puts a target on every document snapshot and request, and suppresses inactive publishers", async () => {
    vi.stubGlobal("__TAURI__", {});
    const a = await webview(A);
    const { DefaultNativeTextStyle } = await import("@chemdraft/chem-core");
    const publish = async () => {
      await a.manager.broadcastToolsetActiveTool("tool.select");
      await a.manager.broadcastToolsetTextStyle(a.manager.createToolsetTextStylePayload(DefaultNativeTextStyle));
      await a.manager.broadcastToolsetCommandSpecs([]);
      await a.manager.broadcastToolsetDefinitions([]);
      await a.manager.broadcastToolsetLayoutState({ version: 1 });
      await a.manager.broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: false });
    };
    await publish();
    for (const request of [a.manager.requestToolsetActiveTool, a.manager.requestToolsetTextStyle,
      a.manager.requestToolsetCommandSpecs, a.manager.requestToolsetDefinitions,
      a.manager.requestToolsetLayoutState, a.manager.requestToolsetCustomizeMode]) await request();
    expect(bus.emit).toHaveBeenCalledTimes(12);
    expect(bus.emit.mock.calls.every(([, payload]) => JSON.stringify((payload as { target: PaletteTarget }).target) === JSON.stringify(A))).toBe(true);
    bus.emit.mockClear(); a.routing.setActivePaletteWindow("B");
    await publish();
    expect(bus.emit).not.toHaveBeenCalled(); a.release?.();
  });

  it("refreshes only the newly active document and leaves same-window activation alone", async () => {
    vi.stubGlobal("__TAURI__", {});
    const a = await webview(A), b = await webview(B);
    const refreshA = vi.fn(), refreshB = vi.fn();
    const stopA = await a.manager.listenForPaletteDocumentActivation(refreshA);
    const stopB = await b.manager.listenForPaletteDocumentActivation(refreshB);
    await bus.emit(a.routing.ACTIVE_DOCUMENT_EVENT, { windowId: "A" });
    expect(refreshA).not.toHaveBeenCalled(); expect(refreshB).not.toHaveBeenCalled();
    await bus.emit(a.routing.ACTIVE_DOCUMENT_EVENT, { windowId: "B" });
    expect(refreshA).not.toHaveBeenCalled(); expect(refreshB).toHaveBeenCalledOnce();
    await bus.emit(a.routing.ACTIVE_DOCUMENT_EVENT, { windowId: "B" });
    expect(refreshB).toHaveBeenCalledOnce();
    stopA(); stopB(); a.release?.(); b.release?.();
  });

  it("uses the native snapshot gate and keeps a delayed bootstrap reply from replacing B", async () => {
    vi.stubGlobal("__TAURI__", {});
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const a = await webview(A);
    await a.manager.broadcastToolsetActiveTool("tool.select");
    expect(native.invoke).toHaveBeenCalledWith("publish_palette_snapshot", {
      event: "chemdraft://toolset-active-tool", payload: { commandId: "tool.select", target: A }
    });
    a.release?.();
    const palette = await webview();
    palette.routing.bindPaletteSnapshot(A);
    let reply!: (state: { windowId: string; target: PaletteTarget }) => void;
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const request = palette.manager.requestToolsetActiveTool();
    for (let i = 0; i < 20 && !reply; i++) await Promise.resolve();
    palette.routing.setActivePaletteWindow("B");
    palette.routing.bindPaletteSnapshot(B);
    reply({ windowId: "A", target: A });
    await request;
    expect(palette.routing.currentPaletteTarget()).toEqual(B);
    expect(bus.emit).toHaveBeenLastCalledWith("chemdraft://toolset-active-tool-request", { target: A });
  });
});
