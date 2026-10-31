// @vitest-environment jsdom

import { massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { MainWindow } from "../MainWindow";
import { ANALYSIS_WINDOW_ACTION_EVENT, type AnalysisWindowAction } from "./panelBridge";
import * as panelBridge from "./panelBridge";
import * as spectrumExport from "./spectrumExport";
import * as clipboard from "../clipboard";
import {
  RECOGNITION_FIXTURE_COMMAND_ID,
  RECOGNITION_FIXTURE_PLUGIN_ID,
  RECOGNITION_FIXTURE_PANEL_ID
} from "../testSupport/recognitionFixturePlugin";
import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { namingInstalled, namingManifest, namingMolecule } from "./structureNamingTestFixtures";
import { getAssistantHistoryPort } from "../assistant/historyPort";
import { selectionBounds } from "../documentWorkflow";

// No recognizer ships with the app, so a test that needs a panel-opening Analyze contribution opts in
// to the test-only recognition fixture, standing in for an installed plugin.
const bundled = vi.hoisted(() => ({
  withRecognitionFixture: false,
  withNamingFixture: false,
  namingNotInstalled: false,
  namingResult: undefined as unknown,
  runtime: undefined as DesktopPluginRuntime | undefined,
  massAnalyzerHandler: undefined as undefined | (() => unknown)
}));
const nativeDialog = vi.hoisted(() => ({
  desktop: false,
  snapshot: undefined as import("../dialogs/dialogProtocol").DialogMessage | undefined,
  listener: undefined as undefined | ((delivery: import("../dialogs/dialogTransport").DialogDelivery) => void),
  close: vi.fn(async () => undefined)
}));
vi.mock("../dialogs/dialogTransport", () => ({
  nativeDialogTransport: {
    subscribe: async (handler: typeof nativeDialog.listener) => {
      nativeDialog.listener = handler;
      return () => { if (nativeDialog.listener === handler) nativeDialog.listener = undefined; };
    },
    open: async (snapshot: import("../dialogs/dialogProtocol").DialogMessage) => {
      nativeDialog.snapshot = snapshot;
      return { hostId: "naming-install", windowLabel: `dialog-main-${snapshot.dialogKind}-1` };
    },
    publish: async () => undefined,
    close: nativeDialog.close
  }
}));
vi.mock("../window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("../window-manager")>(),
  isDesktopRuntime: () => nativeDialog.desktop
}));
vi.mock("./registerBundledPlugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registerBundledPlugins")>();
  const { recognitionFixtureDescriptor } = await import("../testSupport/recognitionFixturePlugin");
  return {
    ...actual,
    registerBundledPlugins: (runtime: DesktopPluginRuntime, disabledIds?: ReadonlySet<string>) => {
      if (!bundled.withRecognitionFixture && !bundled.withNamingFixture && !bundled.massAnalyzerHandler) {
        return actual.registerBundledPlugins(runtime, disabledIds);
      }
      const descriptors = actual.createBundledPluginDescriptors().map((descriptor) => {
        const analyzerCommandId = descriptor.manifest.contributes.analyzers[0]?.commandId;
        if (!bundled.massAnalyzerHandler || analyzerCommandId !== massAnalyzeCommandId) return descriptor;
        return {
          ...descriptor,
          options: {
            ...descriptor.options,
            commandHandlers: {
              ...descriptor.options.commandHandlers,
              [analyzerCommandId]: bundled.massAnalyzerHandler
            }
          }
        };
      });
      if (bundled.withRecognitionFixture) descriptors.push(recognitionFixtureDescriptor());
      if (bundled.withNamingFixture) {
        descriptors.push({
          manifest: { ...namingManifest, permissions: [...namingManifest.permissions, "ui.menu"],
            contributes: { ...namingManifest.contributes, menus: [{ id: "menu.namingTest.run", title: "Name Structure Test", commandId: "plugin.namingTest.run", location: "analyze", requiredPermissions: [] }] } },
          options: { commandHandlers: { "plugin.namingTest.run": async context => {
            const result = await context.chemistry!.structureToName!({ objectId: namingMolecule.id });
            bundled.namingResult = result;
            if (result.status === "named") await context.panels!.showReport("panel.namingTest.result", { title: "Name", sections: [{ kind: "chemicalName", label: "Name", name: result.name, kindLabel: result.kindLabel, warnings: result.warnings }] });
          } } }
        });
      }
      actual.applyEnabledPlugins(runtime, disabledIds ?? new Set(), descriptors);
      return descriptors;
    }
  };
});

