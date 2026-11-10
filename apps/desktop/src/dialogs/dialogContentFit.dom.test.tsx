// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { InsertTableForm } from "./InsertTableForm";
import { PageSizeForm } from "./PageSizeForm";
import { ExportForm } from "./ExportForm";
import { exportFixture } from "./exportTestFixtures";
import { saveExportPreviewEnabled } from "../exportPreviewSettings";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { measureDialogContent, validDialogContentFit } from "./dialogContentFit";

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
        expect(measureDialogContent(form)).toEqual({ contentHeight: natural, contentWidth: 480, pixelRatio });
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

// Layout metrics model the two layouts independently: the temporary intrinsic grid can be
// shorter than the live form. Mocking both to the same natural height hid this regression.
function layoutWithOverflow(form: HTMLElement, viewport: number, intrinsic: number, required: number) {
  const body = form.querySelector<HTMLElement>(".cd-dialog-fit-body")!;
  const chrome = 66; // Outer padding plus the pinned action row, outside the scrollport.
  form.getBoundingClientRect = () => ({ top: 0, height: form.style.height === "auto" ? intrinsic : viewport } as DOMRect);
  Object.defineProperty(form, "scrollHeight", { configurable: true, get: () => form.style.height === "auto" ? intrinsic : viewport });
  Object.defineProperty(body, "clientHeight", { configurable: true, get: () => Math.max(0, viewport - chrome) });
  Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => Math.max(required, viewport) - chrome });
  return { chrome, body };
}

