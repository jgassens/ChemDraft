// @vitest-environment jsdom

import { molscribeOcsrCommandId, molscribeOcsrManifest } from "@chemdraft/molscribe-ocsr-plugin";
import { massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
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
  it("opens the core plugin manager from the Plugins menu", async () => {
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

    expect(container.querySelectorAll('[role="menubar"]')).toHaveLength(1);
    expect(container.querySelector("[data-dev-browser-menu-bar]")).toBeNull();

    await click(container.querySelector('button[data-menu-section="plugins"]')!);
    const manageItem = container.querySelector<HTMLButtonElement>('button[data-command-id="plugins.manage"]');
    expect(manageItem?.textContent).toContain("Add or Remove Plugins");
    await click(manageItem!);

    const dialog = document.querySelector('[data-testid="plugin-manager-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(`[data-plugin-id="${massFragmentManifest.id}"]`)).not.toBeNull();
    expect(dialog?.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')?.disabled).toBe(true);
    expect(dialog?.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')?.disabled).toBe(true);

    await click(dialog!.querySelector<HTMLButtonElement>(".plugin-manager-header .plugin-manager-button")!);
    expect(document.querySelector('[data-testid="plugin-manager-dialog"]')).toBeNull();
  });

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

    expect(document.title).toBe("ChemDraft — test");

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

  it("registers the mass analyzer in Analyze and lists it in diagnostics — and no NMR item exists anywhere (M39)", async () => {
    installDomMocks();
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container!);
      root.render(
        createElement(MainWindow, { initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false })
      );
      await Promise.resolve();
    });

    await click(container.querySelector('button[data-menu-section="analyze"]')!);
    const massItem = container.querySelector<HTMLButtonElement>(`button[data-command-id="${massAnalyzeCommandId}"]`);
    expect(massItem?.textContent).toContain("Analyze Mass / m/z");

    // Core-only build: the open Analyze menu offers no NMR item by command id or label. NMR features
    // can only arrive through the plugin installer (Phase 4).
    const analyzeItems = [...container.querySelectorAll<HTMLButtonElement>("button[data-command-id]")];
    expect(analyzeItems.length).toBeGreaterThan(0);
    expect(analyzeItems.some((item) => /nmr/i.test(item.dataset.commandId ?? "") || /nmr/i.test(item.textContent ?? ""))).toBe(false);

    // Invoking with nothing selected must not crash or open a panel (it returns ok:false).
    await click(massItem!);
    expect(container.querySelector('[data-testid="plugin-panel"]')).toBeNull();

    // The plugin is registered and listed in the bundled-plugin diagnostics — where no NMR plugin appears.
    await click(container.querySelector('button[data-menu-section="analyze"]')!);
    await click(container.querySelector<HTMLButtonElement>('button[data-command-id="plugin.runtime.showDiagnostics"]')!);
    expect(container.querySelector(`[data-plugin-id="${massFragmentManifest.id}"]`)).not.toBeNull();
    expect(container.textContent).toContain(massFragmentManifest.name);
    expect([...container.querySelectorAll("[data-plugin-id]")].some((node) => /nmr/i.test(node.getAttribute("data-plugin-id") ?? ""))).toBe(false);
  });
});
