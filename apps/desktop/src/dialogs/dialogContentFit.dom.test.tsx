// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { InsertTableForm } from "./InsertTableForm";
import { measureDialogContent } from "./dialogContentFit";

afterEach(() => vi.unstubAllGlobals());

// Native placement owns the work-area cap (tested by Rust's DialogPlacement matrix).
// The frontend must report natural content, including overflow, independently of that cap
// and of an oversized remembered viewport. jsdom needs explicit layout metrics.
describe.each(["macos", "windows"] as const)("content sizing on %s", platform => {
  describe.each([1, 1.5, 2])("at %sx DPI", pixelRatio => {
    it.each([
      { name: "content fits", natural: 180, viewport: 900 },
      { name: "content exceeds the screen", natural: 1500, viewport: 600 },
      { name: "remembered size exceeds a new screen", natural: 350, viewport: 700, remembered: 1800 }
    ])("reports the natural height when $name", ({ natural, viewport, remembered }) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("devicePixelRatio", pixelRatio);
      vi.stubGlobal("innerHeight", viewport);
      const styles = document.createElement("style");
      styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
      document.head.append(styles);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const ready = vi.fn();
      try {
        act(() => root.render(createElement(InsertTableForm, {
          title: "Drawing", initial: { rows: 2, columns: 2, headerRows: 1, preset: "three-line" },
          platform, onReady: ready, onSubmit: vi.fn(), onCancel: vi.fn()
        })));
        const form = container.querySelector("form")!;
        const body = form.querySelector<HTMLElement>(".cd-dialog-fit-body")!;
        form.style.height = `${remembered ?? viewport}px`;
        form.style.maxHeight = `${viewport}px`;
        const savedStyle = form.getAttribute("style");
        const savedBodyStyle = body.getAttribute("style");
        const measuring = () => form.style.height === "auto" && form.style.maxHeight === "none" &&
          body.style.overflow === "visible" && body.style.flexShrink === "0";
        form.getBoundingClientRect = () => ({
          top: 0, left: 0, x: 0, y: 0, right: 480, width: 480,
          height: measuring() ? natural : viewport,
          bottom: measuring() ? natural : viewport, toJSON: () => ({})
        });
        Object.defineProperty(form, "scrollHeight", { get: () => measuring() ? natural : Math.max(natural, viewport) });

        expect(ready).toHaveBeenCalledExactlyOnceWith(form);
        expect(measureDialogContent(form)).toEqual({ contentHeight: natural, pixelRatio });
        expect(form.getAttribute("style")).toBe(savedStyle);
        expect(body.getAttribute("style")).toBe(savedBodyStyle);
        expect(getComputedStyle(body).overflow).toBe("auto");
        expect(getComputedStyle(form.querySelector(".cd-dialog-fit-footer")!).flexShrink).toBe("0");
      } finally {
        act(() => root.unmount());
        container.remove();
        styles.remove();
      }
    });
  });
});
