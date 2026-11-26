// @vitest-environment jsdom
//
// Bug clemens-n05 (user report, 2026-11-18): "Choosing a wedge, hashed or bold button hides the
// Single Bond tool." On the Main toolbar the bond group is the Single Bond button (with the
// "Bond tools" submenu) followed by the standalone Wedge/Hashed/Dashed/Bold buttons. Choosing one of
// those variants from the group's submenu turns the group's own button face into that variant, so
// the toolbar shows the variant twice and no button that draws a plain single bond with one click.
//
// These tests pin what the user expects, on both the inline submenu and the native flyout path and
// on both platforms: the submenu choice is activated exactly once, and afterwards (while the variant
// is the active tool, and after switching to another tool) a single click on a toolbar button in
// the bond group activates tool.bond exactly once.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "../PalettePopoverWindow";
import { ToolPalette } from "../ToolPalette";
import { getToolsetItemGroups, type ToolbarPaletteItemModel } from "../toolsets";
import type { ToolsetPopoverContentPayload } from "../window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  command: vi.fn(async () => {}), hide: vi.fn(async () => {}), show: vi.fn(async () => true)
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: native.hide, setFocus: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: vi.fn(async () => {}) }) }));
vi.mock("../plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("../plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));
vi.mock("../window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("../window-manager")>(),
  isToolsetPopoverVisible: async () => true,
  listenForToolsetPopoverContent: vi.fn(async handler => { native.content = handler; return () => {}; }),
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

const VARIANTS = ["tool.wedgeBond", "tool.hashedBond", "tool.boldBond", "tool.dashedBond"] as const;

/** The Main toolbar's bond group as shipped: Single Bond (with its submenu) through Bold Bond. */
function mainBondGroup(): ToolbarPaletteItemModel[] {
  const items = getToolsetItemGroups("core.main").flat();
  const start = items.findIndex(item => item.id === "tool.bond");
  const end = items.findIndex(item => item.id === "tool.benzene");
  if (start < 0 || end <= start) throw new Error("Expected the Main toolbar bond group before Ring templates.");
  return items.slice(start, end);
}

/** Toolbar buttons a user can click directly (not entries of an inline submenu), by command. */
function directButtons(host: HTMLElement, commandId: string): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(`button[data-command-id="${commandId}"]`)]
    .filter(button => !button.closest('[role="menu"]') && !button.disabled);
}

function directCommandIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button[data-command-id]")]
    .filter(button => !button.closest('[role="menu"]'))
    .map(button => button.getAttribute("data-command-id")!);
}

function dispatchPointerButton(element: Element, type: string) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  element.dispatchEvent(event);
}

/** One real mouse click as the webview delivers it: pointerdown, pointerup, then click. */
async function clickOnce(button: HTMLButtonElement) {
  await act(async () => {
    dispatchPointerButton(button, "pointerdown");
    dispatchPointerButton(button, "pointerup");
    button.click();
  });
}

async function expectSingleBondOneClickAway(host: HTMLElement, onInvoke: ReturnType<typeof vi.fn>) {
  expect(directCommandIds(host)).toContain("tool.bond");
  const [single] = directButtons(host, "tool.bond");
  onInvoke.mockClear();
  await clickOnce(single);
  expect(onInvoke).toHaveBeenCalledExactlyOnceWith("tool.bond");
}

let paletteRoot: Root, paletteHost: HTMLDivElement, popoverRoot: Root, popoverHost: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); native.content = undefined;
  paletteHost = document.createElement("div"); document.body.append(paletteHost); paletteRoot = createRoot(paletteHost);
  popoverHost = document.createElement("div"); document.body.append(popoverHost); popoverRoot = createRoot(popoverHost);
});
afterEach(async () => {
  await act(async () => { paletteRoot.unmount(); popoverRoot.unmount(); });
  paletteHost.remove(); popoverHost.remove();
});

describe.each(["macos", "windows"] as const)("bond group keeps Single Bond one click away on %s (clemens-n05)", platform => {
  const items = mainBondGroup();
  const onInvoke = vi.fn();
  const renderPalette = (activeTool: string, onRequestFlyout?: (request: unknown) => void) => act(async () => {
    paletteRoot.render(createElement(ToolPalette, { groups: [], itemGroups: [items], activeTool, onInvoke, onRequestFlyout, platform }));
  });
  const owner = () => paletteHost.querySelector<HTMLButtonElement>('[data-toolbar-item-id="tool.bond"] > button')!;

  beforeEach(() => onInvoke.mockReset());

  it("starts with Single Bond as the group's directly clickable tool", async () => {
    await renderPalette("tool.select");
    await expectSingleBondOneClickAway(paletteHost, onInvoke);
  });

  it.each(VARIANTS)("inline submenu: choosing %s activates it once and leaves Single Bond one click away", async variant => {
    await renderPalette("tool.select");
    await act(async () => owner().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const menu = paletteHost.querySelector<HTMLElement>('[data-toolbar-submenu-owner-id="tool.bond"]')!;
    expect(menu.hidden).toBe(false);
    const choice = menu.querySelector<HTMLButtonElement>(`[role="menuitem"][data-command-id="${variant}"]`)!;
    await act(async () => {
      choice.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      choice.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      choice.click();
    });
    expect(onInvoke).toHaveBeenCalledExactlyOnceWith(variant);
    expect(menu.hidden).toBe(true);

    // The document activates the chosen tool and the palette re-renders from its snapshot.
    await renderPalette(variant);
    await expectSingleBondOneClickAway(paletteHost, onInvoke);
    // …and still after the user moves on to another tool and comes back to the bond group.
    await renderPalette("tool.select");
    await expectSingleBondOneClickAway(paletteHost, onInvoke);
  });

  it.each(VARIANTS)("native flyout: choosing %s activates it once and leaves Single Bond one click away", async variant => {
    const request = vi.fn();
    await renderPalette("tool.select", request);
    await act(async () => owner().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(request).toHaveBeenCalledTimes(1);
    expect(onInvoke).not.toHaveBeenCalled();
    const flyout = request.mock.calls[0][0].flyout;
    await act(async () => popoverRoot.render(<PalettePopoverWindow toolsetId="core.main" kind="flyout" prewarm platform={platform} />));
    await act(async () => native.content?.({ toolsetId: "core.main", kind: "flyout", flyout }));
    const choice = popoverHost.querySelector<HTMLButtonElement>(`[role="menuitem"][data-command-id="${variant}"]`)!;
    await act(async () => { choice.click(); choice.click(); });
    expect(native.command).toHaveBeenCalledExactlyOnceWith(variant, expect.anything());

    // The main window activates the command and re-renders the palette with the new active tool.
    await renderPalette(variant, request);
    await expectSingleBondOneClickAway(paletteHost, onInvoke);
    await renderPalette("tool.select", request);
    await expectSingleBondOneClickAway(paletteHost, onInvoke);
  });
});
