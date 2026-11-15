// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InsertTableForm } from "./InsertTableForm";
import { PageSizeForm } from "./PageSizeForm";
import { readFileSync } from "node:fs";
import type { DialogMessage } from "./dialogProtocol";
import { parseDialogMessage } from "./dialogProtocol";
import { measureDialogContent, measureDialogContentWhenFontsReady, validDialogContentFit } from "./dialogContentFit";
vi.mock("../window-manager", async original => ({ ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true }));
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn(), stop: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return host.stop; }, sendDialogMessage: host.send }));
import { DialogWindow } from "./DialogWindow";

const nativeSpec = () => readFileSync("apps/desktop/src-tauri/src/dialog_windows.rs", "utf8")
  .match(/"insertTable" => Ok\(DialogKindSpec \{([\s\S]*?)\}\),/)![1]!;

/** jsdom has no layout: give the form a natural height that only CSS min-height can stretch. */
function layOut(form: HTMLElement, natural: number, window: number, overflow = natural) {
  form.getBoundingClientRect = () => {
    const minHeight = form.style.getPropertyValue("min-height");
    const height = minHeight === "0px" ? natural : Math.max(natural, window);
    return { x: 0, y: 0, left: 0, top: 0, right: 480, bottom: height, width: 480, height, toJSON: () => ({}) };
  };
  Object.defineProperty(form, "scrollHeight", { configurable: true,
    get: () => form.style.getPropertyValue("min-height") === "0px" ? overflow : Math.max(overflow, window) });
}

