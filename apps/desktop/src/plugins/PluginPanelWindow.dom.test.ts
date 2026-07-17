// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  broadcastPluginPanelReport,
  broadcastPluginPanelStaleness,
  PLUGIN_PANEL_CLOSED_EVENT,
  PLUGIN_PANEL_RERUN_EVENT,
  type PluginPanelReportPayload
} from "./panelBridge";
import { PluginPanelWindow } from "./PluginPanelWindow";

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

const PANEL_ID = "panel.exampleAnalyzer.result";

async function mountWindow(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(PluginPanelWindow, { panelId: PANEL_ID }));
    // Bridge listeners attach in an async then-chain; flush microtasks before broadcasting.
    await Promise.resolve();
  });
}

function reportPayload(overrides: Partial<PluginPanelReportPayload> = {}): PluginPanelReportPayload {
  return {
    panelId: PANEL_ID,
    pluginId: "org.test.exampleAnalyzer",
    revision: 1,
    commandId: "plugin.exampleAnalyzer.run",
    report: {
      title: "Analysis Result",
      sections: [
        { kind: "keyValue", title: "Runtime", rows: [{ label: "Backend", value: "chemdraft.demo-engine" }] },
        {
          kind: "linkedFigure",
          title: "Predicted ¹H spectrum",
          spectrum: {
            nucleus: "1H",
            domain: { min: 0, max: 8 },
            reversed: true,
            peaks: [{ id: "p1", ppm: 7.2, intensity: 1, label: "7.20", atomIndices: [0] }]
          }
        }
      ]
    },
    ...overrides
  };
}

async function broadcast(payload: PluginPanelReportPayload): Promise<void> {
  await act(async () => {
    await broadcastPluginPanelReport(payload);
  });
}

describe("PluginPanelWindow (unified renderer, ADR-0030)", () => {
  it("renders reports through the shared PluginReportRenderer — the linkedFigure survives in the window", async () => {
    await mountWindow();
    expect(container!.textContent).toContain("Waiting for plugin content…");

    await broadcast(reportPayload());

    // The shared renderer, not a window-private section switch: report chrome classes are the
    // plugin-report family, and the interactive linked figure actually renders (main's original
    // window switch silently dropped unknown kinds, losing this entire section).
    expect(container!.querySelector(".plugin-report")).not.toBeNull();
    expect(container!.textContent).toContain("Backend");
    expect(container!.textContent).toContain("chemdraft.demo-engine");
    expect(container!.querySelector(".lf-root")).not.toBeNull();
    expect(container!.textContent).toContain("Predicted ¹H spectrum");
  });

  it("applies the revision guard so a late broadcast never regresses the panel", async () => {
    await mountWindow();
    await broadcast(reportPayload({ revision: 2, report: { title: "Result", sections: [] } }));
    await broadcast(reportPayload({ revision: 1, report: { title: "Stale pending", sections: [] } }));

    expect(container!.textContent).toContain("Result");
    expect(container!.textContent).not.toContain("Stale pending");
  });

  it("relays Run again over the bridge instead of running anything locally", async () => {
    await mountWindow();
    const reruns: string[] = [];
    const onRerun = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: unknown }>).detail;
      if (typeof detail?.panelId === "string") {
        reruns.push(detail.panelId);
      }
    };
    window.addEventListener(PLUGIN_PANEL_RERUN_EVENT, onRerun);
    try {
      await broadcast(reportPayload());
      const runAgain = container!.querySelector<HTMLButtonElement>(".plugin-panel-run-again");
      expect(runAgain).not.toBeNull();
      await act(async () => {
        runAgain!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(reruns).toEqual([PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_RERUN_EVENT, onRerun);
    }
  });

  it("hides Run again when the payload carries no command", async () => {
    await mountWindow();
    await broadcast(reportPayload({ commandId: undefined }));
    expect(container!.querySelector(".plugin-panel-run-again")).toBeNull();
  });

  it("shows the staleness banner for the current revision and clears it for a newer report", async () => {
    await mountWindow();
    await broadcast(reportPayload({ revision: 1 }));
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).toBeNull();

    await act(async () => {
      await broadcastPluginPanelStaleness({ panelId: PANEL_ID, stale: true, revision: 1 });
    });
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();

    // A newer report is a fresh result; the old verdict must not carry over to it.
    await broadcast(reportPayload({ revision: 2 }));
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).toBeNull();

    await act(async () => {
      await broadcastPluginPanelStaleness({ panelId: PANEL_ID, stale: true, revision: 2 });
    });
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();
  });

  it("notifies panel-closed on dismissal so the plugin gets its ADR-0012 cancellation signal", async () => {
    await mountWindow();
    const closes: string[] = [];
    const onClosed = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: unknown }>).detail;
      if (typeof detail?.panelId === "string") {
        closes.push(detail.panelId);
      }
    };
    window.addEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    try {
      await broadcast(reportPayload());
      const close = container!.querySelector<HTMLButtonElement>(".palette-close-button");
      expect(close).not.toBeNull();
      await act(async () => {
        close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    }
  });
});
