// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InsertTableForm } from "./InsertTableForm";
import { readFileSync } from "node:fs";

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
    expect(getComputedStyle(form).minHeight).toBe("max(240px, 100vh)");
    // Native minimum width leaves 444px after padding: three 90px inputs, three
    // 10px gaps and ample room for the native Style select on either platform.
    const native = readFileSync("apps/desktop/src-tauri/src/dialog_windows.rs", "utf8");
    const spec = native.match(/"insertTable" => Ok\(DialogKindSpec \{([\s\S]*?)\}\),/)![1]!;
    expect(spec).toContain("min_size: (480.0, 240.0)");
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
