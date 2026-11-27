// @vitest-environment jsdom
// Right-click on a floating toolbar (1.2.3 RC5): the grip, a gap or a button opens the toolbar's NATIVE
// menu, presented through the document window's popup command, and the press never reaches the
// button under it. Real DOM events are dispatched on the elements themselves (not the agent bridge,
// which skips default actions), in each platform's own order, with the platform passed in.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import { PaletteWindow } from "./PaletteWindow";
import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopToolsetRegistry, getToolsetToggleActions, toolsetUsesResizableWindow } from "./toolsets";
import { broadcastToolsetCustomizeMode } from "./window-manager";
import { isSecondaryPress, toolsetContextMenuItems } from "./nativeToolsetContextMenu";
import { PALETTE_TOOLTIP_DISMISS_DOM_EVENT } from "./toolbars/toolbarTooltip";

type NativeItem = { kind: "separator" } | { kind: "item"; id: string; label: string; enabled: boolean };
type PopupCall = { items: NativeItem[]; position: { x: number; y: number } };

const native = vi.hoisted(() => ({
  popups: [] as PopupCall[],
  /** The label the user picks in the next native menu; undefined dismisses it. */
  choose: undefined as string | undefined,
  command: vi.fn(async (_commandId: string) => {}),
  drag: vi.fn(async (_x: number, _y: number) => {}),
  close: vi.fn(async (_toolsetId: string) => {})
}));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command !== "popup_canvas_context_menu") return undefined;
    const call = args as unknown as PopupCall;
    native.popups.push(call);
    const chosen = call.items.find(item => item.kind === "item" && item.label === native.choose);
    return chosen && chosen.kind === "item" ? chosen.id : null;
  })
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  sendPaletteCommand: native.command,
  closeToolsetWindow: native.close,
  startPaletteWindowDrag: native.drag,
  setPaletteCommandHitBoxes: vi.fn(async () => {}),
  setCurrentWindowLogicalSize: vi.fn(async () => {}),
  setCurrentWindowLogicalPosition: vi.fn(async () => {})
}));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  native.popups = [];
  native.choose = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

async function renderPalette(platform: ShortcutPlatform, toolsetId = "core.main") {
  await act(async () => root!.render(createElement(PaletteWindow, {
    toolsetId, platform, resizable: toolsetUsesResizableWindow(toolsetId)
  })));
  await act(async () => { await Promise.resolve(); });
  const shell = container.querySelector<HTMLElement>("main.palette-window-shell")!;
  for (const owner of [shell, shell.querySelector<HTMLElement>(".palette-title")!]) {
    // jsdom does not implement pointer capture.
    owner.setPointerCapture = vi.fn();
    owner.hasPointerCapture = () => false;
    owner.releasePointerCapture = vi.fn();
  }
  return {
    shell,
    grip: shell.querySelector<HTMLElement>(":scope > .palette-title")!,
    close: shell.querySelector<HTMLButtonElement>(":scope > .palette-title > button.palette-close-button")!,
    gap: shell.querySelector<HTMLElement>(".tool-palette")!,
    bond: shell.querySelector<HTMLButtonElement>('button[data-command-id="tool.bond"]')!
  };
}

type Press = { button: 0 | 2; ctrlKey?: boolean };

function fire(target: Element, type: string, { button, ctrlKey = false }: Press, pointerId = 1) {
  // jsdom has no PointerEvent constructor; React dispatches on the event type, so a MouseEvent works
  // once it carries the pointer fields the handlers read.
  const down = type.endsWith("down");
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, button, ctrlKey,
    buttons: down ? (button === 2 ? 2 : 1) : 0, clientX: 6, clientY: 30
  });
  if (type.startsWith("pointer")) {
    Object.defineProperties(event, {
      pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: "mouse" }
    });
  }
  target.dispatchEvent(event);
  return event;
}

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

/** A right-button click in the order each system sends it: macOS and Linux raise contextmenu on the
 *  press, Windows on the release. */
