// @vitest-environment jsdom

import { molscribeOcsrCommandId, molscribeOcsrManifest } from "@chemdraft/molscribe-ocsr-plugin";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MainWindow } from "../MainWindow";

function installDomMocks(): void {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  window.requestAnimationFrame ??= frame;
  window.cancelAnimationFrame ??= (handle: number) => window.clearTimeout(handle);
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??= TestResizeObserver as typeof ResizeObserver;
  globalThis.ResizeObserver ??= TestResizeObserver as typeof ResizeObserver;
  const prototype = window.HTMLElement.prototype as HTMLElement & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
  };
  prototype.setPointerCapture ??= vi.fn();
  prototype.releasePointerCapture ??= vi.fn();
  prototype.hasPointerCapture ??= vi.fn(() => true);
}

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = "";
});

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("MainWindow bundled plugin integration", () => {
  it("routes an Analyze menu contribution through PluginHost and opens its rendered panel", async () => {
    installDomMocks();
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container!);
      root.render(
        createElement(MainWindow, {
          initialPaletteMode: "hidden",
          initialRulersVisible: false,
          nativePalette: false
        })
      );
      await Promise.resolve();
    });

    // The bundled plugin's Analyze contribution is present in the (web) menu bar.
    const analyzeButton = container.querySelector<HTMLButtonElement>('button[data-menu-section="analyze"]');
    expect(analyzeButton).not.toBeNull();
    await click(analyzeButton!);

    const menuItem = container.querySelector<HTMLButtonElement>(
      `button[data-command-id="${molscribeOcsrCommandId}"]`
    );
    expect(menuItem).not.toBeNull();
    expect(menuItem!.textContent).toContain("Recognize Structure from Image");

    // No plugin panel before the command runs.
    expect(container.querySelector('[data-testid="plugin-panel"]')).toBeNull();

    // Selecting it invokes the command through the host, which pushes a report the desktop renders.
    await click(menuItem!);

    const panel = container.querySelector('[data-testid="plugin-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("data-panel-id")).toBe("panel.molscribeOcsr.review");
    expect(container.textContent).toContain("MolScribe OCSR (runtime canary)");
    expect(container.textContent).toContain("Runtime path");

    // The panel closes cleanly.
    const closeButton = panel!.querySelector<HTMLButtonElement>(".plugin-panel-close");
    expect(closeButton).not.toBeNull();
    await click(closeButton!);
    expect(container.querySelector('[data-testid="plugin-panel"]')).toBeNull();
  });

  it("opens the bundled-plugin diagnostics view from the Analyze menu", async () => {
    installDomMocks();
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container!);
      root.render(
        createElement(MainWindow, {
          initialPaletteMode: "hidden",
          initialRulersVisible: false,
          nativePalette: false
        })
      );
      await Promise.resolve();
    });

    await click(container.querySelector('button[data-menu-section="analyze"]')!);
    const diagnosticsItem = container.querySelector<HTMLButtonElement>(
      'button[data-command-id="plugin.runtime.showDiagnostics"]'
    );
    expect(diagnosticsItem).not.toBeNull();
    await click(diagnosticsItem!);

    const diagnostics = container.querySelector('[data-testid="plugin-diagnostics"]');
    expect(diagnostics).not.toBeNull();
    expect(container.querySelector(`[data-plugin-id="${molscribeOcsrManifest.id}"]`)).not.toBeNull();
    expect(container.textContent).toContain(molscribeOcsrManifest.name);
  });
});
