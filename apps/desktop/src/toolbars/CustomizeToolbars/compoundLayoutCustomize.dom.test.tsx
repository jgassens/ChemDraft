// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyToolsetLayoutState, toolsetItemCustomizationId, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { desktopToolsets } from "../../toolsets";
import { SHELL_COMMAND_IDS } from "../../shellCommandIds";
import { isCompoundLayoutCommand, loadCompoundLayoutSettings, saveCompoundLayoutSettings } from "../../compoundLayoutSettings";
import { MemoryStorage } from "../../testSupport/memoryStorage";
import { CustomizeToolbarsDialog } from "./CustomizeToolbarsDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const main = desktopToolsets.find((toolset) => toolset.id === "core.main")!;
const arrangeId = "layout.arrange.circle";
const layoutCommands = [...new Set([
  ...desktopToolsets.flatMap((toolset) => toolset.groups.flatMap((group) => group.items.flatMap((item) => [
    toolsetItemCustomizationId(item) ?? "",
    ...(item.submenu?.items.map((entry) => entry.commandId) ?? [])
  ]))),
  "layout.adjustArrangementSpacing"
])].filter(isCompoundLayoutCommand);
const availableCommands = layoutCommands.map((id) => ({ id, title: id }));
const emptyState: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

describe("compound layouts in Customize Toolbars", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApply: ReturnType<typeof vi.fn>;
  let onLiveApply: ReturnType<typeof vi.fn>;

  function render(state: ToolsetLayoutState = emptyState) {
    act(() => root.render(createElement(CustomizeToolbarsDialog, {
      baseToolsets: desktopToolsets,
      layoutState: state,
      availableCommands,
      isCommandHidden: loadCompoundLayoutSettings().enabled ? undefined : isCompoundLayoutCommand,
      onApply,
      onLiveApply,
      onClose: vi.fn()
    })));
  }

  function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    act(() => element!.click());
  }

  function selectToolset(id: string) {
    click(`[data-toolset-id="${id}"] .customize-toolset-title`);
  }

  function itemIds() {
    return [...container.querySelectorAll<HTMLElement>("[data-item-id]")].map((row) => row.dataset.itemId);
  }

  function expectNoLayoutCommands() {
    for (const element of container.querySelectorAll<HTMLElement>("[data-item-id], [data-command-id]")) {
      expect(isCompoundLayoutCommand(element.dataset.itemId ?? element.dataset.commandId!)).toBe(false);
    }
    expect(container.textContent).not.toContain("Arrange Selection");
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onApply = vi.fn();
    onLiveApply = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("omits layout commands from every toolbar's contents and the add-command picker when off", () => {
    const state: ToolsetLayoutState = {
      ...emptyState,
      toolsetOverrides: [{
        toolsetId: "core.main",
        itemAdditions: [{
          groupId: main.groups[0]!.id!,
          item: { commandId: "layout.adjustArrangementSpacing", label: "Adjust spacing" }
        }]
      }],
      userToolsets: [{ ...main, id: "user.copy", title: "Custom", source: "user" }]
    };
    render(state);
    for (const id of [...desktopToolsets.map((toolset) => toolset.id), "user.copy"]) {
      selectToolset(id);
      expectNoLayoutCommands();
    }
    // An empty custom toolbar exposes all eligible commands, including ones absent from its contents.
    click(".customize-toolbars-create button");
    expect(container.querySelector('[aria-label="Search commands to add"]')).not.toBeNull();
    expectNoLayoutCommands();
    expect(container.querySelectorAll("[data-command-id]")).toHaveLength(0);
  });

  it.each([false, true])("preserves hidden commands through live apply and Apply (saved override: %s)", (hasOverride) => {
    const group = main.groups[0]!;
    const originalOrder = group.items.map((item) => toolsetItemCustomizationId(item)!);
    const state: ToolsetLayoutState = hasOverride ? {
      ...emptyState,
      toolsetOverrides: [{
        toolsetId: main.id,
        itemOrder: { [group.id!]: [...originalOrder].reverse() },
        hiddenCommandIds: ["layout.arrange.row"],
        itemAdditions: [{
          groupId: group.id!,
          item: { commandId: "layout.adjustArrangementSpacing", label: "Adjust spacing" }
        }]
      }],
      userToolsets: [{ ...main, id: "user.copy", title: "Custom", source: "user" }]
    } : emptyState;
    const effectiveMain = (layout: ToolsetLayoutState) => applyToolsetLayoutState(desktopToolsets, layout, {
      additionalCommandIds: SHELL_COMMAND_IDS
    }).find((toolset) => toolset.id === main.id)!;
    const before = effectiveMain(state).groups.flatMap((entry) => entry.items).map(toolsetItemCustomizationId);
    render(state);
    selectToolset(main.id);
    expectNoLayoutCommands();
    click('[data-item-id="tool.select"] .customize-item-visible');
    expect(onLiveApply).toHaveBeenCalledTimes(1);
    click(".customize-toolbars-apply");
    const applied: ToolsetLayoutState = onApply.mock.calls[0]![0];
    expect(onLiveApply.mock.calls[0]![0]).toEqual(applied);
    expect(applied).toEqual({
      ...state,
      toolsetOverrides: [{
        ...state.toolsetOverrides[0],
        toolsetId: main.id,
        hiddenCommandIds: [...(state.toolsetOverrides[0]?.hiddenCommandIds ?? []), "tool.select"]
      }]
    });
    const after = effectiveMain(applied).groups.flatMap((entry) => entry.items).map(toolsetItemCustomizationId);
    expect(after).toEqual(before.filter((id) => id !== "tool.select"));
    expect(after).toContain(arrangeId);

    saveCompoundLayoutSettings({ enabled: true });
    render(applied);
    const ids = itemIds();
    expect(ids).toContain(arrangeId);
    expect(ids.indexOf(arrangeId)).toBe(hasOverride ? [...originalOrder].reverse().indexOf(arrangeId) : originalOrder.indexOf(arrangeId));
    expect(container.querySelector<HTMLInputElement>(`[data-item-id="${arrangeId}"] .customize-item-visible`)?.checked).toBe(true);
  });

  it("lists Arrange Selection and offers layout commands in the picker when on", () => {
    saveCompoundLayoutSettings({ enabled: true });
    render();
    selectToolset(main.id);
    expect(container.querySelector(`[data-item-id="${arrangeId}"]`)?.textContent).toContain("Arrange Selection");
    expect(container.querySelector<HTMLInputElement>(`[data-item-id="${arrangeId}"] .customize-item-visible`)?.checked).toBe(true);
    click(".customize-toolbars-create button");
    expect([...container.querySelectorAll<HTMLElement>("[data-command-id]")].map((row) => row.dataset.commandId)).toEqual(layoutCommands);
  });
});
