// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteControlTooltip, PaletteControlTooltipContext, TOOLTIP_DELAY_MS, TOOLTIP_RESHOW_WINDOW_MS, usePaletteTooltipState } from "./toolbarTooltip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("palette tooltip handoff", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: ReturnType<typeof usePaletteTooltipState>;
  function Harness() {
    state = usePaletteTooltipState();
    return <PaletteControlTooltipContext.Provider value={state}>
      <PaletteControlTooltip tooltip="Button A"><button id="a">A</button></PaletteControlTooltip>
      <PaletteControlTooltip tooltip="Button B"><button id="b">B</button></PaletteControlTooltip>
      <PaletteControlTooltip tooltip="Button C"><button id="c">C</button></PaletteControlTooltip>
    </PaletteControlTooltipContext.Provider>;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.useRealTimers();
  });
  const button = (id: string) => container.querySelector<HTMLButtonElement>(`#${id}`)!;
  const visible = (id: string) => button(id).dataset.tooltipVisible === "true";
  function pointer(id: string, type: "pointerover" | "pointerout", relatedTarget: Element = document.body) {
    button(id).dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
  }
  function showA() {
    act(() => pointer("a", "pointerover"));
    expect(visible("a")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("a")).toBe(true);
  }

  it("switches A to B to C promptly when leave and enter share a tick", () => {
    showA();
    act(() => {
      pointer("a", "pointerout", button("b"));
      pointer("b", "pointerover", button("a"));
      // A stale document listener can still run before React commits B.
      state.clearTooltip(button("a").dataset.tooltipOwnerId);
      button("b").dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    expect(visible("a")).toBe(false);
    expect(visible("b")).toBe(true);
    act(() => {
      pointer("b", "pointerout", button("c"));
      pointer("c", "pointerover", button("b"));
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(visible("b")).toBe(false);
    expect(visible("c")).toBe(true);
  });

  it("hides on leaving A for empty space and restores the first-hover delay", () => {
    showA();
    act(() => pointer("a", "pointerout"));
    expect(visible("a")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_RESHOW_WINDOW_MS + 1));
    act(() => pointer("b", "pointerover"));
    expect(visible("b")).toBe(false);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("b")).toBe(true);
  });

  it("switches promptly across the small gap between neighbouring controls", () => {
    showA();
    act(() => pointer("a", "pointerout"));
    expect(visible("a")).toBe(false);
    act(() => vi.advanceTimersByTime(50));
    act(() => pointer("b", "pointerover"));
    expect(visible("b")).toBe(true);
  });

  it("does not let a late leave from A cancel B's first-hover timer", () => {
    act(() => {
      pointer("a", "pointerover");
      pointer("a", "pointerout", button("b"));
      pointer("b", "pointerover", button("a"));
      state.clearTooltip(button("a").dataset.tooltipOwnerId);
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(visible("a")).toBe(false);
    expect(visible("b")).toBe(true);
  });

  it("cancels pending and visible tooltips on blur", () => {
    showA();
    act(() => window.dispatchEvent(new Event("blur")));
    expect(visible("a")).toBe(false);
    act(() => pointer("b", "pointerover"));
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(visible("b")).toBe(false);
  });
});
