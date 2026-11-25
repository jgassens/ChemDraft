// @vitest-environment jsdom
// DEV-ONLY drag harness slot in the Templates dialog; remove with the harness in phase 3.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { structureTemplates } from "@chemdraft/template-library";
import { StructureTemplatePicker } from "./StructureTemplatePicker";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class { onmessage?: unknown } }));
vi.mock("./structureTemplateThumbnail", () => ({ structureTemplateThumbnail: vi.fn(async () => "data:image/svg+xml,") }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  tauri.invoke.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const props = { title: "Drawing A", templateIds: structureTemplates.slice(0, 2).map(template => template.id),
  onInsert: vi.fn(), onClose: vi.fn() };

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

describe("Templates dialog drag-test slot", () => {
  it("is off by default: no tile and no native call (browser fallback and stable builds)", async () => {
    await act(async () => root.render(createElement(StructureTemplatePicker, props)));
    await settle();
    expect(container.querySelector(".cd-drag-test")).toBeNull();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("shows nothing when Rust answers null (a stable identity)", async () => {
    tauri.invoke.mockResolvedValue(null);
    await act(async () => root.render(createElement(StructureTemplatePicker, { ...props, showDragTest: true })));
    // The tile's module loads lazily; wait for its one native call, then let the answer land.
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("art_library_dev_drag_test_prepare"));
    await settle();
    expect(tauri.invoke).toHaveBeenCalledOnce();
    expect(container.querySelector(".cd-drag-test")).toBeNull();
  });

  it("shows the tile beside the templates, outside their keyboard grid, when Rust prepares the file", async () => {
    tauri.invoke.mockResolvedValue("/dev/art-library/spike/drag-test.svg");
    await act(async () => root.render(createElement(StructureTemplatePicker, { ...props, showDragTest: true })));
    await vi.waitFor(async () => {
      await settle();
      expect(container.querySelector("[data-drag-test-path]")).not.toBeNull();
    });
    const tile = container.querySelector("[data-drag-test-path]");
    expect(tile?.getAttribute("data-drag-test-path")).toBe("/dev/art-library/spike/drag-test.svg");
    expect(container.querySelectorAll("[data-template-id]")).toHaveLength(2);
    expect(tile?.closest("[data-template-id]")).toBeNull();
  });
});
