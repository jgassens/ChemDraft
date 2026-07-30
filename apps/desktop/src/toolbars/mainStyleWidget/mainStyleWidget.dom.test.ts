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

  it("renders the arrow layout for an arrow selection with head kind, tail toggle, and head size", async () => {
    const { createPhase4Document, insertNativeArtGraphicObject } = await import("../../documentWorkflow");
    const { createArtInspectorModel, selectedGraphicObjectsForArtInspector } = await import("../../artInspectorModel");
    const arrowDocument = insertNativeArtGraphicObject(
      createPhase4Document("Arrow widget"),
      { x: 220, y: 180 },
      "tool.art.reactionArrow"
    );
    const selection = classifyToolbarSelection({ document: arrowDocument, moleculeContext: "none" });
    expect(selection.kind).toBe("arrow");
    const artStyle = createArtInspectorModel({
      document: arrowDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(arrowDocument),
      requestedPaintTarget: "fill"
    });
    expect(artStyle.supportsMarkersAll).toBe(true);
    expect(artStyle.isArrowAll).toBe(true);
    const { onInvoke } = renderWidget({ currentSelection: selection, currentArtStyle: artStyle });

    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("arrow");

    const headKindSelect = widget.querySelector<HTMLSelectElement>("[aria-label=\"Arrowhead style\"]");
    if (!headKindSelect) {
      throw new Error("Expected the arrowhead style select.");
    }
    expect(headKindSelect.value).toBe("object.marker.end.kind.filledArrow");
    act(() => {
      headKindSelect.value = "object.marker.end.kind.bar";
      headKindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.marker.end.kind.bar");

    const headSizeSelect = widget.querySelector<HTMLSelectElement>("[aria-label=\"Arrowhead size\"]");
    if (!headSizeSelect) {
      throw new Error("Expected the arrowhead size select.");
    }
    expect(headSizeSelect.value).toBe("object.marker.size:16");

    const tailToggle = widget.querySelector<HTMLButtonElement>("[aria-label=\"Add Arrow Tail Head\"]");
    if (!tailToggle) {
      throw new Error("Expected the tail-head toggle.");
    }
    expect(tailToggle.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      tailToggle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      tailToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.marker.start.kind.filledArrow");

    const setDefault = widget.querySelector<HTMLButtonElement>("[data-command-id=\"arrow.setDefaultStyle\"]");
    expect(setDefault).not.toBeNull();
    expect(setDefault?.disabled).toBe(false);
    expect(widget.querySelector("[data-command-id=\"layout.flipHorizontal\"]")).not.toBeNull();
  });

  it("pins the text layout while customizing, whatever is selected", () => {
    const { selection } = moleculeSelection();
    renderWidget({ currentSelection: selection }, true);
    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("text");
    expect(widget.querySelector("[aria-label=\"Text font\"]")).not.toBeNull();
  });

  function shellFor(selector: string): HTMLElement {
    const control = widgetRoot().querySelector(selector);
    const shell = control?.closest<HTMLElement>("[data-tooltip-owner-id]");
    if (!shell) {
      throw new Error(`Expected a tooltip shell around ${selector}.`);
    }
    return shell;
  }

  function hover(element: Element, type: "pointerover" | "pointerout") {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "relatedTarget", { value: type === "pointerout" ? document.body : null });
    element.dispatchEvent(event);
  }

  it("shows the shared delayed tooltip on every cell and clears it on leave", async () => {
    vi.useFakeTimers();
    try {
      renderWidget({});
      const swatchShell = shellFor("[data-command-id=\"text.color.blue\"]");
      await act(async () => {
        hover(swatchShell, "pointerover");
      });
      expect(swatchShell.getAttribute("data-tooltip-visible")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(swatchShell.getAttribute("data-tooltip-visible")).toBe("true");
      expect(swatchShell.querySelector(".tool-tooltip")?.textContent).toBe("Text color: Blue");
      await act(async () => {
        hover(swatchShell, "pointerout");
      });
      expect(swatchShell.getAttribute("data-tooltip-visible")).toBeNull();

      // Selects get shells too — the whole reason the widget can't rely on button title attributes.
      const sizeShell = shellFor("select[aria-label=\"Text size\"]");
      await act(async () => {
        hover(sizeShell, "pointerover");
        vi.advanceTimersByTime(500);
      });
      expect(sizeShell.getAttribute("data-tooltip-visible")).toBe("true");
      expect(sizeShell.querySelector(".tool-tooltip")?.textContent).toBe("Text size");
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays cell tooltips to the native palette window's floating tooltip", async () => {
    vi.useFakeTimers();
    const relayed: Array<{ visible: boolean; title?: string }> = [];
    const onRelay = (event: Event) => {
      const detail = (event as CustomEvent<{ visible: boolean; title?: string }>).detail;
      relayed.push({ visible: detail.visible, title: detail.title });
    };
    window.addEventListener("chemdraft:palette-tooltip", onRelay);
    document.body.classList.add("palette-window-body");
    try {
      renderWidget({});
      const boldShell = shellFor("[data-command-id=\"text.bold\"]");
      await act(async () => {
        hover(boldShell, "pointerover");
        vi.advanceTimersByTime(500);
      });
      expect(relayed.some((entry) => entry.visible && entry.title === "Bold Text")).toBe(true);
      await act(async () => {
        hover(boldShell, "pointerout");
      });
      expect(relayed[relayed.length - 1]?.visible).toBe(false);
    } finally {
      document.body.classList.remove("palette-window-body");
      window.removeEventListener("chemdraft:palette-tooltip", onRelay);
      vi.useRealTimers();
    }
  });
});
