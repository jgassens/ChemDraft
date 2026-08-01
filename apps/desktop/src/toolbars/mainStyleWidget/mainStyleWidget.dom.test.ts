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

  it("keeps both atom-label toggles on show polarity — lit always means visible", () => {
    const { document: moleculeDocument, selection } = moleculeSelection();
    const inspector = createMoleculeInspectorModel(moleculeDocument, {
      selectedObjectIds: moleculeDocument.selection.objectIds
    });
    const { onInvoke } = renderWidget({ currentSelection: selection, currentMoleculeInspector: inspector });

    const toggle = (label: string): HTMLButtonElement => {
      const button = widgetRoot().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      if (!button) {
        throw new Error(`Expected the ${label} toggle.`);
      }
      return button;
    };
    const press = (button: HTMLButtonElement) => {
      act(() => {
        button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    // The H toggle's underlying field is inverted (hideImplicitHydrogens), so surfacing it raw
    // would light H for "hidden" while C lights for "shown" — a lit pair would mean opposite
    // things. The fixture is a bare C–C bond, so no atom renders a label: H is inert and reads
    // dim + disabled rather than lit for hydrogens the canvas never draws.
    const showHydrogens = toggle("Show Implicit Hydrogens");
    const showCarbons = toggle("Show Terminal Carbons");
    expect(showHydrogens.getAttribute("aria-pressed")).toBe("false");
    expect(showHydrogens.disabled).toBe(true);
    expect(showCarbons.getAttribute("aria-pressed")).toBe("false");
    expect(showCarbons.disabled).toBe(false);

    // Dim → clicking shows.
    press(showCarbons);
    expect(onInvoke).toHaveBeenCalledWith("molecule.atomLabel.showTerminalCarbons:true");
  });

  it("enables the implicit-hydrogen toggle once an atom actually renders a label", () => {
    const { document: moleculeDocument, molecule } = moleculeSelection();
    // Terminal carbons on → the two carbons render CH3, which implicit hydrogens can act on.
    const labelled = applyPatches(moleculeDocument, [{
      op: "updateObject",
      objectId: molecule.id,
      changes: { style: { ...molecule.style, atomLabelShowTerminalCarbons: true } }
    }]);
    const selection = classifyToolbarSelection({ document: labelled, moleculeContext: "molecule" });
    const inspector = createMoleculeInspectorModel(labelled, {
      selectedObjectIds: labelled.selection.objectIds
    });
    expect(inspector.atomLabels.implicitHydrogensAffectLabels).toBe(true);

    const { onInvoke } = renderWidget({ currentSelection: selection, currentMoleculeInspector: inspector });
    const showHydrogens = widgetRoot().querySelector<HTMLButtonElement>("[aria-label=\"Show Implicit Hydrogens\"]");
    if (!showHydrogens) {
      throw new Error("Expected the implicit-hydrogen toggle.");
    }
    expect(showHydrogens.disabled).toBe(false);
    expect(showHydrogens.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      showHydrogens.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      showHydrogens.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("swaps the green and grey swatches for the ✗-size select on a no-reaction arrow", async () => {
    const { createPhase4Document, insertNativeArtGraphicObject } = await import("../../documentWorkflow");
    const { createArtInspectorModel, selectedGraphicObjectsForArtInspector } = await import("../../artInspectorModel");
    const noReactionDocument = insertNativeArtGraphicObject(
      createPhase4Document("No-reaction widget"),
      { x: 220, y: 180 },
      "tool.art.noReactionArrow"
    );
    const selection = classifyToolbarSelection({ document: noReactionDocument, moleculeContext: "none" });
    expect(selection.kind).toBe("arrow");
    const artStyle = createArtInspectorModel({
      document: noReactionDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(noReactionDocument),
      requestedPaintTarget: "fill"
    });
    expect(artStyle.supportsShaftMarkAll).toBe(true);
    const { onInvoke } = renderWidget({ currentSelection: selection, currentArtStyle: artStyle });

    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("arrow");
    // The last two swatches make room for the size select.
    expect(widget.querySelector("[data-command-id=\"object.color.green\"]")).toBeNull();
    expect(widget.querySelector("[data-command-id=\"object.color.gray\"]")).toBeNull();
    expect(widget.querySelector("[data-command-id=\"object.color.black\"]")).not.toBeNull();

    const sizeSelect = widget.querySelector<HTMLSelectElement>("[aria-label=\"No-reaction mark size\"]");
    if (!sizeSelect) {
      throw new Error("Expected the no-reaction mark size select.");
    }
    // Fresh no-reaction arrows derive the ✗ from stroke width.
    expect(sizeSelect.value).toBe("object.shaftMark.sizeAuto");
    act(() => {
      sizeSelect.value = "object.shaftMark.size:20";
      sizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.shaftMark.size:20");
    expect(onInvoke).toHaveBeenCalledTimes(1);
  });

  it("unfreezes the variant when a gesture is cancelled instead of released", () => {
    // The widget latches its layout during a press so the pressed control isn't unmounted mid-commit.
    // Only pointerup released that latch, so a pointercancel (OS gesture takeover, a native select
    // menu swallowing the release) froze the widget on a stale variant for good.
    const { selection: moleculeSel } = moleculeSelection();
    renderWidget({ currentSelection: moleculeSel });
    expect(widgetRoot().dataset.mainStyleVariant).toBe("molecule");

    // Begin a gesture on a widget control, then have it cancelled rather than released.
    const control = widgetRoot().querySelector("button, select");
    act(() => {
      control?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      window.dispatchEvent(new Event("pointercancel"));
    });

    // A later selection change must still swap the layout (re-render with an empty selection).
    const textSelection = classifyToolbarSelection({
      document: createEmptyDocument({ id: "doc_empty", pageId: "page_empty", title: "Empty" }),
      moleculeContext: "none"
    });
    renderWidget({ currentSelection: textSelection });
    expect(widgetRoot().dataset.mainStyleVariant).toBe("text");
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

  it("offers arrowhead controls on a wavy line, which can carry a head but is not an arrow", async () => {
    const { createPhase4Document, insertNativeArtGraphicObject } = await import("../../documentWorkflow");
    const { createArtInspectorModel, selectedGraphicObjectsForArtInspector } = await import("../../artInspectorModel");
    // The data model has always allowed a head here — `graphicObjectSupportsMarkers` accepts any
    // open stroke, deliberately, so an end that has no head yet can still grow one. Only the
    // classifier disagreed, sending non-arrow strokes to the shape layout (fill, paint type,
    // corners), which left no control anywhere in the app for adding one.
    const wavyDocument = insertNativeArtGraphicObject(
      createPhase4Document("Wavy"),
      { x: 220, y: 180 },
      "tool.art.lineWavy"
    );
    const artStyle = createArtInspectorModel({
      document: wavyDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(wavyDocument),
      requestedPaintTarget: "fill"
    });
    // The premise: it can hold a head, and it is not an arrow.
    expect(artStyle.supportsMarkersAll).toBe(true);
    expect(artStyle.isArrowAny).toBe(false);

    const selection = classifyToolbarSelection({
      document: wavyDocument,
      moleculeContext: "none",
      markerCapableGraphicCount: artStyle.markersSupportedCount
    });
    expect(selection.kind).toBe("arrow");

    const { onInvoke } = renderWidget({ currentSelection: selection, currentArtStyle: artStyle });
    const widget = widgetRoot();
    expect(widget.dataset.mainStyleVariant).toBe("arrow");

    // The head control is present and live.
    const headKindSelect = widget.querySelector<HTMLSelectElement>("[aria-label=\"Arrowhead style\"]");
    if (!headKindSelect) {
      throw new Error("Expected the arrowhead style select on a marker-capable stroke.");
    }
    expect(headKindSelect.disabled).toBe(false);
    act(() => {
      headKindSelect.value = "object.marker.end.kind.filledArrow";
      headKindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.marker.end.kind.filledArrow");

    // But nothing claims it IS an arrow: Set as Default Arrow Style stays disabled, because that
    // command captures an arrow tool's style and a wavy line has none to capture.
    const setDefault = widget.querySelector<HTMLButtonElement>("[aria-label=\"Set as Default Arrow Style\"]");
    if (!setDefault) {
      throw new Error("Expected the set-as-default action.");
    }
    expect(setDefault.disabled).toBe(true);
  });

  it("keeps a closed shape on the shape layout", async () => {
    const { createPhase4Document, insertNativeArtGraphicObject } = await import("../../documentWorkflow");
    const { createArtInspectorModel, selectedGraphicObjectsForArtInspector } = await import("../../artInspectorModel");
    // The complement: a rect cannot carry a head, so it keeps fill, paint type and corners.
    const rectDocument = insertNativeArtGraphicObject(
      createPhase4Document("Rect"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const artStyle = createArtInspectorModel({
      document: rectDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(rectDocument),
      requestedPaintTarget: "fill"
    });
    expect(artStyle.supportsMarkersAny).toBe(false);

    const selection = classifyToolbarSelection({
      document: rectDocument,
      moleculeContext: "none",
      markerCapableGraphicCount: artStyle.markersSupportedCount
    });
    expect(selection.kind).toBe("shape");

    renderWidget({ currentSelection: selection, currentArtStyle: artStyle });
    expect(widgetRoot().dataset.mainStyleVariant).toBe("shape");
    expect(widgetRoot().querySelector("[aria-label=\"Arrowhead style\"]")).toBeNull();
  });
});
