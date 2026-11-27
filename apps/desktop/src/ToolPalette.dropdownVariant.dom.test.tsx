// @vitest-environment jsdom
// Owner report 1.2.3: "the single bond dropdown can't switch its icon (or function) when another tool
// is selected. it needs to be independently functional." A dropdown shows and performs only the
// variant last chosen from its own menu, and exactly one control shows the active tool.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { ToolPalette } from "./ToolPalette";
import { getToolsetCommandGroups, getToolsetItemGroups } from "./toolsets";
import type { ToolsetPopoverContentPayload } from "./window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  /** route_toolset_command as Rust runs it for a popover: a drawing-tool claim is credited to the
   *  popover's verified flyout opening and dispatched into the toolbar windows before the command. */
  command: vi.fn(async (commandId: string, options?: {
    flyoutOpening?: { toolsetId: string; flyoutId: string };
    toolChoice?: object;
  }) => {
    if (!options?.toolChoice || !options.flyoutOpening) return;
    const { toolsetId, flyoutId } = options.flyoutOpening;
    window.dispatchEvent(new CustomEvent("chemdraft:toolbar-tool-choice", { detail: { toolsetId, flyoutId, commandId } }));
  }),
  hide: vi.fn(async () => {}),
  show: vi.fn(async () => true)
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: native.hide, setFocus: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: vi.fn(async () => {}) }) }));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  isToolsetPopoverVisible: async () => true,
  listenForToolsetPopoverContent: vi.fn(async (handler: (payload: ToolsetPopoverContentPayload) => void) => {
    native.content = handler;
    return () => {};
  }),
  listenForToolsetPopoverDismiss: vi.fn(async () => () => {}),
  listenForToolsetPopoverRelease: vi.fn(async () => () => {}),
  listenForToolsetFlyoutKeys: vi.fn(async () => () => {}),
  listenForBondStereoPopoverActions: vi.fn(async () => () => {}),
  listenForToolsetTextStyle: vi.fn(async () => () => {}),
  requestToolsetPopoverContent: vi.fn(async () => {}), requestToolsetTextStyle: vi.fn(async () => {}),
  notifyToolsetPopoverClosed: vi.fn(async () => {}), notifyToolsetFlyoutClosed: vi.fn(async () => {}),
  sendPaletteCommand: native.command,
  setCurrentWindowLogicalSize: vi.fn(async () => {}), setCurrentWindowLogicalPosition: vi.fn(async () => {}),
  showCurrentToolsetPopoverWindow: native.show
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let containers: HTMLDivElement[] = [];
let roots: Root[] = [];
function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  return { container, root };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.content = undefined;
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  for (const container of containers) container.remove();
  roots = [];
  containers = [];
});

/** Drawing-tool controls showing themselves as the active tool (style swatches have their own state). */
const pressed = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"][data-command-id^="tool."]')]
    .map(button => button.dataset.commandId);

