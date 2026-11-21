// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyToolsetLayoutState, parseToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { createPluginRuntime } from "../../plugins/createPluginRuntime";
import {
  createFixturePluginOptions, FIXTURE_PLUGIN_CHAT_COMMAND_ID, FIXTURE_PLUGIN_PING_COMMAND_ID,
  FIXTURE_PLUGIN_TOOLSET_ID, fixturePluginManifest
} from "../../plugins/fixturePlugin";
import { SHELL_COMMAND_IDS } from "../../shellCommandIds";
import { createDesktopShortcutRegistry } from "../../keyboardShortcuts";
import { setNativePromptProvider, type NativePromptOptions } from "../../nativePrompt";
import {
  createDesktopToolsetRegistry, desktopToolsets, getToolsetCommandSpecs, getToolsetItemGroups,
  reachableToolsetCommandSpecs, type DesktopToolsetDefinition
} from "../../toolsets";
import { createToolbarCatalog } from "../toolbarCatalog";
import { filterToolbarCustomizationCommands } from "../toolbarCustomizationCommands";
import { CustomizeToolbarsDialog } from "./CustomizeToolbarsDialog";
import { removeToolsetItem } from "./layoutStateEdits";

vi.mock("../../drawingTools", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../drawingTools")>(),
  TRANSITIONAL_STUB_COMMAND_IDS: new Set(["tool.testStub"])
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React tracks input value/checked itself, so a raw `input.value = …` is ignored. Use the native
// setter + an input event so React's onChange sees the change (the pattern the ToolPalette tests use).
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const baseToolsets: DesktopToolsetDefinition[] = [
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
  },
  {
    id: "plugin.fixture",
    title: "Fixture Toolbar",
    source: "plugin",
    defaultVisible: false,
    defaultMode: "floating",
    groups: [{ id: "plugin.fixture.g", items: [{ commandId: "plugin.fixture.ping", label: "Ping" }] }]
  }
];

const emptyState: ToolsetLayoutState = { version: 1, toolsetOverrides: [], userToolsets: [] };

