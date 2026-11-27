// @vitest-environment jsdom
// Review of d306fcaf0: which control a tool was chosen through must (1) never be claimed for an action
// such as align, (2) be credited only to the toolbar of the window that sent it, so a plugin toolbar
// cannot speak for a core toolbar, and (3) never come back as a stale echo after the tool changed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { ToolPalette } from "./ToolPalette";
import { getToolsetCommandGroups, getToolsetItemGroups } from "./toolsets";
import { sendPaletteCommand, type ToolsetPopoverContentPayload } from "./window-manager";
import { TOOLBAR_TOOL_CHOICE_EVENT, type ToolbarToolChoice, type ToolbarToolChoiceClaim } from "./window-manager/toolbarToolChoice";

/**
 * The Rust side of `route_toolset_command` (lib.rs, unit-tested there): a claim names no toolbar; the
 * toolbar is the sender's own, a popover's verified flyout opening or a palette's recorded toolset id.
 * jsdom is one window, so every toolbar here hears the dispatch, the sender included.
 */
const rust = vi.hoisted(() => ({
  sender: "main",
  directory: new Map([
    ["toolset-core-main", "core.main"],
    ["toolset-core-structure", "core.structure"],
    ["toolset-plugin-fixture", "plugin.fixture"]
  ]),
  routed: [] as Array<{ sender: string; commandId: string; toolChoice?: Record<string, unknown>; flyoutOpening?: unknown }>,
  delivered: [] as unknown[]
}));
/** The Tauri event bus: any toolset window, plugin toolbars included, may emit any event on it. */
const bus = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { event: string; id: number; payload: unknown }) => void>>()
}));
const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void)
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command !== "route_toolset_command") return undefined;
    const commandId = args?.commandId as string;
    const claim = args?.toolChoice as ToolbarToolChoiceClaim | undefined;
    const opening = args?.flyoutOpening as { toolsetId: string; flyoutId: string } | undefined;
    rust.routed.push({ sender: rust.sender, commandId, toolChoice: claim as Record<string, unknown> | undefined, flyoutOpening: opening });
    if (!claim) return undefined;
    let choice: ToolbarToolChoice | undefined;
    if (rust.sender.startsWith("toolset-popover-")) {
      if (opening) choice = { toolsetId: opening.toolsetId, commandId, flyoutId: opening.flyoutId };
    } else {
      const toolsetId = rust.directory.get(rust.sender);
      if (toolsetId) {
        choice = {
          toolsetId, commandId,
          ...(claim.itemId !== undefined ? { itemId: claim.itemId } : {}),
          ...(claim.flyoutId !== undefined ? { flyoutId: claim.flyoutId } : {})
        };
      }
    }
    if (!choice) return undefined;
    rust.delivered.push(choice);
    window.dispatchEvent(new CustomEvent(TOOLBAR_TOOL_CHOICE_EVENT, { detail: choice }));
    return undefined;
  })
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { event: string; id: number; payload: unknown }) => void) => {
    const handlers = bus.handlers.get(event) ?? new Set();
    handlers.add(handler);
    bus.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }),
  emit: vi.fn(async (event: string, payload?: unknown) => {
    for (const handler of [...(bus.handlers.get(event) ?? [])]) handler({ event, id: 0, payload });
  }),
  emitTo: vi.fn(async () => {}),
  once: vi.fn(async () => () => {})
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: vi.fn(async () => {}) }) }));
vi.mock("./plugins/pluginPanelInputFocus", async importOriginal => ({
  ...await importOriginal<typeof import("./plugins/pluginPanelInputFocus")>(),
  installPaletteInputFocus: () => () => {}
}));
// The popover's own window plumbing; `sendPaletteCommand` stays real, down to the invoke above.
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  isToolsetPopoverVisible: async () => true,
  listenForToolsetPopoverContent: vi.fn(async (handler: (payload: ToolsetPopoverContentPayload) => void) => {
    native.content = handler;
    return () => {};
  }),
  listenForToolsetPopoverDismiss: vi.fn(async () => () => {}),
  listenForToolsetPopoverRelease: vi.fn(async () => () => {}),
  listenForToolsetFlyoutKeys: vi.fn(async () => () => {}),
  listenForBondStereoPopoverActions: vi.fn(async () => () => {}),
  listenForToolsetTextStyle: vi.fn(async () => () => {}),
  requestToolsetPopoverContent: vi.fn(async () => {}), requestToolsetTextStyle: vi.fn(async () => {}),
  notifyToolsetPopoverClosed: vi.fn(async () => {}), notifyToolsetFlyoutClosed: vi.fn(async () => {}),
  setCurrentWindowLogicalSize: vi.fn(async () => {}), setCurrentWindowLogicalPosition: vi.fn(async () => {}),
  showCurrentToolsetPopoverWindow: vi.fn(async () => true)
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let containers: HTMLDivElement[] = [];
let roots: Root[] = [];
function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  return { container, root };
}

