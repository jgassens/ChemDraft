// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPalette } from "../../ToolPalette";
import { getToolsetItemGroups, type ToolbarPaletteItemModel } from "../../toolsets";
import { createMoleculeInspectorModel } from "../../moleculeInspectorModel";
import { classifyToolbarSelection, type ToolbarSelectionModel } from "../toolbarSelectionKind";
import type { ToolbarWidgetState } from "../toolbarWidgets";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { applyPatches } from "@chemdraft/chem-core";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function widgetOnlyItemGroups(): ToolbarPaletteItemModel[][] {
  return [getToolsetItemGroups("core.main").flat().filter((item) => item.primary.type === "control")];
}

function singleBondMolecule(id: string): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 100,
    y: 100,
    width: 72,
    height: 32,
    rotation: 0,
    structureFormat: "smiles",
    structure: "CC",
    style: {},
    atoms: [
      { id: `${id}_atom_1`, element: "C", x: 100, y: 100, formalCharge: 0 },
      { id: `${id}_atom_2`, element: "C", x: 172, y: 100, formalCharge: 0 }
    ],
    bonds: [
      { id: `${id}_bond_1`, fromAtomId: `${id}_atom_1`, toAtomId: `${id}_atom_2`, order: "single" }
    ],
    superatoms: [],
    rGroups: []
  };
}

function moleculeSelection(): { document: ChemDraftDocument; selection: ToolbarSelectionModel; molecule: MoleculeObject } {
  const molecule = singleBondMolecule("mol_widget");
  const empty = createEmptyDocument({ id: "doc_widget", pageId: "page_widget", title: "Widget" });
  const withObject = { ...empty, pages: [{ ...empty.pages[0], objects: [molecule] }] };
  const document = applyPatches(withObject, [
    { op: "setSelection", pageId: withObject.pages[0].id, objectIds: [molecule.id] }
  ]);
  const selection = classifyToolbarSelection({ document, moleculeContext: "molecule" });
  return { document, selection, molecule };
}