async function rightClick(target: Element, platform: ShortcutPlatform) {
  const events: MouseEvent[] = [];
  const right: Press = { button: 2 };
  await act(async () => {
    events.push(fire(target, "pointerdown", right), fire(target, "mousedown", right));
    if (platform !== "windows") events.push(fire(target, "contextmenu", right));
    events.push(fire(target, "pointerup", right), fire(target, "mouseup", right), fire(target, "auxclick", right));
    if (platform === "windows") events.push(fire(target, "contextmenu", right));
  });
  await settle();
  return events;
}

/** Control-click: a primary-button press with the Control key. WebKit on macOS may or may not follow
 *  the press with a contextmenu event; both must work. */
async function controlClick(target: Element, withContextMenuEvent = true) {
  const press: Press = { button: 0, ctrlKey: true };
  const events: MouseEvent[] = [];
  await act(async () => {
    events.push(fire(target, "pointerdown", press), fire(target, "mousedown", press));
    if (withContextMenuEvent) events.push(fire(target, "contextmenu", press));
    events.push(fire(target, "pointerup", press), fire(target, "mouseup", press), fire(target, "click", press));
  });
  await settle();
  return events;
}

async function leftClick(target: Element) {
  const press: Press = { button: 0 };
  await act(async () => {
    fire(target, "pointerdown", press, 9);
    fire(target, "mousedown", press, 9);
    fire(target, "pointerup", press, 9);
    fire(target, "mouseup", press, 9);
    fire(target, "click", press, 9);
  });
  await settle();
}

const labels = (call: PopupCall) => call.items.map(item => item.kind === "item" ? item.label : "—");
const MAIN_MENU = ["Customize Toolbar…", "—", "Hide Toolbar"];

describe("toolbar menu model", () => {
  it("offers only registered commands: Customize for Main, the View ▸ Toolbars toggle as Hide", () => {
    const registered = new Set([
      ...allShellCommands(createPhase4Document("Toolbar menu")).map(command => command.id),
      ...getToolsetToggleActions(createDesktopToolsetRegistry()).map(command => command.id)
    ]);
    expect(toolsetContextMenuItems("core.main")).toEqual([
      { kind: "command", commandId: "view.customizeMainToolbar", label: "Customize Toolbar…", enabled: true },
      { kind: "separator" },
      { kind: "command", commandId: createToolsetToggleCommandId("core.main"), label: "Hide Toolbar", enabled: true }
    ]);
    for (const toolset of createDesktopToolsetRegistry().listToolsets()) {
      for (const item of toolsetContextMenuItems(toolset.id)) {
        if (item.kind === "command") expect(registered, `${toolset.id}: ${item.commandId}`).toContain(item.commandId);
      }
    }
    // The gallery customizes Main only; another toolbar gets Hide alone, for itself.
    expect(toolsetContextMenuItems("core.structure")).toEqual([
      { kind: "command", commandId: "view.toolset.toggle.core.structure", label: "Hide Toolbar", enabled: true }
    ]);
    // Inherited object keys are not toolsets with a customize command.
    expect(toolsetContextMenuItems("constructor")).toHaveLength(1);
  });

  it("treats Control-click as a right-click on macOS only", () => {
    expect(isSecondaryPress({ button: 2, ctrlKey: false }, "windows")).toBe(true);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, "macos")).toBe(true);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, "windows")).toBe(false);
    expect(isSecondaryPress({ button: 0, ctrlKey: true }, "linux")).toBe(false);
    expect(isSecondaryPress({ button: 0, ctrlKey: false }, "macos")).toBe(false);
    expect(isSecondaryPress({ button: 1, ctrlKey: false }, "macos")).toBe(false);
  });
});

