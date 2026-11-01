// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { installPaletteInputFocusLease, installPluginPanelInputFocus, type NativePanelFocusEvent } from "./pluginPanelInputFocus";
import type { CommandSpec } from "../commands";

const { invoke, commands } = vi.hoisted(() => ({
  invoke: vi.fn(),
  commands: { notify: undefined as ((commands: CommandSpec[]) => void) | undefined, stop: vi.fn() }
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../palettePendingKeys", async original => ({
  ...await original<typeof import("../palettePendingKeys")>(), listenPaletteClickPending: async () => () => undefined
}));
vi.mock("../window-manager", () => ({
  isDesktopRuntime: () => true,
  TOOLSET_COMMAND_SPECS_REQUEST_EVENT: "chemdraft://toolset-command-specs-request",
  listenForToolsetCommandSpecs: async (listener: (value: CommandSpec[]) => void) => {
    commands.notify = listener;
    return commands.stop;
  }
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

it("registers once per page and sends its token with acquisitions and releases across reinstalls", async () => {
  let register!: (token: string) => void;
  const token = new Promise<string>((resolve) => { register = resolve; });
  invoke.mockImplementation(async (command: string, args?: { editing: boolean }) =>
    command === "register_plugin_panel_input_focus" ? token : args?.editing);
  const shell = document.createElement("aside");
  shell.innerHTML = "<input>";
  document.body.append(shell);
  const listen = vi.spyOn(shell, "addEventListener");
  let nativeFocus!: (event: NativePanelFocusEvent) => void;
  const subscribe = async (listener: typeof nativeFocus) => {
    nativeFocus = listener;
    return () => undefined;
  };
  let cleanup = installPaletteInputFocusLease(shell, undefined, "windows", subscribe);
  try {
    const press = () => {
      const handler = listen.mock.calls.filter(([type]) => type === "pointerdown").at(-1)![1] as EventListener;
      handler({ target: shell.querySelector("input"), button: 0, isTrusted: true } as unknown as Event);
    };
    await flush();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("register_plugin_panel_input_focus");
    press();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1); // No request may precede registration.
    register("opaque-page-token");
    await flush();
    // Round-2 IPC includes click metadata. Only pointer classification supplies
    // pointerBefore; a keyboard release must not timestamp-clear a newer click.
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: true, generation: expect.any(Number), pageToken: "opaque-page-token",
      clickSequence: undefined, pointerBefore: expect.any(Number), returnFocus: false
    });
    shell.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: false, generation: expect.any(Number), pageToken: "opaque-page-token",
      clickSequence: undefined, pointerBefore: undefined, returnFocus: true
    });
    cleanup();
    cleanup = installPaletteInputFocusLease(shell, undefined, "windows", subscribe);
    press();
    await flush();
    expect(invoke.mock.calls.filter(([command]) => command === "register_plugin_panel_input_focus")).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: true, generation: expect.any(Number), pageToken: "opaque-page-token",
      clickSequence: undefined, pointerBefore: expect.any(Number), returnFocus: false
    });
    // Unlike Escape, native focus loss must release the lease without taking focus
    // back from the user's new destination. The page token still authenticates it.
    const generation = invoke.mock.calls.at(-1)![1]!.generation;
    nativeFocus({ kind: "deactivated", generation });
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: false, generation: expect.any(Number), pageToken: "opaque-page-token",
      clickSequence: undefined, pointerBefore: undefined, returnFocus: false
    });
  } finally {
    cleanup();
    await flush();
    shell.remove();
    vi.restoreAllMocks();
  }
});

it.each(["macos", "windows"] as const)("forwards shortcuts from the live host catalog through native IPC on %s", async (platform) => {
  invoke.mockClear();
  commands.stop.mockClear();
  invoke.mockResolvedValue(undefined);
  const shell = document.createElement("aside");
  shell.innerHTML = "<button>Action</button>";
  document.body.append(shell);
  const listen = vi.spyOn(shell, "addEventListener");
  const cleanup = installPluginPanelInputFocus(shell, async (active) => active, platform, async () => () => undefined);
  try {
    await flush();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_panel_event_forward", {
      event: "chemdraft://toolset-command-specs-request", payload: {}
    });
    const undo: CommandSpec = { id: "edit.undo", title: "Undo", icon: "undo", shortcut: "CmdOrCtrl+Z" };
    commands.notify!([undo]);
    const handler = listen.mock.calls.find(([type]) => type === "keydown")![1] as EventListener;
    const pressUndo = () => handler({
      target: shell.querySelector("button"), key: "z", isTrusted: true,
      metaKey: platform === "macos", ctrlKey: platform === "windows", preventDefault: vi.fn()
    } as unknown as Event);
    pressUndo();
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("plugin_panel_event_forward", {
      event: "chemdraft://plugin-panel-shortcut", payload: { commandId: "edit.undo", key: "z", metaKey: platform === "macos", ctrlKey: platform === "windows", altKey: false }
    });
    commands.notify!([{ ...undo, enabled: false }]);
    pressUndo();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    const ring: CommandSpec = { id: "atom.attachRingToHoveredAtom.cyclopropane", title: "Attach ring", icon: "ring", shortcut: "3" };
    commands.notify!([ring]);
    handler({ target: shell.querySelector("button"), key: "3", isTrusted: true,
      metaKey: false, ctrlKey: false, altKey: false, preventDefault: vi.fn() } as unknown as Event);
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("plugin_panel_event_forward", {
      event: "chemdraft://plugin-panel-shortcut", payload: { commandId: ring.id, key: "3", metaKey: false, ctrlKey: false, altKey: false }
    });
  } finally {
    cleanup();
    await flush();
    expect(commands.stop).toHaveBeenCalledOnce();
    shell.remove();
    listen.mockRestore();
  }
});
