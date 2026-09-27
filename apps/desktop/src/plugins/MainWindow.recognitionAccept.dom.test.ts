// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSnapshot } from "../agentBridge";
import { createPhase4Document } from "../documentWorkflow";
import { MainWindow } from "../MainWindow";
import {
  RECOGNITION_FIXTURE_COMMAND_ID,
  RECOGNITION_FIXTURE_PANEL_ID,
  RECOGNITION_FIXTURE_PLUGIN_ID
} from "../testSupport/recognitionFixturePlugin";
import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { ImageSourceRegistry } from "./ImageSourceProvider";
import {
  ANALYSIS_WINDOW_ACTION_EVENT,
  PLUGIN_PANEL_WINDOW_CLOSED_EVENT,
  pluginPanelWindowId,
  type AnalysisWindowAction
} from "./panelBridge";
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
const harness = vi.hoisted(() => ({
  runtime: undefined as DesktopPluginRuntime | undefined
}));
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

async function renderMainWindow(options: { initialActiveToolCommandId?: string } = {}): Promise<Bridge> {
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
        nativePalette: false,
        ...(options.initialActiveToolCommandId
          ? { initialActiveToolCommandId: options.initialActiveToolCommandId, initialCrosshairsVisible: false }
          : {})
      })
    );
    await Promise.resolve();
  });
  const page = container.querySelector<HTMLElement>(".page");
  if (page) {
    page.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) }) as DOMRect;
  }
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

  it("copies nothing on Accept — a screen capture was saved when it was taken — and says where it is", async () => {
    const bridge = await renderMainWindow();
    // The fixture picks an image file: accepted, nothing is copied — the file is still on disk.
    const fromFile = await recognizeIntoProposal(bridge);
    await sendAction({ kind: "acceptPluginProposal", proposalId: fromFile.id });
    expect(statusText()).toBe("Recognition Fixture: inserted recognized structure");

    const capture = {
      mediaType: "image/png" as const,
      bytes: new Uint8Array([137, 80, 78, 71]),
      width: 2,
      height: 2,
      source: "screenRegion" as const
    };
    const fromScreen = await recognizeIntoProposal(bridge);
    vi.spyOn(harness.runtime!.host, "recognitionScreenCaptureOf").mockImplementation((id) =>
      id === fromScreen.id ? capture : undefined
    );
    await sendAction({ kind: "acceptPluginProposal", proposalId: fromScreen.id });

    // One status, settled at once: no second copy is being made in the background.
    expect(statusText()).toBe(
      "Recognition Fixture: inserted recognized structure; its screen capture stays saved (Add or Remove Plugins › Show saved screen captures)"
    );
  });

  it("accepts into a document whose ids and pages differ from the one the proposal was made in", async () => {
    const bridge = await renderMainWindow();
    const first = await recognizeIntoProposal(bridge);
    await sendAction({ kind: "acceptPluginProposal", proposalId: first.id });
    const [takenId] = moleculeIds(bridge);
    const second = await recognizeIntoProposal(bridge);
    const host = harness.runtime!.host;
    // What a proposal made in another document (or an earlier session, whose id reservations are gone)
    // looks like here: an object id this document already uses, on a page it does not have.
    vi.spyOn(host, "acceptProposedPatch").mockImplementation((proposalId, document, options) => {
      const patch = second.proposal.patch as { op: "addObject"; pageId: string; object: { id: string } };
      const foreign = {
        ...second.proposal,
        patch: { ...patch, pageId: "page_from_another_document", object: { ...patch.object, id: takenId } }
      };
      const updated = options!.apply!(document, foreign as typeof second.proposal, {});
      host.rejectProposedPatch(proposalId);
      return updated;
    });

    await sendAction({ kind: "acceptPluginProposal", proposalId: second.id });

    const ids = moleculeIds(bridge);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(takenId);
    expect(statusText()).toBe("Recognition Fixture: inserted recognized structure");
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

describe("closing a report window through the OS (Window > Close Window, Cmd+W)", () => {
  it("is a real panel close: the plugin is told and the panel leaves the detached set", async () => {
    await renderMainWindow();
    const runtime = harness.runtime!;
    const closed = vi.spyOn(runtime.host, "notifyPanelClosed");
    await act(async () => {
      runtime.panels.showReport(RECOGNITION_FIXTURE_PLUGIN_ID, RECOGNITION_FIXTURE_PANEL_ID, {
        title: "Recognizing…",
        sections: []
      });
      runtime.panels.detachPanel(RECOGNITION_FIXTURE_PLUGIN_ID, RECOGNITION_FIXTURE_PANEL_ID);
    });
    expect(runtime.panels.getDetachedPanels()).toHaveLength(1);

    // What lib.rs sends after hiding the window instead of destroying it: the window's label.
    // Another window's label (a toolset palette) is not a panel and changes nothing.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(PLUGIN_PANEL_WINDOW_CLOSED_EVENT, { detail: "toolset-core-main" }));
    });
    expect(closed).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PLUGIN_PANEL_WINDOW_CLOSED_EVENT, {
          detail: `plugin-panel-${pluginPanelWindowId(RECOGNITION_FIXTURE_PLUGIN_ID, RECOGNITION_FIXTURE_PANEL_ID)}`
        })
      );
    });

    expect(closed).toHaveBeenCalledWith(RECOGNITION_FIXTURE_PLUGIN_ID, RECOGNITION_FIXTURE_PANEL_ID);
    // Out of the detached set, the next report takes the open-a-window path again instead of being
    // pushed at a window the main document still believed was open.
    expect(runtime.panels.getDetachedPanels()).toHaveLength(0);
  });
});