vi.mock("./createPluginRuntime", async importOriginal => {
  const actual = await importOriginal<typeof import("./createPluginRuntime")>();
  const { fakeNamingEngine } = await import("./structureNamingTestFixtures");
  return { ...actual, createPluginRuntime: (options: import("./createPluginRuntime").DesktopPluginRuntimeOptions) => {
    const runtime = actual.createPluginRuntime(bundled.withNamingFixture ? { ...options,
      structureNamingEngine: fakeNamingEngine(bundled.namingNotInstalled ? { ...namingInstalled, state: "notInstalled" } : undefined),
      namingCanonicalizer: { canonicalize: async () => "CCO", version: "test" } } : options);
    bundled.runtime = runtime;
    return runtime;
  } };
});

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
  bundled.withRecognitionFixture = false;
  bundled.withNamingFixture = false;
  bundled.namingNotInstalled = false;
  bundled.namingResult = undefined;
  bundled.runtime = undefined;
  bundled.massAnalyzerHandler = undefined;
  nativeDialog.desktop = false;
  nativeDialog.snapshot = undefined;
  nativeDialog.listener = undefined;
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  delete (window as Window & { __CHEMDRAFT_AGENT__?: unknown }).__CHEMDRAFT_AGENT__;
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

async function renderMainWindow(): Promise<void> {
  installDomMocks();
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      createElement(MainWindow, {
        initialDocument: createPhase4Document("Analysis Actions"),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: false
      })
    );
    await Promise.resolve();
  });
}

async function sendAnalysisWindowAction(action: AnalysisWindowAction): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: action }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function statusText(): string {
  return container!.querySelector('[role="status"]')?.textContent ?? "";
}

