// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhase4Document, insertNativeArtGraphicObject } from "./documentWorkflow";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import { ToolPalette } from "./ToolPalette";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import {
  objectEffectDisableCommandId,
  objectEffectOpacityCommandId,
  objectEffectSizeCommandId,
  objectCustomColorCommandId,
  objectGradientStopOffsetCommandId,
  moleculeInspectorTemplateExportCommandId,
  moleculeInspectorTemplateImportCommandId,
  moleculeStructureBondLengthCommandId,
  type CommandSpec
} from "./commands";
import { getToolsetCommandGroups, getToolsetItemGroups } from "./toolsets";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function artInspectorModelFor(commandId: string) {
  const document = insertNativeArtGraphicObject(
    createPhase4Document(`Palette ${commandId}`),
    { x: 220, y: 180 },
    commandId
  );
  return createArtInspectorModel({
    document,
    selectedGraphicObjects: selectedGraphicObjectsForArtInspector(document),
    requestedPaintTarget: "fill"
  });
}

function gradientArtInspectorModel() {
  const document = insertNativeArtGraphicObject(
    createPhase4Document("Palette gradient stops"),
    { x: 220, y: 180 },
    "tool.art.rect"
  );
  const objectId = document.selection.objectIds[0];
  if (!objectId) {
    throw new Error("Expected selected art object.");
  }
  const gradientDocument = applyPatches(document, [{
    op: "updateObject",
    objectId,
    changes: {
      style: {
        fillPaint: {
          kind: "linear-gradient",
          units: "object",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: "#1d7f68" },
            { offset: 1, color: "#ffffff" }
          ]
        },
        fillColor: "#1d7f68",
        fillMode: "solid"
      }
    }
  }]);
  return createArtInspectorModel({
    document: gradientDocument,
    selectedGraphicObjects: selectedGraphicObjectsForArtInspector(gradientDocument),
    requestedPaintTarget: "fill"
  });
}

function artToolsetGroupsWith(overrides: Record<string, Partial<CommandSpec>>) {
  return getToolsetCommandGroups("core.art").map((group) => (
    group.map((command) => (
      overrides[command.id] ? { ...command, ...overrides[command.id] } : command
    ))
  ));
}

function artToolsetItemGroupsWith(overrides: Record<string, Partial<CommandSpec>>) {
  return getToolsetItemGroups(
    "core.art",
    undefined,
    new Map(Object.entries(overrides).map(([commandId, override]) => [
      commandId,
      {
        id: commandId,
        title: override.title ?? commandId,
        icon: override.icon ?? "palette",
        source: override.source ?? "core",
        ...override
      } as CommandSpec
    ]))
  );
}

function effectArtInspectorModel() {
  const document = insertNativeArtGraphicObject(
    createPhase4Document("Palette effect controls"),
    { x: 220, y: 180 },
    "tool.art.rect"
  );
  const objectId = document.selection.objectIds[0];
  if (!objectId) {
    throw new Error("Expected selected art object.");
  }
  const effectDocument = applyPatches(document, [{
    op: "updateObject",
    objectId,
    changes: {
      style: {
        effects: [{ kind: "glow", color: "#1d7f68", opacity: 0.42, blurPx: 7, spreadPx: 1.2 }]
      }
    }
  }]);
  return createArtInspectorModel({
    document: effectDocument,
    selectedGraphicObjects: selectedGraphicObjectsForArtInspector(effectDocument),
    requestedPaintTarget: "fill"
  });
}