const tauriHost = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
beforeEach(() => {
  vi.clearAllMocks();
  native.content = undefined;
  rust.sender = "main";
  rust.routed = [];
  rust.delivered = [];
  bus.handlers.clear();
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  for (const container of containers) container.remove();
  roots = [];
  containers = [];
  delete tauriHost.__TAURI_INTERNALS__;
});

/** Drawing-tool controls showing themselves as the active tool. */
const pressed = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"][data-command-id^="tool."]')]
    .map(button => button.dataset.commandId);

/** Let the palette command queue reach the invoke. */
const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });

describe.each(["macos", "windows"] as const)("toolbar tool choices trust only their sender on %s", platform => {
  /**
   * A toolbar as a native palette window renders it: `label` is its window, a drawing tool chosen through
   * it goes out as PaletteWindow sends it (the claim with the command), and the app owns `activeTool`.
   */
  function palette(toolsetId: string, label: string, options: { native?: boolean } = {}) {
    const { container, root } = mount();
    const onInvoke = vi.fn((commandId: string) => {
      rust.sender = label;
      void sendPaletteCommand(commandId);
    });
    const onInvokeToolChoice = vi.fn((commandId: string, toolChoice: ToolbarToolChoiceClaim) => {
      rust.sender = label;
      void sendPaletteCommand(commandId, { toolChoice });
    });
    const onRequestFlyout = vi.fn();
    const render = async (activeTool: string) => act(async () => root.render(createElement(ToolPalette, {
      groups: getToolsetCommandGroups(toolsetId), itemGroups: getToolsetItemGroups(toolsetId),
      activeTool, toolsetId, orientation: "horizontal", mode: "floating", platform, onInvoke, onInvokeToolChoice,
      ...(options.native ? { onRequestFlyout } : {})
    })));
    /** A real mouse click; exactly one command leaves the palette, then the app makes it active. */
    const click = async (button: HTMLButtonElement) => {
      const before = rust.routed.length;
      await act(async () => {
        button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      });
      await settle();
      expect(rust.routed.length).toBe(before + 1);
      const routed = rust.routed.at(-1)!;
      expect(routed.sender).toBe(label);
      return routed;
    };
    const face = (flyoutId: string) =>
      container.querySelector<HTMLButtonElement>(`[data-command-flyout-button="${flyoutId}"]`)!;
    const standalone = (commandId: string) =>
      container.querySelector<HTMLButtonElement>(`[data-toolbar-item-id="${commandId}"] > button[data-command-id="${commandId}"]`);
    const openMenu = async (flyoutId: string) =>
      act(async () => face(flyoutId).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const chooseFromMenu = async (flyoutId: string, commandId: string) => {
      await openMenu(flyoutId);
      const entry = container.querySelector<HTMLButtonElement>(
        `[data-command-flyout-menu="${flyoutId}"] [role="menuitem"][data-command-id="${commandId}"]`
      )!;
      expect(entry).not.toBeNull();
      return click(entry);
    };
    return { container, onInvoke, onInvokeToolChoice, onRequestFlyout, render, click, face, standalone, openMenu, chooseFromMenu };
  }

  it("never moves a highlight for an align action chosen from a native flyout", async () => {
    const main = palette("core.main", "toolset-core-main", { native: true });
    const structure = palette("core.structure", "toolset-core-structure", { native: true });
    await main.render("tool.select");
    await structure.render("tool.select");
    const dashed = await main.click(main.standalone("tool.dashedBond")!);
    expect(dashed).toMatchObject({ commandId: "tool.dashedBond", toolChoice: { itemId: "tool.dashedBond" } });
    expect(main.onInvoke).not.toHaveBeenCalled();
    await main.render("tool.dashedBond");
    await structure.render("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(pressed(structure.container)).toEqual([]);

    // Align from the main toolbar's native flyout.
    const align = main.face("align");
    const alignFace = align.getAttribute("data-command-id");
    await main.openMenu("align");
    expect(main.onRequestFlyout).toHaveBeenCalledTimes(1);
    const flyout = main.onRequestFlyout.mock.calls[0]![0].flyout;
    expect(flyout.flyoutId).toBe("align");
    const popover = mount();
    await act(async () => popover.root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true, platform })));
    await act(async () => native.content?.({ toolsetId: "core.main", kind: "flyout", flyout }));
    const entry = popover.container.querySelector<HTMLButtonElement>('[role="menu"] [data-command-id="layout.alignCenter"]')!;
    expect(entry).not.toBeNull();
    rust.sender = "toolset-popover-core-main";
    const delivered = rust.delivered.length;
    await act(async () => entry.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    await settle();

    // The command is sent once, with its opening and no claim, so Rust tells no toolbar anything.
    const routed = rust.routed.filter(command => command.commandId === "layout.alignCenter");
    expect(routed).toHaveLength(1);
    expect(routed[0]!.flyoutOpening).toMatchObject({ toolsetId: "core.main", flyoutId: "align" });
    expect(routed[0]).not.toHaveProperty("toolChoice", expect.anything());
    expect(rust.delivered).toHaveLength(delivered);
    // Align is an action, not a tool: the active tool and every highlight stay where they were.
    await main.render("tool.dashedBond");
    await structure.render("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(main.standalone("tool.dashedBond")!.getAttribute("aria-pressed")).toBe("true");
    expect(pressed(structure.container)).toEqual([]);
    expect(align.getAttribute("data-command-id")).toBe(alignFace);

    // Even an action that did arrive as a choice is dropped by every toolbar.
    await act(async () => window.dispatchEvent(new CustomEvent(TOOLBAR_TOOL_CHOICE_EVENT, {
      detail: { toolsetId: "core.main", flyoutId: "align", commandId: "layout.alignCenter" }
    })));
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(pressed(structure.container)).toEqual([]);
  });

  it("ignores a plugin toolbar's claim on a core toolbar's dropdown, over the event bus or with its command", async () => {
    tauriHost.__TAURI_INTERNALS__ = {};
    const structure = palette("core.structure", "toolset-core-structure", { native: true });
    await structure.render("tool.select");
    const bond = structure.face("bond-tools");
    expect(bond.getAttribute("data-command-id")).toBe("tool.bond");
    const forged = { toolsetId: "core.structure", flyoutId: "bond-tools", commandId: "tool.wedgeBond" };

    // 1. The event bus, which every toolset window may emit on, under both event names.
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => {
      await emit("chemdraft://toolbar-tool-choice", forged);
      await emit(TOOLBAR_TOOL_CHOICE_EVENT, forged);
    });
    expect(bus.handlers.get("chemdraft://toolbar-tool-choice")?.size ?? 0).toBe(0);
    expect(bus.handlers.get(TOOLBAR_TOOL_CHOICE_EVENT)?.size ?? 0).toBe(0);

    // 2. The plugin toolbar's own route: it sends the tool with a claim smuggling a core toolset id.
    rust.sender = "toolset-plugin-fixture";
    await act(async () => {
      await sendPaletteCommand("tool.wedgeBond", {
        toolChoice: { ...forged, itemId: "tool.bond" } as ToolbarToolChoiceClaim
      });
    });
    expect(rust.delivered.at(-1)).toMatchObject({ toolsetId: "plugin.fixture", commandId: "tool.wedgeBond" });

    // The document makes Wedge active: the structure toolbar's bond dropdown kept its own variant and
    // was not lit, because the tool was chosen on another toolbar.
    await structure.render("tool.wedgeBond");
    expect(bond.getAttribute("data-command-id")).toBe("tool.bond");
    expect(bond.getAttribute("aria-pressed")).toBeNull();
    expect(pressed(structure.container)).toEqual([]);

    // A palette's own claim never names a toolbar either.
    const routed = await structure.click(structure.face("bond-tools"));
    expect(Object.keys(routed.toolChoice ?? {}).sort()).toEqual(["itemId"]);
  });

  it("ignores a delayed echo of its own choice after a shortcut changed the tool", async () => {
    tauriHost.__TAURI_INTERNALS__ = {};
    const main = palette("core.main", "toolset-core-main");
    await main.render("tool.select");
    const bond = main.face("bond-tools");
    const routed = await main.chooseFromMenu("bond-tools", "tool.dashedBond");
    expect(routed).toMatchObject({ commandId: "tool.dashedBond", toolChoice: { flyoutId: "bond-tools" } });
    expect(main.onInvoke).not.toHaveBeenCalled();
    const echo = rust.delivered.at(-1);
    expect(echo).toMatchObject({ toolsetId: "core.main", commandId: "tool.dashedBond", flyoutId: "bond-tools" });
    await main.render("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(bond.getAttribute("aria-pressed")).toBe("true");

    // A shortcut picks Select; then the choice comes back late, by DOM and by the event bus.
    await main.render("tool.select");
    expect(pressed(main.container)).toEqual(["tool.select"]);
    expect(bond.getAttribute("aria-pressed")).toBeNull();
    const { emit } = await import("@tauri-apps/api/event");
    await act(async () => {
      window.dispatchEvent(new CustomEvent(TOOLBAR_TOOL_CHOICE_EVENT, { detail: echo }));
      await emit("chemdraft://toolbar-tool-choice", echo);
    });

    // A shortcut returns to Dashed: nothing was pressed this time, so the separate Dashed button shows
    // it, not the dropdown the stale echo named.
    await main.render("tool.dashedBond");
    expect(pressed(main.container)).toEqual(["tool.dashedBond"]);
    expect(main.standalone("tool.dashedBond")!.getAttribute("aria-pressed")).toBe("true");
    expect(bond.getAttribute("aria-pressed")).toBeNull();
    expect(bond.getAttribute("data-command-id")).toBe("tool.dashedBond");
  });
});
