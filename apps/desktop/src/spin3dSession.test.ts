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
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import {
  applyNativeAtomElementTarget,
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

async function renderMainWindow(
  initialDocument: ChemDraftDocument = createSelectedMoleculeDocument()
): Promise<{ bridge: ChemDraftAgentBridge; container: HTMLDivElement; root: Root }> {
  installDomMocks();
  window.history.replaceState({}, "", "/?agentBridge=1");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MainWindow, {
      initialDocument,
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

async function commitSpinOverlay(container: HTMLDivElement, bridge: ChemDraftAgentBridge) {
  const overlay = container.querySelector<SVGSVGElement>('[data-spin3d-overlay="true"]');
  expect(overlay).not.toBeNull();

  const originalElementFromPoint = document.elementFromPoint;
  const originalRect = overlay!.getBoundingClientRect;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => overlay)
  });
  overlay!.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 1000,
    width: 1000,
    height: 1000,
    toJSON: () => ({})
  } as DOMRect);

  try {
    await act(async () => {
      bridge.pointerDown({ page: { x: 1, y: 1 } }, { pointerId: 91, buttons: 1 });
      await bridge.waitForIdle();
    });
  } finally {
    if (originalElementFromPoint) {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint
      });
    } else {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
    overlay!.getBoundingClientRect = originalRect;
  }
}

function selectedObjectBounds(bridge: ChemDraftAgentBridge): { x: number; y: number; width: number; height: number } {
  const snapshot = bridge.snapshot();
  const selectedId = snapshot.selection.objectIds[0];
  const object = snapshot.objects.find((candidate) => candidate.id === selectedId);
  if (!object) throw new Error("Selected object missing from snapshot.");
  return { x: object.x, y: object.y, width: object.width, height: object.height };
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

  it("commits a Spin 3D flatten and reopens the overlay without moving document bounds", async () => {
    const { bridge, container, root } = await renderMainWindow();
    try {
      await startSpinSession(bridge);
      expect(container.querySelector('[data-spin3d-overlay="true"]')).not.toBeNull();

      await commitSpinOverlay(container, bridge);
      expect(container.querySelector('[data-spin3d-overlay="true"]')).toBeNull();
      const committedBounds = selectedObjectBounds(bridge);

      await startSpinSession(bridge);
      expect(container.querySelector('[data-spin3d-overlay="true"]')).not.toBeNull();
      const reopenedBounds = selectedObjectBounds(bridge);

      expect(reopenedBounds.x).toBeCloseTo(committedBounds.x, 6);
      expect(reopenedBounds.y).toBeCloseTo(committedBounds.y, 6);
      expect(reopenedBounds.width).toBeCloseTo(committedBounds.width, 6);
      expect(reopenedBounds.height).toBeCloseTo(committedBounds.height, 6);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("draws a group label in the overlay the way round its projected bond reads", async () => {
    // OMe on the left end of a bond: its bond is on its right, so the drawing turns it round to
    // "MeO" with its O on the atom. The overlay places labels by its projected bonds each frame
    // (layout-engine's nonElementAtomLabelPlacement). The overlay opens on the conformer's own view,
    // not the drawing's layout; this two-atom fixture opens in the identity view, which keeps the
    // drawing's left-right order, so here it shows the same text and anchoring as the drawing.
    const ethane = createSelectedMoleculeDocument();
    const molecule = ethane.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const left = [...molecule.atoms].sort((first, second) => first.x - second.x)[0]!;
    const labelled = applyNativeAtomElementTarget(ethane, { objectId: molecule.id, kind: "atom", atomId: left.id, distanceToPointer: 0 }, "OMe", { literal: true });
    const { bridge, container, root } = await renderMainWindow(labelled);
    try {
      // Text and anchoring: the anchored "MeO" is drawn from its O outward (text-anchor "end"),
      // where a centred label would be "middle".
      const labelOf = (element: Element) => ({
        label: element.getAttribute("data-atom-label"),
        textAnchor: element.querySelector("text")?.getAttribute("text-anchor")
      });
      const drawn = [...container.querySelectorAll('[data-atom-label="MeO"]')]
        .filter((element) => !element.closest('[data-spin3d-overlay="true"]'))
        .map(labelOf);
      expect(drawn).toEqual([{ label: "MeO", textAnchor: "end" }]);
      await startSpinSession(bridge);
      const overlay = container.querySelector('[data-spin3d-overlay="true"]');
      expect(overlay).not.toBeNull();
      expect([...overlay!.querySelectorAll("[data-atom-label]")].map(labelOf)).toEqual(drawn);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("keeps a recorded CN reading in the spin overlay and matches the flat drawing", async () => {
    const document = createSelectedMoleculeDocument();
    const page = document.pages[0]!;
    const molecule = page.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const left = [...molecule.atoms].sort((first, second) => first.x - second.x)[0]!;
    const neighbor = molecule.atoms.find((atom) => atom.id !== left.id)!;
    const recorded: ChemDraftDocument = {
      ...document,
      pages: document.pages.map((currentPage) => ({
        ...currentPage,
        objects: currentPage.objects.map((object) => object.id !== molecule.id || object.type !== "molecule" ? object : {
          ...object,
          atoms: object.atoms.map((atom) => atom.id === left.id
            ? { ...atom, element: "CN", labelLiteral: true, labelBondSide: { side: "left" as const, atomId: neighbor.id } }
            : atom)
        })
      }))
    };
    const { bridge, container, root } = await renderMainWindow(recorded);
    try {
      const flatLabels = [...container.querySelectorAll('[data-atom-label="NC"]')]
        .filter((element) => !element.closest('[data-spin3d-overlay="true"]'));
      expect(flatLabels).toHaveLength(1);
      await startSpinSession(bridge);
      const overlay = container.querySelector('[data-spin3d-overlay="true"]');
      expect(overlay?.querySelectorAll('[data-atom-label="NC"]')).toHaveLength(1);
      expect(overlay?.querySelector('[data-atom-label="CN"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
