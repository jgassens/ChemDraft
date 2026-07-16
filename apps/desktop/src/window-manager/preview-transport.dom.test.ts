// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

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
