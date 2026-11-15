// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const modules = vi.hoisted(() => ({ main: vi.fn(), forward: vi.fn(), runtime: vi.fn(), editHistory: vi.fn() }));
vi.mock("../MainWindow", () => { modules.main(); return { MainWindow: () => null }; });
vi.mock("./createPluginRuntime", () => ({ createPluginRuntime: modules.runtime }));
vi.mock("../editHistoryRouting", () => ({ installSecondaryWindowEditHistory: modules.editHistory }));
vi.mock("../window-manager", () => ({ routeToolsetCommand: modules.forward,
  PREFERENCES_WINDOW_KIND: "preferences", TOOLSET_POPOVER_WINDOW_KIND: "toolsetPopover", TOOLSET_TOOLTIP_WINDOW_KIND: "toolsetTooltip" }));
import { App, isRuntimeHostRoute } from "../App";
afterEach(() => { window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });
it("keeps the hidden runtime route inert without loading MainWindow, constructing another runtime or forwarding document history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/?window=runtime");
  expect(isRuntimeHostRoute()).toBe(true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(App)); });
    expect(container.innerHTML).toBe("");
    expect(modules.main).not.toHaveBeenCalled();
    expect(modules.runtime).not.toHaveBeenCalled();
    expect(modules.editHistory).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent("chemdraft:native-command", { detail: { commandId: "edit.undo" } }));
    expect(modules.forward).not.toHaveBeenCalled();
    for (const path of ["/", "/?window=runtime-other", "/?window=toolset", "/?window=dialog&hostId=runtime"]) {
      window.history.replaceState(null, "", path); expect(isRuntimeHostRoute()).toBe(false);
    }
  } finally { act(() => root.unmount()); container.remove(); }
});
