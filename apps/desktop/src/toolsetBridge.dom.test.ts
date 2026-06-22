// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainWindow } from "./MainWindow";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import {
  applyMoleculeRingFillColor,
  applyNativeTemplateToolAtTarget,
  createPhase4Document,
  insertNativeTemplateMolecule
} from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { objectFillOpacityCommandId } from "./commands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const pageRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 792,
  bottom: 612,
  width: 792,
  height: 612,
  toJSON: () => ({})
} as DOMRect;

describe("toolset bridge interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  async function renderMainWindow(initialDocument = createPhase4Document("Toolset Bridge")) {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(MainWindow, {
        initialCrosshairsVisible: false,
        initialDocument,
        initialPaletteMode: "floating",
        initialRulersVisible: false,
        nativePalette: false
      })));
    });
    pageElement().getBoundingClientRect = () => pageRect;
    await act(async () => {
      await Promise.resolve();
    });
  }

  function pageElement(): HTMLElement {
    const page = container.querySelector<HTMLElement>(".page");
    if (!page) {
      throw new Error("Expected rendered page.");
    }
    return page;
  }

  function routeCommand(commandId: string) {
    act(() => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
        detail: { commandId }
      }));
    });
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointerup",
    point: { x: number; y: number },
    pointerId: number,
    options: { shiftKey?: boolean } = {}
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      shiftKey: options.shiftKey
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: pointerId },
      pointerType: { value: "mouse" }
    });
    target.dispatchEvent(event);
  }

  function ringHitTarget(ringKey: string): SVGPathElement {
    const target = Array.from(container.querySelectorAll<SVGPathElement>(".native-molecule-ring-hit-target"))
      .find((candidate) => candidate.dataset.ringHitKey === ringKey);
    if (!target) {
      throw new Error(`Expected rendered ring hit target for ${ringKey}.`);
    }
    return target;
  }

  it("does not double-toggle toolset commands after StrictMode remounts bridge effects", async () => {
    await renderMainWindow();

    expect(container.querySelector('[data-toolset-id="core.moleculeInspector"]')).toBeNull();

    routeCommand("view.toggleMoleculeInspector");

    expect(container.querySelectorAll('[data-toolset-id="core.moleculeInspector"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Toggled Molecule Inspector");
  });

  it("does not select ring interiors while Molecule Inspector is closed", async () => {
    const initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Selection Gate"),
      { x: 300, y: 300 },
      "benzene"
    );
    const molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected benzene ring.");
    }

    await renderMainWindow(initialDocument);

    await act(async () => {
      const target = ringHitTarget(ring.ringKey);
      dispatchPointer(target, "pointerdown", ring.center, 6);
      dispatchPointer(target, "pointerup", ring.center, 6);
    });

    expect(container.querySelector(`[data-selected-native-ring-key="${ring.ringKey}"]`)).toBeNull();
    expect(container.querySelector('[data-toolbar-style-controls="art"][data-art-appearance-target="molecule-rings"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).not.toBe("Selected ring");
  });

  it("clears an active ring selection when Molecule Inspector closes", async () => {
    const initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Selection Close Gate"),
      { x: 300, y: 300 },
      "benzene"
    );
    const molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected benzene ring.");
    }

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(ring.ringKey);
      dispatchPointer(target, "pointerdown", ring.center, 7);
      dispatchPointer(target, "pointerup", ring.center, 7);
    });

    expect(container.querySelector(`[data-selected-native-ring-key="${ring.ringKey}"]`)).not.toBeNull();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    });
    routeCommand("view.toggleMoleculeInspector");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-toolset-id="core.moleculeInspector"]')).toBeNull();
    expect(container.querySelector(`[data-selected-native-ring-key="${ring.ringKey}"]`)).toBeNull();
    expect(container.querySelector('[data-toolbar-style-controls="art"][data-art-appearance-target="molecule-rings"]')).toBeNull();
  });

  it("selects a rendered ring interior and enables Molecule Inspector ring controls", async () => {
    const initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Selection"),
      { x: 300, y: 300 },
      "benzene"
    );
    const molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected benzene ring.");
    }

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(ring.ringKey);
      dispatchPointer(target, "pointerdown", ring.center, 7);
      dispatchPointer(target, "pointerup", ring.center, 7);
    });

    expect(container.querySelector(`[data-selected-native-ring-key="${ring.ringKey}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-selected-ring-key="${ring.ringKey}"]`)).not.toBeNull();
    expect(container.querySelector("[data-molecule-inspector-selection-count=\"1\"]")).not.toBeNull();
    const blueSwatch = container.querySelector<HTMLButtonElement>('[aria-label="Ring Color: Blue"]');
    expect(blueSwatch?.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selected ring");

    await act(async () => {
      blueSwatch?.click();
    });

    const renderedRingFill = container.querySelector<SVGPathElement>(
      `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
    );
    expect(renderedRingFill?.getAttribute("fill")).toBe("#1f5fbf");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Updated selected ring fill");
  });

  it("routes Art toolbar fill and effects to the selected ring target", async () => {
    const initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Art Routing"),
      { x: 300, y: 300 },
      "benzene"
    );
    const molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected benzene ring.");
    }

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(ring.ringKey);
      dispatchPointer(target, "pointerdown", ring.center, 17);
      dispatchPointer(target, "pointerup", ring.center, 17);
    });

    expect(container.querySelector('[data-toolbar-style-controls="art"][data-art-appearance-target="molecule-rings"]')).not.toBeNull();
    expect(container.querySelector('[data-art-inspector-slider="object-opacity"]')).toBeNull();
    expect(container.querySelector('[data-art-inspector-slider="fill-opacity"]')).not.toBeNull();

    routeCommand("object.color.red");
    let renderedRingFill = container.querySelector<SVGPathElement>(
      `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
    );
    expect(renderedRingFill?.getAttribute("fill")).toBe("#b3261e");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Updated selected ring fill");

    routeCommand(objectFillOpacityCommandId(0.42));
    renderedRingFill = container.querySelector<SVGPathElement>(
      `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
    );
    expect(renderedRingFill?.getAttribute("fill-opacity")).toBe("0.42");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Updated selected ring fill opacity");

    routeCommand("object.effect.glow");
    expect(container.querySelector('[data-art-effect-controls="glow"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Applied selected ring glow effect");
  });

  it("shift-selects multiple rendered rings and applies one inspector fill to all of them", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Multi Ring Selection"),
      { x: 300, y: 300 },
      "benzene"
    );
    let molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const sharedBond = molecule.bonds.find((bond) => bond.id === "bond_001");
    const fromAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.fromAtomId);
    const toAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.toAtomId);
    if (!sharedBond || !fromAtom || !toAtom) {
      throw new Error("Expected benzene fusion bond.");
    }

    initialDocument = applyNativeTemplateToolAtTarget(
      initialDocument,
      {
        objectId: molecule.id,
        kind: "bond",
        bondId: sharedBond.id,
        fromAtomId: sharedBond.fromAtomId,
        toAtomId: sharedBond.toAtomId,
        distanceToPointer: 0
      },
      { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 },
      "benzene"
    );
    molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected fused molecule.");
    }
    const rings = nativeMoleculeRings(molecule);
    expect(rings).toHaveLength(2);

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(rings[0].ringKey);
      dispatchPointer(target, "pointerdown", rings[0].center, 8, { shiftKey: true });
      dispatchPointer(target, "pointerup", rings[0].center, 8, { shiftKey: true });
    });
    await act(async () => {
      const target = ringHitTarget(rings[1].ringKey);
      dispatchPointer(target, "pointerdown", rings[1].center, 9, { shiftKey: true });
      dispatchPointer(target, "pointerup", rings[1].center, 9, { shiftKey: true });
    });

    expect(container.querySelector("[data-molecule-inspector-selection-count=\"2\"]")).not.toBeNull();
    expect(container.querySelector(`[data-selected-native-ring-keys="${rings.map((ring) => ring.ringKey).join(",")}"]`)).not.toBeNull();
    expect(container.querySelectorAll(".native-molecule-selected-ring")).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selected 2 rings");

    const blueSwatch = container.querySelector<HTMLButtonElement>('[aria-label="Ring Color: Blue"]');
    expect(blueSwatch?.disabled).toBe(false);
    await act(async () => {
      blueSwatch?.click();
    });

    rings.forEach((ring) => {
      const renderedRingFill = container.querySelector<SVGPathElement>(
        `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
      );
      expect(renderedRingFill?.getAttribute("fill")).toBe("#1f5fbf");
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Updated 2 selected ring fills");
  });

  it("adds a second ring after a normal first-ring click with Shift held", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Additive Selection"),
      { x: 300, y: 300 },
      "benzene"
    );
    let molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const sharedBond = molecule.bonds.find((bond) => bond.id === "bond_001");
    const fromAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.fromAtomId);
    const toAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.toAtomId);
    if (!sharedBond || !fromAtom || !toAtom) {
      throw new Error("Expected benzene fusion bond.");
    }

    initialDocument = applyNativeTemplateToolAtTarget(
      initialDocument,
      {
        objectId: molecule.id,
        kind: "bond",
        bondId: sharedBond.id,
        fromAtomId: sharedBond.fromAtomId,
        toAtomId: sharedBond.toAtomId,
        distanceToPointer: 0
      },
      { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 },
      "benzene"
    );
    molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected fused molecule.");
    }
    const rings = nativeMoleculeRings(molecule);
    expect(rings).toHaveLength(2);

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(rings[0].ringKey);
      dispatchPointer(target, "pointerdown", rings[0].center, 18);
      dispatchPointer(target, "pointerup", rings[0].center, 18);
    });
    expect(container.querySelector(`[data-selected-native-ring-key="${rings[0].ringKey}"]`)).not.toBeNull();

    await act(async () => {
      const target = ringHitTarget(rings[1].ringKey);
      dispatchPointer(target, "pointerdown", rings[1].center, 19, { shiftKey: true });
      dispatchPointer(target, "pointerup", rings[1].center, 19, { shiftKey: true });
    });

    expect(container.querySelector(`[data-selected-native-ring-keys="${rings.map((ring) => ring.ringKey).join(",")}"]`)).not.toBeNull();
    expect(container.querySelectorAll(".native-molecule-selected-ring")).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selected 2 rings");
  });

  it("extends ring selection when Shift is tracked from keyboard state", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Keyboard Shift Selection"),
      { x: 300, y: 300 },
      "benzene"
    );
    let molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const sharedBond = molecule.bonds.find((bond) => bond.id === "bond_001");
    const fromAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.fromAtomId);
    const toAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.toAtomId);
    if (!sharedBond || !fromAtom || !toAtom) {
      throw new Error("Expected benzene fusion bond.");
    }

    initialDocument = applyNativeTemplateToolAtTarget(
      initialDocument,
      {
        objectId: molecule.id,
        kind: "bond",
        bondId: sharedBond.id,
        fromAtomId: sharedBond.fromAtomId,
        toAtomId: sharedBond.toAtomId,
        distanceToPointer: 0
      },
      { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 },
      "benzene"
    );
    molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected fused molecule.");
    }
    const rings = nativeMoleculeRings(molecule);
    expect(rings).toHaveLength(2);

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(rings[0].ringKey);
      dispatchPointer(target, "pointerdown", rings[0].center, 30);
      dispatchPointer(target, "pointerup", rings[0].center, 30);
    });
    expect(container.querySelector(`[data-selected-native-ring-key="${rings[0].ringKey}"]`)).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", shiftKey: true }));
      const target = ringHitTarget(rings[1].ringKey);
      dispatchPointer(target, "pointerdown", rings[1].center, 31);
      dispatchPointer(target, "pointerup", rings[1].center, 31);
      window.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
    });

    expect(container.querySelector(`[data-selected-native-ring-keys="${rings.map((ring) => ring.ringKey).join(",")}"]`)).not.toBeNull();
    expect(container.querySelectorAll(".native-molecule-selected-ring")).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selected 2 rings");
  });

  it("replaces the ring selection on a plain (no-modifier) second-ring click", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Ring Target Fallback Selection"),
      { x: 300, y: 300 },
      "benzene"
    );
    let molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const sharedBond = molecule.bonds.find((bond) => bond.id === "bond_001");
    const fromAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.fromAtomId);
    const toAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.toAtomId);
    if (!sharedBond || !fromAtom || !toAtom) {
      throw new Error("Expected benzene fusion bond.");
    }

    initialDocument = applyNativeTemplateToolAtTarget(
      initialDocument,
      {
        objectId: molecule.id,
        kind: "bond",
        bondId: sharedBond.id,
        fromAtomId: sharedBond.fromAtomId,
        toAtomId: sharedBond.toAtomId,
        distanceToPointer: 0
      },
      { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 },
      "benzene"
    );
    molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected fused molecule.");
    }
    const rings = nativeMoleculeRings(molecule);
    expect(rings).toHaveLength(2);

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(rings[0].ringKey);
      dispatchPointer(target, "pointerdown", rings[0].center, 32);
      dispatchPointer(target, "pointerup", rings[0].center, 32);
    });
    expect(container.querySelector(`[data-selected-native-ring-key="${rings[0].ringKey}"]`)).not.toBeNull();

    await act(async () => {
      const target = ringHitTarget(rings[1].ringKey);
      dispatchPointer(target, "pointerdown", rings[1].center, 33);
      dispatchPointer(target, "pointerup", rings[1].center, 33);
    });

    // Without a modifier the second ring replaces the first. The old no-Shift "continuation" that
    // masked unreliable Shift detection is gone — additive ring selection now requires Shift/Alt.
    expect(container.querySelector(`[data-selected-native-ring-key="${rings[1].ringKey}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-selected-native-ring-key="${rings[0].ringKey}"]`)).toBeNull();
    expect(container.querySelectorAll(".native-molecule-selected-ring")).toHaveLength(1);
    expect(container.querySelector("[data-molecule-inspector-selection-count=\"1\"]")).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Selected ring");
  });

  it("stress-routes repeated Art commands across a multi-ring selection", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Rendered Multi Ring Art Stress"),
      { x: 300, y: 300 },
      "benzene"
    );
    let molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const sharedBond = molecule.bonds.find((bond) => bond.id === "bond_001");
    const fromAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.fromAtomId);
    const toAtom = molecule.atoms.find((atom) => atom.id === sharedBond?.toAtomId);
    if (!sharedBond || !fromAtom || !toAtom) {
      throw new Error("Expected benzene fusion bond.");
    }

    initialDocument = applyNativeTemplateToolAtTarget(
      initialDocument,
      {
        objectId: molecule.id,
        kind: "bond",
        bondId: sharedBond.id,
        fromAtomId: sharedBond.fromAtomId,
        toAtomId: sharedBond.toAtomId,
        distanceToPointer: 0
      },
      { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 },
      "benzene"
    );
    molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected fused molecule.");
    }
    const rings = nativeMoleculeRings(molecule);
    expect(rings).toHaveLength(2);

    await renderMainWindow(initialDocument);
    routeCommand("view.toggleMoleculeInspector");

    await act(async () => {
      const target = ringHitTarget(rings[0].ringKey);
      dispatchPointer(target, "pointerdown", rings[0].center, 21, { shiftKey: true });
      dispatchPointer(target, "pointerup", rings[0].center, 21, { shiftKey: true });
    });
    await act(async () => {
      const target = ringHitTarget(rings[1].ringKey);
      dispatchPointer(target, "pointerdown", rings[1].center, 22, { shiftKey: true });
      dispatchPointer(target, "pointerup", rings[1].center, 22, { shiftKey: true });
    });

    expect(container.querySelector('[data-toolbar-style-controls="art"][data-art-appearance-target="molecule-rings"]')).not.toBeNull();

    routeCommand("object.color.red");
    routeCommand("object.paint.type.none");
    for (const ring of rings) {
      const renderedRingFill = container.querySelector<SVGPathElement>(
        `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
      );
      expect(renderedRingFill?.getAttribute("fill")).not.toBe("#b3261e");
    }

    routeCommand("object.paint.type.solid");
    routeCommand("object.color.green");
    routeCommand(objectFillOpacityCommandId(0.12));
    routeCommand("object.effect.glow");
    routeCommand("object.effect.shadow");
    routeCommand("object.effect.none");

    for (const ring of rings) {
      const renderedRingFill = container.querySelector<SVGPathElement>(
        `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
      );
      expect(renderedRingFill?.getAttribute("fill")).toBe("#1d7f68");
      expect(renderedRingFill?.getAttribute("fill-opacity")).toBe("0.12");
    }
    expect(container.querySelector('[data-art-effect-controls="glow"]')).toBeNull();
    expect(container.querySelector('[data-art-effect-controls="shadow"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Cleared 2 selected ring effects");
  });

  it("requires an explicit choice before whole-molecule Art edits clear ring overrides", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Molecule Ring Override Prompt"),
      { x: 300, y: 300 },
      "benzene"
    );
    const molecule = initialDocument.pages[0]?.objects[0];
    if (molecule?.type !== "molecule") {
      throw new Error("Expected benzene molecule.");
    }
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected benzene ring.");
    }

    initialDocument = applyMoleculeRingFillColor(
      {
        ...initialDocument,
        selection: { objectIds: [molecule.id] }
      },
      { objectId: molecule.id, kind: "ring", ringKey: ring.ringKey },
      "#1f5fbf"
    );

    await renderMainWindow(initialDocument);

    expect(container.querySelector('[data-toolbar-style-controls="art"][data-art-appearance-target="objects"]')).not.toBeNull();
    routeCommand("object.color.red");

    const prompt = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Per-ring appearance attributes"]');
    expect(prompt).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Choose how to handle per-ring attributes");
    let renderedRingFill = container.querySelector<SVGPathElement>(
      `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
    );
    expect(renderedRingFill?.getAttribute("fill")).toBe("#1f5fbf");

    const keepButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Keep Overrides");
    await act(async () => {
      keepButton?.click();
    });

    expect(container.querySelector('[role="dialog"][aria-label="Per-ring appearance attributes"]')).toBeNull();
    renderedRingFill = container.querySelector<SVGPathElement>(
      `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
    );
    expect(renderedRingFill?.getAttribute("fill")).toBe("#1f5fbf");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Updated selected fill");

    routeCommand("object.color.green");
    const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Clear Overrides");
    await act(async () => {
      clearButton?.click();
    });

    expect(container.querySelector('[role="dialog"][aria-label="Per-ring appearance attributes"]')).toBeNull();
    renderedRingFill = container.querySelector<SVGPathElement>(
      `[data-molecule-fill-ring="true"][data-ring-key="${ring.ringKey}"]`
    );
    expect(renderedRingFill?.getAttribute("fill")).not.toBe("#1f5fbf");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Updated selected fill; cleared ring overrides");
  });

  it("shift-clicking a bond on a second molecule adds it without replacing the first selection", async () => {
    let initialDocument = insertNativeTemplateMolecule(
      createPhase4Document("Cross-molecule shift add"),
      { x: 220, y: 220 },
      "benzene"
    );
    initialDocument = insertNativeTemplateMolecule(initialDocument, { x: 560, y: 220 }, "benzene");
    const molA = initialDocument.pages[0]?.objects[0];
    const molB = initialDocument.pages[0]?.objects[1];
    if (molA?.type !== "molecule" || molB?.type !== "molecule") {
      throw new Error("Expected two benzene molecules.");
    }

    const midpointOf = (molecule: typeof molA, bondId: string) => {
      const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
      const from = molecule.atoms.find((atom) => atom.id === bond?.fromAtomId);
      const to = molecule.atoms.find((atom) => atom.id === bond?.toAtomId);
      if (!from || !to) {
        throw new Error(`Expected ${bondId} endpoints.`);
      }
      return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    };
    const wrapperFor = (objectId: string) => {
      const element = container.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`);
      if (!element) {
        throw new Error(`Expected wrapper for ${objectId}.`);
      }
      return element;
    };

    await renderMainWindow(initialDocument);

    // Plain-click a bond on molecule A selects that bond.
    await act(async () => {
      const target = wrapperFor(molA.id);
      dispatchPointer(target, "pointerdown", midpointOf(molA, "bond_001"), 41);
      dispatchPointer(target, "pointerup", midpointOf(molA, "bond_001"), 41);
    });
    expect(wrapperFor(molA.id).getAttribute("data-selected-native-bond-id")).toBe("bond_001");

    // Shift-clicking a bond on molecule B must ADD it (at object grain), preserving A's selection.
    await act(async () => {
      const target = wrapperFor(molB.id);
      dispatchPointer(target, "pointerdown", midpointOf(molB, "bond_001"), 42, { shiftKey: true });
      dispatchPointer(target, "pointerup", midpointOf(molB, "bond_001"), 42, { shiftKey: true });
    });

    // A's bond selection survives (regression: this used to be replaced)...
    expect(wrapperFor(molA.id).getAttribute("data-selected-native-bond-id")).toBe("bond_001");
    // ...and molecule B is added to the selection as a whole object (object-grain cross-molecule
    // add, since the legacy single slot can't hold a native part for two molecules at once).
    expect(wrapperFor(molB.id).classList.contains("native-molecule-selected")).toBe(true);
  });
});
