// @vitest-environment jsdom

// Phase 4 seam: PaletteWindow enters/exits in-place customize mode off the customize-mode broadcast
// and echoes Done/Restore back to the main window over the layout-edit channel. Both run through the
// real window-manager DOM event bus in jsdom.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allShellCommands, type CommandSpec } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createPaletteRegistryFromLayoutState, PaletteWindow } from "./PaletteWindow";
import {
  broadcastToolsetCommandSpecs,
  broadcastToolsetCustomizeMode,
  TOOLSET_LAYOUT_EDIT_EVENT,
  type ToolsetLayoutEditPayload
} from "./window-manager";

const nativeSizing = vi.hoisted(() => ({
  setSize: vi.fn(async (_size: { width: number; height: number }): Promise<void> => undefined),
  setMinimum: vi.fn(async () => undefined),
  canSave: vi.fn(async () => true),
  resize: vi.fn(async () => undefined)
}));
vi.mock("./window-manager", async (importOriginal) => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  setCurrentWindowLogicalSize: nativeSizing.setSize,
  setPaletteMinimumSize: nativeSizing.setMinimum,
  startPaletteWindowResize: nativeSizing.resize,
  canPersistCurrentToolsetSize: nativeSizing.canSave
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PaletteWindow customize mode bridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let edits: ToolsetLayoutEditPayload[];
  let editListener: (event: Event) => void;

  beforeEach(() => {
    nativeSizing.setSize.mockReset().mockResolvedValue(undefined);
    nativeSizing.canSave.mockReset().mockResolvedValue(true);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 700, height: 90 } as DOMRect);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    edits = [];
    editListener = (event: Event) => {
      const detail = (event as CustomEvent<ToolsetLayoutEditPayload>).detail;
      if (detail) {
        edits.push(detail);
      }
    };
    window.addEventListener(TOOLSET_LAYOUT_EDIT_EVENT, editListener);
  });

  afterEach(() => {
    window.removeEventListener(TOOLSET_LAYOUT_EDIT_EVENT, editListener);
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderMainPalette(initialRegistry?: Parameters<typeof PaletteWindow>[0]["initialRegistry"], platform?: Parameters<typeof PaletteWindow>[0]["platform"]) {
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId: "core.main", initialRegistry, platform }));
    });
    // Let the async listener-attachment effects settle before "the main window broadcasts".
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function userResize(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    await act(async () => { window.dispatchEvent(new Event("resize")); });
  }

  it("keeps the complete natural first-open frame without persisting a programmatic resize", async () => {
    await renderMainPalette();
    expect(nativeSizing.setSize).toHaveBeenLastCalledWith({ width: 700, height: 90 });
    await userResize(700, 90);
    expect(container.querySelector("[data-user-sized=true]")).toBeNull();
    expect(localStorage.getItem("chemdraft.palette.frame.v1.core.main")).toBeNull();
  });

  it("persists a user frame, stops content-fit sizing, and restores it on restart", async () => {
    await renderMainPalette();
    await userResize(420, 240);
    expect(JSON.parse(localStorage.getItem("chemdraft.palette.frame.v1.core.main")!)).toEqual({ width: 420, height: 240 });
    expect(container.querySelector("[data-responsive-palette=true]")).not.toBeNull();
    const calls = nativeSizing.setSize.mock.calls.length;
    await act(async () => { await broadcastToolsetCommandSpecs(allShellCommands(createPhase4Document())); });
    expect(nativeSizing.setSize).toHaveBeenCalledTimes(calls);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderMainPalette();
    expect(nativeSizing.setSize).toHaveBeenLastCalledWith({ width: 420, height: 240 });
  });

  it("does not treat the OS minimum clamp as a user resize on a tiny toolbar", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 58, height: 50 } as DOMRect);
    await renderMainPalette();
    expect(nativeSizing.setSize).toHaveBeenLastCalledWith({ width: 96, height: 56 });
    await userResize(96, 56);
    expect(container.querySelector("[data-user-sized=true]")).toBeNull();
    expect(localStorage.getItem("chemdraft.palette.frame.v1.core.main")).toBeNull();
  });

  it("does not persist transient frames rejected by the native owner/quit check", async () => {
    await renderMainPalette();
    nativeSizing.canSave.mockResolvedValue(false);
    await userResize(420, 240);
    expect(localStorage.getItem("chemdraft.palette.frame.v1.core.main")).toBeNull();
    expect(container.querySelector("[data-user-sized=true]")).toBeNull();
  });

  it("ignores resize events until every programmatic size request settles", async () => {
    const finish: Array<() => void> = [];
    nativeSizing.setSize.mockImplementation(() => new Promise<void>((resolve) => finish.push(resolve)));
    await renderMainPalette();
    await act(async () => { await broadcastToolsetCommandSpecs(allShellCommands(createPhase4Document()).map((command) => ({ ...command, title: `${command.title} updated` }))); });
    expect(finish.length).toBeGreaterThan(1);
    await act(async () => { finish[0](); });
    await userResize(420, 240);
    expect(localStorage.getItem("chemdraft.palette.frame.v1.core.main")).toBeNull();
    await act(async () => { finish.slice(1).forEach((resolve) => resolve()); });
  });

  it("keeps the latest frame when native eligibility checks finish out of order", async () => {
    await renderMainPalette();
    const resolves: Array<(value: boolean) => void> = [];
    nativeSizing.canSave.mockImplementation(() => new Promise<boolean>((resolve) => resolves.push(resolve)));
    await userResize(420, 240);
    await userResize(460, 280);
    await act(async () => { resolves[1](true); });
    await act(async () => { resolves[0](true); });
    expect(JSON.parse(localStorage.getItem("chemdraft.palette.frame.v1.core.main")!)).toEqual({ width: 460, height: 280 });
  });

  it("does not persist after unmount while the native check is pending", async () => {
    await renderMainPalette();
    let finish!: (value: boolean) => void;
    nativeSizing.canSave.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await userResize(420, 240);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { finish(true); });
    expect(localStorage.getItem("chemdraft.palette.frame.v1.core.main")).toBeNull();
  });

  it("starts the native resize gesture from the grip", async () => {
    await renderMainPalette(undefined, "windows");
    nativeSizing.resize.mockClear();
    await act(async () => container.querySelector(".palette-resize-handle")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    expect(nativeSizing.resize).toHaveBeenCalledOnce();
  });

  it("resizes the macOS grip with logical pointer deltas instead of the unsupported native drag API", async () => {
    await userResize(700, 90);
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.main", platform: "macos" })));
    const grip = container.querySelector<HTMLButtonElement>(".palette-resize-handle")!;
    Object.defineProperties(grip, { setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() } });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    nativeSizing.resize.mockClear();
    await act(async () => {
      grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, screenX: 100, screenY: 100 }));
      grip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, screenX: 200, screenY: 200 }));
      frames.forEach((frame) => frame(0));
      grip.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(nativeSizing.resize).not.toHaveBeenCalled();
    expect(nativeSizing.setSize).toHaveBeenLastCalledWith({ width: 800, height: 190 });
  });

  it.each(["vertical", "horizontal"] as const)("honours saved %s orientation despite the frame aspect ratio", async (orientation) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(orientation === "vertical" ? 900 : 420);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(orientation === "vertical" ? 128 : 878);
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe() { this.callback(); }
      disconnect() {}
    });
    const registry = createPaletteRegistryFromLayoutState({ version: 1, toolsetOverrides: [{ toolsetId: "core.main", gridLayout: { orientation, columns: 2 } }], userToolsets: [] }, []);
    localStorage.setItem("chemdraft.palette.frame.v1.core.main", JSON.stringify(orientation === "vertical" ? { width: 900, height: 150 } : { width: 420, height: 900 }));
    await renderMainPalette(registry);
    expect(container.querySelector(`[data-tool-palette-orientation=${orientation}]`)).not.toBeNull();
  });

  it("restores a saved frame for a user toolbar with no declared grid size", async () => {
    const registry = createPaletteRegistryFromLayoutState({ version: 1, toolsetOverrides: [], userToolsets: [{ id: "user.empty", title: "Empty", source: "user", defaultVisible: true, defaultMode: "floating", groups: [{ id: "user.empty.items", items: [] }] }] }, []);
    localStorage.setItem("chemdraft.palette.frame.v1.user.empty", JSON.stringify({ width: 420, height: 240 }));
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "user.empty", initialRegistry: registry })));
    expect(nativeSizing.setSize).toHaveBeenLastCalledWith({ width: 420, height: 240 });
    expect(container.querySelector("[data-user-sized=true]")).not.toBeNull();
  });

  it("rejects malformed saved frames and retains the content-fit default", async () => {
    localStorage.setItem("chemdraft.palette.frame.v1.core.main", '{"width":-1,"height":200}');
    await renderMainPalette();
    expect(nativeSizing.setSize).toHaveBeenLastCalledWith({ width: 700, height: 90 });
    expect(container.querySelector("[data-user-sized=true]")).toBeNull();
  });

  it("routes the orientation toggle through the shared layout-edit channel", async () => {
    await renderMainPalette();
    await act(async () => container.querySelector<HTMLButtonElement>(".palette-orientation-toggle")!.click());
    expect(edits).toEqual([{ toolsetId: "core.main", edit: { kind: "setOrientation", orientation: "vertical" } }]);
  });

  it("shows the Done/Restore bar when customize mode turns on and hides it when off", async () => {
    await renderMainPalette();
    expect(container.querySelector(".customize-main-toolbar-bar")).toBeNull();

    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true });
    });
    expect(container.querySelector(".customize-main-toolbar-bar")).not.toBeNull();
    expect(container.querySelector(".tool-palette.customizing")).not.toBeNull();

    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: false });
    });
    expect(container.querySelector(".customize-main-toolbar-bar")).toBeNull();
  });

  it("routes Restore Defaults and Done back to the main window as edit ops", async () => {
    await renderMainPalette();
    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true });
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".customize-main-toolbar-button"));
    const restore = buttons.find((button) => button.textContent === "Restore Defaults");
    const done = buttons.find((button) => button.textContent === "Done");
    expect(restore).toBeDefined();
    expect(done).toBeDefined();

    await act(async () => {
      restore?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      done?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(edits).toEqual([
      { toolsetId: "core.main", edit: { kind: "resetToolset" } },
      { toolsetId: "core.main", edit: { kind: "exitCustomize" } }
    ]);
  });

  it("ignores a customize-mode broadcast for a different toolset", async () => {
    await renderMainPalette();
    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.art", active: true });
    });
    expect(container.querySelector(".customize-main-toolbar-bar")).toBeNull();
  });

  it("keeps an added dynamic launcher and refreshes its live title, icon, and availability", async () => {
    const commandId = "view.toolset.toggle.user.quick";
    const layoutState = {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.items",
              index: 0,
              item: {
                id: commandId,
                kind: "button",
                label: "Toggle Old Quick Tools",
                icon: "text",
                assetName: "Custom_Text",
                primary: { type: "command", commandId },
                submenu: null
              }
            }
          ]
        }
      ],
      userToolsets: [
        {
          id: "user.quick",
          title: "Renamed Quick Tools",
          source: "user",
          defaultVisible: false,
          defaultMode: "floating",
          groups: [
            {
              id: "user.quick.items",
              items: [{ commandId: "tool.select", title: "Selection Tool" }]
            }
          ]
        }
      ]
    };
    const seedSpec: CommandSpec = {
      id: commandId,
      title: "Toggle Renamed Quick Tools",
      icon: "palette",
      source: "core"
    };

    // The static shell id set does not know this user-toolbar launcher; the live spec id keeps the
    // persisted addition from being pruned during detached-palette rehydration.
    const registry = createPaletteRegistryFromLayoutState(layoutState, [seedSpec]);
    const liveLauncher = allShellCommands(createPhase4Document(), undefined, { registry })
      .find((command) => command.id === commandId);
    expect(liveLauncher?.title).toBe("Toggle Renamed Quick Tools");
    await renderMainPalette(registry);

    let button = container.querySelector<HTMLButtonElement>(`[data-command-id="${commandId}"]`);
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toContain("Toggle Renamed Quick Tools");
    expect(button?.getAttribute("data-toolbar-asset")).toBeNull();

    await act(async () => {
      await broadcastToolsetCommandSpecs([
        {
          ...seedSpec,
          title: "Toggle Final Quick Tools",
          icon: "undo",
          enabled: false,
          disabledReason: "Temporarily unavailable"
        }
      ]);
    });

    button = container.querySelector<HTMLButtonElement>(`[data-command-id="${commandId}"]`);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Toggle Final Quick Tools: Temporarily unavailable");
    expect(button?.querySelector(".title-glyph-icon")).toBeNull();
  });
});
