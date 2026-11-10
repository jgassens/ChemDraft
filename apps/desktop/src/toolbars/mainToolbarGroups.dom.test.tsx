// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyToolsetLayoutState, parseToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { desktopToolsets } from "../toolsets";
import { CustomizeToolbarsDialog } from "./CustomizeToolbars/CustomizeToolbarsDialog";
import { MainToolbarMigrationNotice } from "./MainToolbarMigrationNotice";
import { migrateMainToolbarGroups } from "./toolbarLayoutState";
import { mainToolbarDefinition } from "./mainToolbarGroups";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("group customization and migration notice", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  function click(label: string) {
    const target = [...container.querySelectorAll<HTMLElement>("[aria-label]")].find(element => element.getAttribute("aria-label") === label);
    expect(target, label).toBeDefined();
    act(() => target!.click());
  }
  it("edits whole groups and their buttons inside the existing Customize dialog", () => {
    let saved: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };
    act(() => root.render(createElement(CustomizeToolbarsDialog, {
      baseToolsets: desktopToolsets, layoutState: saved, onClose: vi.fn(), onApply: vi.fn(),
      onLiveApply: state => { saved = state; }
    })));
    expect(container.querySelectorAll('[aria-label="Main toolbar groups"] fieldset')).toHaveLength(7);
    expect(container.textContent).not.toContain("Undeclared");
    click("Show Arrows group");
    expect(saved.toolsetOverrides[0].hiddenGroupIds).toEqual(["arrows"]);
    click("Show Arrows group");
    expect(saved.toolsetOverrides[0].hiddenGroupIds).toEqual([]);
    click("Move Orbitals group earlier");
    expect([...container.querySelectorAll<HTMLElement>("fieldset")].map(element => element.dataset.groupId).slice(0, 5))
      .toEqual(["select-text", "bonds-rings", "arrows", "orbitals", "symbols-shapes"]);
    click("Move Text Tool earlier in Select & Text");
    expect(saved.toolsetOverrides[0].itemOrder?.["select-text"]).toEqual(["tool.select", "tool.lasso", "tool.text", "tool.eraser"]);
    const right = container.querySelector<HTMLInputElement>('[data-item-id="layout.alignRight"] input')!;
    expect(right.checked).toBe(false);
    act(() => right.click());
    expect(applyToolsetLayoutState([mainToolbarDefinition], saved)[0].groups.find(group => group.id === "arrange")?.items).toHaveLength(10);
    expect(container.textContent).not.toContain("Space");
    expect(container.querySelector('[aria-label="Add command"]')).toBeNull();
  });
  it.each(["reset", "dismiss"] as const)("persists %s from the one-time notice and hides it afterwards", action => {
    let state = parseToolsetLayoutState(migrateMainToolbarGroups({ version: 1, toolsetOverrides: [{
      toolsetId: "core.main", hiddenCommandIds: ["tool.text"]
    }] }));
    const onChange = (next: ToolsetLayoutState) => {
      state = next;
      root.render(createElement(MainToolbarMigrationNotice, { state, onChange }));
    };
    act(() => root.render(createElement(MainToolbarMigrationNotice, { state, onChange })));
    expect(container.textContent).toBe("Your toolbar layout was rearranged into groups. Reset to defaultDismiss");
    if (action === "dismiss") click("Dismiss toolbar layout notice");
    else act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Reset to default")!.click());
    expect(state.mainToolbarGroupsMigration).toEqual({ version: 1, noticePending: false });
    expect(container.textContent).toBe("");
    expect(migrateMainToolbarGroups(state)).toBe(state);
    if (action === "reset") expect(state.toolsetOverrides).toEqual([]);
    else expect(state.toolsetOverrides[0].hiddenCommandIds).toEqual(["tool.text"]);
  });
});
