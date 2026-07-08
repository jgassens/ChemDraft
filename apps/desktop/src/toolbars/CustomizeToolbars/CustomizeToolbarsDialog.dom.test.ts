// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolsetDefinition, ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { CustomizeToolbarsDialog } from "./CustomizeToolbarsDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React tracks input value/checked itself, so a raw `input.value = …` is ignored. Use the native
// setter + an input event so React's onChange sees the change (the pattern the ToolPalette tests use).
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const baseToolsets: ToolsetDefinition[] = [
  {
    id: "core.main",
    title: "Main Toolbar",
    source: "core",
    defaultVisible: true,
    defaultMode: "floating",
    groups: [{ id: "core.main.g", items: [{ id: "tool.a", kind: "button", label: "A", primary: { type: "command", commandId: "tool.a" }, submenu: null }] }]
  },
  {
    id: "core.art",
    title: "Art Toolbar",
    source: "core",
    defaultVisible: false,
    defaultMode: "floating",
    groups: [{ id: "core.art.g", items: [{ id: "tool.b", kind: "button", label: "B", primary: { type: "command", commandId: "tool.b" }, submenu: null }] }]
  }
];

const emptyState: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

describe("CustomizeToolbarsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApply: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  const availableCommands = [
    { id: "tool.a", title: "A" },
    { id: "tool.b", title: "B" },
    { id: "tool.circle", title: "Circle" }
  ];

  function render(state: ToolsetLayoutState = emptyState) {
    onApply = vi.fn();
    onClose = vi.fn();
    act(() => {
      root.render(createElement(CustomizeToolbarsDialog, { baseToolsets, layoutState: state, availableCommands, onApply, onClose }));
    });
  }

  function clickButton(predicate: (button: HTMLButtonElement) => boolean) {
    const button = [...container.querySelectorAll("button")].find(predicate);
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  function applied(): ToolsetLayoutState {
    const apply = container.querySelector<HTMLButtonElement>(".customize-toolbars-apply");
    act(() => apply?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    return onApply.mock.calls.at(-1)?.[0];
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a row per toolset with current visibility", () => {
    render();
    const rows = container.querySelectorAll("[data-toolset-id]");
    expect([...rows].map((row) => row.getAttribute("data-toolset-id"))).toEqual(["core.main", "core.art"]);
    const mainVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.main"] .customize-toolset-visible');
    expect(mainVisible?.checked).toBe(true);
    const artVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.art"] .customize-toolset-visible');
    expect(artVisible?.checked).toBe(false);
  });

  it("toggles visibility into the applied state", () => {
    render();
    const artVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.art"] .customize-toolset-visible');
    // core.art starts unchecked; a click toggles it on and fires React's onChange.
    act(() => artVisible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.art", visible: true });
  });

  it("commits a rename on Enter", () => {
    render();
    const title = container.querySelector<HTMLInputElement>('[data-toolset-id="core.main"] .customize-toolset-title');
    act(() => {
      setInputValue(title!, "My Main");
      title!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.main", title: "My Main" });
  });

  it("creates a user toolbar", () => {
    render();
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="New toolbar name"]');
    act(() => setInputValue(nameInput!, "My Tools"));
    const createButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Toolbar");
    act(() => createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[data-toolset-id="user.my-tools"]')).not.toBeNull();
    const state = applied();
    expect(state.userToolsets.map((toolset) => toolset.id)).toEqual(["user.my-tools"]);
  });

  it("duplicates a built-in toolset into a user copy and lets it be deleted", () => {
    render();
    const cloneButton = container.querySelector<HTMLButtonElement>('[data-toolset-id="core.main"] .customize-toolset-action');
    act(() => cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const cloneRow = container.querySelector('[data-toolset-id="user.main-toolbar-copy"]');
    expect(cloneRow).not.toBeNull();
    // The clone (a user toolset) exposes a Delete button; core toolsets don't.
    expect(container.querySelector('[data-toolset-id="core.main"] .customize-toolset-delete')).toBeNull();
    const deleteButton = cloneRow!.querySelector<HTMLButtonElement>(".customize-toolset-delete");
    act(() => deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[data-toolset-id="user.main-toolbar-copy"]')).toBeNull();
  });

  it("shows the selected toolset's items and hides one", () => {
    render();
    // core.main is selected by default; its item tool.a shows in the detail pane, visible.
    const item = container.querySelector('[data-item-id="tool.a"]');
    expect(item).not.toBeNull();
    const visible = item!.querySelector<HTMLInputElement>(".customize-item-visible");
    expect(visible?.checked).toBe(true);
    act(() => visible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.main", hiddenCommandIds: ["tool.a"] });
  });

  it("adds a command to a user toolset via the palette", () => {
    render();
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="New toolbar name"]');
    act(() => setInputValue(nameInput!, "Mine"));
    clickButton((button) => button.textContent === "Create Toolbar");
    // The command palette appears for the (selected) user toolset; search + add.
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search commands to add"]');
    expect(search).not.toBeNull();
    act(() => setInputValue(search!, "Circle"));
    const addButton = container.querySelector<HTMLButtonElement>('[data-command-id="tool.circle"]');
    expect(addButton).not.toBeNull();
    act(() => addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const userToolset = applied().userToolsets.find((toolset) => toolset.id === "user.mine");
    expect(userToolset?.groups.some((group) => group.items.some((item) => item.id === "tool.circle"))).toBe(true);
  });
});
