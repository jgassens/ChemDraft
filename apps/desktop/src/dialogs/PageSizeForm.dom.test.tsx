// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertPageSizeDraft, pageSizeFromDraft, PageSizeForm } from "./PageSizeForm";
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = undefined; vi.unstubAllGlobals(); });
describe.each(["macos", "windows"] as const)("Page Size keyboard on %s", platform => {
  it("focuses Width; valid Enter applies, invalid values and IME Enter do not", () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const apply = vi.fn(); const cancel = vi.fn();
    const render = (width = "8.5") => act(() => root!.render(createElement(PageSizeForm, { title: "Drawing A", state: { width, height: "11", unit: "inch" }, platform, onApply: apply, onCancel: cancel, onChange: vi.fn() })));
    render(); const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input); expect(container.textContent).toContain("Drawing A");
    const press = (init: KeyboardEventInit) => act(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
    press({ key: "Enter", isComposing: true }); expect(apply).not.toHaveBeenCalled();
    render("0"); press({ key: "Enter" }); expect(apply).not.toHaveBeenCalled();
    expect(container.querySelectorAll("button")[1]!.disabled).toBe(true);
    render("8.5"); press({ key: "Enter" }); expect(apply).toHaveBeenCalledExactlyOnceWith({ width: 8.5, height: 11, unit: "inch" });
    press({ key: "Escape" }); press({ key: "w", metaKey: platform === "macos", ctrlKey: platform === "windows" }); expect(cancel).toHaveBeenCalledTimes(2);
  });
});
it("uses strict finite dimensions and preserves physical size when units change", () => {
  for (const width of ["", " ", "-1", "1x", "Infinity", "100001"]) expect(pageSizeFromDraft({ width, height: "11", unit: "inch" })).toBeUndefined();
  expect(convertPageSizeDraft({ width: "8.5", height: "11", unit: "inch" }, "mm")).toEqual({ width: "215.9", height: "279.4", unit: "mm" });
});
