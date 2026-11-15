// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PluginCanvasOverlayContributionSchema } from "@chemdraft/plugin-api";
import { PluginCanvasOverlay } from "./PluginCanvasOverlay";
import { MemoryStorage } from "../testSupport/memoryStorage";

it("remembers the same overlay separately in two windows, and keeps the main storage key", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  window.localStorage.clear();
  const overlay = PluginCanvasOverlayContributionSchema.parse({ id: "overlay.test.prompt", title: "Assistant",
    icon: "data:image/png;base64,AA==", commandId: "plugin.test.send", prompt: { kind: "prompt", id: "prompt", commandId: "plugin.test.send", maxLength: 100 } });
  const container = document.createElement("div");
  document.body.append(container);
  const viewport = createRef<HTMLElement>(); viewport.current = container;
  Object.defineProperty(container, "clientWidth", { value: 1000 });
  Object.defineProperty(container, "clientHeight", { value: 800 });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) });
  const keys = ["main", "doc-b"].map(windowId => `chemdraft:canvas-overlay:${windowId}:${overlay.id}`);
  window.localStorage.setItem(`${keys[0]}:collapsed`, JSON.stringify({ version: 1, userPlaced: true, x: 100, y: 120 }));
  window.localStorage.setItem(`${keys[1]}:collapsed`, JSON.stringify({ version: 1, userPlaced: true, x: 250, y: 300 }));
  window.localStorage.setItem(`${keys[0]}:height`, "250");
  window.localStorage.setItem(`${keys[1]}:height`, "350");
  const root = createRoot(container);
  const render = (gesture = false) => act(async () => root.render(<>{["main", "doc-b"].map(windowId =>
    <PluginCanvasOverlay key={windowId} windowId={windowId} overlay={overlay} viewportRef={viewport}
      gestureActive={gesture} onAction={async () => ({ ok: true })} onFocusDrawing={() => {}} />)}</>));
  try {
    await render();
    let widgets = [...container.querySelectorAll<HTMLElement>(".plugin-canvas-overlay")];
    expect(widgets.map(widget => [widget.style.left, widget.style.top])).toEqual([["100px", "120px"], ["250px", "300px"]]);
    await act(async () => widgets[0]!.querySelector<HTMLButtonElement>(".plugin-canvas-overlay-icon")!.click());
    expect(widgets[0]!.dataset.expanded).toBe("true");
    expect(widgets[1]!.dataset.expanded).toBe("false");
    expect(window.localStorage.getItem(`${keys[0]}:height`)).toBe("250");
    expect(window.localStorage.getItem(`${keys[1]}:height`)).toBe("350");
    await render(true);
    widgets = [...container.querySelectorAll<HTMLElement>(".plugin-canvas-overlay")];
    expect(widgets.every(widget => widget.hidden)).toBe(true);
  } finally {
    await act(async () => root.unmount()); container.remove(); window.localStorage.clear();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
