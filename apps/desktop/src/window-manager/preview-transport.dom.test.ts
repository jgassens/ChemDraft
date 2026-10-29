// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ColorPickerPopoverBody } from "../ToolPalette";
import { objectCustomColorCommandId } from "../commands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("delivers applyAndCommitColor's preview then ordinary commit on the event transport", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const sends: Promise<void>[] = [];
    try {
      await act(async () => root.render(createElement(ColorPickerPopoverBody, {
        value: "#111111",
        onPreviewColor: (color) => { sends.push(sendPaletteCommandPreview(objectCustomColorCommandId(color))); },
        onCommitColor: (color) => { sends.push(sendPaletteCommandCommit(objectCustomColorCommandId(color))); }
      })));
      const input = container.querySelector<HTMLInputElement>(".color-hex-field input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#1E88E5");
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
      });
      await Promise.all(sends);
      await sendPaletteCommandCancel("palette.preview.cancel");
      expect(sends).toHaveLength(2);
      expect(tauriEventBus.emit.mock.calls).toEqual([
        ["chemdraft://palette-command-preview", { commandId: objectCustomColorCommandId("#1e88e5") }],
        ["chemdraft://palette-command-commit", { commandId: objectCustomColorCommandId("#1e88e5") }],
        ["chemdraft://palette-command-cancel", { commandId: "palette.preview.cancel" }]
      ]);
      expect(native.invoke).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
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
