// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { installPluginPanelInputFocus } from "./pluginPanelInputFocus";
import type { CommandSpec } from "../commands";

const { invoke, commands } = vi.hoisted(() => ({
  invoke: vi.fn(),
  commands: { notify: undefined as ((commands: CommandSpec[]) => void) | undefined, stop: vi.fn() }
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
  const subscribe = async () => () => undefined;
  const shortcuts = { resolve: () => undefined, forward: () => undefined };
  let cleanup = installPluginPanelInputFocus(shell, undefined, "windows", subscribe, shortcuts);
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
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: true, generation: expect.any(Number), pageToken: "opaque-page-token"
    });
    const firstGeneration = invoke.mock.calls.at(-1)![1].generation;
    press();
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: true, generation: expect.any(Number), pageToken: "opaque-page-token"
    });
    expect(invoke.mock.calls.at(-1)![1].generation).toBeGreaterThan(firstGeneration);
    expect(invoke.mock.calls.filter(([command]) => command === "register_plugin_panel_input_focus")).toHaveLength(1);
    shell.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: true, generation: expect.any(Number), pageToken: "opaque-page-token"
    });
    cleanup();
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: false, generation: expect.any(Number), pageToken: "opaque-page-token"
    });
    cleanup = installPluginPanelInputFocus(shell, undefined, "windows", subscribe, shortcuts);
    press();
    await flush();
    expect(invoke.mock.calls.filter(([command]) => command === "register_plugin_panel_input_focus")).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith("set_plugin_panel_input_focus", {
      editing: true, generation: expect.any(Number), pageToken: "opaque-page-token"
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
      event: "chemdraft://plugin-panel-shortcut", payload: { commandId: "edit.undo" }
    });
    commands.notify!([{ ...undo, enabled: false }]);
    pressUndo();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    await flush();
    expect(commands.stop).toHaveBeenCalledOnce();
    shell.remove();
    listen.mockRestore();
  }
});
