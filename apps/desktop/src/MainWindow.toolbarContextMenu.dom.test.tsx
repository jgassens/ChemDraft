// @vitest-environment jsdom
// Right-click a floating toolbar, choose Customize Toolbar…: the command travels the real palette
// route (sendPaletteCommand -> route_toolset_command -> the document window's native-command event),
// MainWindow runs the REGISTERED customize command, and the clicked toolbar opens its customize
// gallery. Only the two Tauri IPC hops are stood in for: the native popup returns Rust's fixed choice, and
// route_toolset_command delivers the command into the document window exactly as Rust does
// (`dispatch_dom_command_event`). The press itself is a real right-click on the toolbar's button.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  choose: null as string | null,
  popups: 0,
  routed: [] as string[]
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "popup_toolbar_context_menu") {
      // Rust builds the items for the calling window's toolset and returns the fixed choice.
      native.popups += 1;
      expect(args).toEqual({ toolsetId: "core.main" });
      return native.choose;
    }
    if (command === "route_toolset_command") {
      native.routed.push(args!.commandId as string);
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: args!.commandId } }));
    }
    return undefined;
  })
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fire(target: Element, type: string) {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, button: 2, buttons: type.endsWith("down") ? 2 : 0, clientX: 40, clientY: 20
  });
  if (type.startsWith("pointer")) {
    Object.defineProperties(event, { pointerId: { value: 3 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
  }
  target.dispatchEvent(event);
}

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

describe.each(["macos", "windows", "linux"] as const)("Customize Toolbar… from a toolbar's right-click menu (%s)", platform => {
  let documentRoot: Root;
  let paletteRoot: Root;
  let documentContainer: HTMLDivElement;
  let paletteContainer: HTMLDivElement;

  beforeEach(async () => {
    native.choose = null;
    native.popups = 0;
    native.routed = [];
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    documentContainer = document.createElement("div");
    paletteContainer = document.createElement("div");
    document.body.append(documentContainer, paletteContainer);
    documentRoot = createRoot(documentContainer);
    paletteRoot = createRoot(paletteContainer);
    await act(async () => documentRoot.render(createElement(MainWindow, {
      initialDocument: createPhase4Document("Toolbar menu"), initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, initialCrosshairsVisible: false,
      nativePalette: false, shortcutPlatform: platform as ShortcutPlatform
    })));
    await act(async () => paletteRoot.render(createElement(PaletteWindow, { toolsetId: "core.main", platform })));
    await settle();
  });

  afterEach(async () => {
    await act(async () => { paletteRoot.unmount(); documentRoot.unmount(); });
    documentContainer.remove();
    paletteContainer.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs the registered customize command and opens the gallery for the clicked toolbar", async () => {
    const palette = () => paletteContainer.querySelector<HTMLElement>("main.palette-window-shell")!;
    const bond = palette().querySelector<HTMLButtonElement>('button[data-command-id="tool.bond"]')!;
    expect(palette().querySelector(".customize-gallery-tray")).toBeNull();
    native.choose = "customize";

    await act(async () => {
      fire(bond, "pointerdown");
      fire(bond, "mousedown");
      if (platform !== "windows") fire(bond, "contextmenu");
      fire(bond, "pointerup");
      fire(bond, "mouseup");
      fire(bond, "auxclick");
      if (platform === "windows") fire(bond, "contextmenu");
    });
    await settle();

    expect(native.popups).toBe(1);
    // Exactly the customize command reached the document window; the right-clicked button never ran.
    expect(native.routed).toEqual(["view.customizeMainToolbar"]);
    expect(palette().querySelector(".customize-main-toolbar-bar")).not.toBeNull();
    expect(palette().querySelector(".customize-gallery-tray")).not.toBeNull();
    expect(palette().querySelector(".tool-palette.customizing")).not.toBeNull();
  });
});
