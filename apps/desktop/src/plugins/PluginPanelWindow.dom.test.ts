// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_WINDOW_ACTION_EVENT,
  ANALYSIS_WINDOW_ACTION_RESULT_EVENT,
  ANALYSIS_WINDOW_OWNER_ID,
  MOLECULAR_INSPECTOR_WINDOW_ID,
  PATCH_REVIEW_WINDOW_ID,
  PLUGIN_DIAGNOSTICS_WINDOW_ID,
  VALIDATION_RESULT_WINDOW_ID,
  broadcastPluginPanelReport,
  broadcastPluginPanelStaleness,
  broadcastAnalysisWindowSnapshot,
  listenForPluginPanelReruns,
  openPluginPanelWindow,
  PLUGIN_PANEL_CLOSED_EVENT,
  PLUGIN_PANEL_RERUN_EVENT,
  parsePluginPanelWindowId,
  pluginPanelWindowId,
  type PluginPanelReportPayload
} from "./panelBridge";
import { PluginPanelWindow } from "./PluginPanelWindow";

const tauriInvoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

// A minimal cross-window event bus: `emit` reaches every `listen`er of that event name, as Tauri's
// global emit does. `respond` lets a test stand in for the main window.
const tauriEvents = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const emitted: { name: string; payload: unknown }[] = [];
  let respond: ((name: string, payload: unknown) => void) | undefined;
  return {
    listeners,
    emitted,
    setResponder(next: typeof respond) {
      respond = next;
    },
    listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    },
    emit: async (name: string, payload: unknown) => {
      emitted.push({ name, payload });
      for (const handler of [...(listeners.get(name) ?? [])]) handler({ payload });
      respond?.(name, payload);
    }
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvents.listen, emit: tauriEvents.emit }));
const nativeSave = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: nativeSave }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: async () => undefined }) }));

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
  delete (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__;
  tauriInvoke.mockClear();
  nativeSave.mockReset();
  tauriEvents.listeners.clear();
  tauriEvents.emitted.length = 0;
  tauriEvents.setResponder(undefined);
  window.history.replaceState(null, "", "/");
});

const PANEL_ID = "panel.exampleAnalyzer.result";
const PLUGIN_ID = "org.test.exampleAnalyzer";
const WINDOW_ID = pluginPanelWindowId(PLUGIN_ID, PANEL_ID);

async function mountWindow(windowId = WINDOW_ID): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(PluginPanelWindow, { panelId: windowId }));
    await Promise.resolve();
  });
}

