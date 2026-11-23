// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { toolsetUsesResizableWindow } from "./toolsets";

vi.mock("./window-manager/tauriEvents", async (original) => ({
  ...await original<typeof import("./window-manager/tauriEvents")>(),
  listenTauriEvent: async () => () => {},
  listenCurrentWindowEvent: async () => () => {}
}));

let styles: HTMLStyleElement;
beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
  document.head.append(styles);
});
afterAll(() => styles.remove());

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["macos", "windows"] as const)(
  "fits Rings on open and reopen and caps scrolling to the %s work area",
  async (platform) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const toolsetId = "core.ringInspector";
    const legacySize = { width: 780, height: 620 };
    const content = { width: 338.5, bodyHeight: 178.5 };
    const titleHeight = 22;
    let frame = legacySize;
    let workAreaHeight = 560;
    const invoke = vi.fn((command: string, payload: unknown) => {
      if (command === "current_window_logical_work_area") {
        return { left: 0, top: 24, right: 960, bottom: 24 + workAreaHeight };
      }
      if (command === "resize_toolset_window") {
        frame = payload as typeof legacySize;
        return true;
      }
    });
    mockIPC(invoke);
    vi.spyOn(window, "innerWidth", "get").mockImplementation(() => frame.width);
    vi.spyOn(window, "innerHeight", "get").mockImplementation(() => frame.height);
    // JSDOM cannot lay out the shell. Model the intrinsic size with the body cap the effect applies.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const body = this.querySelector<HTMLElement>(".palette-window-content");
      if (!body) return new DOMRect();
      const cap = parseFloat(body.style.maxHeight);
      return new DOMRect(0, 0, content.width, titleHeight + Math.min(content.bodyHeight, cap));
    });

    const open = async (expectedHeight: number) => {
      frame = legacySize; // The legacy native frame is larger than the webview's content.
      invoke.mockClear();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<PaletteWindow
          toolsetId={toolsetId}
          resizable={toolsetUsesResizableWindow(toolsetId)}
          platform={platform}
        />));
        expect(container.querySelector('[role="group"][aria-label="Ring fill color"]')).not.toBeNull();
        const shell = container.querySelector<HTMLElement>(".palette-window-shell")!;
        expect(shell.hasAttribute("data-resizable")).toBe(false);
        const shellStyle = getComputedStyle(shell);
        expect([shellStyle.width, shellStyle.height]).toEqual(["max-content", "max-content"]);
        const body = shell.querySelector<HTMLElement>(".palette-window-content")!;
        const controls = body.querySelector<HTMLElement>(".ring-inspector-controls")!;
        expect(getComputedStyle(controls).maxHeight).toBe("none");
        expect(getComputedStyle(body).overflowY).toBe("auto");
        expect(body.style.maxHeight).toBe(`${workAreaHeight - titleHeight}px`);
        expect(invoke).toHaveBeenCalledWith("resize_toolset_window", { width: 339, height: expectedHeight });
        expect([window.innerWidth, window.innerHeight]).toEqual([339, expectedHeight]);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    };

    await open(201);
    await open(201);
    workAreaHeight = 130;
    await open(130);
  }
);
