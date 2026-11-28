// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { ToolPalette } from "./ToolPalette";
import { getToolsetItemGroups } from "./toolsets";
import type { ToolsetPopoverContentPayload } from "./window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  command: vi.fn(async () => {}), hide: vi.fn(async () => {}), show: vi.fn(async () => true)
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

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); native.content = undefined;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe.each(["macos", "windows"] as const)("native multiple-bond flyout on %s", platform => {
  async function open(disabled = false, ownerId = "tool.doubleBond") {
    const item = getToolsetItemGroups("core.main").flat().find(entry => entry.id === ownerId)!;
    if (disabled) item.submenu!.items = item.submenu!.items.map(command => ({ ...command, enabled: false, disabledReason: "Drawing is temporarily unavailable" }));
    const request = vi.fn();
    await act(async () => root.render(createElement(ToolPalette, { itemGroups: [[item]], onInvoke: vi.fn(), onRequestFlyout: request, platform })));
    await act(async () => container.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(request).toHaveBeenCalledTimes(1);
    const flyout = request.mock.calls[0][0].flyout;
    await act(async () => root.render(<PalettePopoverWindow toolsetId="core.main" kind="flyout" prewarm platform={platform} />));
    await act(async () => native.content?.({ toolsetId: "core.main", kind: "flyout", flyout }));
    expect(native.show).toHaveBeenCalledTimes(1);
    return container.querySelector<HTMLElement>('[role="menu"]')!;
  }

  it.each(["tool.doubleBond", "tool.tripleBond", "tool.doubleBond:either", "tool.wavyBond"])("dispatches %s exactly once from the actual owner request", async id => {
    const menu = await open(false, id === "tool.wavyBond" ? "tool.bond" : "tool.doubleBond");
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(id === "tool.wavyBond" ? 6 : 3);
    const button = menu.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`)!;
    await act(async () => { button.click(); button.click(); });
    expect(native.command).toHaveBeenCalledExactlyOnceWith(id, {
      flyoutOpening: expect.objectContaining({ toolsetId: "core.main", openedAt: expect.any(Number) }),
      toolChoice: {}
    });
    expect(native.hide).toHaveBeenCalledTimes(1);
  });

  it.each(["tool.doubleBond", "tool.bond"])("never dispatches disabled choices for %s", async ownerId => {
    const menu = await open(true, ownerId);
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(buttons).toHaveLength(ownerId === "tool.bond" ? 6 : 3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    expect(native.command).not.toHaveBeenCalled();
    expect(native.hide).not.toHaveBeenCalled();
  });
});
