// @vitest-environment jsdom

// Off the desktop runtime there are no native palette windows to open. A caller that forces native
// palettes there (every DOM test that mounts MainWindow with `nativePalette: true`) used to start the
// native reconcile anyway: it retried for about 0.4 s, then switched to in-window toolbars and posted
// "Native toolset windows unavailable", overwriting whatever the status line said at that moment.
// Under full-suite load that landed mid-test (the unknownBondOrder Spin-flatten flake).

import "@tauri-apps/api/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("native palettes forced off the desktop runtime", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: createPhase4Document("Off desktop"),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";

  it("never posts the native-window fallback status, so a later status line stays put", async () => {
    expect((globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__).toBeUndefined();
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("document.new"); });
    const posted = status();
    expect(posted).toContain("Blank native document");
    // Well past the reconcile's whole retry window (3 attempts, 200 ms apart), letting each
    // attempt's promise chain settle between timer ticks.
    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
    expect(status()).toBe(posted);
    expect(status()).not.toContain("Native toolset windows unavailable");
  });
});
