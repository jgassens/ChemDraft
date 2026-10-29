// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, createEmptyDocument, DefaultNativeTextStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { allShellCommands, moleculeStructureBondLengthCommandId, objectCustomColorCommandId } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  DOM_COMMAND_EVENT, broadcastToolsetCustomizeMode, broadcastToolsetTextStyle, createToolsetTextStylePayload,
  sendPaletteCommand, sendPaletteCommandCancel, sendPaletteCommandCommit, startPaletteWindowDrag, type ToolsetPopoverContentPayload
} from "./window-manager";
import type { NativePanelFocusEvent } from "./plugins/pluginPanelInputFocus";
import {
  installMainWindowPalettePendingKeys, isPendingPaletteEditingKey, PALETTE_CLICK_PENDING_EVENT,
  PALETTE_CLICK_TIMEOUT_MS, type PaletteClickPendingEvent
} from "./palettePendingKeys";
import { forceDocumentHistoryCommandId, installSecondaryWindowEditHistory } from "./editHistoryRouting";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolved: vi.fn(),
  failPointerSubscription: false,
  popoverContent: undefined as ((payload: ToolsetPopoverContentPayload) => void) | undefined,
  platform: "macos" as "macos" | "windows",
  pointerNotify: undefined as ((event: { payload: PaletteClickPendingEvent }) => void) | undefined,
  notify: undefined as ((event: { payload: NativePanelFocusEvent }) => void) | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  sendPaletteCommand: vi.fn(async () => undefined),
  sendPaletteCommandCommit: vi.fn(async () => undefined),
  sendPaletteCommandCancel: vi.fn(async () => undefined),
  startPaletteWindowDrag: vi.fn(async () => undefined),
  listenForToolsetPopoverContent: vi.fn(async (listener: (payload: ToolsetPopoverContentPayload) => void) => {
    native.popoverContent = listener;
    return () => { native.popoverContent = undefined; };
  })
}));
vi.mock("./window-manager/tauriEvents", async (original) => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenCurrentWindowEvent: vi.fn(async (name: string, listener: (event: { payload: NativePanelFocusEvent }) => void) => {
    if (name === "chemdraft://plugin-panel-focus") native.notify = listener;
    if (name === PALETTE_CLICK_PENDING_EVENT) {
      if (native.failPointerSubscription) throw new Error("Pointer listen failed");
      native.pointerNotify = listener as unknown as typeof native.pointerNotify;
    }
    return () => { if (native.notify === listener) native.notify = undefined; };
  })
}));
vi.mock("./keyboardShortcuts", async (original) => {
  const actual = await original<typeof import("./keyboardShortcuts")>();
  return {
    ...actual,
    detectDesktopShortcutPlatform: () => native.platform,
    createDesktopShortcutRegistry: (...args: Parameters<typeof actual.createDesktopShortcutRegistry>) => {
      const registry = actual.createDesktopShortcutRegistry(args[0], {
        ...(typeof args[1] === "object" ? args[1] : {}), platform: native.platform
      });
      return { ...registry, resolve: (event: Parameters<typeof registry.resolve>[0]) => {
        native.resolved(event);
        return registry.resolve(event);
      } };
    }
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0)); // Settled control-focus check.
  });
}

function selectedMolecule() {
  const doc = createEmptyDocument({ id: "doc_input_focus", pageId: "page_input_focus", title: "Input focus" });
  const molecule: MoleculeObject = {
    id: "mol_input_focus", type: "molecule", x: 120, y: 120, width: 80, height: 40,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "CO",
    atoms: [
      { id: "c", element: "C", x: 140, y: 160, formalCharge: 0 },
      { id: "o", element: "O", x: 200, y: 160, formalCharge: 0 }
    ],
    bonds: [{ id: "b", fromAtomId: "c", toAtomId: "o", order: "single" }],
    superatoms: [], rGroups: []
  };
  return applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: molecule }]);
}

