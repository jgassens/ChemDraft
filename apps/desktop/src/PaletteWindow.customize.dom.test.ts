// @vitest-environment jsdom

// Phase 4 seam: PaletteWindow enters/exits in-place customize mode off the customize-mode broadcast
// and echoes Done/Restore back to the main window over the layout-edit channel. Both run through the
// real window-manager DOM event bus in jsdom.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allShellCommands, type CommandSpec } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createPaletteRegistryFromLayoutState, PaletteWindow } from "./PaletteWindow";
import {
  broadcastToolsetCommandSpecs,
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

  async function renderMainPalette(initialRegistry?: Parameters<typeof PaletteWindow>[0]["initialRegistry"]) {
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId: "core.main", initialRegistry }));
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

  it("keeps an added dynamic launcher and refreshes its live title, icon, and availability", async () => {
    const commandId = "view.toolset.toggle.user.quick";
    const layoutState = {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.items",
              index: 0,
              item: {
                id: commandId,
                kind: "button",
                label: "Toggle Old Quick Tools",
                icon: "text",
                assetName: "Custom_Text",
                primary: { type: "command", commandId },
                submenu: null
              }
            }
          ]
        }
      ],
      userToolsets: [
        {
          id: "user.quick",
          title: "Renamed Quick Tools",
          source: "user",
          defaultVisible: false,
          defaultMode: "floating",
          groups: [
            {
              id: "user.quick.items",
              items: [{ commandId: "tool.select", title: "Selection Tool" }]
            }
          ]
        }
      ]
    };
    const seedSpec: CommandSpec = {
      id: commandId,
      title: "Toggle Renamed Quick Tools",
      icon: "palette",
      source: "core"
    };

    // The static shell id set does not know this user-toolbar launcher; the live spec id keeps the
    // persisted addition from being pruned during detached-palette rehydration.
    const registry = createPaletteRegistryFromLayoutState(layoutState, [seedSpec]);
    const liveLauncher = allShellCommands(createPhase4Document(), undefined, { registry })
      .find((command) => command.id === commandId);
    expect(liveLauncher?.title).toBe("Toggle Renamed Quick Tools");
    await renderMainPalette(registry);

    let button = container.querySelector<HTMLButtonElement>(`[data-command-id="${commandId}"]`);
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toContain("Toggle Renamed Quick Tools");
    expect(button?.getAttribute("data-toolbar-asset")).toBeNull();

    await act(async () => {
      await broadcastToolsetCommandSpecs([
        {
          ...seedSpec,
          title: "Toggle Final Quick Tools",
          icon: "undo",
          enabled: false,
          disabledReason: "Temporarily unavailable"
        }
      ]);
    });

    button = container.querySelector<HTMLButtonElement>(`[data-command-id="${commandId}"]`);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Toggle Final Quick Tools: Temporarily unavailable");
    expect(button?.querySelector(".title-glyph-icon")).toBeNull();
  });
});