describe("ToolPalette art color popover", () => {
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

  function renderPalette({
    commandId = "tool.art.rect",
    currentArtStyle = artInspectorModelFor(commandId),
    onCancel = vi.fn(),
    onRequestColorPopover
  }: {
    commandId?: string;
    currentArtStyle?: ReturnType<typeof createArtInspectorModel>;
    onCancel?: () => void;
    onRequestColorPopover?: (anchor: { left: number; top: number; right: number; bottom: number }) => void;
  } = {}) {
    const onInvoke = vi.fn();
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "fill",
        currentArtStyle,
        onArtStylePreview: onPreview,
        onArtStyleCommit: onCommit,
        onArtStyleCancel: onCancel,
        onRequestColorPopover,
        onInvoke
      }));
    });
    return { onCommit, onInvoke, onPreview };
  }

  function colorTrigger(): HTMLButtonElement {
    const trigger = container.querySelector<HTMLButtonElement>(".toolbar-color-trigger");
    if (!trigger) {
      throw new Error("Expected art color trigger.");
    }
    return trigger;
  }

  function openPicker() {
    act(() => {
      colorTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const popover = container.querySelector<HTMLElement>(".art-color-popover");
    if (!popover) {
      throw new Error("Expected art color popover.");
    }
    return popover;
  }

  function changeRangeValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    valueSetter?.call(input, value);
  }

  function setSliderRect(input: HTMLInputElement, left = 10, width = 100) {
    Object.defineProperty(input, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: left,
        y: 4,
        left,
        top: 4,
        right: left + width,
        bottom: 22,
        width,
        height: 18,
        toJSON: () => undefined
      })
    });
  }

  it("opens reliably and closes on outside pointer, Escape, blur, and selection changes", () => {
    const onCancel = vi.fn();
    renderPalette({ onCancel });

    const popover = openPicker();
    expect(popover.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Color");
    expect(popover.querySelector('[aria-label="Color wheel and channel values"]')).not.toBeNull();
    expect(popover.querySelector('[aria-label="RGB color"]')).not.toBeNull();
    expect(popover.querySelector('[aria-label="CMYK color"]')).not.toBeNull();
    expect(popover.querySelector(".color-hex-field")).not.toBeNull();
    expect(popover.querySelector(".iro-color-picker .IroColorPicker")).not.toBeNull();
    expect(popover.querySelector(".iro-color-picker .IroWheel")).not.toBeNull();
    expect(popover.querySelector(".iro-color-picker .IroSlider")).not.toBeNull();
    act(() => {
      popover.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      popover.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      popover.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();

    openPicker();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);

    openPicker();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();

    openPicker();
    renderPalette({ commandId: "tool.art.circle", onCancel });
    expect(container.querySelector(".art-color-popover")).toBeNull();

    openPicker();
    act(() => {
      colorTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".art-color-popover")).toBeNull();
  });

  it("redirects the art color picker to its own window when onRequestColorPopover is provided", () => {
    const onRequestColorPopover = vi.fn();
    renderPalette({ onRequestColorPopover });

    const trigger = colorTrigger();
    Object.defineProperty(trigger, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 12,
        top: 34,
        right: 60,
        bottom: 58,
        x: 12,
        y: 34,
        width: 48,
        height: 24,
        toJSON: () => undefined
      })
    });

    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The swatch hands its screen anchor up so a floating popover window can open there…
    expect(onRequestColorPopover).toHaveBeenCalledTimes(1);
    expect(onRequestColorPopover).toHaveBeenCalledWith({ left: 12, top: 34, right: 60, bottom: 58 });
    // …and the inline (clipped) popover must NOT render — the window hosts it instead.
    expect(container.querySelector(".art-color-popover")).toBeNull();
  });

  it("uses shared color picker palettes for art colors", () => {
    const { onCommit, onPreview } = renderPalette();
    const popover = openPicker();
    const palettesTab = [...popover.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "Palettes");
    if (!palettesTab) {
      throw new Error("Expected palettes tab.");
    }

    act(() => {
      palettesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(popover.querySelector('[data-color-palette="crayola"]')).not.toBeNull();
    expect(popover.querySelector('[data-color-palette="colorblind"]')).not.toBeNull();
    expect(popover.querySelector('[data-color-palette="seasonal"]')).not.toBeNull();

    const redSwatch = popover.querySelector<HTMLButtonElement>('[data-color-palette="crayola"] [aria-label="Crayola red"]');
    if (!redSwatch) {
      throw new Error("Expected Crayola red swatch.");
    }

    act(() => {
      redSwatch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onPreview).toHaveBeenCalledWith(objectCustomColorCommandId("#ed0a3f"));
    expect(onCommit).toHaveBeenCalledWith(objectCustomColorCommandId("#ed0a3f"));
  });

  it("invokes native paint type commands from the art style selector", () => {
    const { onInvoke } = renderPalette();
    const fillSelect = container.querySelector<HTMLSelectElement>('[data-art-paint-type-select="fill"]');
    if (!fillSelect) {
      throw new Error("Expected fill paint type selector.");
    }

    expect([...fillSelect.options].map((option) => option.value)).toContain("object.paint.type.linearGradient");
    expect([...fillSelect.options].map((option) => option.value)).toContain("object.paint.type.gloss");

    act(() => {
      fillSelect.value = "object.paint.type.linearGradient";
      fillSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.paint.type.linearGradient");

    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "stroke",
        currentArtStyle: artInspectorModelFor("tool.art.line"),
        onInvoke
      }));
    });

    const strokeSelect = container.querySelector<HTMLSelectElement>('[data-art-paint-type-select="stroke"]');
    if (!strokeSelect) {
      throw new Error("Expected stroke paint type selector.");
    }

    expect([...strokeSelect.options].map((option) => option.value)).toContain("object.paint.type.radialGradient");
    expect([...strokeSelect.options].map((option) => option.value)).not.toContain("object.paint.type.gloss");

    act(() => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        currentObjectColor: "#111111",
        currentArtStyleTarget: "fill",
        currentArtStyle: artInspectorModelFor("tool.art.rect"),
        onInvoke
      }));
    });

    const restoredFillSelect = container.querySelector<HTMLSelectElement>('[data-art-paint-type-select="fill"]');
    if (!restoredFillSelect) {
      throw new Error("Expected restored fill paint type selector.");
    }
    expect([...restoredFillSelect.options].map((option) => option.value)).toContain("object.paint.type.gloss");
  });

  it("invokes native effect commands from buttons and visible effect controls", () => {
    const { onInvoke } = renderPalette();
    const glowButton = container.querySelector<HTMLButtonElement>('[data-art-effect-button="glow"]');
    if (!glowButton) {
      throw new Error("Expected glow effect button.");
    }

    act(() => {
      glowButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.effect.glow");

    const clearButton = container.querySelector<HTMLButtonElement>('[data-art-effect-button="none"]');
    if (!clearButton) {
      throw new Error("Expected clear effects button.");
    }
    act(() => {
      clearButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("object.effect.none");

    const {
      onCommit,
      onInvoke: onEffectInvoke,
      onPreview
    } = renderPalette({ currentArtStyle: effectArtInspectorModel() });
    expect(container.querySelector('[data-art-effect-controls="glow"]')).not.toBeNull();
    const activeGlowButton = container.querySelector<HTMLButtonElement>('[data-art-effect-button="glow"]');
    expect(activeGlowButton?.className).toContain("active");
    if (!activeGlowButton) {
      throw new Error("Expected active glow effect button.");
    }
    act(() => {
      activeGlowButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onEffectInvoke).not.toHaveBeenCalledWith("object.effect.glow");
    act(() => {
      activeGlowButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onEffectInvoke).toHaveBeenCalledWith(objectEffectDisableCommandId("glow"));
    const effectColorTrigger = container.querySelector<HTMLButtonElement>('[data-art-effect-color-trigger="glow"]');
    if (!effectColorTrigger) {
      throw new Error("Expected effect color trigger.");
    }
    expect(effectColorTrigger.textContent).toContain("Effect");
    act(() => {
      effectColorTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Color wheel and channel values"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="RGB color"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="CMYK color"]')).not.toBeNull();

    const effectOpacity = container.querySelector<HTMLInputElement>('[data-art-inspector-slider="glow-effect-opacity"] input');
    const effectSize = container.querySelector<HTMLInputElement>('[data-art-inspector-slider="glow-effect-size"] input');
    if (!effectOpacity || !effectSize) {
      throw new Error("Expected effect opacity and size sliders.");
    }
    setSliderRect(effectOpacity);
    setSliderRect(effectSize);

    act(() => {
      effectOpacity.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 82, buttons: 0 }));
      changeRangeValue(effectOpacity, "72");
      effectOpacity.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 82, buttons: 0 }));
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      effectOpacity.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 82, buttons: 1 }));
      effectOpacity.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 82, buttons: 1 }));
    });
    expect(onPreview).toHaveBeenCalledWith(objectEffectOpacityCommandId("glow", 0.72));
    act(() => {
      effectOpacity.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 82, buttons: 0 }));
    });
    expect(onCommit).toHaveBeenCalledWith(objectEffectOpacityCommandId("glow", 0.72));

    act(() => {
      effectSize.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 60, buttons: 1 }));
      effectSize.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, buttons: 0 }));
    });
    expect(onPreview).toHaveBeenCalledWith(objectEffectSizeCommandId("glow", 0.5));
    expect(onCommit).toHaveBeenCalledWith(objectEffectSizeCommandId("glow", 0.5));
  });

  it("drags gradient stop markers directly across the gradient rail", () => {
    const { onCommit, onPreview } = renderPalette({ currentArtStyle: gradientArtInspectorModel() });
    const rail = container.querySelector<HTMLDivElement>('[data-art-gradient-rail="fill"]');
    const marker = container.querySelector<HTMLButtonElement>('[data-art-gradient-stop="0"]');
    if (!rail || !marker) {
      throw new Error("Expected gradient rail and stop marker.");
    }

    Object.defineProperty(rail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 10,
        y: 4,
        left: 10,
        top: 4,
        right: 110,
        bottom: 22,
        width: 100,
        height: 18,
        toJSON: () => undefined
      })
    });

    act(() => {
      marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, buttons: 1 }));
      marker.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 47, buttons: 1 }));
    });
    expect(onPreview).toHaveBeenLastCalledWith(objectGradientStopOffsetCommandId(0, 0.37));

    act(() => {
      marker.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 47, buttons: 0 }));
    });
    expect(onCommit).toHaveBeenCalledWith(objectGradientStopOffsetCommandId(0, 0.37));
  });
});

