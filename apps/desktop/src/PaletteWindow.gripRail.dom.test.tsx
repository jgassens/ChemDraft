// @vitest-environment jsdom
// The floating palette chrome (1.2.3 RC5): no title row, a 14px grip rail beside the tools holding the
// close button. Real DOM events are dispatched on the elements themselves (not the agent bridge,
// which skips default actions), so these exercise the same handlers a click in the webview does.
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { PaletteWindow } from "./PaletteWindow";
import { toolsetUsesResizableWindow } from "./toolsets";

const native = vi.hoisted(() => ({
  close: vi.fn(async (_toolsetId: string) => {}),
  drag: vi.fn(async (_x: number, _y: number) => {})
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
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

const appCssText = readFileSync("apps/desktop/src/App.css", "utf8");
let container: HTMLDivElement;
let root: Root | undefined;
let appCss: HTMLStyleElement;

beforeEach(() => {
  vi.clearAllMocks();
  appCss = document.createElement("style");
  appCss.textContent = appCssText;
  document.head.append(appCss);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  appCss.remove();
  vi.restoreAllMocks();
});

async function renderPalette(platform: ShortcutPlatform, toolsetId = "core.main") {
  await act(async () => root!.render(createElement(PaletteWindow, {
    toolsetId, platform, resizable: toolsetUsesResizableWindow(toolsetId)
  })));
  const shell = container.querySelector<HTMLElement>("main.palette-window-shell")!;
  expect(shell).not.toBeNull();
  for (const owner of [shell, shell.querySelector<HTMLElement>(".palette-title")!]) {
    // jsdom does not implement pointer capture.
    owner.setPointerCapture = vi.fn();
    owner.hasPointerCapture = () => false;
    owner.releasePointerCapture = vi.fn();
  }
  return {
    shell,
    grip: shell.querySelector<HTMLElement>(":scope > .palette-title")!,
    close: shell.querySelector<HTMLButtonElement>(":scope > .palette-title > button.palette-close-button")!
  };
}

function fire(target: Element, type: "pointerdown" | "mousedown" | "pointerup" | "mouseup", pointerId = 1) {
  // jsdom has no PointerEvent constructor; React dispatches on the event type, so a MouseEvent works
  // once it carries the pointer fields the handlers read.
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type.endsWith("down") ? 1 : 0, clientX: 6, clientY: 30
  });
  if (type.startsWith("pointer")) {
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
  }
  target.dispatchEvent(event);
  return event;
}

/** Click the close button the way each platform's close works: macOS and Linux close on the press (the
 *  window is gone before any release arrives); Windows closes on release, so pressing and dragging
 *  off cancels. */
async function clickClose(close: HTMLButtonElement, platform: ShortcutPlatform, pointerId = 1) {
  await act(async () => {
    fire(close, "pointerdown", pointerId);
    fire(close, "mousedown", pointerId);
    if (platform !== "windows") return;
    expect(native.close).not.toHaveBeenCalled();
    fire(close, "pointerup", pointerId);
    fire(close, "mouseup", pointerId);
    close.click();
  });
}

async function settleDrag() {
  // startPaletteWindowDrag runs after the handler; let any queued work finish.
  await act(async () => { await vi.dynamicImportSettled(); });
}

describe.each(["macos", "windows", "linux"] as const)("floating Main toolbar chrome on %s", platform => {
  it("has no title row: a 14px grip rail beside the tools holds the close button", async () => {
    const { shell, grip, close } = await renderPalette(platform);

    // The shell is one row: rail | content. Nothing stacks above the tools.
    const shellStyle = getComputedStyle(shell);
    expect(shellStyle.gridTemplateColumns).toBe("14px minmax(0, auto)");
    expect(shellStyle.gridTemplateRows).toBe("minmax(0, auto)");
    expect(Array.from(shell.children).map(child => child.className)).toEqual(["palette-title", "palette-window-content"]);
    expect(grip.dataset.paletteWindowGrip).toBe("true");
    expect(getComputedStyle(grip).width).toBe("14px");
    expect(getComputedStyle(grip).height).toBe("auto");

    // No second grip inside the content, and no trailing divider leaving a blank cell at the right.
    expect(shell.querySelector("[data-palette-content-drag-grip]")).toBeNull();
    const group = shell.querySelector<HTMLElement>(".tool-palette .tool-group")!;
    expect(group.lastElementChild?.classList.contains("toolbar-widget-grid-slot")).toBe(true);
    expect(getComputedStyle(group.lastElementChild!).justifyItems).toBe("end");
    expect(shell.querySelector('[data-toolbar-item-id="core.main.divider.7"]')).toBeNull();
    // A thin uniform margin around the rows.
    expect(getComputedStyle(shell.querySelector(".tool-palette")!).padding).toBe("4px");

    // The window keeps its accessible title, and the label takes no space.
    expect(shell.getAttribute("aria-label")).toBe("ChemDraft floating Main Toolbar");
    const label = grip.querySelector<HTMLElement>(".palette-title-label")!;
    expect(label.textContent).toBe("Main");
    expect(getComputedStyle(label).position).toBe("absolute");
    expect(getComputedStyle(label).width).toBe("1px");

    // The close control is a real, focusable button with an accessible name.
    expect(close.type).toBe("button");
    expect(close.tabIndex).toBe(0);
    expect(close.getAttribute("aria-label")).toBe(platform === "windows" ? "Close Main" : "Hide Main Toolbar");
  });

  it("closes the palette from the close button without starting a drag", async () => {
    const { shell, close } = await renderPalette(platform);

    // The close control lives at the top of the grip rail, the shell's first column beside the
    // content, not in a title row above it.
    const rail = close.parentElement!;
    expect(rail.dataset.paletteWindowGrip).toBe("true");
    expect(shell.firstElementChild).toBe(rail);
    expect(rail.nextElementSibling?.classList.contains("palette-window-content")).toBe(true);
    expect(getComputedStyle(shell).gridTemplateColumns).toBe("14px minmax(0, auto)");
    expect(getComputedStyle(rail).width).toBe("14px");
    const closeStyle = getComputedStyle(close);
    if (platform === "windows") {
      // The Windows "x" is a full-width 14px cell at the top of the rail, not a 28px caption button.
      expect(closeStyle.width).toBe("auto");
      expect(closeStyle.height).toBe("14px");
      expect(closeStyle.minHeight).toBe("0px");
    } else {
      // The macOS/Linux dot sits 3px from the rail's top, not centered in a title row.
      expect(closeStyle.top).toBe("3px");
      expect(closeStyle.left).toBe("1px");
      expect(closeStyle.transform).toBe("none");
    }

    await clickClose(close, platform);
    await settleDrag();
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledWith("core.main");
    expect(native.drag).not.toHaveBeenCalled();
  });

  it("starts a window drag from a pointerdown on the grip, never from a tool button", async () => {
    const { shell } = await renderPalette(platform);

    // The rail is the window's one drag grip: there is no in-content grip any more, and the rail is
    // 14px wide beside the content, whose tools keep a uniform 4px margin.
    const grips = shell.querySelectorAll<HTMLElement>("[data-palette-window-grip], [data-palette-content-drag-grip]");
    expect(grips).toHaveLength(1);
    const grip = grips[0]!;
    expect(grip.dataset.paletteWindowGrip).toBe("true");
    expect(shell.firstElementChild).toBe(grip);
    expect(getComputedStyle(grip).width).toBe("14px");
    expect(getComputedStyle(grip).height).toBe("auto");
    const content = grip.nextElementSibling as HTMLElement;
    expect(content.classList.contains("palette-window-content")).toBe(true);
    expect(getComputedStyle(content.querySelector(".tool-palette")!).padding).toBe("4px");

    let down: MouseEvent | undefined;
    await act(async () => { down = fire(grip, "pointerdown", 7); fire(grip, "mousedown", 7); });
    await settleDrag();
    expect(down!.defaultPrevented).toBe(true);
    expect(native.drag).toHaveBeenCalledExactlyOnceWith(6, 30);
    await act(async () => { fire(grip, "pointerup", 7); fire(grip, "mouseup", 7); });

    native.drag.mockClear();
    const tool = shell.querySelector<HTMLButtonElement>('button[data-command-id="tool.bond"]')!;
    expect(tool).not.toBeNull();
    await act(async () => {
      fire(tool, "pointerdown", 8);
      fire(tool, "mousedown", 8);
      fire(tool, "pointerup", 8);
      fire(tool, "mouseup", 8);
    });
    await settleDrag();
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();
  });
});

// Every palette window shares the shell, so every one gets the rail: vertical toolbars, the Text and
// Art toolbars, the content-sized inspectors and the resizable inspectors.
const sharedPalettes = [
  ["core.structure", "14px minmax(0, auto)"],
  ["core.text", "14px minmax(0, auto)"],
  ["core.art", "14px minmax(0, auto)"],
  ["core.ringInspector", "14px minmax(0, auto)"],
  ["core.drawnStructureSettings", "14px minmax(0, 1fr)"],
  ["core.molecularInspector", "14px minmax(0, 1fr)"]
] as const;

describe.each(sharedPalettes)("%s palette window", (toolsetId, columns) => {
  it.each(["macos", "windows", "linux"] as const)("has the same grip rail, close and drag on %s", async platform => {
    const { shell, grip, close } = await renderPalette(platform, toolsetId);

    expect(getComputedStyle(shell).gridTemplateColumns).toBe(columns);
    expect(shell.firstElementChild).toBe(grip);
    expect(getComputedStyle(grip).width).toBe("14px");
    expect(shell.querySelector("[data-palette-content-drag-grip]")).toBeNull();
    expect(getComputedStyle(grip.querySelector(".palette-title-label")!).position).toBe("absolute");
    // A palette that reserved a grid column for the old in-content grip no longer does.
    const palette = shell.querySelector<HTMLElement>(".tool-palette");
    if (palette && /art-style|ring-inspector|molecule-inspector/.test(palette.className)) {
      expect(getComputedStyle(palette).gridTemplateColumns).toBe("minmax(0, 1fr)");
    }

    await act(async () => { fire(grip, "pointerdown", 7); fire(grip, "mousedown", 7); });
    await settleDrag();
    expect(native.drag).toHaveBeenCalledTimes(1);
    await act(async () => { fire(grip, "pointerup", 7); fire(grip, "mouseup", 7); });

    native.drag.mockClear();
    await clickClose(close, platform, 8);
    await settleDrag();
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledExactlyOnceWith(toolsetId);
  });
});