it("keeps native and page pending editing-key lists in agreement", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const rust = read("../src-tauri/src/palette_key_guard_state.rs")
    .split("fn editing_key(")[1]!.split("#[cfg(test)]")[0]!;
  const page = read("./palettePendingKeys.ts").split("function isPendingPaletteEditingKey(")[1]!
    .split("/** Disabled controls")[0]!;
  const nativeChords = [...rust.split("key.to_ascii_lowercase().as_str(),")[1]!
    .split(");")[0]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
  const pageChordList = [...page.split("return !event.altKey && [")[1]!
    .split("]")[0]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
  expect(nativeChords.length).toBeGreaterThan(0);
  expect(pageChordList).toEqual(nativeChords);
  for (const modifier of ["metaKey", "ctrlKey"] as const) {
    const pageChords = [..."abcdefghijklmnopqrstuvwxyz"].filter((key) =>
      isPendingPaletteEditingKey({ key, metaKey: false, ctrlKey: false, altKey: false, [modifier]: true }));
    expect(pageChords).toEqual(nativeChords.filter((key) => /^[a-z]$/.test(key)));
    for (const key of nativeChords) {
      expect(isPendingPaletteEditingKey({ key: key.toUpperCase(), metaKey: false, ctrlKey: false, altKey: false, [modifier]: true })).toBe(true);
      expect(isPendingPaletteEditingKey({ key, metaKey: false, ctrlKey: false, altKey: true, [modifier]: true })).toBe(false);
    }
  }
  // AppKit encodes these browser key names as control/private-use characters.
  const nativeNames: Record<string, string> = { "\\u{8}": "Backspace", "\\u{7f}": "Backspace", "\\u{f728}": "Delete" };
  const nativeDeletes = [...rust.split("if matches!(key,")[1]!.split(")")[0]!
    .matchAll(/"([^"]+)"/g)].map((match) => nativeNames[match[1]!]);
  expect(nativeDeletes).not.toContain(undefined);
  const pageDeletes = [...page.split("if (event.metaKey")[0]!
    .matchAll(/event.key === "([^"]+)"/g)].map((match) => match[1]!);
  expect([...new Set(nativeDeletes)].sort()).toEqual(pageDeletes.sort());
});

describe.each(["macos", "windows"] as const)("palette input focus (%s)", (platform) => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: MockInstance<EventTarget["addEventListener"]>;
  let windowListeners: MockInstance<Window["addEventListener"]>;
  beforeEach(() => {
    listeners = vi.spyOn(EventTarget.prototype, "addEventListener");
    windowListeners = vi.spyOn(window, "addEventListener");
    native.platform = platform;
    native.failPointerSubscription = false;
    native.invoke.mockReset().mockImplementation(async (command: string, args?: { editing: boolean }) =>
      command === "register_plugin_panel_input_focus" ? "palette-page" : args?.editing);
    vi.mocked(sendPaletteCommand).mockClear();
    vi.mocked(sendPaletteCommandCancel).mockClear();
    vi.mocked(sendPaletteCommandCommit).mockClear();
    vi.mocked(startPaletteWindowDrag).mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await flush();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountSettings(toolsetId = "core.drawnStructureSettings", model = createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: ["mol_input_focus"] })) {
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId, platform })));
    await flush();
    // jsdom has no pointer capture implementation; support the shell's drag cleanup.
    for (const element of container.querySelectorAll<HTMLElement>("*")) {
      element.hasPointerCapture = () => false;
      element.setPointerCapture = () => undefined;
    }
    await act(async () => {
      await broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", model));
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length"]')!;
    if (toolsetId === "core.drawnStructureSettings") expect(input?.disabled).toBe(false);
    return input;
  }

  function leases() {
    return native.invoke.mock.calls.filter(([command]) => command === "set_plugin_panel_input_focus");
  }

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
    });
  }

  function lengthModel(length: number) {
    const model = createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: ["mol_input_focus"] });
    model.structure.values.bondLengthPx = { value: length, mixed: false };
    return model;
  }

  async function snapshot(length: number) {
    await act(async () => broadcastToolsetTextStyle(
      createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", lengthModel(length))
    ));
  }

  async function press(input: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    await act(async () => input.dispatchEvent(event));
    return event;
  }

  async function browserInput(input: HTMLInputElement, value: string, inputType = "") {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }));
    });
  }

  async function steppedNumber(gesture = "arrow") {
    const input = await mountSettings("core.drawnStructureSettings", lengthModel(22));
    await clickControl(input);
    for (const value of [22.5, 23, 23.5]) {
      if (gesture === "arrow") await press(input, "ArrowUp");
      else await act(async () => {
        pointer(input, "pointerdown");
        if (gesture === "released spinner") pointer(input, "pointerup");
      });
      // Stepping can notify during the pointer press, after release or after an arrow.
      await browserInput(input, String(value));
      if (gesture === "spinner") await act(async () => pointer(input, "pointerup"));
      await snapshot(value);
    }
    expect(input.value).toBe("23.5");
    expect(sendPaletteCommandCommit).toHaveBeenCalledTimes(3);
    return input;
  }

  it.each(["untouched", "arrow", "spinner", "released spinner"])("forwards document undo/redo once from a focused %s number, preventing native history", async (kind) => {
    const input = kind !== "untouched" ? await steppedNumber(kind)
      : await mountSettings("core.drawnStructureSettings", lengthModel(22));
    if (kind === "untouched") await clickControl(input);
    const historyInput = vi.fn();
    input.addEventListener("input", historyInput);
    const modifier = { ctrlKey: platform === "windows", metaKey: platform === "macos" };
    const undoneValue = kind === "untouched" ? 21.5 : 23;
    const redoneValue = kind === "untouched" ? 22 : 23.5;
    const chords: Array<{ key: string; shiftKey?: boolean; command: string; value: number; inputType: string }> = [
      { key: "z", command: "edit.undo", value: undoneValue, inputType: "historyUndo" },
      { key: "z", shiftKey: true, command: "edit.redo", value: redoneValue, inputType: "historyRedo" },
      ...(platform === "windows" ? [{ key: "y", command: "edit.redo", value: redoneValue, inputType: "historyRedo" }] : [])
    ];
    for (const chord of chords) {
      vi.mocked(sendPaletteCommand).mockClear();
      const event = await press(input, chord.key, { ...modifier, shiftKey: chord.shiftKey });
      // jsdom has no native text history default; reproduce it only if the browser may run it.
      if (!event.defaultPrevented) await browserInput(input, input.value, chord.inputType);
      expect(event.defaultPrevented).toBe(true);
      expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(forceDocumentHistoryCommandId(chord.command));
      expect(historyInput).not.toHaveBeenCalled();
      await snapshot(chord.value);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe(String(chord.value));
    }
  });

  it.each(["arrow", "spinner"])("menu undo/redo forwards once from a clean %s number and refreshes it", async (gesture) => {
    const input = await steppedNumber(gesture);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const uninstall = installSecondaryWindowEditHistory({ forwardToMain: sendPaletteCommand });
    try {
      for (const [commandId, value] of [["edit.undo", 23], ["edit.redo", 23.5]] as const) {
        vi.mocked(sendPaletteCommand).mockClear();
        await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
        expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(forceDocumentHistoryCommandId(commandId));
        expect(execCommand).not.toHaveBeenCalled();
        await snapshot(value); // The document's undo/redo acknowledgement.
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe(String(value));
      }
      expect(sendPaletteCommandCommit).toHaveBeenCalledTimes(3);
    } finally {
      uninstall();
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("menu undo/redo edits a typed draft natively without forwarding or committing", async () => {
    const input = await steppedNumber();
    await type(input, "30");
    const execCommand = vi.fn((direction: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, direction === "undo" ? "23.5" : "30");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: direction === "undo" ? "historyUndo" : "historyRedo" }));
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const uninstall = installSecondaryWindowEditHistory({ forwardToMain: sendPaletteCommand });
    try {
      for (const [commandId, value] of [["edit.undo", "23.5"], ["edit.redo", "30"]]) {
        await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
        expect(input.value).toBe(value);
        expect(input.dataset.paletteNumberDraft).toBe("true");
        expect(document.activeElement).toBe(input);
      }
      expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
      expect(sendPaletteCommand).not.toHaveBeenCalled();
      expect(sendPaletteCommandCommit).toHaveBeenCalledTimes(3);
    } finally {
      uninstall();
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it.each(["insertText", "deleteContentBackward", "insertFromPaste", "insertCompositionText"])("keeps undo/redo native throughout an uncommitted %s draft", async (inputType) => {
    const input = await mountSettings("core.drawnStructureSettings", lengthModel(22));
    await clickControl(input);
    await browserInput(input, "30", inputType);
    for (const chord of [
      { key: "z", inputType: "historyUndo", value: "22" },
      { key: platform === "windows" ? "y" : "z", shiftKey: platform === "macos", inputType: "historyRedo", value: "30" }
    ]) {
      const event = await press(input, chord.key, {
        ctrlKey: platform === "windows", metaKey: platform === "macos", shiftKey: chord.shiftKey
      });
      expect(event.defaultPrevented).toBe(false);
      await browserInput(input, chord.value, chord.inputType);
      expect(input.value).toBe(chord.value);
      expect(sendPaletteCommand).not.toHaveBeenCalled();
      expect(sendPaletteCommandCommit).not.toHaveBeenCalled();
    }
  });

  it("follows outside undo snapshots after native step input while focused, then Tabs without a commit", async () => {
    const input = await steppedNumber();
    vi.mocked(sendPaletteCommandCommit).mockClear();
    for (const value of [23, 22.5]) {
      await snapshot(value);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe(String(value));
    }
    await press(input, "Tab");
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Target bond length slider"]')!.focus());
    expect(input.value).toBe("22.5");
    expect(sendPaletteCommandCommit).not.toHaveBeenCalled();
  });

  it.each(["Tab", "Enter"])("skips an equal typed value on %s but commits a different value once", async (key) => {
    const input = await mountSettings("core.drawnStructureSettings", lengthModel(22));
    await clickControl(input);
    for (const value of ["22", "22.0001", "30"]) {
      await type(input, value);
      await press(input, key);
      if (key === "Tab") await act(async () => input.blur());
      expect(sendPaletteCommandCommit).toHaveBeenCalledTimes(value === "30" ? 1 : 0);
      if (value !== "30") await clickControl(input);
    }
    expect(sendPaletteCommandCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
  });

  function pointer(target: HTMLElement, type: "pointerdown" | "pointerup" | "click", detail = 1) {
    const owner = container.querySelector(".palette-window-shell, .palette-popover-shell")!;
    const listener = type === "pointerup"
      ? windowListeners.mock.calls.find(([name, , options]) => name === type && options === true)![1]
      : listeners.mock.calls.find(([name, , options], i) =>
        name === type && options === true && listeners.mock.contexts[i] === owner)![1];
    // jsdom cannot manufacture isTrusted. Supply trust only at the installed native-intent
    // listener, then dispatch the DOM event normally so React and control defaults also run.
    (listener as EventListener)({
      target, isTrusted: true, button: 0, pointerId: 1, clientX: 10, clientY: 10, detail
    } as unknown as Event);
    const event = new MouseEvent(type, { button: 0, detail, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it("captures the originating native click before a delayed page release", async () => {
    const input = await mountSettings();
    native.pointerNotify!({ payload: { sequence: 41, pending: true, expiresAt: Date.now() + 1_000 } });
    await clickControl(input);
    expect(leases()[0]![1]).toMatchObject({ clickSequence: 41, pointerBefore: expect.any(Number) });
    // Queue a release; a newer native click event can arrive before its serialized IPC.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      native.pointerNotify!({ payload: { sequence: 42, pending: true, expiresAt: Date.now() + 1_000 } });
    });
    await flush();
    expect(leases().at(-1)![1]).toMatchObject({ editing: false, clickSequence: 41 });
  });

  it.each(["number", "select"])("allows document Save from a held %s without releasing it", async (kind) => {
    const input = await mountSettings();
    const control = kind === "number" ? input : await nonTextControl("select");
    await clickControl(control);
    if (kind === "number") {
      await type(input, "26");
      await press(input, "Enter");
    }
    // Only macOS has an app-wide menu. A Windows palette must route its own key once.
    let notify!: (event: PaletteClickPendingEvent) => void;
    const stopGuard = installMainWindowPalettePendingKeys(async (listener) => {
      notify = listener;
      return () => undefined;
    }, async () => undefined);
    notify({ sequence: 1, pending: true, expiresAt: Date.now() + 1_000 });
    notify({ sequence: 1, pending: false, expiresAt: 0 }); // Native acquisition completed.
    const save = vi.fn();
    const menuDefault = (event: KeyboardEvent) => {
      if (platform === "macos" && !event.defaultPrevented && event.key === "s" && event.metaKey) save();
    };
    window.addEventListener("keydown", menuDefault);
    try {
      const event = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true,
        ctrlKey: platform === "windows", metaKey: platform === "macos" });
      await act(async () => control.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(platform === "windows");
      if (platform === "windows") {
        expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith("document.save", { preserveInputFocus: true });
        expect(save).not.toHaveBeenCalled();
      } else {
        expect(sendPaletteCommand).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledOnce();
      }
      expect(document.activeElement).toBe(control);
      expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    } finally {
      window.removeEventListener("keydown", menuDefault);
      stopGuard();
    }
  });

  it.each(["pending", "disabled sink"])("routes Save once from a %s and keeps its destination", async (kind) => {
    const input = await mountSettings();
    let settle: ((acquired: boolean) => void) | undefined;
    if (kind === "pending") {
      native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
      await clickControl(input);
    } else {
      await act(async () => broadcastToolsetTextStyle(createToolsetTextStylePayload(
        DefaultNativeTextStyle, "normal", undefined, "fill", createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: [] })
      )));
      const disabled = container.querySelector<HTMLInputElement>('[aria-label="Chain angle"]')!;
      await clickControl(disabled.parentElement!);
    }
    try {
      const event = await press(document.activeElement as HTMLElement, "s", {
        ctrlKey: platform === "windows", metaKey: platform === "macos"
      });
      expect(event.defaultPrevented).toBe(platform === "windows");
      if (platform === "windows") {
        expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith("document.save", { preserveInputFocus: true });
      } else expect(sendPaletteCommand).not.toHaveBeenCalled();
    } finally {
      settle?.(true);
      await flush();
    }
    expect(document.activeElement).toBe(kind === "pending" ? input : container.querySelector(".palette-window-shell"));
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
  });

  it("commits a typed draft before forwarding app chords, while editing chords remain native", async () => {
    const input = await mountSettings();
    await clickControl(input);
    await type(input, "31");
    const modifier = { ctrlKey: platform === "windows", metaKey: platform === "macos" };
    for (const key of ["a", "c", "v", "x", "z", "y", "Delete", "Backspace"]) {
      await press(input, key, modifier);
      expect(sendPaletteCommand, key).not.toHaveBeenCalled();
      expect(sendPaletteCommandCommit, key).not.toHaveBeenCalled();
    }
    for (const [key, shiftKey, command] of [
      ["s", false, "document.save"], ["s", true, "document.saveAs"], ["o", false, "document.open"],
      ["n", false, "document.new"], ["w", false, "document.closeTab"],
      ["e", true, "export.open"], [",", false, "view.togglePreferences"],
      ["-", false, "view.zoomOut"], ["r", false, "view.toggleRulers"]
    ] as const) {
      // A new draft for each command; an acknowledged prior value must not mask this edit.
      await snapshot(31);
      await snapshot(20);
      await type(input, "31");
      vi.mocked(sendPaletteCommand).mockClear();
      vi.mocked(sendPaletteCommandCommit).mockClear();
      const event = await press(input, key, { ...modifier, shiftKey });
      expect(event.defaultPrevented, command).toBe(true);
      expect(sendPaletteCommandCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(31), { settleBeforeForward: true });
      expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(command, { preserveInputFocus: true });
      expect(vi.mocked(sendPaletteCommandCommit).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(sendPaletteCommand).mock.invocationCallOrder[0]!);
      expect(input.dataset.paletteNumberDraft).toBe("false");
      expect(document.activeElement).toBe(input);
    }
  });

  it("commits to the original document before Ctrl+Tab, leaving no draft to apply in the next tab", async () => {
    const input = await mountSettings();
    await clickControl(input);
    await type(input, "31");
    let activeDocument = "A";
    const commits: Array<{ document: string; command: string }> = [];
    vi.mocked(sendPaletteCommandCommit).mockImplementationOnce(async (command) => {
      commits.push({ document: activeDocument, command });
    });
    vi.mocked(sendPaletteCommand).mockImplementationOnce(async (command) => {
      expect(command).toBe("document.nextTab");
      activeDocument = "B";
    });
    const event = await press(input, "Tab", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(activeDocument).toBe("B");
    expect(commits).toEqual([{ document: "A", command: moleculeStructureBondLengthCommandId(31) }]);
    await snapshot(40); // The destination document's selected molecule.
    await act(async () => input.blur());
    expect(sendPaletteCommandCommit).toHaveBeenCalledOnce();
    expect(input.value).toBe("40");
  });

  it.each(["checkbox", "range"])("forwards non-menu app chords from a held %s on both platforms", async (kind) => {
    await mountSettings();
    const control = await nonTextControl(kind);
    await clickControl(control);
    for (const [key, modifiers, command] of [
      ["=", { metaKey: platform === "macos", ctrlKey: platform === "windows" }, "view.zoomIn"],
      ["Tab", { ctrlKey: true }, "document.nextTab"],
      ["Tab", { ctrlKey: true, shiftKey: true }, "document.previousTab"],
      ["w", { metaKey: platform === "macos", ctrlKey: platform === "windows" }, "document.closeTab"]
    ] as const) {
      vi.mocked(sendPaletteCommand).mockClear();
      const event = await press(control, key, modifiers);
      expect(event.defaultPrevented).toBe(true);
      expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(command, { preserveInputFocus: true });
    }
    vi.mocked(sendPaletteCommand).mockClear();
    const save = await press(control, "s", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(save.defaultPrevented).toBe(platform === "windows");
    if (platform === "macos") expect(sendPaletteCommand).not.toHaveBeenCalled();
    else expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith("document.save", { preserveInputFocus: true });
  });

  it("forwards without preserveInputFocus when no lease exists", async () => {
    await mountSettings();
    const event = await press(document.body, "=", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(event.defaultPrevented).toBe(true);
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith("view.zoomIn");
  });

  it.each(["title", "background"])("ends a lease on a %s drag press with platform-specific foreground hand-back", async (surface) => {
    const input = await mountSettings();
    await clickControl(input);
    const target = container.querySelector<HTMLElement>(surface === "title" ? ".palette-title" : ".palette-window-shell")!;
    await act(async () => pointer(target, "pointerdown"));
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
    // Only Windows returns foreground at WM_EXITSIZEMOVE; macOS hands back now.
    expect(leases().at(-1)![1]).toMatchObject({ returnFocus: platform === "macos" });
    expect(document.activeElement).not.toBe(input);
    expect(startPaletteWindowDrag).toHaveBeenCalledExactlyOnceWith(expect.any(Number), expect.any(Number));
  });

  it("uses platform-specific foreground hand-back on an unleased background drag press", async () => {
    await mountSettings();
    const shell = container.querySelector<HTMLElement>(".palette-window-shell")!;
    await act(async () => pointer(shell, "pointerdown"));
    await flush();
    expect(leases()).toHaveLength(1);
    // macOS has no end-of-drag hand-back, even when the palette has no input lease.
    expect(leases()[0]![1]).toMatchObject({ editing: false, returnFocus: platform === "macos" });
  });

  it("uses the document capture guard during a pending palette click, allowing Save and keyup", async () => {
    let notify!: (event: PaletteClickPendingEvent) => void;
    const stop = installMainWindowPalettePendingKeys(async (listener) => {
      notify = listener;
      return () => undefined;
    }, async () => undefined);
    const delivered = vi.fn();
    const save = vi.fn();
    const keyup = vi.fn();
    const documentKeys = (event: KeyboardEvent) => {
      delivered(event.key);
      if (event.key === "s" && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) save();
    };
    window.addEventListener("keydown", documentKeys, true);
    window.addEventListener("keyup", keyup);
    try {
      notify({ sequence: 1, pending: true, expiresAt: Date.now() + PALETTE_CLICK_TIMEOUT_MS });
      const modifier = { ctrlKey: platform === "windows", metaKey: platform === "macos" };
      for (const chord of [
        { key: "Delete" }, { key: "Backspace" }, { key: "k" }, { key: "K", shiftKey: true },
        { key: "2" }, ...["a", "x", "v", "z", "y"].map((key) => ({ key, ...modifier })),
        { key: "z", shiftKey: true, ...modifier }
      ]) {
        const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented, chord.key).toBe(true);
      }
      expect(delivered).not.toHaveBeenCalled(); // stopImmediatePropagation, even other capture listeners
      for (const key of ["s", "q", "h", "w", "o", ",", "c"]) {
        const event = new KeyboardEvent("keydown", { key, ...modifier, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented, key).toBe(false);
      }
      expect(save).toHaveBeenCalledOnce();
      document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      expect(keyup).toHaveBeenCalledOnce();
      notify({ sequence: 1, pending: false, expiresAt: 0 });
      const after = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      document.body.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
      expect(delivered).toHaveBeenLastCalledWith("Delete");
    } finally {
      stop();
      window.removeEventListener("keydown", documentKeys, true);
      window.removeEventListener("keyup", keyup);
    }
  });

  it("expires document pending clicks and ignores stale clears or delayed pending events", async () => {
    vi.useFakeTimers();
    let notify!: (event: PaletteClickPendingEvent) => void;
    const release = vi.fn(async () => undefined);
    const stop = installMainWindowPalettePendingKeys(async (listener) => {
      notify = listener;
      return () => undefined;
    }, release);
    const deleted = () => {
      const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      notify({ sequence: 1, pending: true, expiresAt: Date.now() + 1_000 });
      vi.advanceTimersByTime(20);
      notify({ sequence: 2, pending: true, expiresAt: Date.now() + 1_000 });
      notify({ sequence: 1, pending: false, expiresAt: 0 });
      expect(deleted()).toBe(true);
      vi.advanceTimersByTime(999);
      expect(deleted()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(deleted()).toBe(false);
      notify({ sequence: 2, pending: true, expiresAt: Date.now() + 1_000 });
      expect(deleted()).toBe(false); // A delayed start cannot resurrect a cleared sequence.
      notify({ sequence: 3, pending: true, expiresAt: Date.now() - 1 });
      expect(deleted()).toBe(false); // Delivery delay does not extend the native deadline.
      notify({ sequence: 4, pending: true, expiresAt: Date.now() + 1_000 });
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(deleted()).toBe(false);
      expect(release).toHaveBeenCalledWith(4, Date.now());
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  async function clickControl(control: HTMLElement, detail = 1) {
    await act(async () => {
      pointer(control, "pointerdown", detail);
      control.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail, bubbles: true }));
      control.focus(); // Browser mousedown's focus default, absent in jsdom.
      pointer(control, "pointerup", detail);
      control.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail, bubbles: true }));
      pointer(control, "click", detail);
    });
    await flush();
  }

  it("still acquires a field lease when the pending-click listener fails", async () => {
    native.failPointerSubscription = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const input = await mountSettings();
    await clickControl(input);
    expect(error).toHaveBeenCalledWith("Could not observe palette clicks:", expect.any(Error));
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(input);
  });

  it.each(["Escape", "blur", "removal"])("omits the pointer fallback for a sequence-less %s release", async (cause) => {
    const input = await mountSettings();
    const parent = input.parentElement!;
    const nextSibling = input.nextSibling;
    await clickControl(input);
    expect(leases()[0]![1]).toMatchObject({ clickSequence: undefined, pointerBefore: expect.any(Number) });
    await act(async () => {
      if (cause === "Escape") input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (cause === "blur") input.blur();
      else input.remove();
    });
    await flush();
    expect(leases().at(-1)![1]).toMatchObject({ editing: false, clickSequence: undefined, pointerBefore: undefined, returnFocus: true });
    // Restore React's node before unmount; removing it above exercises MutationObserver.
    if (cause === "removal") parent.insertBefore(input, nextSibling);
  });

  it("forgets a cleared click sequence before the next pointer classification", async () => {
    const input = await mountSettings();
    native.pointerNotify!({ payload: { sequence: 91, pending: true, expiresAt: Date.now() + 1_000 } });
    native.pointerNotify!({ payload: { sequence: 91, pending: false, expiresAt: 0 } });
    await clickControl(input);
    expect(leases()[0]![1]).toMatchObject({ clickSequence: undefined, pointerBefore: expect.any(Number) });
  });

  it("does not lease a disabled command button and still forwards the next tool hotkey", async () => {
    await mountSettings();
    await act(async () => {
      await broadcastToolsetTextStyle(createToolsetTextStylePayload(
        DefaultNativeTextStyle, "normal", undefined, "fill", createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: [] })
      ));
      container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-templates")!.click();
    });
    const button = container.querySelector<HTMLButtonElement>("button:disabled")!;
    expect(button).not.toBeNull();
    await clickControl(button);
    expect(leases().filter(([, args]) => args.editing)).toHaveLength(0);
    const shell = container.querySelector<HTMLElement>(".palette-window-shell")!;
    const hotkey = await press(shell, "3");
    const command = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), { includeDisabled: true }).resolve({ key: "3" });
    expect(command).toBeTruthy();
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(command);
    expect(hotkey.defaultPrevented).toBe(true);
    // jsdom does not hit-test CSS: assert the pass-through rule excludes buttons.
    const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    const disabledRules = css.split("/* Disabled native form controls")[1]!;
    expect(disabledRules).not.toContain("button");
    expect(disabledRules).toContain(":is(input, textarea, select):disabled");
    expect(disabledRules).toContain("cursor: not-allowed");
  });

  it("keeps disabled native flyout items out of the lease path with their reason intact", async () => {
    await act(async () => root.render(createElement(PalettePopoverWindow, { kind: "flyout", prewarm: true })));
    await flush();
    await act(async () => native.popoverContent!({
      toolsetId: "core.art", kind: "flyout",
      flyout: { flyoutId: "align", title: "Align", commands: [{
        id: "layout.alignLeft", title: "Align left", enabled: false, active: false,
        disabledReason: "Select two objects"
      }] }
    }));
    const button = container.querySelector<HTMLButtonElement>('button[role="menuitem"]')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Align left: Select two objects");
    await clickControl(button);
    expect(leases().filter(([, args]) => args.editing)).toHaveLength(0);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it("keeps a disabled select's reason on the wrapper receiving hover", async () => {
    await mountSettings();
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Double-bond position"]')!;
    expect(select.disabled).toBe(true);
    expect(select.title).not.toBe("");
    const hovered = select.parentElement!;
    hovered.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(hovered.title).toBe(select.title);
    await clickControl(hovered);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(container.querySelector(".palette-window-shell"));
  });

  it.each(["Enter", "ArrowUp"])("keeps number editing keys local after a %s commit and its snapshot", async (key) => {
    const input = await mountSettings("core.drawnStructureSettings", lengthModel(22));
    await clickControl(input);
    if (key === "Enter") await type(input, "26");
    await press(input, key);
    await snapshot(key === "Enter" ? 26 : 22.5);
    expect(document.activeElement).toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(sendPaletteCommandCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(key === "Enter" ? 26 : 22.5));
    for (const next of ["Delete", "Backspace", "a", "2", "6"]) {
      const event = await press(document.activeElement as HTMLInputElement, next, {
        ctrlKey: next === "a" && platform === "windows", metaKey: next === "a" && platform === "macos"
      });
      expect(event.defaultPrevented, next).toBe(false);
      expect(document.activeElement).toBe(input);
    }
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await press(input, "z", { ctrlKey: platform === "windows", metaKey: platform === "macos" });
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(forceDocumentHistoryCommandId("edit.undo"));
  });

  it("drops editing keys and menu Select All while the native lease is pending", async () => {
    const input = await mountSettings();
    let settle!: (acquired: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const uninstall = installSecondaryWindowEditHistory({ forwardToMain: sendPaletteCommand });
    try {
      await clickControl(input);
      expect(document.activeElement).toBe(document.body); // The caret is suspended.
      for (const key of ["a", "Delete", "Backspace", "2", "7"]) {
        const event = new KeyboardEvent("keydown", {
          key, bubbles: true, cancelable: true,
          ctrlKey: key === "a" && platform === "windows", metaKey: key === "a" && platform === "macos"
        });
        await act(async () => document.activeElement!.dispatchEvent(event));
        expect(event.defaultPrevented, key).toBe(true);
      }
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })));
      expect(sendPaletteCommand).not.toHaveBeenCalled();
    } finally {
      settle(true);
      await flush();
      uninstall();
    }
    expect(document.activeElement).toBe(input);
  });

  it("leases the disabled number wrapper as a typing sink until Escape", async () => {
    await mountSettings();
    await act(async () => broadcastToolsetTextStyle(createToolsetTextStylePayload(
      DefaultNativeTextStyle, "normal", undefined, "fill", createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: [] })
    )));
    const disabled = container.querySelector<HTMLInputElement>('[aria-label="Chain angle"]')!;
    expect(disabled.disabled).toBe(true);
    const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    const cursorRule = css.slice(css.indexOf("/* The real hit target"));
    const selector = cursorRule.slice(cursorRule.indexOf(".palette-window-shell"), cursorRule.indexOf("{")).trim();
    // The wrapper is the browser's hit target with pointer-events:none on the field.
    // This must match before :hover is available on a non-key native window.
    expect(disabled.parentElement!.matches(selector)).toBe(true);
    expect(cursorRule).toContain("cursor: not-allowed");
    // WebKit may dispatch nothing at all on a disabled input. CSS makes its
    // wrapper the pointer target; never inject a trusted event on the input.
    await clickControl(disabled.parentElement!);
    expect(document.activeElement).toBe(container.querySelector(".palette-window-shell"));
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    for (const key of ["2", "9", "Delete", "Backspace", "a"]) {
      const event = new KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true,
        ctrlKey: key === "a" && platform === "windows", metaKey: key === "a" && platform === "macos"
      });
      await act(async () => document.activeElement!.dispatchEvent(event));
      expect(event.defaultPrevented, key).toBe(true);
    }
    const quit = vi.fn();
    const menuDefault = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === "q" && (event.metaKey || event.ctrlKey)) quit();
    };
    window.addEventListener("keydown", menuDefault);
    try {
      const event = await press(document.activeElement as HTMLInputElement, "q", {
        ctrlKey: platform === "windows", metaKey: platform === "macos"
      });
      expect(event.defaultPrevented).toBe(false);
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", menuDefault);
    }
    const uninstall = installSecondaryWindowEditHistory({ forwardToMain: sendPaletteCommand });
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })));
    uninstall();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
  });

  it("leases the sink when the pointer point is inside a disabled field but its target is the shell", async () => {
    await mountSettings();
    await act(async () => broadcastToolsetTextStyle(createToolsetTextStylePayload(
      DefaultNativeTextStyle, "normal", undefined, "fill", createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: [] })
    )));
    const disabled = container.querySelector<HTMLInputElement>('[aria-label="Chain angle"]')!;
    vi.spyOn(disabled, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20,
      toJSON: () => ({})
    });
    const shell = container.querySelector<HTMLElement>(".palette-window-shell")!;
    await clickControl(shell);
    expect(document.activeElement).toBe(shell);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect((await press(shell, "Delete")).defaultPrevented).toBe(true);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it("keeps Text size type-ahead and arrows native, then releases on closed-select Escape", async () => {
    await mountSettings("core.text");
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Text size"]')!;
    expect(select).not.toBeNull();
    await clickControl(select);
    const uninstall = installSecondaryWindowEditHistory({ forwardToMain: sendPaletteCommand });
    try {
      for (const key of ["1", "8", "Delete", "Backspace", "a", "ArrowDown"]) {
        const event = new KeyboardEvent("keydown", {
          key, bubbles: true, cancelable: true,
          ctrlKey: key === "a" && platform === "windows", metaKey: key === "a" && platform === "macos"
        });
        await act(async () => document.activeElement!.dispatchEvent(event));
        expect(event.defaultPrevented, key).toBe(false);
        expect(document.activeElement).toBe(select);
      }
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })));
      expect(sendPaletteCommand).not.toHaveBeenCalled();
      const escape = await press(select, "Escape");
      await flush();
      expect(escape.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(select);
      expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
    } finally {
      uninstall();
    }
  });

  async function nonTextControl(kind: string) {
    if (kind === "checkbox") {
      await act(async () => container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-atom-labels")!.click());
      return container.querySelector<HTMLElement>('[aria-label="Terminal carbon labels"]')!;
    }
    return container.querySelector<HTMLElement>(kind === "select" ? '[aria-label="Bond spacing mode"]'
      : kind === "range" ? '[aria-label="Target bond length slider"]'
        : kind === "button" ? "button:not(:disabled)" : `input[type="${kind}"]`)!;
  }

  it.each(["same checkbox", "another checkbox", "number to slider"])("focuses WebKit's unfocused click on %s without releasing the lease", async (sequence) => {
    const number = await mountSettings();
    const checks = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const first = sequence === "number to slider" ? number : checks[0]!;
    const next = sequence === "number to slider"
      ? container.querySelector<HTMLInputElement>('[aria-label="Target bond length slider"]')!
      : sequence === "another checkbox" ? checks[1]! : first;
    await clickControl(first);
    for (const control of [next, next]) {
      vi.mocked(sendPaletteCommand).mockClear();
      await act(async () => {
        pointer(control, "pointerdown");
        control.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
        // Real WebKit mousedown default: old control loses focus, clicked control stays unfocused.
        (document.activeElement as HTMLElement).blur();
      });
      await flush(); // A held mouse can outlast the settled-blur timer before mouseup/click.
      expect(leases().map(([, args]) => args.editing)).toEqual([true]);
      await act(async () => {
        pointer(control, "pointerup");
        control.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true, cancelable: true }));
        pointer(control, "click");
      });
      await flush();
      expect(document.activeElement).toBe(control);
      expect(leases().map(([, args]) => args.editing)).toEqual([true]);
      vi.mocked(sendPaletteCommand).mockClear(); // Checkbox click itself is a style command.
      for (const key of ["Delete", "Backspace"]) {
        await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
      }
      expect(sendPaletteCommand).not.toHaveBeenCalled();
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", ctrlKey: platform === "windows", metaKey: platform === "macos", bubbles: true, cancelable: true
      })));
      expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(forceDocumentHistoryCommandId("edit.undo"));
    }
  });

  it("routes body-targeted keys through the leased non-text control", async () => {
    await mountSettings();
    await clickControl(await nonTextControl("range"));
    for (const key of ["Delete", "Backspace"]) {
      await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    }
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z", ctrlKey: platform === "windows", metaKey: platform === "macos", bubbles: true, cancelable: true
    })));
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(forceDocumentHistoryCommandId("edit.undo"));
  });

  it.each(["Bond color", "Label color", "Atom label background color", "Custom ring fill color", "Ring effect color"])(
    "preserves %s click defaults, node and focus through lease acquisition and snapshots", async (label) => {
      const doc = structuredClone(selectedMolecule());
      const molecule = doc.pages[0].objects[0] as MoleculeObject;
      // A real ring supplies both Rings colour controls, including a visible glow effect.
      molecule.atoms = Array.from({ length: 6 }, (_, index) => ({
        id: `a${index}`, element: "C", formalCharge: 0,
        x: 160 + 30 * Math.cos(index * Math.PI / 3), y: 160 + 30 * Math.sin(index * Math.PI / 3)
      }));
      molecule.bonds = molecule.atoms.map((atom, index) => ({
        id: `b${index}`, fromAtomId: atom.id, toAtomId: molecule.atoms[(index + 1) % 6]!.id, order: "single"
      }));
      const model = createMoleculeInspectorModel(doc, { selectedObjectIds: [molecule.id] });
      const ring = label === "Custom ring fill color" || label === "Ring effect color";
      // Select the ring through the same model contract the document sends to the palette.
      if (ring) {
        const { nativeMoleculeRings } = await import("@chemdraft/layout-engine");
        const selected = nativeMoleculeRings(molecule)[0]!;
        Object.assign(model, createMoleculeInspectorModel(doc, {
          selectedObjectIds: [molecule.id], selectedPart: {
            objectId: molecule.id, kind: "ring", ringKey: selected.ringKey,
            atomIds: selected.atomIds, bondIds: selected.bondIds
          }
        }));
        model.rings.values.effect.value = "glow";
        model.rings.effectKinds = ["glow"];
        model.rings.effectControls.glow.presentCount = 1;
      }
      model.atomLabels.values.backgroundColor.value = "#ffffff";
      await mountSettings(ring ? "core.ringInspector" : "core.drawnStructureSettings", model);
      if (label === "Label color" || label === "Atom label background color") {
        await act(async () => container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-atom-labels")!.click());
      }
      const color = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      expect(color?.disabled).toBe(false);
      const blur = vi.spyOn(color, "blur");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      let settle!: (acquired: boolean) => void;
      native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
      const snapshots = async () => {
        await broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", structuredClone(model)));
        expect(container.querySelector(`input[aria-label="${label}"]`)).toBe(color);
      };
      await act(async () => {
        expect(pointer(color, "pointerdown").defaultPrevented).toBe(false);
        const down = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
        color.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
        color.focus(); // Browser default on WebView2; never suspend this non-text focus.
        await snapshots();
      });
      await flush();
      expect(document.activeElement).toBe(color);
      await act(async () => {
        pointer(color, "pointerup");
        color.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
        expect(pointer(color, "click").defaultPrevented).toBe(false);
        await snapshots();
      });
      settle(true);
      await flush();
      await act(snapshots);
      expect(document.activeElement).toBe(color);
      expect(blur).not.toHaveBeenCalled();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus.mock.contexts.every((target) => target === color)).toBe(true);
      expect(leases().map(([, args]) => args.editing)).toEqual([true]);
      expect(sendPaletteCommandCommit).not.toHaveBeenCalled();
    }
  );

  // Deliberately reverse the earlier text-only rule: otherwise Delete lands on the document.
  it.each(["select", "range", "checkbox", "color"])("leases a clicked %s and preserves select type-ahead or forwards its palette hotkey", async (kind) => {
    await mountSettings();
    const control = await nonTextControl(kind);
    await clickControl(control);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(control);
    vi.mocked(sendPaletteCommand).mockClear();
    native.resolved.mockClear();
    const event = new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true });
    await act(async () => control.dispatchEvent(event));
    expect(native.resolved).toHaveBeenCalledTimes(kind === "select" ? 0 : 1);
    expect(sendPaletteCommand).toHaveBeenCalledTimes(kind === "select" ? 0 : 1);
    expect(event.defaultPrevented).toBe(kind !== "select");
  });

  it("does not forward a hotkey in the native acquisition/refocus gap", async () => {
    const input = await mountSettings();
    let settle!: (acquired: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    await act(async () => input.focus());
    await flush();
    expect(document.activeElement).not.toBe(input);
    native.resolved.mockClear();
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true })));
    expect(native.resolved).not.toHaveBeenCalled();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    settle(true);
    await flush();
    expect(document.activeElement).toBe(input);
  });

  it.each(["checkbox", "select", "range", "color", "button"])("keeps activation and editing keys in a clicked %s while still forwarding shortcuts", async (kind) => {
    await mountSettings();
    const control = await nonTextControl(kind);
    await clickControl(control);
    expect(document.activeElement).toBe(control);
    expect(leases().filter(([, args]) => args.editing)).toHaveLength(kind === "button" ? 0 : 1);
    native.resolved.mockClear();
    vi.mocked(sendPaletteCommand).mockClear();
    for (const key of ["Delete", "Backspace", " ", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => control.dispatchEvent(event));
      expect(native.resolved, key).not.toHaveBeenCalled();
      expect(sendPaletteCommand, key).not.toHaveBeenCalled();
      expect(event.defaultPrevented, key).toBe(false);
      expect(document.activeElement, key).toBe(control);
    }
    const hotkey = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    await act(async () => control.dispatchEvent(hotkey));
    expect(native.resolved).toHaveBeenCalledTimes(kind === "select" ? 0 : 1);
    expect(sendPaletteCommand).toHaveBeenCalledTimes(kind === "select" ? 0 : 1);
    expect(hotkey.defaultPrevented).toBe(kind !== "select");
    vi.mocked(sendPaletteCommand).mockClear();
    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: platform === "windows", metaKey: platform === "macos", bubbles: true, cancelable: true });
    await act(async () => control.dispatchEvent(undo));
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(forceDocumentHistoryCommandId("edit.undo"));
    expect(undo.defaultPrevented).toBe(true);
    if (kind !== "button") {
      await act(async () => control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      await flush();
      expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
      expect(document.activeElement).not.toBe(control);
    }
  });

  it("preserves select type-ahead that does not resolve to a shortcut", async () => {
    await mountSettings();
    const select = container.querySelector<HTMLSelectElement>("select:not(:disabled)")!;
    await clickControl(select);
    const registry = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), { includeDisabled: true });
    const key = [..."abcdefghijklmnopqrstuvwxyz"].find((key) => !registry.resolve({ key }))!;
    expect(key).toBeTruthy();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => select.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it.each([2, 3])("keeps a number's lease across a Windows-ordered %i-click and transient control blur", async (count) => {
    const input = await mountSettings();
    await clickControl(input);
    for (let detail = 2; detail <= count; detail++) {
      await act(async () => {
        pointer(input, "pointerdown", detail);
        input.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail, bubbles: true }));
        // WebView2 can emit focusout(null) before restoring focus during the next click.
        // Use actual blur/focus: relatedTarget and document.activeElement must be real.
        input.blur();
        window.dispatchEvent(new Event("blur"));
        input.focus();
        window.dispatchEvent(new Event("focus"));
        pointer(input, "pointerup", detail);
        input.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail, bubbles: true }));
        pointer(input, "click", detail);
        if (detail === 2) input.dispatchEvent(new MouseEvent("dblclick", { detail, bubbles: true }));
      });
      await flush();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(input);
    for (const key of ["3", "Delete", "Backspace"]) {
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    }
    await type(input, "33");
    expect(input.value).toBe("33");
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it.each([2, 3])("requests only one lease for %i clicks while acquisition is pending", async (count) => {
    const input = await mountSettings();
    let settle!: (acquired: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    for (let detail = 1; detail <= count; detail++) await clickControl(input, detail);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    settle(true);
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(input);
  });

  it("does not forward a key without a control target during transient text blur", async () => {
    const input = await mountSettings();
    await clickControl(input);
    native.resolved.mockClear();
    await act(async () => {
      input.blur();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true }));
      input.focus();
    });
    await flush();
    expect(native.resolved).not.toHaveBeenCalled();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(input);
  });

  it("leases a clicked slider so its arrow default commits once per changed value", async () => {
    await mountSettings();
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Target bond length slider"]')!;
    await clickControl(slider);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    for (const value of [60.5, 61]) {
      const down = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      await act(async () => slider.dispatchEvent(down));
      expect(down.defaultPrevented).toBe(false);
      // jsdom omits range stepping. Execute that browser default after keydown, with input
      // and change delivered before keyup, as WebView2/WebKit do for range controls.
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, String(value));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })));
    }
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      slider.blur();
    });
    await flush();
    expect(sendPaletteCommandCommit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendPaletteCommandCommit).mock.calls).toEqual([60.5, 61].map((value) => [moleculeStructureBondLengthCommandId(value)]));
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it("reverts a numeric draft after a failed lease and follows subsequent model updates", async () => {
    const input = await mountSettings();
    let settle!: (acquired: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    await act(async () => input.focus());
    await flush();
    await type(input, "30"); // Input already delivered while the native acquisition reply is pending.
    settle(false);
    await flush();
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("60");
    const model = createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: ["mol_input_focus"] });
    model.structure.values.bondLengthPx.value = 40;
    await act(async () => broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", model)));
    expect(input.value).toBe("40");
    expect(sendPaletteCommandCommit).not.toHaveBeenCalled();
  });

  it("commits the first unfocused native spinner click once across asynchronous lease refocus", async () => {
    const input = await mountSettings();
    let settle!: (acquired: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    await act(async () => {
      input.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
      input.focus();
    });
    await flush();
    await act(async () => {
      input.stepUp(); // jsdom has no spin-button hit target; run the native default explicitly.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    settle(true);
    await flush();
    expect(input.value).toBe("60.5");
    expect(sendPaletteCommandCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(60.5));
    await act(async () => input.blur());
    expect(sendPaletteCommandCommit).toHaveBeenCalledTimes(1);
  });

  it("Tabs from a typed number to its slider and commits only the typed value", async () => {
    const input = await mountSettings();
    await act(async () => input.focus());
    await flush();
    await type(input, "30");
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(tab));
    if (!tab.defaultPrevented) await act(async () => slider.focus());
    await flush();
    expect(document.activeElement).toBe(slider);
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true })));
    expect(sendPaletteCommandCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
    expect(leases().map(([, args]) => args.editing)).toEqual([true]); // Slider retains the control lease.
  });

  it("acquires for real control focus and releases on real blur", async () => {
    const input = await mountSettings();
    await act(async () => input.focus());
    await flush();
    expect(document.activeElement).toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(leases()[0]![1]).toMatchObject({ pageToken: "palette-page", generation: expect.any(Number) });
    await act(async () => input.blur());
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
  });

  it.each(["3", "Delete", "Backspace"])("keeps %s in the input and still forwards it outside controls", async (key) => {
    const input = await mountSettings();
    await act(async () => input.focus());
    await flush();
    const typing = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    native.resolved.mockClear();
    await act(async () => input.dispatchEvent(typing));
    expect(native.resolved).not.toHaveBeenCalled();
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    expect(typing.defaultPrevented).toBe(false);
    await act(async () => input.blur());
    await flush(); // Only a settled departure releases the lease and restores shortcuts.
    const outside = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => container.querySelector(".palette-window-shell")!.dispatchEvent(outside));
    const command = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), { includeDisabled: true }).resolve({ key });
    expect(command).toBeTruthy();
    expect(sendPaletteCommand).toHaveBeenCalledExactlyOnceWith(command);
    expect(outside.defaultPrevented).toBe(true);
  });

  it("keeps a field unfocused until acquisition settles and blurs a rejected lease", async () => {
    const input = await mountSettings();
    let settle!: (acquired: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    await act(async () => input.focus());
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).not.toBe(input);
    settle(false);
    await flush();
    expect(document.activeElement).not.toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await act(async () => input.focus());
    await flush();
    expect(document.activeElement).toBe(input);
  });

  it("ends the lease on native loss and allows a fresh edit after switching apps", async () => {
    const input = await mountSettings();
    await act(async () => input.focus());
    await flush();
    const generation = leases()[0]![1].generation;
    await act(async () => native.notify!({ payload: { kind: "deactivated", generation } }));
    await flush();
    expect(document.activeElement).not.toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
    expect(leases().at(-1)![1]).toMatchObject({ returnFocus: false });
    await act(async () => input.focus());
    await flush();
    expect(document.activeElement).toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false, true]);
  });

  it.each(["Escape", "Tab"])("requests document foreground when a closed select ends via %s", async (key) => {
    await mountSettings();
    const select = await nonTextControl("select");
    await clickControl(select);
    await press(select, "n"); // Native type-ahead keeps the lease.
    const event = await press(select, key);
    if (key === "Tab") {
      expect(event.defaultPrevented).toBe(false);
      await act(async () => select.blur()); // Browser's traversal out of the palette.
    }
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
    expect(leases().at(-1)![1]).toMatchObject({ returnFocus: true });
    expect(document.activeElement).not.toBe(select);
  });

  it.each(["select", "color"])("does not request foreground when a native %s chooser takes focus", async (kind) => {
    await mountSettings();
    const control = await nonTextControl(kind);
    await clickControl(control);
    const generation = leases().at(-1)![1].generation;
    await act(async () => native.notify!({ payload: { kind: "deactivated", generation } }));
    await flush();
    expect(leases().at(-1)![1]).toMatchObject({ editing: false, returnFocus: false });
    expect(document.activeElement).toBe(control);
  });

  it("lets the settings control cancel its preview before Escape releases focus", async () => {
    const input = await mountSettings();
    await act(async () => input.focus());
    await flush();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await flush();
    expect(sendPaletteCommandCancel).toHaveBeenCalledExactlyOnceWith("palette.preview.cancel");
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
    expect(document.activeElement).not.toBe(input);
    expect(sendPaletteCommand).not.toHaveBeenCalled();
  });

  it("gives Customize gallery search the same lease and keeps its keys local", async () => {
    await act(async () => root.render(createElement(PaletteWindow)));
    await flush();
    await act(async () => { await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true }); });
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search toolbar items"]')!;
    expect(search).not.toBeNull();
    await act(async () => search.focus());
    await flush();
    expect(document.activeElement).toBe(search);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true })));
    expect(sendPaletteCommand).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "ring");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(search.value).toBe("ring");
    await act(async () => search.blur());
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
  });

  it("also leases the colour popover's editable fields", async () => {
    await act(async () => root.render(createElement(PalettePopoverWindow, { prewarm: true })));
    await flush();
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input).not.toBeNull();
    await act(async () => input.focus());
    await flush();
    expect(document.activeElement).toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    await act(async () => input.blur());
    await flush();
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
  });

  it("commits the popover hex field once on Enter before releasing its lease", async () => {
    await act(async () => root.render(createElement(PalettePopoverWindow, { prewarm: true })));
    await flush();
    const input = container.querySelector<HTMLInputElement>('.color-hex-field input')!;
    await act(async () => input.focus());
    await flush();
    await type(input, "#abc");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await flush();
    expect(sendPaletteCommandCommit).toHaveBeenCalledExactlyOnceWith(objectCustomColorCommandId("#aabbcc"));
    expect(document.activeElement).not.toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
  });

  it("keeps two open palettes' lease generations and native loss listeners independent", async () => {
    const first = await mountSettings();
    const firstNotify = native.notify!;
    const secondContainer = document.createElement("div");
    document.body.append(secondContainer);
    const secondRoot = createRoot(secondContainer);
    try {
      await act(async () => secondRoot.render(createElement(PaletteWindow, { toolsetId: "core.main" })));
      await flush();
      const secondNotify = native.notify!;
      await act(async () => broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true }));
      const second = secondContainer.querySelector<HTMLInputElement>('[aria-label="Search toolbar items"]')!;
      // Concurrent dynamic imports in the runner can reach Tauri's actual invoke wrapper.
      // After mounting both windows, terminate that route at the same mocked native boundary.
      vi.stubGlobal("__TAURI_INTERNALS__", { invoke: native.invoke });
      await act(async () => first.focus());
      await flush();
      expect(document.activeElement === first, "first acquired").toBe(true);
      const firstGeneration = leases().at(-1)![1].generation;
      await act(async () => second.focus());
      await act(async () => vi.waitFor(() => expect(document.activeElement === second, "second acquired").toBe(true)));
      const secondGeneration = leases().at(-1)![1].generation;
      expect(secondGeneration).not.toBe(firstGeneration);
      await act(async () => firstNotify({ payload: { kind: "deactivated", generation: firstGeneration } }));
      await flush();
      expect(document.activeElement).toBe(second);
      await act(async () => secondNotify({ payload: { kind: "deactivated", generation: secondGeneration } }));
      await flush();
      expect(document.activeElement).not.toBe(second);
      await act(async () => first.focus());
      await flush();
      expect(document.activeElement).toBe(first);
      expect(leases().map(([, args]) => args.editing)).toEqual([true, false, true, false, true]);
    } finally {
      await act(async () => secondRoot.unmount());
      secondContainer.remove();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the colour popover's Escape dismissal while releasing its input lease", async () => {
    await act(async () => root.render(createElement(PalettePopoverWindow, { prewarm: true })));
    await flush();
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => input.focus());
    await flush();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await flush();
    expect(sendPaletteCommandCancel).toHaveBeenCalledExactlyOnceWith("palette.preview.cancel");
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
  });
});
