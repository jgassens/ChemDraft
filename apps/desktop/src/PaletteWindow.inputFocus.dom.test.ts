// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, createEmptyDocument, DefaultNativeTextStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { allShellCommands, moleculeStructureBondLengthCommandId, objectCustomColorCommandId } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  broadcastToolsetCustomizeMode, broadcastToolsetTextStyle, createToolsetTextStylePayload,
  sendPaletteCommand, sendPaletteCommandCancel, sendPaletteCommandCommit
} from "./window-manager";
import type { NativePanelFocusEvent } from "./plugins/pluginPanelInputFocus";

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
      const registry = actual.createDesktopShortcutRegistry(...args);
      return { ...registry, resolve: (event: Parameters<typeof registry.resolve>[0]) => {
        native.resolved(event);
        return registry.resolve(event);
      } };
    }
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
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
  beforeEach(() => {
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
  });

  async function mountSettings() {
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.drawnStructureSettings" })));
    await flush();
    // jsdom has no pointer capture implementation; support the shell's drag cleanup.
    container.querySelector<HTMLElement>(".palette-window-shell")!.hasPointerCapture = () => false;
    const model = createMoleculeInspectorModel(selectedMolecule(), { selectedObjectIds: ["mol_input_focus"] });
    await act(async () => {
      await broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", model));
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length"]')!;
    expect(input?.disabled).toBe(false);
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

  it.each(["select", "range", "checkbox", "color"])("does not lease a %s and forwards its next palette hotkey", async (kind) => {
    await mountSettings();
    const control = container.querySelector<HTMLElement>(kind === "select" ? "select:not(:disabled)" : `input[type="${kind}"]`)!;
    await act(async () => {
      control.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
      control.focus();
      control.click();
    });
    await flush();
    expect(leases().filter(([, args]) => args.editing)).toEqual([]);
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

  it.each(["checkbox", "select", "range", "color", "button"])("keeps activation and editing keys in a focused %s while still forwarding a tool hotkey", async (kind) => {
    await mountSettings();
    const control = container.querySelector<HTMLElement>(
      kind === "select" ? "select:not(:disabled)" : kind === "button" ? "button:not(:disabled)" : `input[type="${kind}"]`
    )!;
    await act(async () => control.focus());
    await flush();
    expect(document.activeElement).toBe(control);
    native.resolved.mockClear();
    vi.mocked(sendPaletteCommand).mockClear();
    for (const key of ["Delete", "Backspace", " ", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => control.dispatchEvent(event));
      expect(native.resolved, key).not.toHaveBeenCalled();
      expect(sendPaletteCommand, key).not.toHaveBeenCalled();
      expect(event.defaultPrevented, key).toBe(false);
    }
    const hotkey = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    await act(async () => control.dispatchEvent(hotkey));
    expect(native.resolved).toHaveBeenCalledOnce();
    expect(sendPaletteCommand).toHaveBeenCalledOnce();
    expect(hotkey.defaultPrevented).toBe(true);
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
    expect(leases().map(([, args]) => args.editing)).toEqual([true, false]);
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
