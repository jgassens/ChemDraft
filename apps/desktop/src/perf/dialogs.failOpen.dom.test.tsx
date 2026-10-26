// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStorage } from "../testSupport/memoryStorage";
import type { DialogMessage } from "../dialogs/dialogProtocol";
import type { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { exportFixture } from "../dialogs/exportTestFixtures";

const host = vi.hoisted(() => ({
  receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn()
}));
vi.mock("../dialogs/dialogTransport", () => ({
  subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return () => {}; },
  sendDialogMessage: host.send
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
let runtime: typeof import("./runtime"), root: Root | undefined, container: HTMLDivElement;
let coordinator: DialogCoordinator | undefined;
afterEach(async () => {
  await coordinator?.dispose(); coordinator = undefined;
  act(() => root?.unmount()); root = undefined; container?.remove();
  runtime?.perfProbe?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const hooks = ["coordinator.new", "coordinator.reuse", "coordinator.revealReceipt", "dialog.ready",
  "dialog.apply", "coordinator.applyReceipt", "dialog.export", "coordinator.exportReceipt"] as const;
it.each(hooks.flatMap(hook => ["throw", "reject"].map(failure => ({ hook, failure }))))
  ("$hook fails open ($failure) through real dialog transport and form controls", async ({ hook, failure }) => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
    vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?window=dialog&agentBridge=1");
    runtime = await import("./runtime"); await runtime.startPerfProbe("dialog-fault");
    const { DialogWindow } = await import("../dialogs/DialogWindow");
    const { DialogCoordinator } = await import("../dialogs/DialogCoordinator");
    await import("../dialogs/ExportForm");
    const { createPhase4Document, setDocumentCustomPageSize, exportPhase4Svg } = await import("../documentWorkflow");
    let documentState = createPhase4Document("Real dialog action");
    const written: string[] = [];
    const apply = vi.fn((_tab: string, size: { width: number; height: number; unit: "inch" | "mm" }) => {
      documentState = setDocumentCustomPageSize(documentState, size);
    });
    const exporter = vi.fn(async () => { written.push(exportPhase4Svg(documentState).contents); return { status: "exported" as const }; });
    const close = vi.fn().mockResolvedValue(undefined);
    let snapshot!: Extract<DialogMessage, { type: "snapshot" }>;
    const label = "dialog-main-pageSize-1";
    const deliver = (message: DialogMessage) => coordinator!.receive({ message, senderWindowId: label, windowLabel: label });
    const transport = {
      subscribe: async () => () => {},
      open: vi.fn(async (message: typeof snapshot) => { snapshot = message; host.receive!(message); return { hostId: "host", windowLabel: label }; }),
      publish: async (_id: string, message: DialogMessage) => { host.receive!(message); }, close
    };
    coordinator = new DialogCoordinator(transport, { applyPageSize: apply, export: exporter, onError: vi.fn() });
    host.send.mockImplementation((_id: string, message: DialogMessage) => deliver(message));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(createElement(DialogWindow, { hostId: "host" })));
    const isExport = hook.includes("export") || hook.includes("Export");
    const open = () => act(async () => {
      if (isExport) await coordinator!.openExport("tab", { title: "Drawing", options: { ...exportFixture(), format: "svg", filename: "drawing.svg" } });
      else await coordinator!.openPageSize("tab", { title: "Drawing", width: 8.5, height: 11, unit: "inch" });
    });
    if (!["coordinator.new", "dialog.ready"].includes(hook)) await open();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const broken = () => {
      if (failure === "throw") throw new Error("injected dialog probe");
      return pending as never;
    };
    const fault = hook === "dialog.ready" ? vi.spyOn(runtime, "perfSurfaceReady").mockImplementation(broken)
      : hook.endsWith("Receipt") ? vi.spyOn(runtime, "sendPerfCompletion").mockImplementation(broken)
      : vi.spyOn(runtime.perfProbe!, "expectCompletion").mockImplementation(broken);
    const start = Date.now();
    if (hook === "coordinator.new" || hook === "dialog.ready" || hook === "coordinator.reuse" || hook === "coordinator.revealReceipt") {
      await open();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(transport.open).toHaveBeenCalledTimes(hook.includes("reuse") || hook.includes("reveal") ? 2 : 1);
    } else {
      const text = isExport ? "Export" : "Apply";
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
      expect(button).toBeDefined();
      if (!isExport) await act(async () => {
        const field = container.querySelector("input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "10");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button.click());
      if (isExport) {
        expect(exporter).toHaveBeenCalledOnce(); expect(written[0]).toContain("<svg");
        expect(container.textContent).toContain("Exported");
      } else {
        expect(apply).toHaveBeenCalledOnce();
        expect(documentState.pages[0].width).toBe(960);
        expect(close).toHaveBeenCalledWith("host", "apply");
      }
    }
    expect(fault).toHaveBeenCalled();
    expect(Date.now()).toBe(start); // No timers or probe promise advanced to complete the action.
    if (failure === "reject") reject(new Error("injected rejection"));
    await Promise.resolve(); await Promise.resolve();
    const calls = fault.mock.calls.length, rows = localStorage.getItem("chemdraft.perfLog");
    // User can still close the real dialog after the fault; cancellation reaches its owner.
    const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Cancel" || b.textContent === "Close");
    if (cancel) await act(async () => cancel.click());
    await coordinator!.closeTab("tab");
    expect(close).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    runtime.perfHook(() => runtime.perfProbe?.expectCompletion("dialog-open", "later"));
    expect(fault).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem("chemdraft.perfLog")).toBe(rows);
  });
