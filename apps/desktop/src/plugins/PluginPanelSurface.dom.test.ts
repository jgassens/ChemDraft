// @vitest-environment jsdom

import { molscribeOcsrManifest } from "@chemdraft/molscribe-ocsr-plugin";
import type { PluginManifest } from "@chemdraft/plugin-api";
import type { PluginHost } from "@chemdraft/plugin-host";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginPanelSurface, type PluginPanelSurfaceProps } from "./PluginPanelSurface";
import type { OpenPluginPanel } from "./types";
import { usePluginRuntime } from "./usePluginRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function surfaceProps(overrides: Partial<PluginPanelSurfaceProps> = {}): PluginPanelSurfaceProps {
  return {
    openPanel: undefined,
    diagnosticsOpen: false,
    plugins: [],
    diagnostics: [],
    onClose: vi.fn(),
    onCloseDiagnostics: vi.fn(),
    onRunAgain: vi.fn(),
    ...overrides
  };
}

const openPanel: OpenPluginPanel = {
  pluginId: molscribeOcsrManifest.id,
  panelId: "panel.molscribeOcsr.review",
  title: "MolScribe OCSR Review",
  commandId: "plugin.molscribeOcsr.recognizeImage",
  openedAt: "2026-07-07T00:00:00.000Z",
  report: {
    title: "MolScribe OCSR (runtime canary)",
    sections: [
      { kind: "keyValue", title: "Runtime", rows: [{ label: "Runtime path", value: "Active" }] },
      { kind: "text", body: "No document changes were made." }
    ]
  }
};

describe("PluginPanelSurface", () => {
  it("renders a declarative report with chrome and wires Close / Run again", () => {
    const onClose = vi.fn();
    const onRunAgain = vi.fn();
    mount(createElement(PluginPanelSurface, surfaceProps({ openPanel, onClose, onRunAgain })));

    expect(container!.querySelector('[data-testid="plugin-panel"]')).not.toBeNull();
    expect(container!.textContent).toContain("MolScribe OCSR (runtime canary)");
    expect(container!.textContent).toContain("Runtime path");
    expect(container!.textContent).toContain("Active");
    expect(container!.textContent).toContain("No document changes were made.");

    const runAgain = container!.querySelector<HTMLButtonElement>(".plugin-panel-run-again");
    const close = container!.querySelector<HTMLButtonElement>(".plugin-panel-close");
    expect(runAgain).not.toBeNull();
    act(() => {
      runAgain!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRunAgain).toHaveBeenCalledWith("plugin.molscribeOcsr.recognizeImage");
    act(() => {
      close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders SVG report sections through an inert img data URL", () => {
    mount(
      createElement(
        PluginPanelSurface,
        surfaceProps({
          openPanel: {
            ...openPanel,
            report: {
              title: "Spectrum",
              sections: [{ kind: "svg", svg: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", caption: "stick" }]
            }
          }
        })
      )
    );

    const image = container!.querySelector<HTMLImageElement>(".plugin-report-svg-image");
    expect(image).not.toBeNull();
    expect(image!.getAttribute("src")).toContain("data:image/svg+xml");
    // The SVG is not injected as live DOM (script-inert rendering path).
    expect(container!.querySelector("svg")).toBeNull();
  });

  it("lists bundled plugins when diagnostics are open", () => {
    mount(createElement(PluginPanelSurface, surfaceProps({ diagnosticsOpen: true, plugins: [molscribeOcsrManifest] })));

    expect(container!.querySelector(`[data-plugin-id="${molscribeOcsrManifest.id}"]`)).not.toBeNull();
    expect(container!.textContent).toContain(molscribeOcsrManifest.name);
    expect(container!.textContent).toContain(`v${molscribeOcsrManifest.version}`);
  });

  it("renders nothing when neither a panel nor diagnostics is open", () => {
    mount(createElement(PluginPanelSurface, surfaceProps({ plugins: [molscribeOcsrManifest] })));
    expect(container!.querySelector('[data-testid="plugin-surface"]')).toBeNull();
  });
});

describe("usePluginRuntime host persistence", () => {
  it("keeps one host instance across re-renders with changing providers", () => {
    const hosts: PluginHost[] = [];
    const plugins: PluginManifest[][] = [];

    function Probe({ tick }: { tick: number }) {
      // A fresh providers object every render (as MainWindow passes) must not rebuild the host.
      const runtime = usePluginRuntime({
        getActiveDocument: () => undefined,
        getSelection: () => ({ objectIds: [`tick-${tick}`], molecules: [] })
      });
      hosts.push(runtime.runtime.host);
      plugins.push([...runtime.plugins]);
      return null;
    }

    mount(createElement(Probe, { tick: 0 }));
    act(() => {
      root!.render(createElement(Probe, { tick: 1 }));
    });

    expect(hosts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hosts).size).toBe(1);
    expect(plugins.at(-1)?.map((manifest) => manifest.id)).toContain(molscribeOcsrManifest.id);
  });
});