// A plugin whose command writes directly (`document.write`), released by the test at the moment it
// chooses — here, in the middle of a canvas drag.
const DIRECT_WRITE_PLUGIN_ID = "org.chemdraft.test.direct-write";
const DIRECT_WRITE_COMMAND_ID = "plugin.directWriteFixture.insert";

function registerDirectWritePlugin(pageId: string): { release: () => void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.runtime!.registerPlugin(
    {
      id: DIRECT_WRITE_PLUGIN_ID,
      name: "Direct Write Fixture",
      version: "0.0.1",
      apiVersion: "^0.1.6",
      entry: "test:direct-write",
      permissions: ["document.write"],
      contributes: {
        commands: [{ id: DIRECT_WRITE_COMMAND_ID, title: "Insert Named Structure", requiredPermissions: ["document.write"] }]
      }
    },
    {
      commandHandlers: {
        [DIRECT_WRITE_COMMAND_ID]: async (context) => {
          await released;
          return context.documents.applyPatch!({
            reason: "deterministic result for a name the user typed",
            patch: {
              op: "addObject",
              pageId,
              object: {
                id: "mol_named_001",
                type: "molecule",
                x: 400,
                y: 300,
                width: 40,
                height: 20,
                rotation: 0,
                style: {},
                structureFormat: "smiles",
                structure: "C=O",
                atoms: [],
                bonds: [],
                superatoms: [],
                rGroups: []
              }
            }
          });
        }
      }
    }
  );
  return { release };
}

function dispatchPen(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    cancelable: true,
    clientX: x,
    clientY: y
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 71 },
    pointerType: { value: "pen" },
    pressure: { value: 0.5 }
  });
  target.dispatchEvent(event);
}

function objectIds(bridge: Bridge): string[] {
  return bridge.snapshot().document.pages.flatMap((page) => page.objects.map((object) => object.id));
}

async function undo(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", metaKey: true }));
  });
}