describe.each(["macos", "windows", "linux"] as const)("floating toolbar right-click on %s", platform => {
  it.each(["grip", "gap", "bond", "close"] as const)("right-click on the %s opens the native menu and fires nothing", async part => {
    const parts = await renderPalette(platform);
    const target = parts[part];
    expect(target).not.toBeNull();
    const pressedBefore = parts.bond.getAttribute("aria-pressed");
    const tooltipDismissed = vi.fn();
    window.addEventListener(PALETTE_TOOLTIP_DISMISS_DOM_EVENT, tooltipDismissed);

    const events = await rightClick(target, platform);
    window.removeEventListener(PALETTE_TOOLTIP_DISMISS_DOM_EVENT, tooltipDismissed);

    expect(native.popups).toHaveLength(1);
    expect(labels(native.popups[0])).toEqual(MAIN_MENU);
    // The press and the contextmenu are handled: no webview menu, no focus move, no range step.
    for (const event of events) expect(event.defaultPrevented, event.type).toBe(true);
    expect(native.command).not.toHaveBeenCalled();
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();
    expect(parts.bond.getAttribute("aria-pressed")).toBe(pressedBefore);
    expect(parts.shell.querySelector(".toolbar-command-flyout-menu:not([hidden])")).toBeNull();
    // The hover tooltip hides on a press it no longer sees, so the menu does not open under it.
    expect(tooltipDismissed).toHaveBeenCalled();
  });

  it("runs Customize Toolbar… as the registered customize command for this toolbar", async () => {
    const { bond } = await renderPalette(platform);
    native.choose = "Customize Toolbar…";

    await rightClick(bond, platform);

    expect(native.command).toHaveBeenCalledExactlyOnceWith("view.customizeMainToolbar");
  });

  it("offers Hide Toolbar alone on another toolbar and hides that toolbar, not Main", async () => {
    const { gap } = await renderPalette(platform, "core.structure");
    native.choose = "Hide Toolbar";

    await rightClick(gap, platform);

    expect(labels(native.popups[0])).toEqual(["Hide Toolbar"]);
    expect(native.command).toHaveBeenCalledExactlyOnceWith("view.toolset.toggle.core.structure");
  });

  it("leaves the left click and the grip drag as they were, before and after a right-click", async () => {
    const { grip, bond } = await renderPalette(platform);
    await rightClick(bond, platform);
    await leftClick(bond);
    expect(native.command).toHaveBeenCalledExactlyOnceWith("tool.bond");

    await act(async () => { fire(grip, "pointerdown", { button: 0 }, 7); fire(grip, "mousedown", { button: 0 }, 7); });
    await settle();
    expect(native.drag).toHaveBeenCalledExactlyOnceWith(6, 30);
    await act(async () => { fire(grip, "pointerup", { button: 0 }, 7); fire(grip, "mouseup", { button: 0 }, 7); });
    expect(native.popups).toHaveLength(1);
  });

  it("shows no menu while the toolbar is being customized, and still keeps the press from the button", async () => {
    const { bond } = await renderPalette(platform);
    await act(async () => { await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true }); });

    await rightClick(bond, platform);

    expect(native.popups).toHaveLength(0);
    expect(native.command).not.toHaveBeenCalled();
  });

  if (platform === "macos") {
    it.each([true, false])("Control-click is a right-click (contextmenu event sent: %s)", async withContextMenuEvent => {
      const { grip, bond } = await renderPalette(platform);

      for (const target of [bond, grip]) {
        const events = await controlClick(target, withContextMenuEvent);
        for (const event of events) expect(event.defaultPrevented, event.type).toBe(true);
      }

      expect(native.popups.map(labels)).toEqual([MAIN_MENU, MAIN_MENU]);
      expect(native.command).not.toHaveBeenCalled();
      expect(native.drag).not.toHaveBeenCalled();
    });
  } else {
    it("Control-click stays an ordinary click", async () => {
      const { bond } = await renderPalette(platform);

      await controlClick(bond, false);

      expect(native.popups).toHaveLength(0);
      expect(native.command).toHaveBeenCalledExactlyOnceWith("tool.bond");
    });
  }
});