describe.each(["macos", "windows"] as const)("live content minimum on %s", platform => {
  const firstFitCases = [
    { kind: "pageSize", width: 420, viewport: 300, intrinsicGrid: 240, required: 286 },
    { kind: "insertTable", width: 480, viewport: 240, intrinsicGrid: 198, required: 230 }
  ].flatMap(form => [1, 1.25, 1.5, 2].map(pixelRatio => ({ ...form, pixelRatio })));
  it.each(firstFitCases)("does not shrink $kind below its flex content on the first fit at $pixelRatio×", ({ kind, width, viewport, intrinsicGrid, required, pixelRatio }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("devicePixelRatio", pixelRatio);
    vi.stubGlobal("screen", { width: 2560, height: 1440, availWidth: 2560, availHeight: 1415 });
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", viewport);
    const styles = document.createElement("style");
    styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
    document.head.append(styles);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(kind === "pageSize"
        ? createElement(PageSizeForm, { title: "Drawing", platform,
          state: { width: "8.5", height: "11", unit: "inch" }, onChange: vi.fn(), onCancel: vi.fn(), onApply: vi.fn() })
        : createElement(InsertTableForm, { title: "Drawing", platform,
          initial: { rows: 2, columns: 2, headerRows: 1, preset: "grid" }, onSubmit: vi.fn(), onCancel: vi.fn() })));
      const form = container.querySelector<HTMLElement>(".cd-dialog-fit")!;
      const body = form.querySelector<HTMLElement>(".cd-dialog-fit-body")!;
      let clientHeight = viewport;
      const height = () => form.style.height !== "auto" ? clientHeight
        : getComputedStyle(form).display === "grid" && platform === "macos" ? intrinsicGrid : required;
      form.getBoundingClientRect = () => ({ top: 0, width, height: height() } as DOMRect);
      Object.defineProperty(form, "scrollHeight", { get: height });
      // The initial client fits: live overflow cannot rescue an under-sized grid probe.
      // The two intrinsic layouts deliberately have different track/control heights.
      Object.defineProperty(body, "clientHeight", { get: () => height() - 66 });
      Object.defineProperty(body, "scrollHeight", { get: () => height() - 66 });
      const before = [form.getAttribute("style"), body.getAttribute("style")];
      const fit = measureDialogContent(form)!;
      expect(fit).toEqual({ contentHeight: required, contentWidth: width, pixelRatio });
      // Stable after fitting, or restoring a larger saved client: neither viewport becomes
      // the content minimum. Rust's placement tests exercise the saved-client floor itself.
      for (const nextClient of [required, 800]) {
        clientHeight = nextClient;
        expect(measureDialogContent(form)).toEqual(fit);
      }
      expect([form.getAttribute("style"), body.getAttribute("style")]).toEqual(before);
    } finally { act(() => root.unmount()); container.remove(); styles.remove(); }
  });

  it.each(["hidden", "clip"])("does not size Insert Table to an ellipsized title (%s)", overflow => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const styles = document.createElement("style");
    styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
    document.head.append(styles);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      const render = (title: string) => act(() => root.render(createElement(InsertTableForm, {
        title, initial: { rows: 2, columns: 2, headerRows: 1, preset: "three-line" },
        platform, onSubmit: vi.fn(), onCancel: vi.fn()
      })));
      render("Short");
      const form = container.querySelector("form")!;
      const title = form.querySelector<HTMLElement>(".cd-insert-table-drawing")!;
      title.style.overflow = overflow;
      // jsdom does not expand the overflow shorthand into its computed axes.
      title.style.overflowX = overflow;
      // Model CSS intrinsic sizing: a definite width replaces the text's min-content width,
      // but the declared min-width still wins. A visible wide sibling must still count.
      const wide = document.createElement("div");
      form.querySelector(".cd-dialog-fit-body")!.append(wide);
      form.getBoundingClientRect = () => {
        const css = getComputedStyle(title);
        const textWidth = title.textContent!.length * 8;
        const titleWidth = Math.max(Number.parseFloat(css.minWidth) || 0,
          Number.parseFloat(css.width) || (css.width === "0px" ? 0 : textWidth));
        const intrinsic = Math.max(300, titleWidth + 36, Number.parseFloat(wide.style.width) || 0);
        return { top: 0, height: 334,
          width: form.style.width === "min-content" ? intrinsic : 480 } as DOMRect;
      };
      const short = measureDialogContent(form)!;
      expect(short.contentWidth).toBe(300);
      render("W".repeat(300));
      const savedStyle = title.getAttribute("style");
      expect(measureDialogContent(form)).toEqual(short);
      expect(title.getAttribute("style")).toBe(savedStyle);
      title.style.minWidth = "620px";
      expect(measureDialogContent(form)?.contentWidth).toBe(656);
      title.style.minWidth = "0px";
      wide.style.width = "900px";
      expect(measureDialogContent(form)?.contentWidth).toBe(900);
    } finally {
      act(() => root.unmount()); container.remove(); styles.remove();
    }
  });

  it("caps an over-wide measurement without dropping its height or pixel ratio", () => {
    const form = document.createElement("section");
    document.body.append(form);
    vi.stubGlobal("devicePixelRatio", platform === "macos" ? 2 : 1.5);
    form.getBoundingClientRect = () => ({ top: 0, height: 334, width: 5000 } as DOMRect);
    try {
      expect(measureDialogContent(form)).toEqual({
        contentHeight: 334, contentWidth: 4096, pixelRatio: devicePixelRatio
      });
    } finally { form.remove(); }
  });

  it("keeps measuring minimum width after a fit removes overflow, and when content shrinks", () => {
    const form = document.createElement("section");
    form.innerHTML = '<div class="cd-dialog-fit-body"></div>';
    document.body.append(form);
    const body = form.firstElementChild as HTMLElement;
    vi.stubGlobal("devicePixelRatio", platform === "macos" ? 2 : 1.5);
    let viewport = 380;
    let minimumWidth = 548;
    Object.defineProperty(form, "clientWidth", { get: () => viewport });
    Object.defineProperty(form, "scrollWidth", { get: () => Math.max(viewport, minimumWidth) });
    form.getBoundingClientRect = () => ({ top: 0, height: 334,
      width: form.style.width === "min-content" ? minimumWidth : viewport } as DOMRect);
    const before = [form.getAttribute("style"), body.getAttribute("style")];
    try {
      expect(measureDialogContent(form)?.contentWidth).toBe(548);
      viewport = 900; // A fitted/larger user window has no overflow.
      expect(measureDialogContent(form)?.contentWidth).toBe(548);
      minimumWidth = 460; // Removed content must reduce the minimum too.
      expect(measureDialogContent(form)?.contentWidth).toBe(460);
      expect([form.getAttribute("style"), body.getAttribute("style")]).toEqual(before);
    } finally { form.remove(); }
  });

  it("reports horizontal overflow independently of a larger saved height", () => {
    const form = document.createElement("section");
    form.innerHTML = '<div class="cd-dialog-fit-body"></div>';
    document.body.append(form);
    try {
      const { body } = layoutWithOverflow(form, 800, 334, 334);
      form.getBoundingClientRect = () => ({ top: 0, width: 380, height: form.style.height === "auto" ? 334 : 800 } as DOMRect);
      Object.defineProperty(body, "clientWidth", { value: 344 });
      Object.defineProperty(body, "scrollWidth", { value: 384 });
      expect(measureDialogContent(form)).toEqual({ contentHeight: 334, contentWidth: 420, pixelRatio: 1 });
    } finally { form.remove(); }
  });

  it.each([300, 800])("includes Page Size's clipped fields with a saved 420×%s frame", savedHeight => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("devicePixelRatio", platform === "macos" ? 2 : 1.5);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(PageSizeForm, { title: "Drawing", platform,
        state: { width: "8.5", height: "11", unit: "inch" }, onChange: vi.fn(), onCancel: vi.fn(), onApply: vi.fn() })));
      const form = container.querySelector<HTMLElement>("section")!;
      const required = platform === "macos" ? 334 : 286;
      const { chrome, body } = layoutWithOverflow(form, savedHeight, 286, required);
      const fit = measureDialogContent(form)!;
      expect(fit.contentHeight).toBe(savedHeight < required ? required : 286);
      // The reported minimum reserves all body content plus actions/padding: a native client
      // at least this high has no overlap. Rust's placement tests cover saved-size and screen caps.
      expect(Math.max(savedHeight, fit.contentHeight) - chrome).toBeGreaterThanOrEqual(required - chrome);
      expect(form.getAttribute("style")).toBeNull();
      expect(body.getAttribute("style")).toBeNull();
      expect(form.querySelector(".cd-dialog-fit-footer")?.textContent).toBe("CancelApply");
    } finally { act(() => root.unmount()); container.remove(); }
  });

  it.each([false, true])("counts Export's final page-guides option (preview %s)", previewEnabled => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveExportPreviewEnabled(previewEnabled);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(ExportForm, { state: { ...exportFixture(), busy: false }, platform,
        onChange: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn(), onSubmit: vi.fn() })));
      const form = container.querySelector("form")!;
      const viewport = previewEnabled ? 1000 : 620;
      const required = viewport + 30;
      const { body } = layoutWithOverflow(form, viewport, viewport, required);
      const guides = Array.from(body.querySelectorAll("label")).find(label => label.textContent?.includes("Include page guides"))!;
      expect(guides).toBeDefined();
      const before = form.getAttribute("style");
      expect(measureDialogContent(form)?.contentHeight).toBe(required);
      expect(form.getAttribute("style")).toBe(before);
    } finally { act(() => root.unmount()); container.remove(); }
  });
});

it("accepts bounded width measurements without weakening ready validation", () => {
  const fit = { contentHeight: 334, contentWidth: 420, pixelRatio: 2 };
  expect(validDialogContentFit(fit)).toBe(true);
  expect(validDialogContentFit({ contentHeight: 334, pixelRatio: 2 })).toBe(true);
  for (const contentWidth of [null, 0, -1, 4097, Infinity, NaN, "420"]) {
    expect(validDialogContentFit({ ...fit, contentWidth })).toBe(false);
  }
  expect(validDialogContentFit({ ...fit, path: "private" })).toBe(false);
});