it.each(["macos", "windows"] as const)("reserves status space and stable row metrics on %s", platform => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const styles = document.createElement("style");
  styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
  document.head.append(styles);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (error?: string) => act(() => root.render(createElement(InsertTableForm, {
    title: "Drawing", initial: { rows: 2, columns: 2, headerRows: 1, preset: "three-line" },
    platform, error, onSubmit: vi.fn(), onCancel: vi.fn(),
  })));
  try {
    render();
    const form = container.querySelector("form")!;
    expect(form.classList.contains("cd-insert-table-form")).toBe(true);
    expect(getComputedStyle(form).display).toBe("flex");
    // The form fills the fitted native viewport without imposing an initial height.
    expect(getComputedStyle(form).height).toBe("100vh");
    expect(getComputedStyle(form).minHeight).toBe("0px");
    // A shorter minimum allows resizing below natural content; fields wrap at narrow widths.
    const spec = nativeSpec();
    expect(spec).toContain("min_size: (360.0, 120.0)");
    // The window height comes from content, including when shorter than the old 240px floor.
    expect(spec).toContain("fit_content: true");
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("");
    expect(getComputedStyle(status).minHeight).toBe("32px");
    expect(getComputedStyle(status).lineHeight).toBe("16px");
    expect(getComputedStyle(form.querySelector("h2")!).lineHeight).toBe("19px");
    for (const control of form.querySelectorAll("input, select, button")) {
      expect(getComputedStyle(control).height).toBe("30px");
      expect(getComputedStyle(control).boxSizing).toBe("border-box");
    }
    render("Table insertion failed. Try again.");
    expect(status.textContent).toBe("Table insertion failed. Try again.");
    expect(getComputedStyle(status).minHeight).toBe("32px");
  } finally {
    act(() => root.unmount());
    container.remove();
    styles.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps a long drawing title on one line and exposes the full title", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const title = "a".repeat(200);
  try {
    act(() => root.render(createElement(InsertTableForm, {
      title, initial: { rows: 2, columns: 2, headerRows: 1, preset: "three-line" },
      onSubmit: vi.fn(), onCancel: vi.fn(),
    })));
    const drawing = container.querySelector(".cd-insert-table-drawing");
    expect(drawing?.querySelector("strong")?.textContent).toBe(title);
    expect(drawing?.querySelector("strong")?.getAttribute("title")).toBe(title);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  ["empty status", 236, 236],
  ["status shown", 263, 263],
  ["wrapped title and larger text", 341, 341],
  ["three-line error overflowing the status", 300, 318]
])("measures the whole form (%s), not the window it is in", (_case, natural, overflow) => {
  const form = document.createElement("form");
  form.style.minHeight = "max(240px, 100vh)";
  document.body.append(form);
  try {
    // A taller window must not be measured as content (the Windows empty band) ...
    layOut(form, natural, 400, overflow);
    vi.stubGlobal("devicePixelRatio", 1.25);
    expect(measureDialogContent(form)).toEqual({ contentHeight: Math.max(natural, overflow), contentWidth: 480, pixelRatio: 1.25 });
    // ... and a shorter one must not hide the buttons (the macOS cut-off).
    layOut(form, natural, 240, overflow);
    const fit = measureDialogContent(form)!;
    expect(fit.contentHeight).toBeGreaterThanOrEqual(Math.max(natural, overflow));
    expect(form.style.minHeight).toBe("max(240px, 100vh)");
  } finally {
    form.remove();
    vi.unstubAllGlobals();
  }
});

it("fails when the form's content is taller than the window the host would size", () => {
  // The host sets inner height = contentHeight × pixelRatio / scale, at least the 240px floor.
  const windowHeight = (fit: { contentHeight: number; pixelRatio: number }, scale: number) =>
    Math.max(240, Math.ceil(fit.contentHeight * fit.pixelRatio / scale));
  const form = document.createElement("form");
  document.body.append(form);
  try {
    for (const [natural, ratio, scale] of [[236, 1, 1], [263, 2, 2], [263, 1.25, 1.25], [263, 1.5, 1.5], [263, 1.25, 1]]) {
      layOut(form, natural, 240);
      vi.stubGlobal("devicePixelRatio", ratio);
      const fit = measureDialogContent(form)!;
      // Content, in the window's logical pixels, never exceeds the window.
      expect(natural * ratio / scale).toBeLessThanOrEqual(windowHeight(fit, scale));
      // And the window is no taller than its content plus a rounding pixel (or the CSS floor).
      expect(windowHeight(fit, scale)).toBeLessThanOrEqual(Math.max(240, Math.ceil(natural * ratio / scale)));
    }
  } finally {
    form.remove();
    vi.unstubAllGlobals();
  }
});

it("waits for fonts before measuring, but never longer than the bound", async () => {
  vi.useFakeTimers();
  const form = document.createElement("form");
  document.body.append(form);
  try {
    layOut(form, 250, 240);
    let loaded!: () => void;
    const fonts = { ready: new Promise<void>(resolve => { loaded = resolve; }) };
    let fit: unknown;
    void measureDialogContentWhenFontsReady(form, fonts, 1000).then(value => { fit = value; });
    await vi.advanceTimersByTimeAsync(10);
    expect(fit).toBeUndefined();
    layOut(form, 262, 240); // the web font arrives and the text grows
    loaded();
    await vi.advanceTimersByTimeAsync(0);
    expect(fit).toEqual({ contentHeight: 262, contentWidth: 480, pixelRatio: 1 });
    const stuck = measureDialogContentWhenFontsReady(form, { ready: new Promise(() => {}) }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await stuck).toEqual({ contentHeight: 262, contentWidth: 480, pixelRatio: 1 });
  } finally {
    form.remove();
    vi.useRealTimers();
  }
});

it("accepts only a bounded content fit on ready, on both sides of the protocol", () => {
  const ready = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "insertTable", sessionId: "session",
    requestId: "request", snapshotRevision: 1, type: "ready" };
  expect(parseDialogMessage({ ...ready, data: {} })).toBeDefined();
  expect(parseDialogMessage({ ...ready, data: { contentHeight: 263, pixelRatio: 1.5 } })).toBeDefined();
  expect(parseDialogMessage({ ...ready, data: { contentHeight: 4096, pixelRatio: 8 } })).toBeDefined();
  expect(parseDialogMessage({ ...ready, data: { contentHeight: 263, pixelRatio: 0.5 } })).toBeDefined();
  // The same caps as the native ContentFit: 4096 CSS px, a ratio of 0.5 to 8.
  for (const data of [{ contentHeight: 263 }, { contentHeight: 0, pixelRatio: 1 }, { contentHeight: 4097, pixelRatio: 1 },
    { contentHeight: 16384, pixelRatio: 16 }, { contentHeight: 263, pixelRatio: 0.49 }, { contentHeight: 263, pixelRatio: 8.01 },
    { contentHeight: 263, pixelRatio: 0 }, { contentHeight: 263, pixelRatio: 1, width: 480 }, { contentHeight: "263", pixelRatio: 1 }]) {
    expect(parseDialogMessage({ ...ready, data })).toBeUndefined();
  }
  expect(parseDialogMessage({ ...ready, type: "request", data: { contentHeight: 263, pixelRatio: 1 } })).toBeUndefined();
  const native = readFileSync("apps/desktop/src-tauri/src/dialog_windows.rs", "utf8");
  expect(native).toContain("const CONTENT_FIT_MAX_HEIGHT: f64 = 4096.0;");
  expect(native).toContain("const CONTENT_FIT_SCALE_RANGE: std::ops::RangeInclusive<f64> = 0.5..=8.0;");
  // The native side records the window's scale with the measurement, not at reveal.
  expect(native).toMatch(/session\.content_fit =\s+MeasuredContent::new\(ContentFit::from_ready\(&message\.data\), scale_at_ready\);/);
});

