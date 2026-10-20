// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const modules = vi.hoisted(() => ({ main: vi.fn(), dialog: vi.fn(), forward: vi.fn() }));
vi.mock("../MainWindow", () => { modules.main(); return { MainWindow: () => null }; });
vi.mock("./DialogWindow", () => ({ DialogWindow: ({ hostId }: { hostId: string }) => { modules.dialog(hostId); return createElement("input", { autoFocus: true }); } }));
vi.mock("../window-manager", () => ({ routeToolsetCommand: modules.forward, PREFERENCES_WINDOW_KIND: "preferences", TOOLSET_POPOVER_WINDOW_KIND: "toolsetPopover", TOOLSET_TOOLTIP_WINDOW_KIND: "toolsetTooltip", DOM_COMMAND_EVENT: "chemdraft:native-command" }));
import { App } from "../App";
afterEach(() => { window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });
it("renders the dialog route without loading MainWindow and keeps edit history local", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/?window=dialog&hostId=opaque");
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(App)); });
    expect(modules.dialog).toHaveBeenCalledWith("opaque"); expect(modules.main).not.toHaveBeenCalled();
    const undo = vi.fn(); Object.defineProperty(document, "execCommand", { configurable: true, value: undo });
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: "edit.undo" } }));
    expect(undo).toHaveBeenCalledWith("undo");
    (document.activeElement as HTMLElement).blur();
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: "edit.undo" } }));
    expect(modules.forward).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); }
});
