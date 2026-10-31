// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { objectCustomColorCommandId } from "../commands";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const tauriEventBus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  return {
    listeners,
    emit: vi.fn(async (eventName: string, payload: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener({ payload });
      }
    }),
    listen: vi.fn(async (eventName: string, listener: (event: { payload: unknown }) => void) => {
      const eventListeners = listeners.get(eventName) ?? new Set();
      eventListeners.add(listener);
      listeners.set(eventName, eventListeners);
      return () => {
        eventListeners.delete(listener);
      };
    })
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  emit: tauriEventBus.emit,
  listen: tauriEventBus.listen
}));
import {
  PALETTE_EVENT_SETTLE_TIMEOUT_MS,
  broadcastToolsetCommandSpecs,
  broadcastToolsetCustomizeMode,
  listenForPaletteCommandCancels,
  listenForPaletteCommandCommits,
  listenForPaletteCommandPreviews,
  listenForToolsetCustomizeMode,
  listenForToolsetCommandSpecs,
  listenForToolsetCommandSpecsRequests,
  listenForToolsetLayoutEdits,
  requestToolsetCommandSpecs,
  sendPaletteCommand,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  sendToolsetLayoutEdit,
  toolsetCommandSpecsSignature
} from "./index";

afterEach(() => {
  const tauriGlobal = globalThis as typeof globalThis & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  delete tauriGlobal.__TAURI__;
  delete tauriGlobal.__TAURI_INTERNALS__;
  tauriEventBus.listeners.clear();
  native.invoke.mockReset();
  tauriEventBus.emit.mockClear();
  tauriEventBus.listen.mockClear();
});

