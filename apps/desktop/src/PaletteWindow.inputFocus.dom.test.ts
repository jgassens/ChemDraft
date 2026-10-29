// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, createEmptyDocument, DefaultNativeTextStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  broadcastToolsetCustomizeMode, broadcastToolsetTextStyle, createToolsetTextStylePayload,
  sendPaletteCommand, sendPaletteCommandCancel
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
  sendPaletteCommandCancel: vi.fn(async () => undefined)
}));
vi.mock("./window-manager/tauriEvents", async (original) => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenCurrentWindowEvent: vi.fn(async (_name: string, listener: (event: { payload: NativePanelFocusEvent }) => void) => {
    native.notify = listener;
    return () => { native.notify = undefined; };
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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await flush();
  });

  async function mountSettings() {
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.drawnStructureSettings" })));
    await flush();
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