function reportPayload(overrides: Partial<PluginPanelReportPayload> = {}): PluginPanelReportPayload {
  return {
    panelId: PANEL_ID,
    pluginId: PLUGIN_ID,
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
  it("opens plugin and built-in analysis identities through the one existing native transport", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    await openPluginPanelWindow({
      pluginId: ANALYSIS_WINDOW_OWNER_ID,
      panelId: VALIDATION_RESULT_WINDOW_ID,
      title: "Validation Result",
      width: 500,
      height: 520,
      focus: true
    });

    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("open_plugin_panel_window", {
      request: {
        panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, VALIDATION_RESULT_WINDOW_ID),
        title: "Validation Result",
        width: 500,
        height: 520,
        focus: true
      }
    });
  });

  it("passes focus: false through for an automatic show so the canvas keeps the keyboard", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    await openPluginPanelWindow({
      pluginId: ANALYSIS_WINDOW_OWNER_ID,
      panelId: PATCH_REVIEW_WINDOW_ID,
      title: "Plugin Proposals",
      focus: false
    });

    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("open_plugin_panel_window", {
      request: expect.objectContaining({ focus: false })
    });
  });

  it("closes Full size on the first Escape and the window only on the second", async () => {
    await mountWindow();
    const closes: string[] = [];
    const onClosed = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: unknown }>).detail;
      if (typeof detail?.panelId === "string") closes.push(detail.panelId);
    };
    window.addEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    try {
      await broadcast(reportPayload());
      const fullSize = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
        (button) => button.textContent === "Full size"
      )!;
      await act(async () => {
        fullSize.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(document.querySelector(".lf-modal")).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(document.querySelector(".lf-modal")).toBeNull();
      expect(closes).toEqual([]);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    }
  });

  it("exports JCAMP-DX through the main window, which holds the save permission", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${WINDOW_ID}`);
    // Stand in for the main window: answer a save request as saved.
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "saveTextFile") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, result: "saved" });
      }
    });
    await mountWindow();
    await act(async () => {
      await broadcastPluginPanelReport(reportPayload());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const exportButton = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
      (button) => button.textContent === "Export"
    )!;
    expect(exportButton).toBeDefined();

    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const request = tauriEvents.emitted.find(
      (event) =>
        event.name === ANALYSIS_WINDOW_ACTION_EVENT && (event.payload as { kind?: string }).kind === "saveTextFile"
    );
    expect(request?.payload).toMatchObject({
      kind: "saveTextFile",
      filename: "predicted-1H-nmr.jdx",
      formatLabel: "JCAMP-DX",
      extensions: ["jdx", "dx"]
    });
    expect((request?.payload as { text: string }).text).toContain("##JCAMP-DX=");
    // The report window never reached for a dialog of its own.
    expect(nativeSave).not.toHaveBeenCalled();
    expect(exportButton.textContent).toBe("Exported");
  });

  it("shows Export failed when the main window reports the save failed", async () => {
    (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {};
    window.history.replaceState(null, "", `/?window=pluginPanel&panelId=${WINDOW_ID}`);
    tauriEvents.setResponder((name, payload) => {
      const action = payload as { kind?: string; requestId?: string };
      if (name === ANALYSIS_WINDOW_ACTION_EVENT && action.kind === "saveTextFile") {
        void tauriEvents.emit(ANALYSIS_WINDOW_ACTION_RESULT_EVENT, { requestId: action.requestId, result: "failed" });
      }
    });
    await mountWindow();
    await act(async () => {
      await broadcastPluginPanelReport(reportPayload());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const exportButton = [...container!.querySelectorAll<HTMLButtonElement>(".lf-btn")].find(
      (button) => button.textContent === "Export"
    )!;
    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(exportButton.textContent).toBe("Export failed");
  });

  it("returns listener cleanup synchronously so an immediate effect cleanup cannot leak", () => {
    const handler = vi.fn();
    const cleanup = listenForPluginPanelReruns(handler);
    cleanup();

    window.dispatchEvent(
      new CustomEvent(PLUGIN_PANEL_RERUN_EVENT, { detail: { pluginId: PLUGIN_ID, panelId: PANEL_ID } })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses a reversible collision-free native identity instead of lossy panel-id punctuation", () => {
    const dotted = pluginPanelWindowId("org.test.a", "panel.shared.a-b");
    const dashed = pluginPanelWindowId("org.test.a", "panel.shared.a.b");
    const otherOwner = pluginPanelWindowId("org.test.b", "panel.shared.a-b");

    expect(new Set([dotted, dashed, otherOwner]).size).toBe(3);
    expect(parsePluginPanelWindowId(dotted)).toEqual({ pluginId: "org.test.a", panelId: "panel.shared.a-b" });
  });

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
      const detail = (event as CustomEvent<{ pluginId?: unknown; panelId?: unknown }>).detail;
      if (detail?.pluginId === PLUGIN_ID && typeof detail.panelId === "string") {
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
      await broadcastPluginPanelStaleness({ pluginId: PLUGIN_ID, panelId: PANEL_ID, stale: true, revision: 1 });
    });
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();

    // A newer report is a fresh result; the old verdict must not carry over to it.
    await broadcast(reportPayload({ revision: 2 }));
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).toBeNull();

    await act(async () => {
      await broadcastPluginPanelStaleness({ pluginId: PLUGIN_ID, panelId: PANEL_ID, stale: true, revision: 2 });
    });
    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();
  });

  it("retains a replayed staleness verdict that arrives before its matching report", async () => {
    await mountWindow();
    await act(async () => {
      await broadcastPluginPanelStaleness({
        pluginId: PLUGIN_ID,
        panelId: PANEL_ID,
        stale: true,
        revision: 7
      });
    });
    await broadcast(reportPayload({ revision: 7 }));

    expect(container!.querySelector('[data-testid="plugin-panel-stale"]')).not.toBeNull();
  });

  it("draws its stoplight close button without a stray glyph, and closes by click or Escape", async () => {
    await mountWindow();
    const closes: string[] = [];
    const onClosed = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginId?: unknown; panelId?: unknown }>).detail;
      if (detail?.pluginId === PLUGIN_ID && typeof detail.panelId === "string") {
        closes.push(detail.panelId);
      }
    };
    window.addEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    try {
      await broadcast(reportPayload());
      const close = container!.querySelector<HTMLButtonElement>(".palette-close-button");
      expect(close).not.toBeNull();
      expect(close!.getAttribute("aria-label")).toBe("Close panel");
      expect(close!.textContent).toBe("");
      expect(container!.querySelector(".palette-title")!.textContent).not.toContain("×");
      await act(async () => {
        close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID]);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await Promise.resolve();
      });
      expect(closes).toEqual([PANEL_ID, PANEL_ID]);
    } finally {
      window.removeEventListener(PLUGIN_PANEL_CLOSED_EVENT, onClosed);
    }
  });

  it("does not retain duplicate bridge listeners through StrictMode's setup/cleanup probe", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(StrictMode, null, createElement(PluginPanelWindow, { panelId: WINDOW_ID })));
      await Promise.resolve();
    });

    await broadcast(reportPayload({ revision: 1, report: { title: "First", sections: [] } }));
    await broadcast(reportPayload({ revision: 2, report: { title: "Second", sections: [] } }));

    expect(container.querySelectorAll(".plugin-report")).toHaveLength(1);
    expect(container.textContent).toContain("Second");
    expect(container.textContent).not.toContain("First");
  });

  it("ignores a same-named panel report owned by a different plugin", async () => {
    await mountWindow();
    await broadcast(reportPayload({ pluginId: "org.test.other", report: { title: "Wrong owner", sections: [] } }));
    expect(container!.textContent).toContain("Waiting for plugin content…");

    await broadcast(reportPayload({ report: { title: "Correct owner", sections: [] } }));
    expect(container!.textContent).toContain("Correct owner");
    expect(container!.textContent).not.toContain("Wrong owner");
  });

  it("renders proposal review in the shared analysis window and relays Accept/Reject", async () => {
    await mountWindow(pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, PATCH_REVIEW_WINDOW_ID));
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: PATCH_REVIEW_WINDOW_ID,
        revision: 1,
        content: {
          kind: "patchReview",
          proposals: [
            {
              id: "proposal-1",
              pluginId: "org.test.proposer",
              pluginName: "Test Proposer",
              reason: "Insert the recognized structure",
              warnings: [{ code: "low-confidence", message: "Review the stereochemistry." }],
              recognition: {
                sourceImageRef: "data:image/png;base64,iVBORw==",
                proposedSmiles: "[C@H](F)Cl",
                proposedMolfile: "fixture molfile",
                confidenceTier: "low",
                elapsedMs: 125,
                engine: {
                  name: "MolScribe",
                  molscribeCommit: "abc123",
                  modelSha256: "a".repeat(64)
                }
              },
              structurePreview: "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E"
            }
          ]
        }
      });
    });

    expect(container!.textContent).toContain("Insert the recognized structure");
    expect(container!.textContent).toContain("Low confidence");
    expect(container!.textContent).toContain("[C@H](F)Cl");
    expect(container!.querySelector<HTMLImageElement>('[alt="Source submitted for structure recognition"]')?.src).toContain(
      "data:image/png;base64,iVBORw=="
    );
    expect(
      container!.querySelector<HTMLImageElement>('[data-testid="recognition-structure-preview"]')?.getAttribute("src")
    ).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E");
    const actions: unknown[] = [];
    const onAction = (event: Event) => actions.push((event as CustomEvent<unknown>).detail);
    window.addEventListener(ANALYSIS_WINDOW_ACTION_EVENT, onAction);
    try {
      const [accept, reject] = [...container!.querySelectorAll<HTMLButtonElement>(".patch-review-actions button")];
      await act(async () => {
        accept!.click();
        reject!.click();
        await Promise.resolve();
      });
      expect(actions).toEqual([
        { kind: "acceptPluginProposal", proposalId: "proposal-1" },
        { kind: "rejectPluginProposal", proposalId: "proposal-1" }
      ]);
    } finally {
      window.removeEventListener(ANALYSIS_WINDOW_ACTION_EVENT, onAction);
    }
  });

  it("renders the built-in Molecular Inspector, validation result, and diagnostics snapshot kinds", async () => {
    await mountWindow(pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, MOLECULAR_INSPECTOR_WINDOW_ID));
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: MOLECULAR_INSPECTOR_WINDOW_ID,
        revision: 1,
        content: { kind: "molecularInspector", busy: false, stale: false }
      });
    });
    expect(container!.textContent).toContain("Select a structure to see its analyses here.");

    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        createElement(PluginPanelWindow, {
          panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, VALIDATION_RESULT_WINDOW_ID)
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: VALIDATION_RESULT_WINDOW_ID,
        revision: 1,
        content: {
          kind: "report",
          report: {
            title: "Validation Result",
            sections: [{ kind: "text", body: "No validation warnings or errors were reported." }]
          }
        }
      });
    });
    expect(container!.textContent).toContain("No validation warnings or errors were reported.");

    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        createElement(PluginPanelWindow, {
          panelId: pluginPanelWindowId(ANALYSIS_WINDOW_OWNER_ID, PLUGIN_DIAGNOSTICS_WINDOW_ID)
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      await broadcastAnalysisWindowSnapshot({
        pluginId: ANALYSIS_WINDOW_OWNER_ID,
        panelId: PLUGIN_DIAGNOSTICS_WINDOW_ID,
        revision: 1,
        content: { kind: "pluginDiagnostics", plugins: [], diagnostics: [] }
      });
    });
    expect(container!.querySelector('[data-testid="plugin-diagnostics"]')).not.toBeNull();
    expect(container!.textContent).toContain("No bundled plugins are registered.");
  });
});
