// @vitest-environment jsdom

// Phase 4 seam: PaletteWindow enters/exits in-place customize mode off the customize-mode broadcast
// and echoes Done/Restore back to the main window over the layout-edit channel. Both run through the
// real window-manager DOM event bus in jsdom.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import {
  broadcastToolsetCustomizeMode,
  TOOLSET_LAYOUT_EDIT_EVENT,
  type ToolsetLayoutEditPayload
} from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PaletteWindow customize mode bridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let edits: ToolsetLayoutEditPayload[];
  let editListener: (event: Event) => void;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    edits = [];
    editListener = (event: Event) => {
      const detail = (event as CustomEvent<ToolsetLayoutEditPayload>).detail;
      if (detail) {
        edits.push(detail);
      }
    };
    window.addEventListener(TOOLSET_LAYOUT_EDIT_EVENT, editListener);
  });

  afterEach(() => {
    window.removeEventListener(TOOLSET_LAYOUT_EDIT_EVENT, editListener);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderMainPalette() {
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId: "core.main" }));
    });
    // Let the async listener-attachment effects settle before "the main window broadcasts".
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("shows the Done/Restore bar when customize mode turns on and hides it when off", async () => {
    await renderMainPalette();
    expect(container.querySelector(".customize-main-toolbar-bar")).toBeNull();

    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true });
    });
    expect(container.querySelector(".customize-main-toolbar-bar")).not.toBeNull();
    expect(container.querySelector(".tool-palette.customizing")).not.toBeNull();

    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: false });
    });
    expect(container.querySelector(".customize-main-toolbar-bar")).toBeNull();
  });

  it("routes Restore Defaults and Done back to the main window as edit ops", async () => {
    await renderMainPalette();
    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true });
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".customize-main-toolbar-button"));
    const restore = buttons.find((button) => button.textContent === "Restore Defaults");
    const done = buttons.find((button) => button.textContent === "Done");
    expect(restore).toBeDefined();
    expect(done).toBeDefined();

    await act(async () => {
      restore?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      done?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(edits).toEqual([
      { toolsetId: "core.main", edit: { kind: "resetToolset" } },
      { toolsetId: "core.main", edit: { kind: "exitCustomize" } }
    ]);
  });

  it("ignores a customize-mode broadcast for a different toolset", async () => {
    await renderMainPalette();
    await act(async () => {
      await broadcastToolsetCustomizeMode({ toolsetId: "core.art", active: true });
    });
    expect(container.querySelector(".customize-main-toolbar-bar")).toBeNull();
  });
});
