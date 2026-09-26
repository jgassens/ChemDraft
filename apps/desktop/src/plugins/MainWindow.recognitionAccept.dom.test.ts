// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSnapshot } from "../agentBridge";
import { createPhase4Document } from "../documentWorkflow";
import { MainWindow } from "../MainWindow";
import { RECOGNITION_FIXTURE_COMMAND_ID } from "../testSupport/recognitionFixturePlugin";
import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { ImageSourceRegistry } from "./ImageSourceProvider";
import { ANALYSIS_WINDOW_ACTION_EVENT, type AnalysisWindowAction } from "./panelBridge";
import type { StructureRecognitionEngine, StructureRecognitionOutcome } from "./structureRecognitionEngine";

const carbonMonoxideMolfile = [
  "Recognized carbon monoxide",
  "  MolScribe",
  "",
  "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0  0  0  0",
  "M  END"
].join("\n");

const recognized: StructureRecognitionOutcome = {
  status: "recognized",
  smiles: "C=O",
  molfile: carbonMonoxideMolfile,
  confidence: 0.91,
  atoms: [
    { index: 0, symbol: "C", x: -0.75, y: 0, confidence: 0.9 },
    { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.92 }
  ],
  bonds: [{ begin: 0, end: 1, bondType: "double", confidence: 0.89 }],
  agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 80,
  engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
};

// The only stand-ins are the machine edges: the image the user picks and the native engine that reads
// it. Everything between — the installed-plugin-shaped fixture, the host's held-patch substitution,
// the proposal queue, the window action listener, and MainWindow's accept handler — is the real code.
const harness = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
vi.mock("./registerBundledPlugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registerBundledPlugins")>();
  const { recognitionFixtureDescriptor } = await import("../testSupport/recognitionFixturePlugin");
  return {
    ...actual,
    registerBundledPlugins: (runtime: DesktopPluginRuntime, disabledIds?: ReadonlySet<string>) => {
      const descriptors = [...actual.createBundledPluginDescriptors(), recognitionFixtureDescriptor()];
      actual.applyEnabledPlugins(runtime, disabledIds ?? new Set(), descriptors);
      return descriptors;
    }
  };
});
vi.mock("./createPluginRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./createPluginRuntime")>();
  const engine: StructureRecognitionEngine = {
    status: async () => ({ state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 }),
    install: async () => ({ state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 }),
    cancelInstall: async () => undefined,
    uninstall: async () => ({ state: "notInstalled", requiredDiskBytes: 0, freeDiskBytes: 0 }),
    recognizeImage: async () => recognized
  };
  return {
    ...actual,
    createPluginRuntime: (options: Parameters<typeof actual.createPluginRuntime>[0]) => {
      const runtime = actual.createPluginRuntime({
        ...options,
        structureRecognitionEngine: engine,
        recognitionStructureValidator: async () => ({ valid: true, errors: [], warnings: [] }),
        imageSourceRegistry: new ImageSourceRegistry([
          {
            id: "file",
            label: "File",
            isAvailable: async () => true,
            acquire: async () => ({
              mediaType: "image/png",
              bytes: new Uint8Array([1, 2, 3]),
              width: 320,
              height: 200,
              source: "file",
              fileName: "brevetoxin.png"
            })
          }
        ])
      });
      harness.runtime = runtime;
      return runtime;
    }
  };
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

type Bridge = { snapshot(): AgentSnapshot; command(id: string): Promise<AgentSnapshot> };

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  harness.runtime = undefined;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  delete (window as Window & { __CHEMDRAFT_AGENT__?: unknown }).__CHEMDRAFT_AGENT__;
  vi.restoreAllMocks();
});

async function renderMainWindow(): Promise<Bridge> {
  installDomMocks();
  window.history.replaceState(null, "", "/?agentBridge=1");
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      createElement(MainWindow, {
        initialDocument: createPhase4Document("Recognition Accept"),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: false
      })
    );
    await Promise.resolve();
  });
  return (window as Window & { __CHEMDRAFT_AGENT__?: Bridge }).__CHEMDRAFT_AGENT__!;
}

async function sendAction(action: AnalysisWindowAction): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(ANALYSIS_WINDOW_ACTION_EVENT, { detail: action }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function statusText(): string {
  return container!.querySelector('[role="status"]')?.textContent ?? "";
}

/** Run the fixture's Recognize command end to end and return the proposal it queued. */
async function recognizeIntoProposal(bridge: Bridge) {
  const runtime = harness.runtime!;
  let invocation: Promise<unknown> | undefined;
  await act(async () => {
    invocation = bridge.command(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    await invocation;
    await vi.waitFor(() => expect(runtime.host.listProposedPatches("pending")).toHaveLength(1));
  });
  return runtime.host.listProposedPatches("pending")[0]!;
}

function moleculeIds(bridge: Bridge): string[] {
  return bridge
    .snapshot()
    .document.pages.flatMap((page) => page.objects)
    .filter((object) => object.type === "molecule")
    .map((object) => object.id);
}

describe("accepting a recognition proposal from the review window", () => {
  it("inserts the recognized structure as one undoable, selected edit and says so", async () => {
    const bridge = await renderMainWindow();
    const before = moleculeIds(bridge);
    const proposal = await recognizeIntoProposal(bridge);
    expect(proposal.proposal.recognition).toBeDefined();

    await sendAction({ kind: "acceptPluginProposal", proposalId: proposal.id });

    const inserted = moleculeIds(bridge).filter((id) => !before.includes(id));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatch(/^mol_ocsr_/);
    expect(harness.runtime!.host.listProposedPatches("pending")).toHaveLength(0);
    expect(bridge.snapshot().selection.objectIds).toEqual(inserted);
    expect(statusText()).toMatch(/Recognition Fixture: inserted recognized structure/);

    await act(async () => {
      await bridge.command("edit.undo");
    });
    expect(moleculeIds(bridge)).toEqual(before);
  });

  it("reports an accept that fails instead of leaving the proposal silently pending", async () => {
    const bridge = await renderMainWindow();
    const proposal = await recognizeIntoProposal(bridge);
    vi.spyOn(harness.runtime!.host, "acceptProposedPatch").mockImplementation(() => {
      throw new Error("page page_1 does not exist");
    });

    await sendAction({ kind: "acceptPluginProposal", proposalId: proposal.id });

    expect(statusText()).toContain("Could not insert the proposal: page page_1 does not exist");
  });

  it("reports an Accept for a proposal that is no longer pending", async () => {
    await renderMainWindow();
    await sendAction({ kind: "acceptPluginProposal", proposalId: "proposal_404" });
    expect(statusText()).toContain("That proposal was already resolved");
  });
});
