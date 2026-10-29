// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InsertTableForm } from "./InsertTableForm";

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