describe("ToolPalette molecule inspector font controls", () => {
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

  it("loads Atom Labels font options lazily while preserving unavailable stored fonts", async () => {
    const onInvoke = vi.fn();
    const model = createMoleculeInspectorModel(moleculeInspectorDocument(), {
      selectedObjectIds: ["mol_font"]
    });

    await act(async () => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showMoleculeInspectorControls: true,
        currentMoleculeInspector: model,
        onInvoke
      }));
    });

    const atomLabelsTab = container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-atom-labels");
    if (!atomLabelsTab) {
      throw new Error("Expected Atom Labels tab.");
    }

    await act(async () => {
      atomLabelsTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const familySelect = container.querySelector<HTMLSelectElement>('[aria-label="Atom label font family"]');
    const faceSelect = container.querySelector<HTMLSelectElement>('[aria-label="Atom label font face"]');
    expect([...familySelect?.options ?? []].map((option) => option.value)).toContain("Unavailable Lab Font");
    expect([...familySelect?.options ?? []].map((option) => option.value)).toContain("Arial");
    expect(familySelect?.value).toBe("Unavailable Lab Font");
    expect([...faceSelect?.options ?? []].map((option) => option.value)).toContain("650:italic");
  });

  it("does not commit 0 when a numeric structure field is cleared to empty", async () => {
    const onInvoke = vi.fn();
    const model = createMoleculeInspectorModel(moleculeInspectorDocument(), {
      selectedObjectIds: ["mol_font"]
    });

    await act(async () => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showMoleculeInspectorControls: true,
        currentMoleculeInspector: model,
        onInvoke
      }));
    });

    // Ensure the Structure tab (which owns the numeric fields) is active.
    act(() => {
      container
        .querySelector<HTMLButtonElement>("#molecule-inspector-tab-structure")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const bondLengthInput = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length"]');
    if (!bondLengthInput) {
      throw new Error("Expected the Target bond length field on the Structure tab.");
    }
    expect(bondLengthInput.disabled).toBe(false);

    // Clearing the field and committing must leave the value untouched, not stamp 0.
    act(() => {
      bondLengthInput.value = "";
      bondLengthInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onInvoke).not.toHaveBeenCalled();

    // A real numeric edit still commits.
    act(() => {
      bondLengthInput.value = "20";
      bondLengthInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith(moleculeStructureBondLengthCommandId(20));
  });

  it("renders a Templates tab that routes import and export commands", async () => {
    const onInvoke = vi.fn();
    const model = createMoleculeInspectorModel(moleculeInspectorDocument(), {
      selectedObjectIds: ["mol_font"]
    });

    await act(async () => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showMoleculeInspectorControls: true,
        currentMoleculeInspector: model,
        onInvoke
      }));
    });

    const templatesTab = container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-templates");
    if (!templatesTab) {
      throw new Error("Expected Templates tab.");
    }

    act(() => {
      templatesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[data-molecule-inspector-section="templates"]')?.textContent).toContain("1 molecule");
    const importButton = container.querySelector<HTMLButtonElement>(
      `[data-command-id="${moleculeInspectorTemplateImportCommandId}"]`
    );
    const exportButton = container.querySelector<HTMLButtonElement>(
      `[data-command-id="${moleculeInspectorTemplateExportCommandId}"]`
    );
    expect(importButton?.disabled).toBe(false);
    expect(exportButton?.disabled).toBe(false);

    act(() => {
      importButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      exportButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onInvoke).toHaveBeenCalledWith(moleculeInspectorTemplateImportCommandId);
    expect(onInvoke).toHaveBeenCalledWith(moleculeInspectorTemplateExportCommandId);
  });

  it("keeps template loading available when no molecule is selected", async () => {
    const onInvoke = vi.fn();
    const model = createMoleculeInspectorModel(moleculeInspectorDocument(), {
      selectedObjectIds: []
    });

    await act(async () => {
      root.render(createElement(ToolPalette, {
        groups: [],
        activeTool: "tool.select",
        orientation: "horizontal",
        showMoleculeInspectorControls: true,
        currentMoleculeInspector: model,
        onInvoke
      }));
    });

    const templatesTab = container.querySelector<HTMLButtonElement>("#molecule-inspector-tab-templates");
    if (!templatesTab) {
      throw new Error("Expected Templates tab.");
    }

    act(() => {
      templatesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[data-molecule-inspector-section="templates"]')?.textContent).toContain("No molecule");
    const loadButton = container.querySelector<HTMLButtonElement>(
      `[data-command-id="${moleculeInspectorTemplateImportCommandId}"]`
    );
    const exportButton = container.querySelector<HTMLButtonElement>(
      `[data-command-id="${moleculeInspectorTemplateExportCommandId}"]`
    );
    expect(loadButton?.textContent).toBe("Load");
    expect(loadButton?.disabled).toBe(false);
    expect(exportButton?.disabled).toBe(true);

    act(() => {
      loadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onInvoke).toHaveBeenCalledWith(moleculeInspectorTemplateImportCommandId);
  });
});

function moleculeInspectorDocument() {
  const document = createEmptyDocument({
    id: "doc_molecule_inspector_fonts",
    pageId: "page_molecule_inspector_fonts",
    title: "Molecule Inspector Fonts"
  });
  const molecule: MoleculeObject = {
    id: "mol_font",
    type: "molecule",
    x: 120,
    y: 120,
    width: 80,
    height: 40,
    rotation: 0,
    style: {
      atomLabelFontFamily: "Unavailable Lab Font",
      atomLabelFontWeight: 650,
      atomLabelFontStyle: "italic"
    },
    structureFormat: "smiles",
    structure: "CO",
    atoms: [
      { id: "atom_001", element: "C", x: 140, y: 160, formalCharge: 0 },
      { id: "atom_002", element: "O", x: 200, y: 160, formalCharge: 0 }
    ],
    bonds: [
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }
    ],
    superatoms: [],
    rGroups: []
  };
  return applyPatches(document, [
    { op: "addObject", pageId: document.pages[0].id, object: molecule },
    { op: "setSelection", pageId: document.pages[0].id, objectIds: [molecule.id] }
  ]);
}

describe("ToolPalette arrange flyouts", () => {
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

  it("opens art arrange flyout menus and invokes submenu commands", () => {
    const onInvoke = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: getToolsetCommandGroups("core.art"),
        itemGroups: getToolsetItemGroups("core.art"),
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        onInvoke
      }));
    });

    const transformButton = container.querySelector<HTMLButtonElement>('[data-command-flyout-button="transform"]');
    if (!transformButton) {
      throw new Error("Expected transform flyout button.");
    }
    const transformMenu = container.querySelector<HTMLElement>('[data-command-flyout-menu="transform"]');
    expect(transformMenu?.hidden).toBe(true);

    act(() => {
      transformButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(transformMenu?.hidden).toBe(false);

    const flipVertical = container.querySelector<HTMLButtonElement>('[data-command-flyout-menu="transform"] [data-command-id="layout.flipVertical"]');
    if (!flipVertical) {
      throw new Error("Expected flip vertical menu command.");
    }
    act(() => {
      flipVertical.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onInvoke).toHaveBeenCalledWith("layout.flipVertical");
    expect(transformMenu?.hidden).toBe(true);
  });

  it("redirects arrange flyouts to their own window when onRequestFlyout is provided", () => {
    const onRequestFlyout = vi.fn();
    const onInvoke = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: getToolsetCommandGroups("core.art"),
        itemGroups: getToolsetItemGroups("core.art"),
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        onRequestFlyout,
        onInvoke
      }));
    });

    const transformButton = container.querySelector<HTMLButtonElement>('[data-command-flyout-button="transform"]');
    if (!transformButton) {
      throw new Error("Expected transform flyout button.");
    }

    act(() => {
      transformButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    // The inline (clipping) menu must NOT open — a floating window hosts the flyout instead.
    const transformMenu = container.querySelector<HTMLElement>('[data-command-flyout-menu="transform"]');
    expect(transformMenu?.hidden).toBe(true);

    // …and the palette hands up the flyout's id + a command snapshot to open in that window.
    expect(onRequestFlyout).toHaveBeenCalledTimes(1);
    const request = onRequestFlyout.mock.calls[0][0] as {
      flyout: { flyoutId: string; commands: Array<{ id: string }> };
    };
    expect(request.flyout.flyoutId).toBe("transform");
    expect(request.flyout.commands.map((command) => command.id)).toContain("layout.flipVertical");
  });

  // Regression guard for the "C…" / "E…" truncation bug: distribute-mode commands are icon-less
  // plain-text choices, so PalettePopoverWindow must render them via the flex-based
  // toolbar-distribute-menu layout — NOT the icon+label grid the other flyouts use, which places a
  // lone icon-less label in its narrow 20px icon column and ellipsizes it. The palette's job is
  // just to tag the snapshot so the popover window picks the right layout.
  it("tags the distribute-mode flyout snapshot so the popover renders full labels, not icons", () => {
    const onRequestFlyout = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: getToolsetCommandGroups("core.art"),
        itemGroups: getToolsetItemGroups("core.art"),
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        onRequestFlyout,
        onInvoke: vi.fn()
      }));
    });

    const distributeButton = container.querySelector<HTMLButtonElement>(".distribute-mode-button");
    if (!distributeButton) {
      throw new Error("Expected distribute-mode button.");
    }

    act(() => {
      distributeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    expect(onRequestFlyout).toHaveBeenCalledTimes(1);
    const request = onRequestFlyout.mock.calls[0][0] as {
      flyout: {
        variant?: string;
        commands: Array<{ id: string; title: string; assetName?: string; icon?: string }>;
      };
    };
    expect(request.flyout.variant).toBe("distribute");
    expect(request.flyout.commands.map((command) => command.title)).toEqual(["Centers", "Equal gaps"]);
    // Confirms these really are icon-less — the exact condition that trips the grid-column bug if
    // the popover window ever renders a "distribute" flyout through the icon+label layout again.
    for (const command of request.flyout.commands) {
      expect(command.assetName).toBeUndefined();
      expect(command.icon).toBeUndefined();
    }
  });

  it("keeps the declared group primary action while allowing enabled submenu commands", () => {
    const onInvoke = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: artToolsetGroupsWith({
          "layout.group": {
            enabled: false,
            disabledReason: "Select at least two objects"
          },
          "layout.ungroup": {
            enabled: true,
            shortcut: "Shift+Cmd+G",
            shortcutLabel: "⇧⌘G"
          }
        }),
        itemGroups: artToolsetItemGroupsWith({
          "layout.group": {
            enabled: false,
            disabledReason: "Select at least two objects"
          },
          "layout.ungroup": {
            enabled: true,
            shortcut: "Shift+Cmd+G",
            shortcutLabel: "⇧⌘G"
          }
        }),
        activeTool: "tool.select",
        orientation: "horizontal",
        showArtStyleControls: true,
        onInvoke
      }));
    });

    const groupButton = container.querySelector<HTMLButtonElement>('[data-command-flyout-button="group"]');
    if (!groupButton) {
      throw new Error("Expected group flyout button.");
    }

    expect(groupButton.getAttribute("data-command-id")).toBe("layout.group");
    expect(groupButton.getAttribute("data-toolbar-asset")).toBe("Custom_Group");
    expect(groupButton.getAttribute("data-disabled")).toBe("true");
    expect(groupButton.getAttribute("aria-label")).toContain("Select at least two objects");

    act(() => {
      groupButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onInvoke).not.toHaveBeenCalled();

    act(() => {
      groupButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const ungroup = container.querySelector<HTMLButtonElement>('[data-command-flyout-menu="group"] [data-command-id="layout.ungroup"]');
    if (!ungroup) {
      throw new Error("Expected ungroup submenu command.");
    }
    act(() => {
      ungroup.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvoke).toHaveBeenCalledWith("layout.ungroup");
  });

  it("consolidates art shape tools behind one active flyout button", () => {
    const onInvoke = vi.fn();
    act(() => {
      root.render(createElement(ToolPalette, {
        groups: getToolsetCommandGroups("core.art"),
        itemGroups: getToolsetItemGroups("core.art"),
        activeTool: "tool.art.circle",
        orientation: "horizontal",
        showArtStyleControls: true,
        onInvoke
      }));
    });

    const shapeButton = container.querySelector<HTMLButtonElement>('[data-command-flyout-button="shapes"]');
    if (!shapeButton) {
      throw new Error("Expected shape flyout button.");
    }
    expect(shapeButton.getAttribute("data-toolbar-asset")).toBe("Art_Shapes");
    expect(shapeButton.getAttribute("data-command-flyout-ids")).toBe("tool.art.rect tool.art.roundedRect tool.art.circle tool.art.ellipse");
    expect(shapeButton.getAttribute("data-active")).toBe("true");
    expect(shapeButton.getAttribute("aria-pressed")).toBe("true");

    const shapeMenu = container.querySelector<HTMLElement>('[data-command-flyout-menu="shapes"]');
    expect(shapeMenu?.hidden).toBe(true);

    act(() => {
      shapeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(shapeMenu?.hidden).toBe(false);

    const ellipse = container.querySelector<HTMLButtonElement>('[data-command-flyout-menu="shapes"] [data-command-id="tool.art.ellipse"]');
    if (!ellipse) {
      throw new Error("Expected ellipse menu command.");
    }
    act(() => {
      ellipse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onInvoke).toHaveBeenCalledWith("tool.art.ellipse");
    expect(shapeMenu?.hidden).toBe(true);
  });
});