describe("MainStyleWidget variants", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderWidget(widgetState: Partial<ToolbarWidgetState> & { onInvoke?: (commandId: string) => void }, customize = false) {
    const onInvoke = widgetState.onInvoke ?? vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        itemGroups: widgetOnlyItemGroups(),
        activeTool: "tool.select",
        orientation: "horizontal",
        onInvoke,
        customize: customize ? { groupIds: ["core.main.items"] } : undefined,
        widgetState: { ...widgetState, onInvoke }
      }));
    });
    return { onInvoke };
  }

  function widgetRoot(): HTMLElement {
    const element = container.querySelector<HTMLElement>("[data-toolbar-style-controls=\"main\"]");
    if (!element) {
      throw new Error("Expected the main style widget.");
    }
    return element;
  }

  it("renders the text layout when no selection model is supplied (back-compat)", () => {
    renderWidget({});
    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("text");
    expect(widget.querySelector("[aria-label=\"Text font\"]")).not.toBeNull();
    expect(widget.querySelector("[aria-label=\"Text size\"]")).not.toBeNull();
    expect(widget.querySelector("[data-command-id=\"text.bold\"]")).not.toBeNull();
    expect(widget.querySelector("[data-command-id=\"text.align.left\"]")).not.toBeNull();
    expect(widget.querySelector("[data-command-id=\"text.color.black\"]")).not.toBeNull();
    expect(widget.querySelector("[data-command-id=\"text.color.cyan\"]")).toBeNull();
  });

  it("renders the molecule layout for a molecule selection and routes its commands", () => {
    const { document: moleculeDocument, selection } = moleculeSelection();
    const inspector = createMoleculeInspectorModel(moleculeDocument, {
      selectedObjectIds: moleculeDocument.selection.objectIds
    });
    const { onInvoke } = renderWidget({ currentSelection: selection, currentMoleculeInspector: inspector });

    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("molecule");
    expect(widget.querySelector("[aria-label=\"Text font\"]")).toBeNull();
    expect(widget.querySelector("[aria-label=\"Atom label font\"]")).not.toBeNull();
    expect(widget.querySelector("[aria-label=\"Bond and atom color\"]")).not.toBeNull();

    const widthSelect = widget.querySelector<HTMLSelectElement>("[aria-label=\"Bond line width\"]");
    if (!widthSelect) {
      throw new Error("Expected bond line width select.");
    }
    expect(widthSelect.value).toBe("molecule.structure.bondStrokeWidth:2");
    act(() => {
      widthSelect.value = "molecule.structure.bondStrokeWidth:3";
      widthSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("molecule.structure.bondStrokeWidth:3");

    const moreButton = widget.querySelector<HTMLButtonElement>("[data-command-id=\"tool.settings\"]");
    expect(moreButton).not.toBeNull();
  });

  it("invokes exactly once per swatch press in the molecule layout", () => {
    const { document: moleculeDocument, selection } = moleculeSelection();
    const inspector = createMoleculeInspectorModel(moleculeDocument, {
      selectedObjectIds: moleculeDocument.selection.objectIds
    });
    const { onInvoke } = renderWidget({ currentSelection: selection, currentMoleculeInspector: inspector });

    const swatch = widgetRoot().querySelector<HTMLButtonElement>("[data-command-id=\"text.color.blue\"]");
    if (!swatch) {
      throw new Error("Expected the blue swatch.");
    }
    act(() => {
      swatch.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      swatch.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      swatch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(onInvoke).toHaveBeenCalledWith("text.color.blue");
  });

  it("toggles hydrogen and terminal-carbon display with negated boolean commands", () => {
    const { document: moleculeDocument, selection } = moleculeSelection();
    const inspector = createMoleculeInspectorModel(moleculeDocument, {
      selectedObjectIds: moleculeDocument.selection.objectIds
    });
    const { onInvoke } = renderWidget({ currentSelection: selection, currentMoleculeInspector: inspector });

    const hideH = widgetRoot().querySelector<HTMLButtonElement>("[aria-label=\"Hide Implicit Hydrogens\"]");
    if (!hideH) {
      throw new Error("Expected the hide-hydrogens toggle.");
    }
    expect(hideH.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      hideH.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      hideH.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("molecule.atomLabel.hideImplicitHydrogens:true");
  });

  it("renders the shape layout for a plain graphic and targets fill or stroke", async () => {
    const { createPhase4Document, insertNativeArtGraphicObject } = await import("../../documentWorkflow");
    const { createArtInspectorModel, selectedGraphicObjectsForArtInspector } = await import("../../artInspectorModel");
    const shapeDocument = insertNativeArtGraphicObject(
      createPhase4Document("Shape widget"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const selection = classifyToolbarSelection({ document: shapeDocument, moleculeContext: "none" });
    expect(selection.kind).toBe("shape");
    const artStyle = createArtInspectorModel({
      document: shapeDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(shapeDocument),
      requestedPaintTarget: "fill"
    });
    const { onInvoke } = renderWidget({
      currentSelection: selection,
      currentArtStyle: artStyle,
      currentArtStyleTarget: "fill"
    });

    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("shape");
    expect(widget.querySelector("[aria-label=\"Fill color\"]")).not.toBeNull();
    expect(widget.querySelector("[data-command-id=\"object.color.blue\"]")).not.toBeNull();
    expect(widget.querySelector("[aria-label=\"Stroke width\"]")).not.toBeNull();
    expect(widget.querySelector("[aria-label=\"Dash pattern\"]")).not.toBeNull();
    expect(widget.querySelector("[data-command-id=\"object.style.swapFillStroke\"]")).not.toBeNull();

    const strokeTarget = widget.querySelector<HTMLButtonElement>("[data-command-id=\"object.style.target.stroke\"]");
    if (!strokeTarget) {
      throw new Error("Expected the stroke target toggle.");
    }
    act(() => {
      strokeTarget.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      strokeTarget.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.style.target.stroke");
  });

  it("pins the text layout while customizing, whatever is selected", () => {
    const { selection } = moleculeSelection();
    renderWidget({ currentSelection: selection }, true);
    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("text");
    expect(widget.querySelector("[aria-label=\"Text font\"]")).not.toBeNull();
  });
});