describe.each(["macos", "windows"] as const)("toolbar dropdowns keep their own variant on %s", platform => {
  /** A real toolbar the app ships, as the palette window renders it; the app owns `activeTool`. */
  function palette(toolsetId: string, options: { native?: boolean } = {}) {
    const { container, root } = mount();
    const onInvoke = vi.fn();
    const onRequestFlyout = vi.fn();
    const render = async (activeTool: string) => act(async () => root.render(createElement(ToolPalette, {
      groups: getToolsetCommandGroups(toolsetId), itemGroups: getToolsetItemGroups(toolsetId),
      activeTool, toolsetId, orientation: "horizontal", mode: "floating", platform, onInvoke,
      ...(options.native ? { onRequestFlyout } : {})
    })));
    /** A real mouse click (press, release, click); the palette invokes, then the document window makes
     *  the tool active and broadcasts it back. */
    const click = async (button: HTMLButtonElement) => {
      onInvoke.mockClear();
      await act(async () => {
        button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      });
      expect(onInvoke).toHaveBeenCalledTimes(1);
      const commandId = onInvoke.mock.calls[0]![0] as string;
      await render(commandId);
      return commandId;
    };
    const face = (flyoutId: string) =>
      container.querySelector<HTMLButtonElement>(`[data-command-flyout-button="${flyoutId}"]`)!;
    const standalone = (commandId: string) =>
      container.querySelector<HTMLButtonElement>(`[data-toolbar-item-id="${commandId}"] > button[data-command-id="${commandId}"]`)!;
    const chooseFromMenu = async (flyoutId: string, commandId: string) => {
      await act(async () => face(flyoutId).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
      const entry = container.querySelector<HTMLButtonElement>(
        `[data-command-flyout-menu="${flyoutId}"] [role="menuitem"][data-command-id="${commandId}"]`
      )!;
      expect(entry).not.toBeNull();
      return click(entry);
    };
    return { container, onInvoke, onRequestFlyout, render, click, face, standalone, chooseFromMenu };
  }

  it("keeps the single-bond dropdown's icon and function when the separate Dashed button is chosen", async () => {
    const main = palette("core.main");
    await main.render("tool.select");
    const bond = main.face("bond-tools");
    const icon = bond.getAttribute("data-toolbar-asset");
    expect(bond.getAttribute("data-command-id")).toBe("tool.bond");

    expect(await main.click(main.standalone("tool.dashedBond"))).toBe("tool.dashedBond");
    expect(bond.getAttribute("data-command-id")).toBe("tool.bond");
    expect(bond.getAttribute("data-toolbar-asset")).toBe(icon);
    expect(bond.getAttribute("aria-pressed")).toBeNull();
    expect(bond.classList.contains("active")).toBe(false);
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);

    // Its main face still draws its own variant, the single bond.
    expect(await main.click(bond)).toBe("tool.bond");
    expect(pressed(main.container)).toEqual(["tool.bond"]);
  });

  it("shows and highlights a variant chosen from the bond dropdown, never the separate button", async () => {
    const main = palette("core.main");
    await main.render("tool.select");
    const bond = main.face("bond-tools");
    const singleIcon = bond.getAttribute("data-toolbar-asset");

    expect(await main.chooseFromMenu("bond-tools", "tool.dashedBond")).toBe("tool.dashedBond");
    expect(bond.getAttribute("data-command-id")).toBe("tool.dashedBond");
    expect(bond.getAttribute("data-toolbar-asset")).not.toBe(singleIcon);
    expect(bond.getAttribute("aria-pressed")).toBe("true");
    expect(main.standalone("tool.dashedBond").getAttribute("aria-pressed")).toBeNull();
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);

    // Another button takes the highlight but not the dropdown's variant.
    expect(await main.click(main.standalone("tool.wedgeBond"))).toBe("tool.wedgeBond");
    expect(bond.getAttribute("data-command-id")).toBe("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.wedgeBond"]);

    // The separate Dashed button, choosing the dropdown's own variant, highlights only itself.
    expect(await main.click(main.standalone("tool.dashedBond"))).toBe("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(main.standalone("tool.dashedBond").getAttribute("aria-pressed")).toBe("true");
    expect(bond.getAttribute("aria-pressed")).toBeNull();

    // The dropdown's face performs its remembered variant, exactly once.
    expect(await main.click(bond)).toBe("tool.dashedBond");
    expect(bond.getAttribute("aria-pressed")).toBe("true");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
  });

  it("does the same for the ring dropdown", async () => {
    const main = palette("core.main");
    await main.render("tool.select");
    const ring = main.face("ring-templates");
    expect(ring.getAttribute("data-command-id")).toBe("tool.benzene");

    expect(await main.chooseFromMenu("ring-templates", "tool.cyclohexane")).toBe("tool.cyclohexane");
    expect(ring.getAttribute("data-command-id")).toBe("tool.cyclohexane");
    expect(ring.getAttribute("aria-pressed")).toBe("true");
    expect(pressed(main.container)).toEqual(["tool.cyclohexane"]);

    expect(await main.click(main.standalone("tool.dashedBond"))).toBe("tool.dashedBond");
    expect(ring.getAttribute("data-command-id")).toBe("tool.cyclohexane");
    expect(ring.getAttribute("aria-pressed")).toBeNull();

    expect(await main.click(ring)).toBe("tool.cyclohexane");
    expect(pressed(main.container)).toEqual(["tool.cyclohexane"]);
  });

  it("does the same for the arrow dropdown and its separate arrow buttons", async () => {
    const main = palette("core.main");
    await main.render("tool.select");
    const arrow = main.face("arrow-tools");

    expect(await main.click(main.standalone("tool.art.resonanceArrow"))).toBe("tool.art.resonanceArrow");
    expect(arrow.getAttribute("data-command-id")).toBe("tool.art.reactionArrow");
    expect(pressed(main.container)).toEqual(["tool.art.resonanceArrow"]);

    expect(await main.chooseFromMenu("arrow-tools", "tool.art.resonanceArrow")).toBe("tool.art.resonanceArrow");
    expect(arrow.getAttribute("data-command-id")).toBe("tool.art.resonanceArrow");
    expect(arrow.getAttribute("aria-pressed")).toBe("true");
    expect(main.standalone("tool.art.resonanceArrow").getAttribute("aria-pressed")).toBeNull();
    expect(pressed(main.container)).toEqual(["tool.art.resonanceArrow"]);
  });

  it("highlights one control for a tool chosen off the toolbar, preferring its separate button", async () => {
    const main = palette("core.main");
    await main.render("tool.select");
    await main.chooseFromMenu("bond-tools", "tool.dashedBond");
    await main.render("tool.select");
    // A shortcut or the menu bar makes Dashed active: no control was pressed, so the separate button
    // shows it and the dropdown, though its face shows Dashed too, does not.
    await main.render("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(main.standalone("tool.dashedBond").getAttribute("aria-pressed")).toBe("true");
    expect(main.face("bond-tools").getAttribute("data-command-id")).toBe("tool.dashedBond");
    // With no separate button for the tool, the dropdown whose face shows it is the one.
    await main.chooseFromMenu("ring-templates", "tool.cyclohexane");
    await main.render("tool.select");
    await main.render("tool.cyclohexane");
    expect(pressed(main.container)).toEqual(["tool.cyclohexane"]);
    // ...and a dropdown whose face shows something else never lights up for a tool in its menu, nor
    // takes that tool as its variant.
    await main.render("tool.benzene");
    expect(pressed(main.container)).toEqual([]);
    expect(main.face("ring-templates").getAttribute("data-command-id")).toBe("tool.cyclohexane");
    await main.render("tool.bond");
    expect(pressed(main.container)).toEqual([]);
    expect(main.face("bond-tools").getAttribute("data-command-id")).toBe("tool.dashedBond");
  });

  it("lights only the control that was pressed when two toolbars carry the same tool", async () => {
    const main = palette("core.main");
    const structure = palette("core.structure");
    await main.render("tool.select");
    await structure.render("tool.select");
    await structure.click(structure.standalone("tool.dashedBond"));
    await main.render("tool.dashedBond");
    expect(pressed(structure.container)).toEqual(["tool.dashedBond"]);
    expect(pressed(main.container)).toEqual([]);
  });

  it("credits a native flyout choice to its own dropdown only", async () => {
    const main = palette("core.main", { native: true });
    await main.render("tool.select");
    const bond = main.face("bond-tools");
    await act(async () => bond.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(main.onRequestFlyout).toHaveBeenCalledTimes(1);
    const flyout = main.onRequestFlyout.mock.calls[0]![0].flyout;
    expect(flyout.flyoutId).toBe("bond-tools");

    const popover = mount();
    await act(async () => popover.root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true, platform })));
    await act(async () => native.content?.({ toolsetId: "core.main", kind: "flyout", flyout }));
    const dashed = popover.container.querySelector<HTMLButtonElement>('[role="menu"] [data-command-id="tool.dashedBond"]')!;
    await act(async () => dashed.click());
    expect(native.command).toHaveBeenCalledExactlyOnceWith("tool.dashedBond", expect.objectContaining({
      flyoutOpening: expect.objectContaining({ toolsetId: "core.main" }),
      toolChoice: {}
    }));
    expect(main.onInvoke).not.toHaveBeenCalled();

    // The document window makes Dashed active and broadcasts it.
    await main.render("tool.dashedBond");
    expect(bond.getAttribute("data-command-id")).toBe("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(bond.getAttribute("aria-pressed")).toBe("true");

    // Picking the separate Dashed button afterwards moves the highlight, not the variant.
    expect(await main.click(main.standalone("tool.dashedBond"))).toBe("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(main.standalone("tool.dashedBond").getAttribute("aria-pressed")).toBe("true");
    expect(bond.getAttribute("data-command-id")).toBe("tool.dashedBond");

    // A press on the face performs its own variant, through the same invoke-once path.
    expect(await main.click(bond)).toBe("tool.dashedBond");
    expect(bond.getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores a native flyout choice made on another toolbar", async () => {
    const main = palette("core.main", { native: true });
    await main.render("tool.select");
    const popover = mount();
    await act(async () => popover.root.render(createElement(PalettePopoverWindow, { toolsetId: "core.structure", kind: "flyout", prewarm: true, platform })));
    const structureBond = getToolsetItemGroups("core.structure").flat().find(item => item.id === "tool.bond")!;
    await act(async () => native.content?.({ toolsetId: "core.structure", kind: "flyout", flyout: {
      flyoutId: structureBond.submenu!.id, id: structureBond.submenu!.id, type: "command-grid", title: "Bonds",
      commands: structureBond.submenu!.items.map(command => ({ id: command.id, title: command.title, enabled: true, active: false }))
    } }));
    const wedge = popover.container.querySelector<HTMLButtonElement>('[role="menu"] [data-command-id="tool.wedgeBond"]')!;
    await act(async () => wedge.click());
    await main.render("tool.wedgeBond");
    expect(main.face("bond-tools").getAttribute("data-command-id")).toBe("tool.bond");
    expect(pressed(main.container)).toEqual([]);
  });
});
