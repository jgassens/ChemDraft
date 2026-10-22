// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChemicalMetadataSchema, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { MainWindow, ObjectLayerContextMenu } from "./MainWindow";
import { createLayerActions } from "./commands";
import { createSmilesMolecule, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { createPhase4Document, nativeMoleculeCenter } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@scena/react-ruler", () => ({ default: () => null }));

describe("whole-molecule in-plane rotation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const pointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  const pointerDescriptors = pointerMethods.map(method => Object.getOwnPropertyDescriptor(Element.prototype, method));
  function drawing(): ChemDraftDocument {
    const doc = createPhase4Document("Rigid rotation");
    const graph = depictSmiles2D("[13CH3][C@H](O)C(=O)[O-]");
    const molecule = createSmilesMolecule(doc, { x: 300, y: 300 }, graph,
      "[13CH3][C@H](O)C(=O)[O-]") as MoleculeObject;
    molecule.id = "rotate-me";
    // This document version carries isotopes in chemistry metadata.
    molecule.chemistry = ChemicalMetadataSchema.parse({ isotopeLabels: ["13C"], totalCharge: -1 });
    doc.pages[0].objects = [molecule];
    doc.selection.objectIds = [molecule.id];
    return doc;
  }
  beforeEach(() => {
    for (const method of pointerMethods) {
      Object.defineProperty(Element.prototype, method, { configurable: true,
        value: method === "hasPointerCapture" ? () => false : () => {} });
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pointerMethods.forEach((method, index) => {
      const descriptor = pointerDescriptors[index];
      if (descriptor) Object.defineProperty(Element.prototype, method, descriptor);
      else Reflect.deleteProperty(Element.prototype, method);
    });
  });
  async function mount(doc = drawing()) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({})
    });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const molecule = () => snapshot().pages[0].objects[0] as MoleculeObject;
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function angle(degrees: string) {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Z rotation degrees"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, degrees);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function keep() {
    await act(async () => container.querySelector('[data-rotation-input-popover]')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  function expectRigid(before: MoleculeObject, after: MoleculeObject) {
    const chemistry = (object: MoleculeObject) => ({
      atoms: object.atoms.map(({ x, y, ...atom }) => atom), bonds: object.bonds,
      superatoms: object.superatoms, rGroups: object.rGroups, chemistry: object.chemistry
    });
    expect(chemistry(after)).toEqual(chemistry(before));
    const stereoBefore = perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(before));
    expect(stereoBefore.some(atom => atom.descriptor === "R" || atom.descriptor === "S")).toBe(true);
    expect(perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(after))).toEqual(stereoBefore);
    // All pair distances also constrain bond angles, including non-bonded atom pairs.
    for (let i = 0; i < before.atoms.length; i++) {
      for (let j = i + 1; j < before.atoms.length; j++) {
        const distance = (object: MoleculeObject) => Math.hypot(
          object.atoms[i].x - object.atoms[j].x, object.atoms[i].y - object.atoms[j].y);
        expect(distance(after)).toBeCloseTo(distance(before), 6);
      }
    }
  }

  it("shows the flat rotation handle without Shift, while keeping 3D tilt hidden", async () => {
    await mount();
    expect(container.querySelector('[data-selection-rotate-handle]')).not.toBeNull();
    expect(container.querySelector('[data-selection-tilt3d-handle]')).toBeNull();
    expect(container.querySelector('[data-modifier-hint]')?.textContent).toContain("3D tilt");
    await act(async () => container.querySelector('[data-selection-rotate-handle]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector('[aria-label="Z rotation degrees"]')).not.toBeNull();
  });

  it.each([37.5, -112, 270, 360])("preserves geometry and chemistry for %s degrees", async degrees => {
    await mount();
    const before = molecule();
    await command("layout.rotateMolecule");
    await angle(String(degrees));
    await keep();
    const after = molecule();
    expectRigid(before, after);
    const direction = (object: MoleculeObject) => Math.atan2(
      object.atoms[1].y - object.atoms[0].y, object.atoms[1].x - object.atoms[0].x) * 180 / Math.PI;
    const error = ((direction(after) - direction(before) - degrees) % 360 + 540) % 360 - 180;
    expect(error).toBeCloseTo(0, 6);
    if (degrees === 360) {
      after.atoms.forEach((atom, index) => {
        expect(atom.x).toBeCloseTo(before.atoms[index].x, 6);
        expect(atom.y).toBeCloseTo(before.atoms[index].y, 6);
      });
    } else {
      expect(after.atoms).not.toEqual(before.atoms);
      await command("edit.undo");
      expect(molecule()).toEqual(before);
      await command("edit.redo");
      expect(molecule()).toEqual(after);
    }
    expect(snapshot().selection.objectIds).toEqual([before.id]);
  });

  it("cancels a live rotation preview without changing the molecule", async () => {
    await mount();
    const before = molecule();
    await command("layout.rotateMolecule");
    await angle("47");
    expect(molecule().atoms).not.toEqual(before.atoms);
    await act(async () => container.querySelector('[aria-label="Cancel rotation entry"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(molecule()).toEqual(before);
  });

  it("reopens at the current angle and keeps each accepted rotation as one undo step", async () => {
    await mount();
    const before = molecule();
    await command("layout.rotateMolecule");
    await angle("37.5");
    await keep();
    const first = molecule();
    await command("layout.rotateMolecule");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Z rotation degrees"]')!.value).toBe("37.5");
    await angle("120");
    await keep();
    expectRigid(before, molecule());
    expect(molecule().transform?.rotationDegrees).toBeCloseTo(120, 6);
    await command("edit.undo");
    expect(molecule()).toEqual(first);
    await command("edit.undo");
    expect(molecule()).toEqual(before);
  });

  it("drags the visible handle without Shift and preserves rigid geometry", async () => {
    await mount();
    const before = molecule();
    const center = nativeMoleculeCenter(before);
    const scale = (window.__CHEMDRAFT_AGENT__!.snapshot().viewport as { scale: number }).scale;
    const handle = container.querySelector('[data-selection-rotate-handle]')!;
    const page = container.querySelector(".page")!;
    for (const [target, type, x, y] of [
      [handle, "pointerdown", center.x + 80, center.y],
      // ChemDraft's existing gesture uses one degree per tangential document pixel.
      [page, "pointermove", center.x + 80, center.y + 90],
      [page, "pointerup", center.x + 80, center.y + 90]
    ] as const) {
      await act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true,
          button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x * scale, clientY: y * scale });
        Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
        target.dispatchEvent(event);
        if (type === "pointermove") await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
    }
    expectRigid(before, molecule());
    molecule().atoms.forEach((atom, index) => {
      expect(atom.x).toBeCloseTo(center.x - (before.atoms[index].y - center.y), 6);
      expect(atom.y).toBeCloseTo(center.y + (before.atoms[index].x - center.x), 6);
    });
    await command("edit.undo");
    expect(molecule()).toEqual(before);
  });

  it("opens numeric rotation from the actual selected molecule context menu", async () => {
    await mount();
    const atom = molecule().atoms[0];
    const scale = (window.__CHEMDRAFT_AGENT__!.snapshot().viewport as { scale: number }).scale;
    await act(async () => container.querySelector(".native-molecule-object")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
        button: 2, clientX: atom.x * scale, clientY: atom.y * scale })));
    const item = container.querySelector('[data-context-command="layout.rotateMolecule"]');
    expect(item).not.toBeNull();
    await act(async () => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[aria-label="Z rotation degrees"]')).not.toBeNull();
  });

  it("offers the registered rotation command in the molecule context menu", async () => {
    const action = createLayerActions(drawing()).find(action => action.id === "layout.rotateMolecule")!;
    const invoke = vi.fn();
    await act(async () => root.render(createElement(ObjectLayerContextMenu, {
      rotateMoleculeAction: action, objectId: "rotate-me", objectIndex: 0, objectCount: 1,
      targetKind: "object", position: { x: 0, y: 0 }, onInvoke: invoke
    })));
    const item = container.querySelector('[data-context-command="layout.rotateMolecule"]');
    expect(item?.textContent).toContain("Rotate molecule");
    await act(async () => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(invoke).toHaveBeenCalledExactlyOnceWith(action.id);
  });

  it("disables rotation for empty or multiple-object selections", () => {
    const doc = drawing();
    const enabled = () => createLayerActions(doc).find(action => action.id === "layout.rotateMolecule")!.enabled;
    expect(enabled()).toBe(true);
    doc.selection.objectIds = [];
    expect(enabled()).toBe(false);
    doc.selection.objectIds = ["rotate-me", "another"];
    expect(enabled()).toBe(false);
  });
});