describe("a plugin's direct write that lands during a canvas drag", () => {
  it("waits for the drag to commit, then commits as its own undo entry, and only then answers the plugin", async () => {
    const bridge = await renderMainWindow({ initialActiveToolCommandId: "tool.art.pencil" });
    const pageId = bridge.snapshot().document.pages[0]!.id;
    const { release } = registerDirectWritePlugin(pageId);
    const page = container!.querySelector<HTMLElement>(".page")!;

    let receipt: unknown;
    let settled = false;
    const invocation = harness.runtime!.host.invokeCommand(DIRECT_WRITE_COMMAND_ID).then((value) => {
      settled = true;
      receipt = value;
    });

    // A pencil stroke in progress: it previews from the document as it was at pointer-down.
    await act(async () => {
      dispatchPen(page, "pointerdown", 180, 180);
      dispatchPen(page, "pointermove", 214, 196);
      dispatchPen(page, "pointermove", 252, 178);
    });
    // The plugin's write arrives mid-stroke.
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(objectIds(bridge)).not.toContain("mol_named_001");
    expect(settled).toBe(false);
    expect(statusText()).toBe("Direct Write Fixture: finish the current edit to insert the result");

    await act(async () => {
      dispatchPen(page, "pointerup", 252, 178);
    });
    await act(async () => {
      await invocation;
    });

    // Both survive: the stroke, and on top of it the insertion the plugin was told about.
    const ids = objectIds(bridge);
    expect(ids).toContain("mol_named_001");
    expect(ids).toHaveLength(2);
    expect(receipt).toEqual({ applied: true, objectIds: ["mol_named_001"] });
    const stroke = ids.find((id) => id !== "mol_named_001")!;

    // History in the order it happened: undo removes the insertion, then the stroke.
    await undo();
    expect(objectIds(bridge)).toEqual([stroke]);
    await undo();
    expect(objectIds(bridge)).toEqual([]);
  });

  it("writes at once when nothing is being dragged", async () => {
    const bridge = await renderMainWindow();
    const pageId = bridge.snapshot().document.pages[0]!.id;
    const { release } = registerDirectWritePlugin(pageId);
    release();
    let receipt: unknown;
    await act(async () => {
      receipt = await harness.runtime!.host.invokeCommand(DIRECT_WRITE_COMMAND_ID);
    });
    expect(receipt).toEqual({ applied: true, objectIds: ["mol_named_001"] });
    expect(objectIds(bridge)).toEqual(["mol_named_001"]);
    expect(statusText()).toBe("Direct Write Fixture: inserted structure");
  });
});

describe("an open host modal keeps the keyboard and the clipboard away from the document", () => {
  function clipboardEvent(type: "cut" | "paste", data: Record<string, string> = {}): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const store = new Map(Object.entries(data));
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: [...store.keys()],
        getData: (format: string) => store.get(format) ?? "",
        setData: (format: string, value: string) => void store.set(format, value)
      }
    });
    return event;
  }

  it("ignores Cut, Paste and Delete from a focused dialog button, and acts once the dialog is gone", async () => {
    const bridge = await renderMainWindow();
    const proposal = await recognizeIntoProposal(bridge);
    await sendAction({ kind: "acceptPluginProposal", proposalId: proposal.id });
    const [inserted] = moleculeIds(bridge);
    expect(bridge.snapshot().selection.objectIds).toEqual([inserted]);

    // The fixture's command opens the host's image-request dialog and waits in it.
    const runtime = harness.runtime!;
    let invocation: Promise<unknown> | undefined;
    await act(async () => {
      invocation = bridge.command(RECOGNITION_FIXTURE_COMMAND_ID);
      await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    });
    const dialog = document.querySelector<HTMLElement>('[aria-modal="true"]');
    expect(dialog).not.toBeNull();
    const button = dialog!.querySelector<HTMLButtonElement>("button")!;
    button.focus();

    const cut = clipboardEvent("cut");
    await act(async () => {
      button.dispatchEvent(cut);
      button.dispatchEvent(clipboardEvent("paste", { "text/plain": "CCO" }));
      button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Delete" }));
      // Focus fallen to <body> while the dialog is still open is no different.
      document.body.dispatchEvent(clipboardEvent("cut"));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(cut.defaultPrevented).toBe(false);
    expect(moleculeIds(bridge)).toEqual([inserted]);

    await act(async () => {
      runtime.images.cancel(runtime.images.getOpenRequest()!.id);
      await invocation;
    });
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();

    // The same Cut, with no dialog open, reaches the canvas selection.
    await act(async () => {
      document.body.dispatchEvent(clipboardEvent("cut"));
    });
    expect(moleculeIds(bridge)).toEqual([]);
  });
});
