// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { installPluginPanelInputFocus, type NativePanelFocusEvent } from "./pluginPanelInputFocus";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../window-manager", () => ({ isDesktopRuntime: () => true }));

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
  let cleanup = installPluginPanelInputFocus(shell, undefined, "windows", subscribe);
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
    cleanup = installPluginPanelInputFocus(shell, undefined, "windows", subscribe);
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
