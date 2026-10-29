// @vitest-environment jsdom
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
  sendPaletteCommand, sendPaletteCommandCancel, sendPaletteCommandCommit
} from "./window-manager";
import type { NativePanelFocusEvent } from "./plugins/pluginPanelInputFocus";
import { forceDocumentHistoryCommandId, installSecondaryWindowEditHistory } from "./editHistoryRouting";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolved: vi.fn(),
  platform: "macos" as "macos" | "windows",
  notify: undefined as ((event: { payload: NativePanelFocusEvent }) => void) | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  sendPaletteCommand: vi.fn(async () => undefined),
  sendPaletteCommandCommit: vi.fn(async () => undefined),
  sendPaletteCommandCancel: vi.fn(async () => undefined)
}));
vi.mock("./window-manager/tauriEvents", async (original) => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenCurrentWindowEvent: vi.fn(async (name: string, listener: (event: { payload: NativePanelFocusEvent }) => void) => {
    if (name === "chemdraft://plugin-panel-focus") native.notify = listener;
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

describe.each(["macos", "windows"] as const)("palette input focus (%s)", (platform) => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: MockInstance<EventTarget["addEventListener"]>;
  let windowListeners: MockInstance<Window["addEventListener"]>;
  beforeEach(() => {
    listeners = vi.spyOn(EventTarget.prototype, "addEventListener");
    windowListeners = vi.spyOn(window, "addEventListener");
    native.platform = platform;
    native.invoke.mockReset().mockImplementation(async (command: string, args?: { editing: boolean }) =>
      command === "register_plugin_panel_input_focus" ? "palette-page" : args?.editing);
    vi.mocked(sendPaletteCommand).mockClear();
    vi.mocked(sendPaletteCommandCancel).mockClear();
    vi.mocked(sendPaletteCommandCommit).mockClear();
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
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId })));
    await flush();
    // jsdom has no pointer capture implementation; support the shell's drag cleanup.
    for (const element of container.querySelectorAll<HTMLElement>("*")) element.hasPointerCapture = () => false;
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

  async function press(input: HTMLInputElement, key: string, modifiers: KeyboardEventInit = {}) {
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
    const owner = container.querySelector(".palette-window-shell")!;
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
  it.each(["select", "range", "checkbox", "color"])("leases a clicked %s and forwards its next palette hotkey", async (kind) => {
    await mountSettings();
    const control = await nonTextControl(kind);
    await clickControl(control);
    expect(leases().map(([, args]) => args.editing)).toEqual([true]);
    expect(document.activeElement).toBe(control);
    vi.mocked(sendPaletteCommand).mockClear();
    native.resolved.mockClear();
    const event = new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true });
    await act(async () => control.dispatchEvent(event));
    expect(native.resolved).toHaveBeenCalledOnce();
    expect(sendPaletteCommand).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
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
    expect(native.resolved).toHaveBeenCalledOnce();
    expect(sendPaletteCommand).toHaveBeenCalledOnce();
    expect(hotkey.defaultPrevented).toBe(true);
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

  it("prevents select type-ahead that does not resolve to a shortcut", async () => {
    await mountSettings();
    const select = container.querySelector<HTMLSelectElement>("select:not(:disabled)")!;
    await clickControl(select);
    const registry = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), { includeDisabled: true });
    const key = [..."abcdefghijklmnopqrstuvwxyz"].find((key) => !registry.resolve({ key }))!;
    expect(key).toBeTruthy();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => select.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
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
    await act(async () => input.focus());
    await flush();
    expect(document.activeElement).toBe(input);
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false, true]);
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