/** Plugin commands settle asynchronously (a queued run, then the plugin's own awaits). */
async function waitForElement(selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const element = container!.querySelector(selector);
    if (element) return element;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function massAnalyzerMenuItem(): Promise<HTMLButtonElement> {
  await click(container!.querySelector('button[data-menu-section="analyze"]')!);
  const item = container!.querySelector<HTMLButtonElement>(`button[data-command-id="${massAnalyzeCommandId}"]`);
  expect(item).not.toBeNull();
  return item!;
}

function deferredResult(): { promise: Promise<unknown>; resolve(result: unknown): void } {
  let resolve!: (result: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MainWindow bundled plugin integration", () => {
  it.each([
    ["MacIntel", true], ["Win32", true], ["MacIntel", false], ["Win32", false]
  ] as const)("preserves in-page batches and places off-page batches with one labelled undo (%s, offPage=%s)", async (platform, offPage) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    window.history.replaceState(null, "", "/?agentBridge=1");
    await renderMainWindow();
    const port = getAssistantHistoryPort();
    const before = port.read("initial")!;
    const page = before.pages[0];
    // Visible page-space region is x=120..520, y=160..460 at scale 1.
    const canvas = container!.querySelector<HTMLElement>(".canvas-region")!;
    const pageElement = container!.querySelector<HTMLElement>(".page")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 } as DOMRect);
    Object.defineProperties(canvas, { clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 300 } });
    vi.spyOn(pageElement, "getBoundingClientRect").mockReturnValue({ left: -120, top: -160,
      right: page.width - 120, bottom: page.height - 160, width: page.width, height: page.height } as DOMRect);
    const bridge = (window as Window & { __CHEMDRAFT_AGENT__?: { command(id: string): Promise<unknown> } }).__CHEMDRAFT_AGENT__!;
    const id = "plugin.batchPlacement.insert";
    const x = offPage ? -50 : 180;
    const y = offPage ? -20 : 200;
    await act(async () => bundled.runtime!.registerPlugin({ id: "org.test.batchPlacement", name: "Batch test", version: "0.0.1",
      apiVersion: "^0.1.16", entry: "index.js", permissions: ["document.write"],
      contributes: { commands: [{ id, title: "Insert complex", requiredPermissions: [] }] } }, {
      commandHandlers: { [id]: context => context.documents.applyPatch!({ reason: "test 3D output", patch: {
        op: "batch", patches: [0, 1].map(index => ({ op: "addObject" as const, pageId: page.id,
          object: { ...namingMolecule, id: `batch_${index}`, x: x + index * 80, y,
            atoms: namingMolecule.atoms.map(atom => ({ ...atom, x: atom.x + x + index * 80, y: atom.y + y })) } }))
      } }) }
    }));
    const afterRuns = [before];
    for (let run = 0; run < 2; run++) {
      await act(async () => { await bundled.runtime!.host.invokeCommand(id); });
      // Let post-insert effects and frames settle; there must be no later recenter commit.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      const after = port.read("initial")!;
      expect(after.pages[0].objects).toHaveLength(before.pages[0].objects.length + (run + 1) * 2);
      expect(after.selection.objectIds).toHaveLength(2);
      const bounds = selectionBounds(after.pages[0].objects, after.selection.objectIds)!;
      if (offPage) {
        expect(bounds.centerX).toBeCloseTo(320);
        expect(bounds.centerY).toBeCloseTo(310);
      }
      expect(bounds.x).toBeGreaterThanOrEqual(120);
      expect(bounds.y).toBeGreaterThanOrEqual(160);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(520);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(460);
      const objects = after.pages[0].objects.filter(object => after.selection.objectIds.includes(object.id));
      expect(objects[1].x - objects[0].x).toBeCloseTo(80);
      if (!offPage) {
        expect(objects.map(object => [object.x, object.y])).toEqual([[x, y], [x + 80, y]]);
        expect(objects.map(object => object.type === "molecule" ? object.atoms : [])).toEqual([0, 1].map(index =>
          namingMolecule.atoms.map(atom => ({ ...atom, x: atom.x + x + index * 80, y: atom.y + y }))));
      }
      afterRuns.push(after);
    }
    for (let run = 1; run >= 0; run--) {
      await act(async () => { await bridge.command("edit.undo"); });
      expect(statusText()).toBe("Undid Batch test: Insert complex");
      expect(port.read("initial")!.pages).toEqual(afterRuns[run].pages);
      expect(port.read("initial")!.selection).toEqual(afterRuns[run].selection);
    }
    await act(async () => { await bridge.command("edit.redo"); });
    expect(statusText()).toBe("Redid Batch test: Insert complex");
    expect(port.read("initial")!.pages).toEqual(afterRuns[1].pages);
  });

  it("drops a detached report across uninstall, reinstall and closing Plugin Manager", async () => {
    const openWindow = vi.spyOn(panelBridge, "openPluginPanelWindow").mockResolvedValue();
    vi.spyOn(panelBridge, "hidePluginPanelWindow").mockResolvedValue();
    const broadcastReport = vi.spyOn(panelBridge, "broadcastPluginPanelReport").mockResolvedValue();
    await renderMainWindow();
    await click(container!.querySelector('button[data-menu-section="plugins"]')!);
    await click(container!.querySelector('button[data-command-id="plugins.manage"]')!);
    const dialog = document.querySelector('[data-testid="plugin-manager-dialog"]')!;
    expect(dialog).not.toBeNull();

    const runtime = bundled.runtime!;
    const manifest = {
      ...namingManifest,
      permissions: [...namingManifest.permissions],
      contributes: namingManifest.contributes
    };
    const identity = { pluginId: manifest.id, panelId: "panel.namingTest.result" };
    nativeDialog.desktop = true;
    await act(async () => {
      runtime.registerPlugin(manifest);
      runtime.panels.showReport(identity.pluginId, identity.panelId, {
        title: "install claude failed: declined", sections: []
      });
      runtime.panels.detachPanel(identity.pluginId, identity.panelId);
    });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(broadcastReport).toHaveBeenCalledTimes(1);
    openWindow.mockClear();
    broadcastReport.mockClear();

    // One React batch: pruning must observe unregister synchronously, before the id exists again.
    await act(async () => {
      runtime.unregisterPlugin(identity.pluginId);
      runtime.registerPlugin(manifest);
      window.dispatchEvent(new CustomEvent(panelBridge.PLUGIN_PANEL_REQUEST_EVENT, { detail: identity }));
    });
    await click(dialog.querySelector(".plugin-manager-header .plugin-manager-button")!);
    expect(document.querySelector('[data-testid="plugin-manager-dialog"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(panelBridge.PLUGIN_PANEL_REQUEST_EVENT, { detail: identity }));
    });
    expect(runtime.panels.getDetachedPanels()).toEqual([]);
    expect(openWindow).not.toHaveBeenCalled();
    expect(broadcastReport).not.toHaveBeenCalled();

    // Only a new showReport from the new registration may open the panel again.
    await act(async () => {
      runtime.panels.showReport(identity.pluginId, identity.panelId, { title: "Fresh report", sections: [] });
      runtime.panels.detachPanel(identity.pluginId, identity.panelId);
    });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(broadcastReport).toHaveBeenCalledWith(expect.objectContaining({
      report: { title: "Fresh report", sections: [] }
    }));
  });

  it("runs Orthonym's existing insert command from Structure and hides it on removal", async () => {
    await renderMainWindow();
    const commandId = "plugin.orthonymNaming.insertName";
    const handler = vi.fn(async () => undefined);
    await act(async () => {
      bundled.runtime!.registerPlugin({
        ...namingManifest,
        id: "org.chemdraft.orthonym-naming",
        permissions: ["ui.menu"],
        contributes: {
          ...namingManifest.contributes,
          panels: [],
          commands: [{ id: commandId, title: "Insert Name", requiredPermissions: [], enabled: true }],
          menus: [{ id: "menu.orthonymNaming.insertName", title: "Insert Name", commandId, location: "analyze", requiredPermissions: [] }]
        }
      }, { commandHandlers: { [commandId]: handler } });
    });
    await click(container!.querySelector('button[data-menu-section="structure"]')!);
    const item = container!.querySelector(`button[data-command-id="${commandId}"]`)!;
    expect(item.textContent).toContain("Convert Structure to Name");
    await click(item);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await click(container!.querySelector('button[data-menu-section="analyze"]')!);
    expect(container!.querySelector(`button[data-command-id="${commandId}"]`)?.textContent).toContain("Insert Name");
    await act(async () => { bundled.runtime!.unregisterPlugin("org.chemdraft.orthonym-naming"); });
    await click(container!.querySelector('button[data-menu-section="structure"]')!);
    expect(container!.querySelector(`button[data-command-id="${commandId}"]`)).toBeNull();
  });

  it("routes a named result through the plugin command and chemicalName renderer", async () => {
    bundled.withNamingFixture = true;
    installDomMocks();
    container = document.createElement("div");
    document.body.append(container);
    const drawing = createPhase4Document();
    drawing.pages[0]!.objects = [namingMolecule];
    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(MainWindow, { initialDocument: drawing, initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false }));
    });
    await click(container.querySelector('button[data-menu-section="analyze"]')!);
    await click(container.querySelector('button[data-command-id="plugin.namingTest.run"]')!);
    const name = await waitForElement(".plugin-report-chemical-name pre");
    expect(name.textContent).toBe("ethanol");
    expect(container.textContent).toContain("Preferred IUPAC name");
  });

  it("opens a native naming install dialog for the active tab without recreating the plugin runtime", async () => {
    bundled.withNamingFixture = true;
    bundled.namingNotInstalled = true;
    nativeDialog.desktop = true;
    installDomMocks();
    container = document.createElement("div");
    document.body.append(container);
    const drawing = createPhase4Document();
    drawing.pages[0]!.objects = [namingMolecule];
    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(MainWindow, { initialDocument: drawing, initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false }));
    });
    const runtime = bundled.runtime;
    expect(runtime).toBeDefined();

    await click(container.querySelector<HTMLButtonElement>(".document-tab-new")!);
    await click(container.querySelector<HTMLButtonElement>('[role="tab"]')!);
    expect(bundled.runtime).toBe(runtime);

    const invocation = runtime!.invokeCommand("plugin.namingTest.run");
    await vi.waitFor(() => expect(nativeDialog.snapshot?.dialogKind).toBe("engineInstall"));
    expect(nativeDialog.snapshot?.documentTabId).toBe("initial");
    expect(document.querySelector(".structure-naming-host section")).toBeNull();
    expect(bundled.namingResult).toBeUndefined();

    await act(async () => {
      nativeDialog.listener!({ senderWindowId: "main", windowLabel: "dialog-main-engineInstall-1", message: {
        ...nativeDialog.snapshot!, type: "closed", data: { reason: "close" }
      } });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(bundled.namingResult).toEqual({ status: "engineNotInstalled" }));
    await invocation;
  });

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

  it("shows no image-recognition item until the MolScribe plugin is installed", async () => {
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
    const items = [...container.querySelectorAll<HTMLButtonElement>("button[data-command-id]")];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => /molscribe/i.test(item.dataset.commandId ?? ""))).toBe(false);
    expect(items.some((item) => /Recognize Structure from Image/.test(item.textContent ?? ""))).toBe(false);
  });

  it("routes an Analyze menu contribution through PluginHost and opens its rendered panel", async () => {
    bundled.withRecognitionFixture = true;
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

    expect(document.title).toBe("Untitled — ChemDraft — test");

    // The plugin's Analyze contribution is present in the (web) menu bar.
    const analyzeButton = container.querySelector<HTMLButtonElement>('button[data-menu-section="analyze"]');
    expect(analyzeButton).not.toBeNull();
    await click(analyzeButton!);

    const menuItem = container.querySelector<HTMLButtonElement>(
      `button[data-command-id="${RECOGNITION_FIXTURE_COMMAND_ID}"]`
    );
    expect(menuItem).not.toBeNull();
    expect(menuItem!.textContent).toContain("Recognize Fixture Image");

    // No plugin panel before the command runs.
    expect(container.querySelector('[data-testid="plugin-panel"]')).toBeNull();

    // The browser test has no native image providers, so the host-owned request dialog explains that
    // honestly. Closing it returns `unavailable`; the plugin reports that state without fake chemistry.
    await click(menuItem!);
    await vi.waitFor(() => expect(document.querySelector(".plugin-image-dialog")).not.toBeNull());
    expect(document.querySelector('.plugin-image-dialog [role="alert"]')?.textContent).toContain(
      "None of the requested image sources"
    );
    await click(document.querySelector<HTMLButtonElement>(".plugin-image-dialog .plugin-prompt-actions button")!);

    await vi.waitFor(() => expect(container!.querySelector('[data-testid="plugin-panel"]')).not.toBeNull());
    const panel = container.querySelector('[data-testid="plugin-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("data-panel-id")).toBe(RECOGNITION_FIXTURE_PANEL_ID);
    expect(container.textContent).toContain("Image input is unavailable");

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
    expect(container.querySelector(`[data-plugin-id="${massFragmentManifest.id}"]`)).not.toBeNull();
    expect(container.textContent).toContain(massFragmentManifest.name);
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

    // Invoking with nothing selected must not crash or open a panel (it returns ok:false) — and the
    // refusal must be visible, not only a status-line message (a refused run was once reported as
    // "the report window never opens").
    await click(massItem!);
    expect(container.querySelector('[data-testid="plugin-panel"]')).toBeNull();
    const notice = await waitForElement(`[data-analyzer-notice="${massFragmentManifest.id}"]`);
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain(massFragmentManifest.name);
    expect(notice.textContent).toContain("Select one molecule before analyzing its mass.");
    expect(statusText()).toContain("Plugin command failed: Select one molecule before analyzing its mass.");
    await click(notice.querySelector('button[aria-label="Dismiss"]')!);
    expect(container.querySelector("[data-analyzer-notice]")).toBeNull();

    // The plugin is registered and listed in the bundled-plugin diagnostics — where no NMR plugin appears.
    await click(container.querySelector('button[data-menu-section="analyze"]')!);
    await click(container.querySelector<HTMLButtonElement>('button[data-command-id="plugin.runtime.showDiagnostics"]')!);
    expect(container.querySelector(`[data-plugin-id="${massFragmentManifest.id}"]`)).not.toBeNull();
    expect(container.textContent).toContain(massFragmentManifest.name);
    expect([...container.querySelectorAll("[data-plugin-id]")].some((node) => /nmr/i.test(node.getAttribute("data-plugin-id") ?? ""))).toBe(false);
  });

  it("shows an analyzer notice when the mass analyzer throws", async () => {
    bundled.massAnalyzerHandler = () => {
      throw new Error("The mass engine is unavailable.");
    };
    await renderMainWindow();

    await click(await massAnalyzerMenuItem());

    const notice = await waitForElement(`[data-analyzer-notice="${massFragmentManifest.id}"]`);
    expect(notice.textContent).toContain(massFragmentManifest.name);
    expect(notice.textContent).toContain("The mass engine is unavailable.");
  });

  it("clears a mass-analyzer refusal notice after a later successful run", async () => {
    const handler = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, error: { code: "MASS_REFUSED", message: "The sample is not applicable." } })
      .mockResolvedValueOnce({ ok: true });
    bundled.massAnalyzerHandler = handler;
    await renderMainWindow();

    await click(await massAnalyzerMenuItem());
    await waitForElement(`[data-analyzer-notice="${massFragmentManifest.id}"]`);

    await click(await massAnalyzerMenuItem());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container!.querySelector("[data-analyzer-notice]")).toBeNull());
  });

  it("ignores superseded mass-analyzer results instead of showing or clearing notices", async () => {
    const olderSuccess = deferredResult();
    const newerSuccess = deferredResult();
    const olderRefusal = deferredResult();
    const latestSuccess = deferredResult();
    const handler = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, error: { code: "MASS_REFUSED", message: "Keep this notice." } })
      .mockImplementationOnce(() => olderSuccess.promise)
      .mockImplementationOnce(() => newerSuccess.promise)
      .mockResolvedValueOnce({ ok: false, error: { code: "MASS_REFUSED", message: "Keep this next notice." } })
      .mockImplementationOnce(() => olderRefusal.promise)
      .mockImplementationOnce(() => latestSuccess.promise);
    bundled.massAnalyzerHandler = handler;
    await renderMainWindow();

    // Establish a visible refusal notice, then start an older successful run followed by a newer one.
    await click(await massAnalyzerMenuItem());
    const originalNotice = await waitForElement(`[data-analyzer-notice="${massFragmentManifest.id}"]`);
    expect(originalNotice.textContent).toContain("Keep this notice.");

    await click(await massAnalyzerMenuItem());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await click(await massAnalyzerMenuItem());
    await act(async () => {
      olderSuccess.resolve({ ok: true });
      await Promise.resolve();
    });

    // The older success settles after the newer request started, so its generation is obsolete and
    // must not clear the prior refusal notice. Only the newer success is allowed to clear it.
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    expect(container!.querySelector(`[data-analyzer-notice="${massFragmentManifest.id}"]`)?.textContent).toContain(
      "Keep this notice."
    );
    await act(async () => {
      newerSuccess.resolve({ ok: true });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container!.querySelector("[data-analyzer-notice]")).toBeNull());

    // A stale refusal likewise must not replace the notice that was already visible when its newer
    // request started. The latest success alone clears that newer refusal notice.
    await click(await massAnalyzerMenuItem());
    await waitForElement(`[data-analyzer-notice="${massFragmentManifest.id}"]`);
    await click(await massAnalyzerMenuItem());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(5));
    await click(await massAnalyzerMenuItem());
    await act(async () => {
      olderRefusal.resolve({ ok: false, error: { code: "MASS_REFUSED", message: "Do not show this." } });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(6));
    expect(container!.querySelector(`[data-analyzer-notice="${massFragmentManifest.id}"]`)?.textContent).toContain(
      "Keep this next notice."
    );
    await act(async () => {
      latestSuccess.resolve({ ok: true });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container!.querySelector("[data-analyzer-notice]")).toBeNull());
  });

  it("registers the analysis-window action listener once, however often the document changes", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const registrations = () =>
      addListener.mock.calls.filter(([name]) => name === ANALYSIS_WINDOW_ACTION_EVENT).length;
    window.history.replaceState(null, "", "/?agentBridge=1");
    await renderMainWindow();
    expect(registrations()).toBe(1);

    const bridge = (window as Window & { __CHEMDRAFT_AGENT__?: { command(id: string): Promise<unknown> } })
      .__CHEMDRAFT_AGENT__;
    expect(bridge).toBeDefined();
    // A new document replaces the one the analysis handlers close over — which used to tear the
    // listener down and re-register it (an async gap in which a window's action was dropped).
    await act(async () => {
      await bridge!.command("document.new");
    });
    expect(statusText()).toContain("Blank native document");
    expect(registrations()).toBe(1);
  });

  it("reports a failed Molecular Inspector copy instead of claiming it was copied", async () => {
    await renderMainWindow();
    Reflect.deleteProperty(navigator, "clipboard");
    await sendAnalysisWindowAction({ kind: "copyMolecularInspector", text: "C6H6" });
    expect(statusText()).toContain("Could not copy the analysis to the clipboard");

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await sendAnalysisWindowAction({ kind: "copyMolecularInspector", text: "C6H6" });
    expect(writeText).toHaveBeenCalledWith("C6H6");
    expect(statusText()).toContain("Analysis copied");
  });

  it.each(["acceptPluginProposal", "rejectPluginProposal"] as const)(
    "authorizes %s and review-window closing only for the proposal's own window", async (kind) => {
      bundled.withRecognitionFixture = true;
      let receive!: Parameters<typeof panelBridge.listenForAnalysisWindowActions>[0];
      let nativeClose!: Parameters<typeof panelBridge.listenForNativePanelWindowCloses>[0];
      vi.spyOn(panelBridge, "listenForAnalysisWindowActions").mockImplementation(handler => { receive = handler; return () => undefined; });
      vi.spyOn(panelBridge, "listenForNativePanelWindowCloses").mockImplementation(handler => { nativeClose = handler; return () => undefined; });
      vi.spyOn(panelBridge, "broadcastAnalysisWindowSnapshot").mockResolvedValue();
      vi.spyOn(panelBridge, "openPluginPanelWindow").mockResolvedValue();
      vi.spyOn(panelBridge, "hidePluginPanelWindow").mockResolvedValue();
      const respond = vi.spyOn(panelBridge, "respondToProposalDecision").mockResolvedValue();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await renderMainWindow();
      nativeDialog.desktop = true;
      const before = getAssistantHistoryPort().read("initial")!;
      const host = bundled.runtime!.host;
      let proposalId!: string;
      await act(async () => {
        proposalId = host.proposePatch(RECOGNITION_FIXTURE_PLUGIN_ID, {
          reason: "Insert test molecule",
          patch: { op: "addObject", pageId: before.pages[0]!.id, object: { ...namingMolecule, id: "reviewed-molecule" } }
        }).id;
      });
      const review = { pluginId: panelBridge.ANALYSIS_WINDOW_OWNER_ID, panelId: panelBridge.PATCH_REVIEW_WINDOW_ID };
      const label = panelBridge.pluginPanelWindowLabel(review);
      const other = panelBridge.pluginPanelWindowLabel({ pluginId: "org.nmr", panelId: "panel.nmr.result" });
      const action = { kind, proposalId, requestId: "decision" };
      await act(async () => {
        receive(action, other);
        receive(action);
        receive({ ...action, proposalId: "not-displayed" }, label);
        receive({ kind: "close", windowId: review.panelId }, other);
      });
      expect(host.listProposedPatches("pending")).toHaveLength(1);
      expect(getAssistantHistoryPort().read("initial")!.pages).toEqual(before.pages);
      expect(respond).not.toHaveBeenCalled();
      expect(container!.querySelector("[data-pending-proposals-badge]")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(4);
      await act(async () => { receive({ kind: "close", windowId: review.panelId }, label); });
      const badge = container!.querySelector("[data-pending-proposals-badge] button")!;
      expect(badge).not.toBeNull();
      await click(badge);
      await act(async () => { nativeClose(review); });
      expect(container!.querySelector("[data-pending-proposals-badge]")).not.toBeNull();
      await click(container!.querySelector("[data-pending-proposals-badge] button")!);
      await act(async () => { receive(action, label); });
      expect(host.listProposedPatches("pending")).toHaveLength(0);
      expect(respond).toHaveBeenCalledWith("decision", expect.objectContaining({ ok: true }), label);
      const inserted = getAssistantHistoryPort().read("initial")!.pages[0]!.objects.some(object => object.id === "reviewed-molecule");
      expect(inserted).toBe(kind === "acceptPluginProposal");
    }
  );

  it("binds report text copy and every spectrum action to live panel content", async () => {
    let receive!: Parameters<typeof panelBridge.listenForAnalysisWindowActions>[0];
    vi.spyOn(panelBridge, "listenForAnalysisWindowActions").mockImplementation(handler => { receive = handler; return () => undefined; });
    vi.spyOn(panelBridge, "broadcastAnalysisWindowSnapshot").mockResolvedValue();
    vi.spyOn(panelBridge, "broadcastPluginPanelReport").mockResolvedValue();
    vi.spyOn(panelBridge, "broadcastPluginPanelStaleness").mockResolvedValue();
    vi.spyOn(panelBridge, "broadcastPluginPanelReportCleared").mockResolvedValue();
    vi.spyOn(panelBridge, "openPluginPanelWindow").mockResolvedValue();
    vi.spyOn(panelBridge, "hidePluginPanelWindow").mockResolvedValue();
    const copyReply = vi.spyOn(panelBridge, "respondToCopyMolecularInspector").mockResolvedValue();
    const saveReply = vi.spyOn(panelBridge, "respondToSaveTextFile").mockResolvedValue();
    const handleSpectrum = vi.spyOn(spectrumExport, "handleSpectrumWindowAction").mockResolvedValue();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeText = vi.spyOn(clipboard, "writeClipboardTextItems").mockResolvedValue(true);
    await renderMainWindow();
    nativeDialog.desktop = true;
    const runtime = bundled.runtime!;
    const identity = { pluginId: namingManifest.id, panelId: "panel.namingTest.result" };
    const label = panelBridge.pluginPanelWindowLabel(identity);
    const other = panelBridge.pluginPanelWindowLabel({ ...identity, panelId: "panel.namingTest.other" });
    await act(async () => {
      runtime.registerPlugin(namingManifest);
      runtime.panels.showReport(identity.pluginId, identity.panelId, { title: "Result", sections: [{
        kind: "linkedFigure", spectrum: { nucleus: "13C", domain: { min: 0, max: 200 }, peaks: [] }
      }] });
      runtime.panels.detachPanel(identity.pluginId, identity.panelId);
    });
    const actions: AnalysisWindowAction[] = [
      { kind: "copyMolecularInspector", text: "ethanol", requestId: "name" },
      { kind: "copySpectrum", requestId: "spectrum" },
      { kind: "saveTextFile", requestId: "text" },
      { kind: "saveBinaryFile", requestId: "binary" }
    ];
    await act(async () => { for (const action of actions) receive(action, other); });
    expect(writeText).not.toHaveBeenCalled();
    expect(handleSpectrum).not.toHaveBeenCalled();
    await act(async () => { for (const action of actions) receive(action, label); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith([{ type: "text/plain", text: "ethanol" }]);
    expect(copyReply).toHaveBeenCalledWith("name", true, label);
    expect(handleSpectrum.mock.calls.map(([action]) => action)).toEqual(actions.slice(1));
    const dependencies = handleSpectrum.mock.calls[0]![1]!;
    await dependencies.respondCopy("spectrum", true);
    await dependencies.respondSave("text", "saved");
    expect(copyReply).toHaveBeenCalledWith("spectrum", true, label);
    expect(saveReply).toHaveBeenCalledWith("text", "saved", label);
    handleSpectrum.mockClear();
    await act(async () => {
      runtime.panels.showReport(identity.pluginId, identity.panelId, { title: "Name only", sections: [] });
      for (const action of actions.slice(1)) receive(action, label);
    });
    expect(handleSpectrum).not.toHaveBeenCalled();
    await act(async () => {
      runtime.panels.closeDetachedPanel(identity.pluginId, identity.panelId);
      receive(actions[0]!, label);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("performs a report window's file save itself, with the main window's own permissions", async () => {
    let receive!: Parameters<typeof panelBridge.listenForAnalysisWindowActions>[0];
    vi.spyOn(panelBridge, "listenForAnalysisWindowActions").mockImplementation(handler => { receive = handler; return () => undefined; });
    vi.spyOn(panelBridge, "broadcastPluginPanelReport").mockResolvedValue();
    vi.spyOn(panelBridge, "openPluginPanelWindow").mockResolvedValue();
    const saveReply = vi.spyOn(panelBridge, "respondToSaveTextFile").mockResolvedValue();
    await renderMainWindow();
    nativeDialog.desktop = true;
    const runtime = bundled.runtime!;
    const identity = { pluginId: namingManifest.id, panelId: "panel.namingTest.result" };
    const label = panelBridge.pluginPanelWindowLabel(identity);
    await act(async () => {
      runtime.registerPlugin(namingManifest);
      runtime.panels.showReport(identity.pluginId, identity.panelId, { title: "Result", sections: [{
        kind: "linkedFigure", spectrum: { nucleus: "13C", domain: { min: 0, max: 200 }, peaks: [] }
      }] });
      runtime.panels.detachPanel(identity.pluginId, identity.panelId);
    });
    nativeDialog.desktop = false;
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    URL.createObjectURL ??= () => "blob:test";
    URL.revokeObjectURL ??= () => undefined;
    await act(async () => {
      receive({ kind: "saveTextFile", requestId: "save", filename: "predicted-1H-nmr.jdx", text: "##TITLE=x", format: "jcamp" }, label);
    });
    expect(downloads).toEqual(["predicted-1H-nmr.jdx"]);
    expect(saveReply).toHaveBeenCalledWith("save", "saved", label);
  });
});