describe("CustomizeToolbarsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApply: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  const circle = { id: "tool.art.circle", title: "Circle", icon: "bracket", assetName: "Art_Circle" } as const;
  const availableCommands = filterToolbarCustomizationCommands([
    { id: "plugin.fixture.ping", title: "Ping", source: "plugin" },
    circle,
    { id: "tool.testStub", title: "Unimplemented Test Tool" },
    { id: "tool.art.rectShadow", title: "Shadow Rectangle" },
    { id: "edit.undo", title: "Undo", enabled: false, disabledReason: "Nothing to undo" }
  ], { enabled: false });

  function render(
    state: ToolsetLayoutState = emptyState,
    toolsets: DesktopToolsetDefinition[] = baseToolsets,
    confirmReset?: (title: string) => Promise<boolean>
  ) {
    onApply = vi.fn();
    onClose = vi.fn();
    act(() => {
      root.render(createElement(CustomizeToolbarsDialog, {
        baseToolsets: toolsets, layoutState: state, availableCommands, onApply, onClose, confirmReset
      }));
    });
  }

  function clickButton(predicate: (button: HTMLButtonElement) => boolean) {
    const button = [...container.querySelectorAll("button")].find(predicate);
    expect(button).toBeDefined();
    act(() => button!.click());
  }

  function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    act(() => element!.click());
  }

  function openPicker() {
    clickButton((button) => button.textContent === "Add command…");
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search commands to add"]');
    expect(search).not.toBeNull();
    return search!;
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
    expect([...rows].map((row) => row.getAttribute("data-toolset-id"))).toEqual(["core.main", "core.art", "plugin.fixture"]);
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

  it("keeps Escape inside a rename field from discarding the whole session's edits", () => {
    render();
    // A live-applied edit first: hiding a toolbar. Escape in a text field must not roll it back.
    const artVisible = container.querySelector<HTMLInputElement>('[data-toolset-id="core.art"] .customize-toolset-visible');
    act(() => artVisible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const title = container.querySelector<HTMLInputElement>('[data-toolset-id="core.main"] .customize-toolset-title');
    act(() => {
      setInputValue(title!, "Half-typed name");
      title!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // The dialog is still open and the earlier edit survives.
    expect(onClose).not.toHaveBeenCalled();
    expect(applied().toolsetOverrides).toContainEqual({ toolsetId: "core.art", visible: true });
  });

  it("still closes on Escape outside a text field", () => {
    render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
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

  it.each(["stable", "index"] as const)("shows the same plugin item order as the palette with a saved %s group ID", idKind => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
    const toolsets = runtime.listPluginToolsets();
    const toolsetId = FIXTURE_PLUGIN_TOOLSET_ID;
    const groupId = toolsets[0].groups[0].id!;
    const orderGroupId = idKind === "stable" ? groupId : `${toolsetId}.group.0`;
    const undo = "edit.undo";
    const originalOrder = [FIXTURE_PLUGIN_PING_COMMAND_ID, FIXTURE_PLUGIN_CHAT_COMMAND_ID, undo];
    const savedOrder = [undo, FIXTURE_PLUGIN_PING_COMMAND_ID, FIXTURE_PLUGIN_CHAT_COMMAND_ID];
    const state: ToolsetLayoutState = {
      ...emptyState,
      toolsetOverrides: [{
        toolsetId,
        itemAdditions: [{ groupId, index: 2, item: { commandId: undo } }],
        itemOrder: { [orderGroupId]: savedOrder }
      }]
    };
    const catalog = createToolbarCatalog();
    catalog.setPluginToolsets(toolsets, runtime.listPluginCommandsWithHandlers());
    catalog.setLayoutState(state);
    render(state, toolsets);

    const paletteOrder = getToolsetItemGroups(toolsetId, catalog.registry()).flat().map(item => item.id);
    const dialogOrder = [...container.querySelectorAll<HTMLElement>("[data-item-id]")].map(item => item.dataset.itemId);
    expect(paletteOrder).toEqual(dialogOrder);
    expect(dialogOrder).toEqual(idKind === "stable" ? savedOrder : originalOrder);
  });

  it("adds a command to a user toolset via the palette", () => {
    render();
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="New toolbar name"]');
    act(() => setInputValue(nameInput!, "Mine"));
    clickButton((button) => button.textContent === "Create Toolbar");
    const search = openPicker();
    act(() => setInputValue(search, "Circle"));
    click(`[data-command-id="${circle.id}"]`);
    const state = applied();
    expect(state.toolsetOverrides).toEqual([]);
    expect(state.userToolsets.find((toolset) => toolset.id === "user.mine")?.groups[0]?.items).toMatchObject([
      { id: circle.id, icon: circle.icon, assetName: circle.assetName }
    ]);
  });

  it.each([
    ["core.main", "core.main.g", "tool.a"],
    ["plugin.fixture", "plugin.fixture.g", "plugin.fixture.ping"]
  ])("adds and removes a command via the override for %s", (toolsetId, groupId, manifestItemId) => {
    render();
    click(`[data-toolset-id="${toolsetId}"] .customize-toolset-title`);
    const manifestItem = container.querySelector(`[data-item-id="${manifestItemId}"]`)!;
    expect(manifestItem.querySelector(".customize-item-remove")).not.toBeNull();
    const search = openPicker();
    expect(container.querySelector(`[data-command-id="${manifestItemId}"]`)).toBeNull();
    act(() => setInputValue(search, circle.id));
    click(`[data-command-id="${circle.id}"]`);
    expect(container.querySelector(`[data-command-id="${circle.id}"]`)).toBeNull();
    expect(applied()).toEqual({
      ...emptyState,
      toolsetOverrides: [{
        toolsetId,
        itemAdditions: [{
          groupId,
          item: {
            id: circle.id, kind: "button", label: circle.title, icon: circle.icon, assetName: circle.assetName,
            primary: { type: "command", commandId: circle.id }, submenu: null
          }
        }]
      }]
    });
    click(`[data-item-id="${circle.id}"] .customize-item-visible`);
    click(`[data-item-id="${circle.id}"] .customize-item-remove`);
    expect(container.querySelector(`[data-item-id="${circle.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-command-id="${circle.id}"]`)).not.toBeNull();
    expect(applied()).toEqual(emptyState);
  });

  it("resets a built-in toolbar to its manifest layout after confirmation", async () => {
    const confirmReset = vi.fn(async () => true);
    render(emptyState, baseToolsets, confirmReset);
    openPicker();
    click('[data-command-id="edit.undo"]');
    click('[data-item-id="tool.a"] .customize-item-visible');
    const edited = applyToolsetLayoutState(baseToolsets, applied(), { additionalCommandIds: SHELL_COMMAND_IDS });
    expect(edited.find((toolset) => toolset.id === "core.main")?.groups[0]?.items.map((item) => item.id))
      .toEqual(["edit.undo"]);
    await act(async () => container.querySelector<HTMLElement>('[title="Reset Main Toolbar to Defaults"]')!.click());
    expect(confirmReset).toHaveBeenCalledWith("Main Toolbar");
    expect(container.querySelector('[data-item-id="edit.undo"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-item-id="tool.a"] .customize-item-visible')?.checked).toBe(true);
    expect(applied()).toEqual(emptyState);
  });

  it("removes a built-in item like any other, persists it, and can add it back", () => {
    render();
    click('[data-item-id="tool.a"] .customize-item-remove');
    // Gone from the list (not left as an unchecked row) and offered under Add command instead.
    expect(container.querySelector('[data-item-id="tool.a"]')).toBeNull();
    openPicker();
    expect(container.querySelector('[data-command-id="tool.a"]')?.textContent).toBe("+ A");
    const removed = applied();
    expect(removed).toEqual({
      ...emptyState,
      toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: ["tool.a"] }],
      removedToolsetItemIds: { "core.main": ["tool.a"] }
    });
    // The toolbar itself drops the item; the manifest is untouched.
    const effective = applyToolsetLayoutState(baseToolsets, removed, { additionalCommandIds: SHELL_COMMAND_IDS });
    expect(effective.find((toolset) => toolset.id === "core.main")?.groups).toEqual([]);
    expect(baseToolsets[0]!.groups[0]!.items.map((item) => item.id)).toEqual(["tool.a"]);

    // Reopen with the saved (JSON round-tripped) state, as after a restart: still removed.
    act(() => root.unmount());
    root = createRoot(container);
    render(parseToolsetLayoutState(JSON.parse(JSON.stringify(removed))));
    expect(container.querySelector('[data-item-id="tool.a"]')).toBeNull();
    openPicker();
    click('[data-command-id="tool.a"]');
    expect(container.querySelector<HTMLInputElement>('[data-item-id="tool.a"] .customize-item-visible')?.checked).toBe(true);
    expect(applied()).toEqual(emptyState);
  });

  it("keeps an unchecked built-in item listed, unlike a removed one", () => {
    render();
    click('[data-item-id="tool.a"] .customize-item-visible');
    expect(container.querySelector<HTMLInputElement>('[data-item-id="tool.a"] .customize-item-visible')?.checked).toBe(false);
    expect(applied().removedToolsetItemIds).toBeUndefined();
  });

  it("restores removed built-in items with Reset to Defaults, through the native prompt", async () => {
    const prompts: NativePromptOptions[] = [];
    let answer = "cancel";
    const restore = setNativePromptProvider(async (prompt) => { prompts.push(prompt); return answer; });
    try {
      render();
      click('[data-item-id="tool.a"] .customize-item-remove');
      const reset = () => container.querySelector<HTMLElement>('[data-toolset-id="core.main"] .customize-toolset-reset')!;
      expect(reset().textContent).toBe("Reset to Defaults");

      await act(async () => reset().click());
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        title: "Reset “Main Toolbar” to its defaults?",
        kind: "warning",
        owner: "document",
        choices: [
          { id: "reset", label: "Reset to Defaults", destructive: true },
          { id: "cancel", label: "Cancel", cancel: true }
        ]
      });
      // Cancel keeps the removal.
      expect(container.querySelector('[data-item-id="tool.a"]')).toBeNull();
      expect(applied().removedToolsetItemIds).toEqual({ "core.main": ["tool.a"] });

      answer = "reset";
      await act(async () => reset().click());
      expect(container.querySelector('[data-item-id="tool.a"]')).not.toBeNull();
      expect(applied()).toEqual(emptyState);
    } finally {
      restore();
    }
  });

  it("offers Reset to Defaults per built-in or plugin toolbar, never on a user toolbar", () => {
    render();
    const nameInput = container.querySelector<HTMLInputElement>('[aria-label="New toolbar name"]');
    act(() => setInputValue(nameInput!, "Mine"));
    clickButton((button) => button.textContent === "Create Toolbar");
    const resettable = [...container.querySelectorAll("[data-toolset-id]")]
      .filter((row) => row.querySelector(".customize-toolset-reset"))
      .map((row) => row.getAttribute("data-toolset-id"));
    expect(resettable).toEqual(["core.main", "core.art", "plugin.fixture"]);
  });

  it("keeps a removed built-in item's command registered for menus, shortcuts and Customize", () => {
    // Use the real manifest so commands carry their real shortcuts. Remove a shortcut command from
    // EVERY built-in toolbar that carries it as a button, so the customized registry really loses it.
    const removeEverywhere = (commandId: string) => desktopToolsets
      .filter((toolset) => toolset.groups.some((group) => group.items.some((item) => item.commandId === commandId)))
      .reduce<ToolsetLayoutState>((next, toolset) => removeToolsetItem(next, toolset.id, commandId), { ...emptyState });
    const target = getToolsetCommandSpecs(createDesktopToolsetRegistry()).find((command) =>
      command.shortcut && desktopToolsets.some((toolset) => toolset.id === "core.main" &&
        toolset.groups.some((group) => group.items.some((item) => item.commandId === command.id))) &&
      !getToolsetCommandSpecs(createDesktopToolsetRegistry(removeEverywhere(command.id)))
        .some((candidate) => candidate.id === command.id))!;
    expect(target).toBeDefined();
    const state = removeEverywhere(target.id);
    const catalog = createToolbarCatalog();
    catalog.setLayoutState(state);

    // Off the toolbars...
    expect(getToolsetItemGroups("core.main", catalog.registry()).flat().map((item) => item.id)).not.toContain(target.id);
    // ...but the command survives: in the gallery's base commands, the toolbar command specs the
    // document window registers (menus and shortcuts share that registry), and its shortcut on both platforms.
    expect(catalog.baseCommands().map((command) => command.id)).toContain(target.id);
    // The customized registry alone no longer yields it, which is why the manifest's are merged in.
    expect(getToolsetCommandSpecs(catalog.registry()).map((command) => command.id)).not.toContain(target.id);
    const reachable = reachableToolsetCommandSpecs(catalog.registry(), catalog.baseRegistry());
    expect(reachable.map((command) => command.id)).toContain(target.id);
    for (const platform of ["macos", "windows"] as const) {
      expect(createDesktopShortcutRegistry(reachable, platform).list().map((shortcut) => shortcut.commandId)).toContain(target.id);
    }
  });

  it("offers transiently disabled commands and excludes transitional stubs and compatibility-only variants", () => {
    render();
    openPicker();
    expect(container.querySelector('[data-command-id="tool.testStub"]')).toBeNull();
    expect(container.querySelector('[data-command-id="tool.art.rectShadow"]')).toBeNull();
    expect(container.querySelector('[data-command-id="edit.undo"]')?.textContent).toBe("+ Undo");
  });

  it("re-shows a manifest command with a legacy hidden override while preserving its placement", () => {
    const layout = { colSpan: 2 };
    render({
      ...emptyState,
      toolsetOverrides: [{ toolsetId: "plugin.fixture", itemOverrides: [{ commandId: "plugin.fixture.ping", hidden: true, layout }] }]
    });
    click('[data-toolset-id="plugin.fixture"] .customize-toolset-title');
    expect(container.querySelector<HTMLInputElement>('[data-item-id="plugin.fixture.ping"] .customize-item-visible')?.checked).toBe(false);
    openPicker();
    click('[data-command-id="plugin.fixture.ping"]');
    expect(container.querySelectorAll('[data-item-id="plugin.fixture.ping"]')).toHaveLength(1);
    expect(applied().toolsetOverrides).toEqual([{ toolsetId: "plugin.fixture", itemOverrides: [{ commandId: "plugin.fixture.ping", layout }] }]);
  });

  it("surfaces an in-place addition (spacer) as a row so it can be hidden there too", () => {
    const withSpacer: ToolsetLayoutState = {
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.g",
              index: 1,
              item: { id: "user.spacer.1", kind: "spacer", label: "Spacer", primary: { type: "none" }, layout: { rowSpan: 2 } }
            }
          ]
        }
      ]
    };
    render(withSpacer);
    const spacerRow = container.querySelector('[data-item-id="user.spacer.1"]');
    expect(spacerRow).not.toBeNull();
    const visible = spacerRow!.querySelector<HTMLInputElement>(".customize-item-visible");
    act(() => visible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const override = applied().toolsetOverrides.find((entry) => entry.toolsetId === "core.main");
    expect(override?.hiddenCommandIds).toContain("user.spacer.1");
  });

  it("shows multiple additions in the registry's chronological insertion order", () => {
    render({
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.g",
              index: 1,
              item: { id: "user.spacer.1", kind: "spacer", label: "First", primary: { type: "none" } }
            },
            {
              groupId: "core.main.g",
              index: 0,
              item: { id: "user.spacer.2", kind: "spacer", label: "Second", primary: { type: "none" } }
            }
          ]
        }
      ]
    });

    expect([...container.querySelectorAll("[data-item-id]")].map((row) => row.getAttribute("data-item-id"))).toEqual([
      "user.spacer.2",
      "tool.a",
      "user.spacer.1"
    ]);
  });

  it("preserves a shell-only toolbar addition when duplicating the effective toolbar", () => {
    render({
      version: 1,
      userToolsets: [],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          itemAdditions: [
            {
              groupId: "core.main.g",
              index: 1,
              item: {
                id: "edit.undo",
                kind: "button",
                label: "Undo",
                primary: { type: "command", commandId: "edit.undo" },
                submenu: null
              }
            }
          ]
        }
      ]
    });

    const cloneButton = container.querySelector<HTMLButtonElement>('[data-toolset-id="core.main"] .customize-toolset-action');
    act(() => cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const clone = applied().userToolsets.find((toolset) => toolset.id === "user.main-toolbar-copy");
    expect(clone?.groups.flatMap((group) => group.items).map((item) => item.id ?? item.commandId)).toContain("edit.undo");
  });

  it("duplicates the on-screen (customized) toolset, not the raw manifest", () => {
    render();
    // Hide core.main's only item, then Duplicate core.main.
    const visible = container.querySelector<HTMLInputElement>('[data-item-id="tool.a"] .customize-item-visible');
    act(() => visible!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const cloneButton = container.querySelector<HTMLButtonElement>('[data-toolset-id="core.main"] .customize-toolset-action');
    act(() => cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const clone = applied().userToolsets.find((toolset) => toolset.id === "user.main-toolbar-copy");
    // The clone mirrors what's on screen (the hidden item is gone), not the raw manifest.
    expect(clone?.groups.every((group) => group.items.every((item) => item.id !== "tool.a"))).toBe(true);
  });
});
