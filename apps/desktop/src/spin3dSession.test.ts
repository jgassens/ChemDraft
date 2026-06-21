// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import type { ConformerStageHandlers } from "./conformerClient";
import type { ChemDraftAgentBridge } from "./agentBridge";

const conformerMock = vi.hoisted(() => {
  let handlers: ConformerStageHandlers | undefined;
  const cancel = vi.fn();
  const client = {
    generate: vi.fn((_molfile, _atomCount, _options, _enginePreference, nextHandlers: ConformerStageHandlers) => {
      handlers = nextHandlers;
      return cancel;
    }),
    prefetch: vi.fn(),
    warmup: vi.fn()
  };

  return {
    cancel,
    client,
    get handlers() {
      return handlers;
    },
    reset() {
      handlers = undefined;
      cancel.mockClear();
      client.generate.mockClear();
      client.prefetch.mockClear();
      client.warmup.mockClear();
    }
  };
});

vi.mock("./conformerClient", () => ({
  getConformerWorkerClient: () => conformerMock.client
}));

vi.mock("@scena/react-ruler", () => ({
  default: () => null
}));

import { AGENT_BRIDGE_GLOBAL_NAME } from "./agentBridge";
import {
  createPhase4Document,
  insertNativeSingleBondMolecule,
  selectDocumentObjects
} from "./documentWorkflow";
import { MainWindow } from "./MainWindow";

function installDomMocks() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  window.requestAnimationFrame ??= frame;
  window.cancelAnimationFrame ??= (handle: number) => window.clearTimeout(handle);
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??= TestResizeObserver;
  globalThis.ResizeObserver ??= TestResizeObserver;
  const htmlPrototype = window.HTMLElement.prototype as HTMLElement & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
  };
  htmlPrototype.setPointerCapture ??= vi.fn();
  htmlPrototype.releasePointerCapture ??= vi.fn();
  htmlPrototype.hasPointerCapture ??= vi.fn(() => true);
  const svgPrototype = window.SVGElement.prototype as SVGElement & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
  };
  svgPrototype.setPointerCapture ??= vi.fn();
  svgPrototype.releasePointerCapture ??= vi.fn();
  svgPrototype.hasPointerCapture ??= vi.fn(() => true);
}

function conformerResult(status: NonNullable<Generate3DConformerResult["forceField"]>["status"]): Generate3DConformerResult {
  return {
    mapping: {
      coords3dByOriginalAtom: new Float64Array([0, 0, 0, 1, 0.5, 0.25]),
      originalToEngineAtom: [0, 1],
      engineToOriginalAtom: [0, 1],
      generatedHydrogenEngineAtoms: []
    },
    originalAtomCount: 2,
    generatedAtomCount: 2,
    hydrogens: { added: false, explicitInputHydrogensPreserved: false },
    embed: { status: "ok" },
    forceField: { name: "UFF", status, iterations: 1 },
    engine: { name: "openchemlib", version: "test", parameters: {} },
    unsupportedFeatures: [],
    warnings: []
  };
}

async function waitForBridge(): Promise<ChemDraftAgentBridge> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bridge = window[AGENT_BRIDGE_GLOBAL_NAME];
    if (bridge) return bridge;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Agent bridge was not installed.");
}

function createSelectedMoleculeDocument() {
  const document = insertNativeSingleBondMolecule(createPhase4Document("Spin session test"), { x: 300, y: 300 });
  const page = document.pages[0];
  const molecule = page.objects.find((object) => object.type === "molecule");
  if (!molecule) throw new Error("Expected fixture molecule.");
  return selectDocumentObjects(document, page.id, [molecule.id]);
}

async function renderMainWindow(): Promise<{ bridge: ChemDraftAgentBridge; container: HTMLDivElement; root: Root }> {
  installDomMocks();
  window.history.replaceState({}, "", "/?agentBridge=1");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MainWindow, {
      initialDocument: createSelectedMoleculeDocument(),
      initialPaletteMode: "hidden",
      initialRulersVisible: false,
      nativePalette: true
    }));
  });
  const bridge = await waitForBridge();
  return { bridge, container, root };
}

async function startSpinSession(bridge: ChemDraftAgentBridge) {
  await act(async () => {
    await bridge.command("structure.spin3d");
  });

  expect(conformerMock.handlers).toBeDefined();
  await act(async () => {
    conformerMock.handlers?.onEmbedded(conformerResult("converged"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    conformerMock.handlers?.onRefined(conformerResult("converged"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  delete window[AGENT_BRIDGE_GLOBAL_NAME];
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = "";
  conformerMock.reset();
});

describe("Spin 3D session state", () => {
  it("cancels the transient spin overlay before document undo mutates history", async () => {
    const { bridge, container, root } = await renderMainWindow();
    try {
      const initialPageHeight = bridge.snapshot().page.height;
      await act(async () => {
        await bridge.command("page.setSize.legal");
      });
      expect(bridge.snapshot().page.height).toBeGreaterThan(initialPageHeight);

      await startSpinSession(bridge);
      expect(container.querySelector('[data-spin3d-overlay="true"]')).not.toBeNull();

      await act(async () => {
        await bridge.command("edit.undo");
      });
      expect(container.querySelector('[data-spin3d-overlay="true"]')).toBeNull();
      expect(bridge.snapshot().page.objectCount).toBe(1);
      expect(bridge.snapshot().page.height).toBeGreaterThan(initialPageHeight);

      await act(async () => {
        await bridge.command("edit.undo");
      });
      expect(bridge.snapshot().page.objectCount).toBe(1);
      expect(bridge.snapshot().page.height).toBe(initialPageHeight);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("clears the transient spin overlay when New replaces the document", async () => {
    const { bridge, container, root } = await renderMainWindow();
    try {
      await startSpinSession(bridge);
      expect(container.querySelector('[data-spin3d-overlay="true"]')).not.toBeNull();

      await act(async () => {
        await bridge.command("document.new");
      });
      expect(container.querySelector('[data-spin3d-overlay="true"]')).toBeNull();
      expect(bridge.snapshot().page.objectCount).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