it("falls back to an empty ready, so the spec size, when the measurement is out of range", () => {
  const form = document.createElement("form");
  document.body.append(form);
  try {
    layOut(form, 263, 240);
    vi.stubGlobal("devicePixelRatio", 16);
    expect(measureDialogContent(form)).toBeUndefined();
    vi.stubGlobal("devicePixelRatio", 1);
    layOut(form, 5000, 240);
    expect(measureDialogContent(form)).toBeUndefined();
    expect(validDialogContentFit({ contentHeight: 263, pixelRatio: Number.NaN })).toBe(false);
  } finally {
    form.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["macos", "windows"] as const)("keeps Cancel and Insert reachable in a window shorter than the content on %s", platform => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const styles = document.createElement("style");
  styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
  document.head.append(styles);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(InsertTableForm, {
      title: "Drawing", initial: { rows: 2, columns: 2, headerRows: 1, preset: "three-line" },
      platform, error: "A validation message long enough to wrap past the two lines the status reserves. ".repeat(4),
      onSubmit: vi.fn(), onCancel: vi.fn(),
    })));
    const form = container.querySelector("form")!;
    expect(form.classList.contains("cd-dialog-fit")).toBe(true);
    const children = Array.from(form.children);
    expect(children.map(child => child.className)).toEqual(["cd-dialog-fit-body", "cd-page-size-buttons cd-dialog-fit-footer"]);
    const [body, footer] = children as HTMLElement[];
    // Everything that can grow (title, fields that wrap, the status message) is in the body,
    // which scrolls; the button row is outside it and never shrinks.
    expect(body.querySelector("h2")).not.toBeNull();
    expect(body.querySelector(".cd-page-size-fields")).not.toBeNull();
    expect(body.querySelector('[role="status"]')).not.toBeNull();
    expect(getComputedStyle(body).overflow).toBe("auto");
    expect(getComputedStyle(body).minHeight).toBe("0px");
    expect([getComputedStyle(footer).flexGrow, getComputedStyle(footer).flexShrink]).toEqual(["0", "0"]);
    expect(Array.from(footer.querySelectorAll("button"), button => button.textContent)).toEqual(["Cancel", "Insert"]);
    expect(body.querySelector("button")).toBeNull();
    // The status grows with its message; it never shrinks below it and overlaps the buttons.
    const status = getComputedStyle(body.querySelector('[role="status"]')!);
    expect([status.flexGrow, status.flexShrink]).toEqual(["1", "0"]);
  } finally {
    act(() => root.unmount());
    container.remove();
    styles.remove();
    vi.unstubAllGlobals();
  }
});

it("shares the scrolling-body layout with all fixed-form dialogs", () => {
  const css = readFileSync("apps/desktop/src/App.css", "utf8");
  // Shared selectors, not Insert-Table-only ones.
  expect(css).toMatch(/^\.cd-dialog-fit \{[^}]*height: 100vh;[^}]*\}/m);
  expect(css).toMatch(/^\.cd-dialog-fit-body \{[^}]*overflow: auto;[^}]*\}/m);
  expect(css).toMatch(/^\.cd-dialog-fit-footer \{[^}]*flex: none;[^}]*\}/m);
  for (const file of ["PageSizeForm.tsx", "ArrangementSpacingForm.tsx", "ExportForm.tsx", "EngineInstallForm.tsx", "ToolInstallForm.tsx"]) {
    expect(readFileSync(`apps/desktop/src/dialogs/${file}`, "utf8")).toContain("cd-dialog-fit-body");
  }
  expect(readFileSync("apps/desktop/src/dialogs/StructureTemplatePicker.tsx", "utf8")).not.toContain("cd-dialog-fit");
  expect(readFileSync("apps/desktop/src/dialogs/InsertTableForm.tsx", "utf8")).toContain("cd-dialog-fit-body");
});