describe("window-manager palette preview transport", () => {
  it("fingerprints command content instead of fresh array/object identity", () => {
    const first = [{ id: "edit.undo", title: "Undo", icon: "undo", source: "core", enabled: false }] as const;
    const equalCopy = [{ ...first[0] }];
    const enabledCopy = [{ ...first[0], enabled: true }];

    expect(toolsetCommandSpecsSignature(first)).toBe(toolsetCommandSpecsSignature(equalCopy));
    expect(toolsetCommandSpecsSignature(enabledCopy)).not.toBe(toolsetCommandSpecsSignature(first));
  });

  it("routes preview, commit, and cancel commands over DOM events outside native runtime", async () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const cancel = vi.fn();
    const unlistenPreview = await listenForPaletteCommandPreviews(preview);
    const unlistenCommit = await listenForPaletteCommandCommits(commit);
    const unlistenCancel = await listenForPaletteCommandCancels(cancel);

    await sendPaletteCommandPreview("molecule.structure.bondLength:96");
    await sendPaletteCommandCommit("molecule.structure.bondLength:96");
    await sendPaletteCommandCancel("palette.preview.cancel");

    expect(preview).toHaveBeenCalledWith("molecule.structure.bondLength:96");
    expect(commit).toHaveBeenCalledWith("molecule.structure.bondLength:96");
    expect(cancel).toHaveBeenCalledWith("palette.preview.cancel");

    unlistenPreview();
    unlistenCommit();
    unlistenCancel();
  });

  it.each(["document.save", "document.saveAs", "export.open", "document.nextTab"])(
    "delivers a delayed native draft commit before %s over the same IPC route", async (command) => {
      (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let activeDocument = "A";
      const values: Record<string, string> = { A: "20", B: "40" };
      const observed: string[] = [];
      native.invoke.mockImplementation(async (route, args) => {
        expect(route).toBe("route_toolset_command");
        if (args.commit) {
          entered();
          await blocked;
          values[activeDocument] = "31";
          observed.push(`commit:${activeDocument}`);
        } else {
          observed.push(`${args.commandId}:${values[activeDocument]}`);
          if (args.commandId === "document.nextTab") activeDocument = "B";
        }
      });
      const commit = sendPaletteCommandCommit("molecule.structure.bondLength:31", { settleBeforeForward: true });
      const forward = sendPaletteCommand(command, { preserveInputFocus: true });
      await started;
      expect(native.invoke).toHaveBeenCalledExactlyOnceWith("route_toolset_command", {
        commandId: "molecule.structure.bondLength:31", commit: true
      });
      release();
      await Promise.all([commit, forward]);
      expect(observed).toEqual(["commit:A", `${command}:31`]);
      expect(values).toEqual({ A: "31", B: "40" });
      expect(tauriEventBus.emit).not.toHaveBeenCalled();
    }
  );

  it("delivers a preview, an ordinary commit and a cancel on the event transport, not IPC", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const commandId = objectCustomColorCommandId("#1e88e5");
    // Concurrent first dynamic imports of a vi.mock'ed module can resolve to the real module in vitest; this test checks transport choice, not concurrency.
    await sendPaletteCommandPreview(commandId);
    await sendPaletteCommandCommit(commandId);
    await sendPaletteCommandCancel("palette.preview.cancel");

    expect(tauriEventBus.emit.mock.calls).toEqual([
      ["chemdraft://palette-command-preview", { commandId }],
      ["chemdraft://palette-command-commit", { commandId }],
      ["chemdraft://palette-command-cancel", { commandId: "palette.preview.cancel" }]
    ]);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each(["preview", "commit"] as const)("flushes an earlier slider %s before a typed settle commit and shortcut", async (event) => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const observed: string[] = [];
    tauriEventBus.emit.mockImplementationOnce(async () => {
      entered();
      await blocked;
      observed.push(event);
    });
    const earlier = (event === "preview" ? sendPaletteCommandPreview : sendPaletteCommandCommit)("molecule.structure.bondLength:25");
    await started;
    const settle = sendPaletteCommandCommit("molecule.structure.bondLength:31", { settleBeforeForward: true });
    const forward = sendPaletteCommand("document.nextTab");
    // Let the IPC queue run while the slider's event-plugin invocation is unresolved.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(native.invoke).not.toHaveBeenCalled();
    native.invoke.mockImplementation(async (_route, args) => {
      observed.push(args.commit ? "settle" : "shortcut");
    });
    release();
    await Promise.all([earlier, settle, forward]);
    expect(observed).toEqual([event, "settle", "shortcut"]);
  });

  it.each(["preview", "commit"] as const)("still settles and forwards after an earlier slider %s rejects", async (event) => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    // Warm both dynamic imports sequentially, independently of test order.
    await sendPaletteCommandPreview("molecule.structure.bondLength:20");
    await sendPaletteCommand("document.save");
    native.invoke.mockClear();
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    tauriEventBus.emit.mockImplementationOnce(async () => {
      entered();
      await blocked;
    });
    const earlier = (event === "preview" ? sendPaletteCommandPreview : sendPaletteCommandCommit)("molecule.structure.bondLength:25");
    const rejection = expect(earlier).rejects.toThrow("Event delivery failed");
    await started;
    const settle = sendPaletteCommandCommit("molecule.structure.bondLength:31", { settleBeforeForward: true });
    const forward = sendPaletteCommand("document.nextTab");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(native.invoke).not.toHaveBeenCalled();
    reject(new Error("Event delivery failed"));
    await Promise.all([rejection, settle, forward]);
    expect(native.invoke.mock.calls).toEqual([
      ["route_toolset_command", { commandId: "molecule.structure.bondLength:31", commit: true }],
      ["route_toolset_command", { commandId: "document.nextTab" }]
    ]);
  });

  it.each(["preview", "commit"] as const)("bounds a stuck slider %s so settle, shortcut and later commands proceed", async (event) => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    // Warm both dynamic imports sequentially, independently of test order.
    await sendPaletteCommandPreview("molecule.structure.bondLength:20");
    await sendPaletteCommand("document.save");
    native.invoke.mockClear();
    vi.useFakeTimers();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    tauriEventBus.emit.mockImplementationOnce(async () => {
      entered();
      await blocked;
    });
    const earlier = (event === "preview" ? sendPaletteCommandPreview : sendPaletteCommandCommit)("molecule.structure.bondLength:25");
    try {
      await started;
      const settle = sendPaletteCommandCommit("molecule.structure.bondLength:31", { settleBeforeForward: true });
      const forward = sendPaletteCommand("document.nextTab");
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(PALETTE_EVENT_SETTLE_TIMEOUT_MS - 1);
      expect(native.invoke).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([settle, forward]);
      await sendPaletteCommand("document.save");
      expect(native.invoke.mock.calls).toEqual([
        ["route_toolset_command", { commandId: "molecule.structure.bondLength:31", commit: true }],
        ["route_toolset_command", { commandId: "document.nextTab" }],
        ["route_toolset_command", { commandId: "document.save" }]
      ]);
    } finally {
      // The emit stays unresolved through every assertion; release only for test isolation.
      release();
      await earlier;
      vi.useRealTimers();
    }
  });

  it("does not forward a queued app command when its preceding commit fails", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    native.invoke.mockRejectedValueOnce(new Error("Commit delivery failed"));
    const commit = sendPaletteCommandCommit("molecule.structure.bondLength:31", { settleBeforeForward: true });
    const forward = sendPaletteCommand("document.nextTab");
    await expect(commit).rejects.toThrow("Commit delivery failed");
    await expect(forward).rejects.toThrow("Commit delivery failed");
    expect(native.invoke).toHaveBeenCalledOnce();
    native.invoke.mockResolvedValueOnce(undefined);
    await sendPaletteCommand("document.save");
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("round-trips a customize layout edit over DOM events (palette → main)", async () => {
    const handler = vi.fn();
    const unlisten = await listenForToolsetLayoutEdits(handler);

    await sendToolsetLayoutEdit({ toolsetId: "core.main", edit: { kind: "addSpacer", groupId: "core.main.selection", index: 0 } });
    await sendToolsetLayoutEdit({ toolsetId: "core.main", edit: { kind: "exitCustomize" } });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, {
      toolsetId: "core.main",
      edit: { kind: "addSpacer", groupId: "core.main.selection", index: 0 }
    });
    expect(handler).toHaveBeenNthCalledWith(2, { toolsetId: "core.main", edit: { kind: "exitCustomize" } });

    unlisten();
  });

  it("uses only the Tauri channel in desktop runtime, avoiding a same-window double delivery", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const handler = vi.fn();
    const domListener = vi.fn();
    window.addEventListener("chemdraft://toolset-layout-edit", domListener);
    const unlisten = await listenForToolsetLayoutEdits(handler);

    await sendToolsetLayoutEdit({
      toolsetId: "core.main",
      edit: { kind: "addSpacer", groupId: "core.main.items", index: 0 }
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(domListener).not.toHaveBeenCalled();
    expect(tauriEventBus.emit).toHaveBeenCalledTimes(1);

    unlisten();
    window.removeEventListener("chemdraft://toolset-layout-edit", domListener);
  });

  it("round-trips a customize-mode broadcast (main → palettes)", async () => {
    const handler = vi.fn();
    const unlisten = await listenForToolsetCustomizeMode(handler);

    await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true });

    expect(handler).toHaveBeenCalledWith({ toolsetId: "core.main", active: true });

    unlisten();
  });

  it("answers a detached palette command-spec request with the live snapshot", async () => {
    const command = {
      id: "edit.undo",
      title: "Undo",
      icon: "undo",
      source: "core",
      shortcut: "Cmd+Z",
      enabled: true
    } as const;
    const received = vi.fn();
    const unlistenSpecs = await listenForToolsetCommandSpecs(received);
    const unlistenRequests = await listenForToolsetCommandSpecsRequests(() => {
      void broadcastToolsetCommandSpecs([command]);
    });

    await requestToolsetCommandSpecs();

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith([command]);
    unlistenSpecs();
    unlistenRequests();
  });

  it("uses only the Tauri channel for command-spec snapshots in desktop runtime", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const handler = vi.fn();
    const domListener = vi.fn();
    window.addEventListener("chemdraft://toolset-command-specs", domListener);
    const unlisten = await listenForToolsetCommandSpecs(handler);
    const command = {
      id: "edit.undo",
      title: "Undo",
      icon: "undo",
      source: "core",
      enabled: false
    } as const;

    await broadcastToolsetCommandSpecs([command]);

    expect(handler).toHaveBeenCalledWith([command]);
    expect(domListener).not.toHaveBeenCalled();
    expect(tauriEventBus.emit).toHaveBeenCalledTimes(1);
    unlisten();
    window.removeEventListener("chemdraft://toolset-command-specs", domListener);
  });
});
