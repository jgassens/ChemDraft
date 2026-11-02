// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultNativeTextStyle } from "@chemdraft/chem-core";
import { PaletteWindow } from "./PaletteWindow";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import { broadcastToolsetTextStyle, createToolsetTextStylePayload } from "./window-manager";
import { PALETTE_TOOLTIP_DOM_EVENT, type PaletteTooltipDomDetail } from "./toolbars/toolbarTooltip";

const native = vi.hoisted(() => ({
  visible: false,
  position: vi.fn(async () => ({ x: 100, y: 100 })),
  open: vi.fn(async () => { native.visible = true; }),
  close: vi.fn(async () => { native.visible = false; }),
  isVisible: vi.fn(async () => native.visible),
  showTooltip: vi.fn(async () => {}),
  hideTooltip: vi.fn(async () => {}),
  setContent: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {})
}));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  currentWindowLogicalPosition: native.position,
  openToolsetPopoverWindow: native.open,
  closeToolsetPopoverWindow: native.close,
  isToolsetPopoverWindowVisible: native.isVisible,
  setToolsetPopoverContent: native.setContent,
  dismissToolsetPopovers: native.dismiss,
  showPaletteFloatingTooltip: native.showTooltip,
  hidePaletteFloatingTooltip: native.hideTooltip
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("native palette tooltip and colour handoff", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.clearAllMocks(); native.visible = false;
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(PaletteWindow, { toolsetId: "core.art" })));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
  });

  async function selectArt(target: "fill" | "stroke") {
    const document = insertNativeArtGraphicObject(createPhase4Document(), { x: 100, y: 100 }, "tool.art.rect");
    const model = createArtInspectorModel({ document,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(document), requestedPaintTarget: target });
    await act(async () => broadcastToolsetTextStyle(createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", model, target)));
  }
  async function clickSwatch() {
    const swatch = container.querySelector<HTMLButtonElement>(".art-color-picker .toolbar-color-trigger")!;
    expect(swatch.disabled).toBe(false);
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, button: 0 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        swatch.dispatchEvent(event);
      }
      swatch.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
  }

  it.each(["fill", "stroke"] as const)("toggles the native %s swatch and reopens after external dismissal", async target => {
    await selectArt(target);
    await clickSwatch();
    expect(native.visible).toBe(true);
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.dismiss).not.toHaveBeenCalled(); // The opening pointerdown is not click-away.
    await clickSwatch();
    expect(native.visible).toBe(false);
    expect(native.close).toHaveBeenCalledExactlyOnceWith("core.art", expect.any(Number), expect.any(Number));
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.dismiss).toHaveBeenCalledTimes(1);
    await clickSwatch();
    expect(native.visible).toBe(true);
    native.visible = false; // OS app-deactivation or click-away, without an owner state update.
    await clickSwatch();
    expect(native.visible).toBe(true);
    expect(native.open).toHaveBeenCalledTimes(3);
  });

  it("opens colour when a different popover occupies the shared window", async () => {
    await selectArt("stroke");
    native.visible = true;
    await clickSwatch();
    expect(native.open).toHaveBeenCalledExactlyOnceWith("core.art", "artColor", expect.any(Number), expect.any(Number));
    expect(native.close).not.toHaveBeenCalled();
  });

  function tooltip(detail: PaletteTooltipDomDetail) {
    window.dispatchEvent(new CustomEvent(PALETTE_TOOLTIP_DOM_EVENT, { detail }));
  }
  const show = (ownerId: string): PaletteTooltipDomDetail => ({ visible: true, ownerId, title: ownerId,
    anchor: { left: 0, right: 24, top: 0, bottom: 24 } });

  it("ignores A's late cleanup after B's show and hides when B leaves for empty space", async () => {
    await act(async () => tooltip(show("A")));
    expect(native.showTooltip).toHaveBeenLastCalledWith(expect.objectContaining({ title: "A" }));
    await act(async () => {
      tooltip(show("B"));
      tooltip({ visible: false, ownerId: "A" });
    });
    expect(native.showTooltip).toHaveBeenLastCalledWith(expect.objectContaining({ title: "B" }));
    expect(native.hideTooltip).not.toHaveBeenCalled();
    await act(async () => tooltip({ visible: false, ownerId: "B" }));
    expect(native.hideTooltip).toHaveBeenCalledTimes(1);
  });

  it("rejects an old asynchronous anchor read after the pointer leaves", async () => {
    let resolve!: (position: { x: number; y: number }) => void;
    native.position.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => tooltip(show("A")));
    await act(async () => {
      tooltip({ visible: false, ownerId: "A" });
      resolve({ x: 100, y: 100 });
    });
    expect(native.showTooltip).not.toHaveBeenCalled();
    expect(native.hideTooltip).toHaveBeenCalledTimes(1);
  });
});