it("measures a scrolling body at its natural height, then restores the layout", () => {
  const form = document.createElement("form");
  form.className = "cd-dialog-fit";
  form.style.setProperty("height", "123px");
  const body = document.createElement("div");
  body.className = "cd-dialog-fit-body";
  form.append(body);
  document.body.append(form);
  // jsdom has no layout: the form is its window's 240px unless the measurement lifts the
  // form's height and unclips the body, when the content's natural 318px shows.
  const unclipped = () => form.style.getPropertyValue("height") === "auto" && form.style.getPropertyValue("min-height") === "0px" &&
    body.style.getPropertyValue("overflow") === "visible" && body.style.getPropertyValue("flex-shrink") === "0" && body.style.getPropertyValue("min-height") === "0px";
  form.getBoundingClientRect = () => {
    const height = unclipped() ? 318 : 240;
    return { x: 0, y: 0, left: 0, top: 0, right: 480, bottom: height, width: 480, height, toJSON: () => ({}) };
  };
  Object.defineProperty(form, "scrollHeight", { configurable: true, get: () => unclipped() ? 318 : 240 });
  try {
    expect(measureDialogContent(form)).toEqual({ contentHeight: 318, contentWidth: 480, pixelRatio: 1 });
    expect(form.style.getPropertyValue("height")).toBe("123px");
    expect(form.style.getPropertyValue("min-height")).toBe("");
    expect(body.getAttribute("style") ?? "").toBe("");
  } finally {
    form.remove();
  }
});

it.each(["macos", "windows"] as const)("includes Page Size's wrapped labels, closed popup, actions and padding on %s", platform => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(PageSizeForm, { title: "Drawing", platform,
      state: { width: "8.5", height: "11", unit: "inch" }, onChange: vi.fn(), onCancel: vi.fn(), onApply: vi.fn() })));
    const form = container.querySelector<HTMLElement>("section")!;
    const body = form.querySelector<HTMLElement>(".cd-dialog-fit-body")!;
    expect(form.querySelectorAll("input")).toHaveLength(2);
    expect(form.querySelector("select")!.value).toBe("inch");
    // jsdom has no layout. Model WebKit's constrained flex measurement versus intrinsic rows.
    // Content: heading/prose 142 + labelled fields 50 + wrapped closed popup 50 + status 26;
    // actions 30 and outer padding 36 are additional, rather than overlapping the body.
    const content = 142 + 50 + 50 + 26 + 30 + 36;
    form.getBoundingClientRect = () => {
      const intrinsic = form.style.display === "grid" && form.style.gridAutoRows === "max-content" && body.style.height === "max-content";
      const height = intrinsic ? content : 249;
      return { top: 0, height } as DOMRect;
    };
    const saved = [form.getAttribute("style"), body.getAttribute("style")];
    expect(measureDialogContent(form)?.contentHeight).toBeGreaterThanOrEqual(content);
    expect([form.getAttribute("style"), body.getAttribute("style")]).toEqual(saved);
  } finally {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});

it.each(["macos", "windows"] as const)("sends ready once on %s with the form's measured height, after fonts settle", async platform => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { ...navigator, platform: platform === "macos" ? "MacIntel" : "Win32", userAgent: platform === "macos" ? "Macintosh" : "Windows" });
  vi.stubGlobal("devicePixelRatio", platform === "macos" ? 2 : 1.5);
  host.send.mockReset().mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const layout = vi.spyOn(HTMLFormElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLFormElement) {
    const height = this.style.getPropertyValue("min-height") === "0px" ? 263 : 240;
    return { x: 0, y: 0, left: 0, top: 0, right: 480, bottom: height, width: 480, height, toJSON: () => ({}) };
  });
  try {
    await act(async () => root.render(createElement(DialogWindow, { hostId: "table-host" })));
    const snapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "insertTable", sessionId: "session",
      requestId: "request", snapshotRevision: 1, type: "snapshot",
      data: { title: "Drawing A", rows: 3, columns: 3, headerRows: 1, preset: "three-line" } } as const;
    await act(async () => host.receive!(snapshot));
    await act(async () => { await document.fonts?.ready; await new Promise(resolve => setTimeout(resolve, 0)); });
    const readies = host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "ready");
    expect(readies).toHaveLength(1);
    expect(readies[0].data).toEqual({ contentHeight: 263, contentWidth: 480, pixelRatio: platform === "macos" ? 2 : 1.5 });
    expect(parseDialogMessage(readies[0])).toBeDefined();
    // A replayed snapshot at the same revision does not re-measure or resend ready.
    await act(async () => host.receive!(snapshot));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.send.mock.calls.filter(call => (call[1] as DialogMessage).type === "ready")).toHaveLength(1);
  } finally {
    layout.mockRestore();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("reports ready once with its own form element", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onReady = vi.fn();
  const render = (error?: string) => act(() => root.render(createElement(InsertTableForm, {
    title: "Drawing", initial: { rows: 2, columns: 2, headerRows: 1, preset: "three-line" },
    error, onReady, onSubmit: vi.fn(), onCancel: vi.fn(),
  })));
  try {
    render();
    render("Table insertion failed. Try again.");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(container.querySelector("form"));
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
