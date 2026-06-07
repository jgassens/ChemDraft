import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DefaultNativeTextStyle,
  applyPatch,
  ChemDraftSyntheticStylePreset,
  stylePresetToObjectStyle,
  type DocumentObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import {
  allShellCommands,
  atomElementActions,
  createQuickActions,
  editActions,
  normalizeHexColor,
  pageOrientationActions,
  pageSizeActions,
  paletteGroups,
  structureCleanupCommandId,
  textCustomColorCommandId,
  textStylePatchForCommand,
  textToolbarActions,
  toolbarCustomizationActions,
  viewActions
} from "./commands";
import {
  applyAnalysisToSelectedMolecule,
  applyFreeformSingleBondToolAtPoint,
  applyNativeAtomElementTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeDeleteTarget,
  applySingleBondToolAtPoint,
  createPhase4Document,
  insertAdapterFallbackMolecule,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  insertNativeTextObject,
  nativeAtomHitRadiusPx,
  nativeBondLengthPx,
  reorderSelectedDocumentObject,
  setDocumentPageOrientation,
  setDocumentPageSize
} from "./documentWorkflow";
import {
  MainWindow,
  ObjectLayerContextMenu,
  SelectionMarqueeOverlay,
  activeNativeTargetShortcutCommand,
  cumulativeMoleculeResizeScale,
  cumulativeRotationReadoutDegrees,
  hoveredNativeTargetShortcutCommand,
  moleculeResizeReadoutPercent,
  moleculeResizeScaleFromDrag,
  bondDepthContextFromNativeSelection,
  bondDepthRefsFromNativeSelection,
  crossingClearPatchesForObjectLayerPlacement,
  nativeContextMenuSelectionResolutionFromHit,
  nativePlacementRotationDegrees,
  nativeDeleteTargetFromSelectionPart,
  nativeMoleculeCanvasHoverTarget,
  nativeMoleculeObjectAtPoint,
  nativeMoleculeSelectionHasVisibleTargets,
  planBondDepthPatches,
  reorderSelectedDocumentObjectWithCrossingDefaults,
  nativeMoleculeSelectionDragIntent,
  nativeSelectionWithHitToggled,
  pagePointFromRenderedPageRect,
  resolvePngCanvasSize,
  rotationDeltaDegrees,
  rotationReadoutDegrees,
  selectionInSelectionRect,
  shouldActivateDocumentObject,
  shouldDragDocumentObject,
  shouldOpenMoleculeEditorFromObjectClick,
  shouldUseViewportWheelZoom
} from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { ToolPalette, cmykToRgbColor, hexToRgbColor, rgbToCmykColor, rgbToHexColor } from "./ToolPalette";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  DEFAULT_TOOLSET_ID,
  TOOLSET_ACTIVE_TOOL_EVENT,
  TOOLSET_ACTIVE_TOOL_REQUEST_EVENT,
  TOOLSET_TEXT_STYLE_EVENT,
  TOOLSET_TEXT_STYLE_REQUEST_EVENT,
  TOOLSET_WINDOW_STATE_EVENT,
  createPaletteCommandPayload,
  createToolsetActiveToolPayload,
  createToolsetCommandPayload,
  createToolsetTextStylePayload,
  createToolsetWindowStatePayload
} from "./window-manager";
import {
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  getToolbarsMenuModel,
  getToolsetCommandGroups,
  getToolsetCommandSpecs,
  getToolsetToggleActions
} from "./toolsets";

function svgLineNumberAttribute(lineMarkup: string, attribute: "x1" | "y1" | "x2" | "y2"): number {
  const match = lineMarkup.match(new RegExp(`${attribute}="([^"]+)"`));
  return Number(match?.[1]);
}

function svgLineLength(lineMarkup: string): number {
  return Math.hypot(
    svgLineNumberAttribute(lineMarkup, "x2") - svgLineNumberAttribute(lineMarkup, "x1"),
    svgLineNumberAttribute(lineMarkup, "y2") - svgLineNumberAttribute(lineMarkup, "y1")
  );
}

function buttonMarkupForCommand(markup: string, commandId: string): string {
  const commandIndex = markup.indexOf(`data-command-id="${commandId}"`);
  if (commandIndex === -1) {
    throw new Error(`Expected markup for command ${commandId}.`);
  }

  const buttonStart = markup.lastIndexOf("<button", commandIndex);
  const buttonEnd = markup.indexOf("</button>", commandIndex);
  return markup.slice(buttonStart, buttonEnd === -1 ? undefined : buttonEnd + "</button>".length);
}

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const toolPaletteSource = readFileSync(new URL("./ToolPalette.tsx", import.meta.url), "utf8");

describe("ChemDraft desktop shell", () => {
  it("defines a canonical desktop design-token layer in App.css", () => {
    [
      "--cd-bg-app",
      "--cd-bg-canvas",
      "--cd-bg-panel",
      "--cd-bg-page",
      "--cd-border",
      "--cd-text-primary",
      "--cd-text-secondary",
      "--cd-text-muted",
      "--cd-accent",
      "--cd-accent-text",
      "--cd-bg-hover",
      "--cd-bg-active",
      "--cd-bg-selected",
      "--cd-focus-ring",
      "--cd-control-height",
      "--cd-tool-size",
      "--cd-radius-control"
    ].forEach((tokenName) => {
      expect(appCss).toContain(`${tokenName}:`);
    });

    expect(appCss).toContain("--chrome: var(--cd-bg-panel-raised);");
    expect(appCss).toContain("--canvas: var(--cd-bg-app);");
    expect(appCss).toContain("--accent: var(--cd-accent);");
    expect(appCss).toMatch(/\.native-crossing-hit-target\s*{[^}]*pointer-events:\s*none;/s);
    expect(appCss).toContain(".native-bond-hover-decorator");
    expect(appCss).toMatch(/g\[data-bond-layer-id\]:hover\s+\.native-bond-hover-decorator\s*{[^}]*stroke-opacity:\s*0\.32;/s);
    expect(appCss).not.toContain(".native-bond-hit-target:hover");
  });

  it("renders compact web-preview workspace regions with a floating fallback palette", () => {
    const markup = renderToStaticMarkup(createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false }));

    expect(markup).toContain("app-shell");
    expect(markup).toContain("web-floating-palette");
    expect(markup).toContain("data-floating-palette");
    expect(markup).toContain("tool-palette");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("rulers-visible");
    expect(markup).toContain("document-rulers-overlay");
    expect(markup).toContain("ruler-top");
    expect(markup).toContain("crosshair-axis-vertical");
    expect(markup).toContain("crosshair-tick-quarter");
    expect(markup).toContain("document-board without-rulers");
    expect(markup).not.toContain("menu-bar");
    expect(markup).not.toContain("command-bar");
    expect(markup).not.toContain("statusbar");
    expect(markup).not.toContain("EditorAdapter not connected");
    expect(markup).not.toContain("tool-palette docked");
    expect(markup.indexOf("web-floating-palette")).toBeLessThan(markup.indexOf('class="workspace"'));
  });

  it("renders the main desktop document window without an in-window palette by default", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).toContain("app-shell");
    expect(markup).toContain("native-shell");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("rulers-visible");
    expect(markup).toContain("document-rulers-overlay");
    expect(markup).toContain("ruler-top");
    expect(markup).toContain('data-zoom-surface="document"');
    expect(markup).toContain('data-can-undo="false"');
    expect(markup).toContain('data-can-redo="false"');
    expect(markup).toContain("crosshair-axis-horizontal");
    expect(markup).toContain("crosshair-tick-half");
    expect(markup).toContain("document-board without-rulers");
    expect(markup).not.toContain("menu-bar");
    expect(markup).not.toContain("command-bar");
    expect(markup).not.toContain("tool-palette");
    expect(markup).not.toContain("drawer-rail");
    expect(markup).not.toContain("statusbar");
  });

  it("keeps viewport zoom reserved for trackpad pinch and command-style wheel gestures", () => {
    expect(shouldUseViewportWheelZoom({ ctrlKey: true, metaKey: false, deltaY: -42 } as globalThis.WheelEvent)).toBe(true);
    expect(shouldUseViewportWheelZoom({ ctrlKey: false, metaKey: true, deltaY: 42 } as globalThis.WheelEvent)).toBe(true);
    expect(shouldUseViewportWheelZoom({ ctrlKey: false, metaKey: false, deltaY: 42 } as globalThis.WheelEvent)).toBe(false);
    expect(shouldUseViewportWheelZoom({ ctrlKey: true, metaKey: false, deltaY: 0 } as globalThis.WheelEvent)).toBe(false);
  });

  it("resolves native molecule hover targets from page geometry instead of fragile SVG event targets", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Hover Target"), { x: 200, y: 220 });
    const document = insertNativeSingleBondMolecule(first, { x: 200, y: 220 });

    expect(nativeMoleculeCanvasHoverTarget(document, { x: 200, y: 220 })).toMatchObject({
      objectId: "mol_bond_002",
      kind: "bond",
      bondId: "bond_001"
    });
    expect(nativeMoleculeCanvasHoverTarget(document, { x: 200 - nativeBondLengthPx / 2, y: 220 })).toMatchObject({
      objectId: "mol_bond_002",
      kind: "atom",
      atomId: "atom_001"
    });
    expect(nativeMoleculeCanvasHoverTarget(document, { x: 24, y: 24 })).toBeUndefined();
  });

  it("finds a native molecule by bounds for whole-molecule double-clicks inside ring interiors", () => {
    const first = insertNativeTemplateMolecule(createPhase4Document("Double Click Bounds"), { x: 300, y: 300 }, "benzene");
    const document = insertNativeTemplateMolecule(first, { x: 300, y: 300 }, "benzene");

    expect(nativeMoleculeObjectAtPoint(document.pages[0].objects, { x: 300, y: 300 })?.id).toBe("mol_template_002");
    expect(nativeMoleculeObjectAtPoint(document.pages[0].objects, { x: 24, y: 24 })).toBeUndefined();
  });

  it("converts captured window hover coordinates through the rendered page rectangle", () => {
    expect(pagePointFromRenderedPageRect(
      { left: 120, top: 80 },
      2,
      { x: 340, y: 300 }
    )).toEqual({ x: 110, y: 110 });
    expect(pagePointFromRenderedPageRect(
      { left: 120, top: 80 },
      0,
      { x: 340, y: 300 }
    )).toEqual({ x: 220, y: 220 });
  });

  it("renders the native palette route as an independent palette-only surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));

    expect(markup).toContain("palette-window-shell");
    expect(markup).toContain("data-palette-drag-surface");
    expect(markup).toContain('data-tauri-drag-region="true"');
    expect(markup).toContain('data-palette-content-drag-grip="true"');
    expect(markup).toContain("palette-close-button");
    expect(markup).toContain('aria-label="Hide Main Toolbar"');
    expect(markup).toContain("Main");
    expect(markup).toContain("tool-palette");
    expect(markup).toContain("main-style-palette");
    expect(markup).toContain('data-tool-palette-orientation="horizontal"');
    expect(buttonMarkupForCommand(markup, "tool.select")).toContain('data-active="true"');
    expect(buttonMarkupForCommand(markup, "tool.text")).not.toContain('data-active="true"');
    expect(markup).toContain('data-toolbar-style-controls="main"');
    expect(markup).toContain('aria-label="Text font"');
    expect(markup).toContain('aria-label="Text size"');
    expect(markup).toContain('aria-label="Text color"');
    expect(markup).toContain("toolbar-color-swatch");
    expect(markup).toContain('data-command-id="text.color.black"');
    expect(markup).toContain('data-command-id="text.color.green"');
    expect(markup).not.toContain('data-command-id="text.color.cyan"');
    expect(markup).not.toContain('data-color-picker="true"');
    expect(markup).not.toContain('data-color-picker-trigger="true"');
    expect(markup).not.toContain('aria-label="Open text color picker"');
    expect(markup).toContain('aria-label="Text style"');
    expect(markup).toContain('aria-label="Text alignment"');
    expect(markup).toContain('data-command-id="text.script.subscript"');
    expect(markup).toContain('data-command-id="text.script.superscript"');
    expect(markup).toContain('data-command-id="text.align.left"');
    expect(markup).toContain(`data-toolset-id="${DEFAULT_TOOLSET_ID}"`);
    expect(markup).not.toContain("app-shell");
    expect(markup).not.toContain("canvas-region");
    expect(markup).not.toContain("utility-drawer");
    expect(appCss).toContain("grid-template-columns: minmax(0, 1fr) 70px max-content;");
    expect(appCss).toContain("grid-template-columns: 170px 70px auto;");
    expect(appCss).toContain("appearance: none;");
    expect(appCss).toContain("linear-gradient(45deg, transparent 50%, var(--cd-text-secondary) 50%)");
    expect(appCss).toContain("min-width: 70px;");
    expect(appCss).toContain("font-variant-numeric: tabular-nums;");
  });

  it("keeps every non-canvas panel out of the document window by default", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).not.toContain("utility-drawer");
    expect(markup).not.toContain("drawer-title");
    expect(markup).not.toContain("adapter-state");
    expect(markup).not.toContain("margin-guide");
  });

  it("hides the crosshair overlay and page grid together", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialCrosshairsVisible: false,
        initialPaletteMode: "floating",
        nativePalette: true
      })
    );

    expect(markup).toContain("crosshairs-hidden");
    expect(markup).not.toContain("crosshairs-visible");
    expect(markup).not.toContain("crosshair-overlay");
    expect(markup).not.toContain("crosshair-tick");
  });

  it("can render the document workspace with rulers hidden", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialPaletteMode: "floating",
        initialRulersVisible: false,
        nativePalette: true
      })
    );

    expect(markup).toContain("canvas-region");
    expect(markup).not.toContain("rulers-visible");
    expect(markup).not.toContain("document-rulers-overlay");
    expect(markup).not.toContain("ruler-top");
  });

  it("renders the selection marquee in scaled page coordinates", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionMarqueeOverlay, {
        startPoint: { x: 20, y: 30 },
        latestPoint: { x: 70, y: 90 }
      })
    );

    expect(markup).toContain("selection-marquee");
    expect(markup).toContain("left:calc(20px * var(--page-scale))");
    expect(markup).toContain("top:calc(30px * var(--page-scale))");
    expect(markup).toContain("width:calc(50px * var(--page-scale))");
    expect(markup).toContain("height:calc(60px * var(--page-scale))");
  });

  it("selects every whole native molecule inside a marquee instead of keeping only the first one", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Multi Marquee"), { x: 220, y: 240 });
    const second = insertNativeSingleBondMolecule(first, { x: 320, y: 240 });
    const molecules = second.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
    const bounds = molecules.reduce(
      (rect, molecule) => ({
        left: Math.min(rect.left, molecule.x),
        top: Math.min(rect.top, molecule.y),
        right: Math.max(rect.right, molecule.x + molecule.width),
        bottom: Math.max(rect.bottom, molecule.y + molecule.height)
      }),
      { left: Number.POSITIVE_INFINITY, top: Number.POSITIVE_INFINITY, right: 0, bottom: 0 }
    );
    const selection = selectionInSelectionRect(second.pages[0].objects, {
      x: bounds.left - 4,
      y: bounds.top - 4
    }, {
      x: bounds.right + 4,
      y: bounds.bottom + 4
    });

    expect(selection.objectIds).toEqual(molecules.map((molecule) => molecule.id));
    expect(selection.nativeSelection).toBeUndefined();
  });

  it("does not pull adjacent text into a molecule marquee unless the text box is enclosed", () => {
    const withMolecule = insertNativeSingleBondMolecule(createPhase4Document("Marquee Text Guard"), { x: 220, y: 240 });
    const withText = insertNativeTextObject(withMolecule, { x: 264, y: 212 }, "hello");
    const molecule = withText.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const text = withText.pages[0].objects.find((object): object is DocumentObject =>
      object.type === "text" && object.text === "hello"
    );
    if (!molecule || !text) {
      throw new Error("Expected molecule and text fixtures.");
    }
    const moleculeSelection = selectionInSelectionRect(withText.pages[0].objects, {
      x: molecule.x - 4,
      y: molecule.y - 4
    }, {
      x: molecule.x + molecule.width + 4,
      y: molecule.y + molecule.height + 4
    });
    const fullSelection = selectionInSelectionRect(withText.pages[0].objects, {
      x: Math.min(molecule.x, text.x) - 4,
      y: Math.min(molecule.y, text.y) - 4
    }, {
      x: Math.max(molecule.x + molecule.width, text.x + text.width) + 4,
      y: Math.max(molecule.y + molecule.height, text.y + text.height) + 4
    });

    expect(moleculeSelection.objectIds).toEqual([molecule.id]);
    expect(moleculeSelection.objectIds).not.toContain(text.id);
    expect(fullSelection.objectIds).toEqual([molecule.id, text.id]);
  });

  it("keeps a tight marquee over one native atom as a partial native selection", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Atom Marquee"), { x: 220, y: 240 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const atom = molecule?.atoms.find((candidate) => candidate.id === "atom_001");
    if (!molecule || !atom) {
      throw new Error("Expected native molecule atom fixture.");
    }
    const selection = selectionInSelectionRect(document.pages[0].objects, {
      x: atom.x - 3,
      y: atom.y - 3
    }, {
      x: atom.x + 3,
      y: atom.y + 3
    });

    expect(selection.objectIds).toEqual([]);
    expect(selection.nativeSelection).toEqual(
      expect.objectContaining({
        objectId: molecule.id
      })
    );
    expect(selection.nativeSelection?.kind).not.toBe("molecule");
  });

  it("toggles discontiguous native molecule atoms and bonds with selection hits", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Shift Part Selection"), { x: 220, y: 240 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!molecule) {
      throw new Error("Expected native molecule fixture.");
    }
    const atomHit = {
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    } as const;
    const secondAtomHit = {
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    } as const;
    const bondHit = {
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    } as const;

    const first = nativeSelectionWithHitToggled(undefined, molecule.id, atomHit);
    const second = nativeSelectionWithHitToggled(first, molecule.id, secondAtomHit);
    const third = nativeSelectionWithHitToggled(second, molecule.id, bondHit);
    const fourth = nativeSelectionWithHitToggled(third, molecule.id, atomHit);

    expect(first).toEqual({ objectId: molecule.id, kind: "atom", atomId: "atom_001" });
    expect(second).toEqual({
      objectId: molecule.id,
      kind: "parts",
      atomIds: ["atom_001", "atom_002"],
      bondIds: []
    });
    expect(third).toEqual({
      objectId: molecule.id,
      kind: "parts",
      atomIds: ["atom_001", "atom_002"],
      bondIds: ["bond_001"]
    });
    expect(fourth).toEqual({
      objectId: molecule.id,
      kind: "parts",
      atomIds: ["atom_002"],
      bondIds: ["bond_001"]
    });
  });

  it("clears a native molecule part selection when the last hit is toggled off", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Shift Clear Part Selection"), { x: 220, y: 240 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!molecule) {
      throw new Error("Expected native molecule fixture.");
    }
    const atomSelection = {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001"
    } as const;
    const atomHit = {
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    } as const;

    expect(nativeSelectionWithHitToggled(atomSelection, molecule.id, atomHit)).toBeUndefined();
  });

  it("starts a new native molecule part selection when the toggled hit belongs to another molecule", () => {
    const firstDocument = insertNativeSingleBondMolecule(createPhase4Document("Shift Cross Molecule"), { x: 220, y: 240 });
    const document = insertNativeSingleBondMolecule(firstDocument, { x: 320, y: 240 });
    const molecules = document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
    if (molecules.length < 2) {
      throw new Error("Expected two native molecule fixtures.");
    }
    const previousSelection = {
      objectId: molecules[0].id,
      kind: "atom",
      atomId: "atom_001"
    } as const;
    const bondHit = {
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    } as const;

    expect(nativeSelectionWithHitToggled(previousSelection, molecules[1].id, bondHit)).toEqual({
      objectId: molecules[1].id,
      kind: "bond",
      bondId: "bond_001"
    });
  });

  it("keeps command definitions available without embedding actions in the canvas", () => {
    const document = createPhase4Document();
    const commands = allShellCommands(document);
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false })
    );

    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
    expect(commands.some((command) => command.id === "document.open")).toBe(true);
    expect(commands.some((command) => command.id === "document.saveAs")).toBe(true);
    expect(commands.some((command) => command.id === "view.toggleRulers")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.legal")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.a4")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.a0")).toBe(true);
    expect(commands.some((command) => command.id === "page.setOrientation.landscape")).toBe(true);
    expect(commands.some((command) => command.id === "layout.bringForward")).toBe(true);
    expect(commands.some((command) => command.id === "layout.sendBackward")).toBe(true);
    expect(commands.some((command) => command.id === "layout.bringToFront")).toBe(true);
    expect(commands.some((command) => command.id === "layout.sendToBack")).toBe(true);
    expect(commands.some((command) => command.id === "view.toolset.toggle.core.main")).toBe(true);
    expect(commands.some((command) => command.id === "tool.atom")).toBe(true);
    expect(commands.some((command) => command.id === "atom.setHoveredElement.O")).toBe(true);
    expect(markup).toContain(".chemdraft,.cdxml,.xml,.json,chemical/x-cdxml,application/xml,text/xml,application/json");
    expect(markup).not.toContain("Open Native Document");
    expect(markup).not.toContain("Validate Selected Structure");
  });

  it("builds keyboard shortcuts from command definitions", () => {
    const registry = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), "macos");

    expect(registry.resolve({ key: "v" })).toBe("tool.select");
    expect(registry.resolve({ key: "r", metaKey: true })).toBe("view.toggleRulers");
    expect(registry.resolve({ key: "r", metaKey: true, shiftKey: true })).toBe("view.toggleCrosshairs");
    expect(registry.resolve({ key: "a", metaKey: true })).toBe("edit.selectAll");
    expect(registry.resolve({ key: "v", metaKey: true })).toBe("clipboard.paste");
    expect(registry.resolve({ key: "m" })).toBe("tool.bond");
    expect(registry.resolve({ key: "b" })).toBeUndefined();
    expect(registry.resolve({ key: "t" })).toBe("tool.text");
    expect(registry.resolve({ key: "1" })).toBe("atom.addSingleBondToHoveredAtom");
    expect(registry.resolve({ key: "2" })).toBe("bond.setHoveredBondOrder.double");
    expect(registry.resolve({ key: "3" })).toBe("bond.setHoveredBondOrder.triple");
    expect(registry.resolve({ key: "k" })).toBe("atom.addCarbonylToHoveredAtom");
    expect(registry.resolve({ key: "k", metaKey: true, shiftKey: true })).toBe(structureCleanupCommandId);
    expect(registry.resolve({ key: "+" })).toBe("tool.plus");
    expect(registry.resolve({ key: "-" })).toBe("tool.minus");
    expect(registry.resolve({ key: "o" })).toBeUndefined();
    expect(registry.resolve({ key: "Backspace" })).toBe("edit.deleteHoveredNativeTarget");
    expect(registry.resolve({ key: "Delete" })).toBe("edit.forwardDeleteHoveredNativeTarget");
    expect(registry.conflicts()).toEqual([]);
  });

  it("only exposes undo and redo shortcuts when document history can move", () => {
    const document = createPhase4Document();
    const disabledRegistry = createDesktopShortcutRegistry(createQuickActions(document, undefined), "macos");
    const enabledRegistry = createDesktopShortcutRegistry(
      createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
      "macos"
    );

    expect(disabledRegistry.resolve({ key: "z", metaKey: true })).toBeUndefined();
    expect(disabledRegistry.resolve({ key: "z", metaKey: true, shiftKey: true })).toBeUndefined();
    expect(enabledRegistry.resolve({ key: "z", metaKey: true })).toBe("edit.undo");
    expect(enabledRegistry.resolve({ key: "z", metaKey: true, shiftKey: true })).toBe("edit.redo");
    expect(enabledRegistry.conflicts()).toEqual([]);
  });

  it("defines View menu commands for optional canvas scaffolding", () => {
    expect(viewActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "view.toggleRulers", title: "Toggle Rulers" }),
        expect.objectContaining({ id: "view.toggleCrosshairs", title: "Toggle Crosshairs" })
      ])
    );
  });

  it("defines command-backed hovered atom element actions without global shortcut conflicts", () => {
    expect(atomElementActions.map((command) => command.id)).toEqual([
      "atom.setHoveredElement.H",
      "atom.setHoveredElement.B",
      "atom.setHoveredElement.C",
      "atom.setHoveredElement.N",
      "atom.setHoveredElement.O",
      "atom.setHoveredElement.F",
      "atom.setHoveredElement.P",
      "atom.setHoveredElement.S",
      "atom.setHoveredElement.I"
    ]);
    expect(atomElementActions.every((command) => command.shortcut === undefined)).toBe(true);
  });

  it("defines command-backed hovered atom growth and charge actions", () => {
    expect(editActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "atom.addSingleBondToHoveredAtom", shortcut: "1" }),
      expect.objectContaining({ id: "bond.setHoveredBondOrder.single" }),
      expect.objectContaining({ id: "bond.setHoveredBondOrder.double", shortcut: "2" }),
      expect.objectContaining({ id: "bond.setHoveredBondOrder.triple", shortcut: "3" }),
      expect.objectContaining({ id: "atom.addCarbonylToHoveredAtom", shortcut: "K" }),
      expect.objectContaining({ id: "atom.addPositiveChargeToHoveredAtom" }),
      expect.objectContaining({ id: "atom.addNegativeChargeToHoveredAtom" })
    ]));
    expect(editActions.find((command) => command.id === "bond.setHoveredBondOrder.single")?.shortcut).toBeUndefined();
    expect(editActions.find((command) => command.id === "atom.addPositiveChargeToHoveredAtom")?.shortcut).toBeUndefined();
    expect(editActions.find((command) => command.id === "atom.addNegativeChargeToHoveredAtom")?.shortcut).toBeUndefined();
  });

  it("resolves context-sensitive hovered atom and bond number keys before global shortcuts", () => {
    const atomTarget = {
      objectId: "mol_001",
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    } as const;
    const bondTarget = {
      objectId: "mol_001",
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    } as const;

    expect(hoveredNativeTargetShortcutCommand(atomTarget, "1")).toBe("atom.addSingleBondToHoveredAtom");
    expect(hoveredNativeTargetShortcutCommand(bondTarget, "1")).toBe("bond.setHoveredBondOrder.single");
    expect(hoveredNativeTargetShortcutCommand(bondTarget, "2")).toBe("bond.setHoveredBondOrder.double");
    expect(hoveredNativeTargetShortcutCommand(bondTarget, "3")).toBe("bond.setHoveredBondOrder.triple");
    expect(hoveredNativeTargetShortcutCommand(atomTarget, "k")).toBe("atom.addCarbonylToHoveredAtom");
    expect(hoveredNativeTargetShortcutCommand(atomTarget, "c")).toBe("atom.setHoveredElement.C");
    expect(hoveredNativeTargetShortcutCommand(atomTarget, "t")).toBeUndefined();
    expect(hoveredNativeTargetShortcutCommand(bondTarget, "c")).toBeUndefined();

    const document = insertNativeSingleBondMolecule(createPhase4Document("Selected Bond Shortcut"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!molecule) {
      throw new Error("Expected molecule fixture.");
    }
    expect(activeNativeTargetShortcutCommand(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001"
    }, undefined, "1")).toBe("bond.setHoveredBondOrder.single");
  });

  it("defines minimal command-backed page-size and orientation controls", () => {
    expect(pageSizeActions.map((command) => command.id)).toEqual([
      "page.setSize.letter",
      "page.setSize.legal",
      "page.setSize.a4",
      "page.setSize.a3",
      "page.setSize.a2",
      "page.setSize.a1",
      "page.setSize.a0",
      "page.setSize.a5"
    ]);
    expect(pageOrientationActions.map((command) => command.id)).toEqual([
      "page.setOrientation.portrait",
      "page.setOrientation.landscape"
    ]);
  });

  it("defines disabled toolbar customization command placeholders", () => {
    expect(toolbarCustomizationActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "view.customizeToolbars",
          enabled: false,
          disabledReason: "Toolbar customization UI is not implemented yet"
        }),
        expect.objectContaining({ id: "view.toolset.resetLayout", enabled: false }),
        expect.objectContaining({ id: "view.toolset.resetAllLayouts", enabled: false }),
        expect.objectContaining({ id: "view.toolset.createUserToolset", enabled: false }),
        expect.objectContaining({ id: "view.toolset.cloneToolset", enabled: false })
      ])
    );
  });

  it("defines command-backed text toolbar actions", () => {
    expect(textToolbarActions.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "text.font.system",
        "text.size.12",
        "text.size.20",
        "text.color.black",
        "text.align.left",
        "text.bold",
        "text.script.subscript",
        "text.script.superscript"
      ])
    );
    expect(getToolsetCommandGroups("core.text").flat().map((command) => command.id)).toEqual(["tool.text"]);
  });

  it("supports preset and custom text color commands", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
    expect(textStylePatchForCommand("text.color.magenta")).toEqual({ color: "#9b287b" });
    expect(textStylePatchForCommand(textCustomColorCommandId("#A0B1C2"))).toEqual({ color: "#a0b1c2" });
    expect(appCss).toContain(".toolbar-color-swatch:hover,\n.toolbar-color-swatch.active");
    expect(appCss).toContain("background: var(--swatch-color);");
  });

  it("renders mutually exclusive text toolbar active states from current style", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolPalette, {
        groups: [],
        mode: "floating",
        orientation: "horizontal",
        showMainStyleControls: true,
        currentTextStyle: {
          ...DefaultNativeTextStyle,
          color: "#1f5fbf",
          textAlign: "right"
        },
        currentTextScript: "superscript",
        onInvoke: () => undefined
      })
    );

    expect(buttonMarkupForCommand(markup, "text.color.blue")).toContain("active");
    expect(buttonMarkupForCommand(markup, "text.color.green")).not.toContain("active");
    expect(buttonMarkupForCommand(markup, "text.align.right")).toContain("active");
    expect(buttonMarkupForCommand(markup, "text.align.left")).not.toContain("active");
    expect(buttonMarkupForCommand(markup, "text.script.superscript")).toContain("active");
    expect(buttonMarkupForCommand(markup, "text.script.subscript")).not.toContain("active");
  });

  it("converts picker colors across RGB, CMYK, and HEX", () => {
    expect(hexToRgbColor("#1d7f68")).toEqual({ r: 29, g: 127, b: 104 });
    expect(rgbToHexColor({ r: 29, g: 127, b: 104 })).toBe("#1d7f68");
    expect(rgbToCmykColor({ r: 255, g: 0, b: 0 })).toEqual({ c: 0, m: 100, y: 100, k: 0 });
    expect(cmykToRgbColor({ c: 0, m: 100, y: 100, k: 0 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("keeps unsupported chemistry tools disabled while native single bond is enabled", () => {
    const enabledToolIds = new Set([
      "tool.select",
      "tool.text",
      "tool.bond",
      "tool.wedgeBond",
      "tool.hashedBond",
      "tool.dashedBond",
      "tool.boldBond",
      "tool.cyclopentane",
      "tool.cyclohexane",
      "tool.benzene",
      "tool.chairCyclohexaneA",
      "tool.chairCyclohexaneB",
      structureCleanupCommandId,
      "tool.plus",
      "tool.minus",
      "layout.bringToFront",
      "layout.bringForward",
      "layout.sendBackward",
      "layout.sendToBack"
    ]);
    const disabledTools = paletteGroups.flat().filter((command) => !enabledToolIds.has(command.id));

    expect(paletteGroups.flat().find((command) => command.id === "tool.bond")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.text")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === structureCleanupCommandId)).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.plus")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.minus")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.wedgeBond")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.benzene")).toMatchObject({ enabled: true });
    expect(disabledTools.length).toBeGreaterThan(20);
    expect(disabledTools.every((command) => command.enabled === false)).toBe(true);
  });

  it("keeps palette buttons backed by command ids", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));

    for (const command of paletteGroups.flat()) {
      expect(markup).toContain(`data-command-id="${command.id}"`);
      expect(markup).toContain(command.title);
    }
  });

  it("marks only the current drawing tool as active", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolPalette, {
        groups: getToolsetCommandGroups("core.main"),
        activeTool: "tool.text",
        orientation: "horizontal",
        onInvoke: () => undefined
      })
    );

    expect(buttonMarkupForCommand(markup, "tool.text")).toContain('data-active="true"');
    expect(buttonMarkupForCommand(markup, "tool.text")).toContain('aria-pressed="true"');
    expect(buttonMarkupForCommand(markup, "tool.select")).not.toContain('data-active="true"');
    expect(buttonMarkupForCommand(markup, "tool.select")).not.toContain('aria-pressed="true"');
    expect(buttonMarkupForCommand(markup, "tool.wedgeBond")).not.toContain('data-active="true"');
  });

  it("keeps rotate-handle drag sensitive without capping full turns", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 0, y: -20 };

    expect(rotationDeltaDegrees(center, start, { x: 4, y: -20 })).toBe(180);
    expect(rotationDeltaDegrees(center, start, { x: 8, y: -20 })).toBe(360);
    expect(rotationDeltaDegrees(center, start, { x: 16, y: -20 })).toBe(720);
    expect(rotationDeltaDegrees(center, start, { x: -8, y: -20 })).toBe(-360);
  });

  it("uses the placement click point as the rotation origin for fresh bonds and templates", () => {
    const start = { x: 120, y: 160 };

    expect(nativePlacementRotationDegrees(start, { x: 160, y: 160 })).toBe(0);
    expect(nativePlacementRotationDegrees(start, { x: 120, y: 200 })).toBe(90);
    expect(nativePlacementRotationDegrees(start, { x: 80, y: 160 })).toBe(180);
    expect(nativePlacementRotationDegrees(start, { x: 120, y: 120 })).toBe(-90);
    expect(nativePlacementRotationDegrees(start, start)).toBe(0);
  });

  it("normalizes the rotate drag readout to a readable 0-360 degree value", () => {
    expect(rotationReadoutDegrees(0)).toBe(0);
    expect(rotationReadoutDegrees(12.4)).toBe(12);
    expect(rotationReadoutDegrees(359.6)).toBe(360);
    expect(rotationReadoutDegrees(360)).toBe(360);
    expect(rotationReadoutDegrees(721)).toBe(1);
    expect(rotationReadoutDegrees(-1)).toBe(359);
    expect(rotationReadoutDegrees(-360)).toBe(360);
  });

  it("adds rotate drag readouts to the object's starting rotation", () => {
    expect(cumulativeRotationReadoutDegrees(90, 45)).toBe(135);
    expect(cumulativeRotationReadoutDegrees(350, 25)).toBe(15);
    expect(cumulativeRotationReadoutDegrees(200, -60)).toBe(140);
  });

  it("resolves molecule corner resize drag as proportional unless shift stretch is active", () => {
    const center = { x: 100, y: 100 };
    const start = { x: 60, y: 60 };

    expect(moleculeResizeScaleFromDrag(center, start, { x: 40, y: 40 }, false)).toEqual({ x: 1.5, y: 1.5 });
    expect(moleculeResizeScaleFromDrag(center, start, { x: 20, y: 60 }, false)).toEqual({ x: 1.5, y: 1.5 });
    expect(moleculeResizeScaleFromDrag(center, start, { x: 40, y: 80 }, false)).toEqual({ x: 1, y: 1 });
    expect(moleculeResizeScaleFromDrag(center, start, { x: 40, y: 80 }, true)).toEqual({ x: 1.5, y: 0.5 });
    expect(moleculeResizeReadoutPercent(1.254)).toBe(125);
  });

  it("multiplies molecule resize readouts by the starting molecule scale", () => {
    expect(cumulativeMoleculeResizeScale({ x: 2, y: 2 }, { x: 1.5, y: 1.5 })).toEqual({ x: 3, y: 3 });
    expect(cumulativeMoleculeResizeScale({ x: 2, y: 0.5 }, { x: 1.25, y: 0.8 })).toEqual({ x: 2.5, y: 0.4 });
  });

  it("renders the text toolbar as a formatting surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow, { toolsetId: "core.text" }));

    expect(markup).toContain('data-toolbar-style-controls="text"');
    expect(markup).toContain('data-palette-title-drag-surface="true"');
    expect(markup).toContain('aria-label="Text font"');
    expect(markup).toContain('aria-label="Text size"');
    expect(markup).toContain('aria-label="Text color"');
    expect(markup).toContain('data-color-picker="true"');
    expect(markup).toContain('data-color-picker-trigger="true"');
    expect(markup).toContain('aria-label="Open text color picker"');
    expect(markup).toContain('aria-label="Text style"');
    expect(markup).toContain('aria-label="Text alignment"');
    expect(markup).toContain('aria-label="Letter spacing"');
    expect(markup).toContain('aria-label="Line spacing"');
    expect(markup).toContain('aria-label="Paragraph spacing"');
    expect(markup).toContain('data-command-id="tool.text"');
    expect(markup).toContain('data-command-id="text.spacing.tight"');
    expect(markup).toContain('data-command-id="text.lineHeight.loose"');
    expect(markup).toContain('data-command-id="text.paragraph.medium"');
    expect(markup).toContain('data-command-id="text.script.subscript"');
    expect(markup).toContain('data-command-id="text.script.superscript"');
    expect(appCss).toContain(".toolbar-color-popover");
    expect(appCss).toContain(".color-picker-tabs");
    expect(appCss).toContain(".color-wheel-face");
    expect(appCss).toContain(".color-channel-group");
    expect(appCss).toContain(".color-hex-field");
  });

  it("registers built-in and plugin fixture toolsets", () => {
    const toolsets = desktopToolsetRegistry.listToolsets();
    const ids = toolsets.map((toolset) => toolset.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "core.main",
        "core.structure",
        "core.arrows",
        "core.annotations",
        "core.orbitals",
        "core.layout",
        "core.style",
        "core.text",
        "plugin.fixture"
      ])
    );
    expect(desktopToolsetRegistry.require("core.main").defaultVisible).toBe(true);
    expect(desktopToolsetRegistry.require("plugin.fixture").source).toBe("plugin");
  });

  it("keeps sparse floating toolsets compact", () => {
    const mainToolset = desktopToolsetRegistry.require("core.main");
    const fixtureSize = desktopToolsetRegistry.require("plugin.fixture").preferredWindowSize;
    const textToolset = desktopToolsetRegistry.require("core.text");
    const verticalSizes = desktopToolsetRegistry
      .listToolsets()
      .filter((toolset) => toolset.gridLayout?.orientation !== "horizontal")
      .map((toolset) => toolset.preferredWindowSize?.height ?? 0);

    expect(mainToolset.preferredWindowSize).toMatchObject({ width: 1138, height: 88, minWidth: 860, minHeight: 84 });
    expect(fixtureSize).toMatchObject({ width: 112, height: 58, minWidth: 112, minHeight: 58 });
    expect(textToolset.gridLayout).toMatchObject({ orientation: "horizontal" });
    expect(textToolset.preferredWindowSize).toMatchObject({ width: 590, height: 112, minWidth: 520, minHeight: 104 });
    expect(Math.max(...verticalSizes)).toBeLessThanOrEqual(224);
  });

  it("keeps the main text controls compact and two-row balanced", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));
    const fontIndex = markup.indexOf('aria-label="Text font"');
    const boldIndex = markup.indexOf('data-command-id="text.bold"');

    expect(fontIndex).toBeGreaterThan(-1);
    expect(boldIndex).toBeGreaterThan(fontIndex);
    expect(appCss).toContain("--cd-main-toolbar-style-width: 344px;");
    expect(appCss).toContain("grid-template-columns: max-content minmax(0, 1fr) max-content;");
    expect(appCss).toContain("grid-template-columns: minmax(0, 1fr) 70px max-content;");
    expect(appCss).toContain("justify-self: end;");
    expect(appCss).toContain(".tool-palette.floating.horizontal.main-style-palette");
    expect(appCss).toContain("max-height: 64px;");
  });

  it("clips narrow palette titles away from the close control", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow, { toolsetId: "plugin.fixture" }));

    expect(markup).toContain('data-palette-title-drag-surface="true"');
    expect(appCss).toContain(".palette-title-label");
    expect(appCss).toContain("text-overflow: ellipsis;");
    expect(appCss).toContain("left: 4px;");
  });

  it("builds View > Toolbars menu items from registered toolsets", () => {
    const menu = getToolbarsMenuModel(new Set(["core.main"]));

    expect(menu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Main Toolbar",
          commandId: "view.toolset.toggle.core.main",
          checked: true
        }),
        expect.objectContaining({
          title: "Text Toolbar",
          commandId: "view.toolset.toggle.core.text",
          checked: false
        }),
        expect.objectContaining({
          title: "Fixture Plugin Toolbar",
          commandId: "view.toolset.toggle.plugin.fixture",
          checked: false,
          source: "plugin"
        })
      ])
    );
  });

  it("applies persisted toolbar layout state to startup registry and menu models", () => {
    const registry = createDesktopToolsetRegistry({
      version: 1,
      toolsetOrder: ["user.quick", "plugin.fixture", "core.main"],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          title: "My Main Toolbar",
          visible: false,
          hiddenCommandIds: ["tool.lasso"],
          itemOrder: {
            "core.main.selection": ["tool.text", "tool.select", "tool.eraser"]
          }
        }
      ],
      userToolsets: [
        {
          id: "user.quick",
          title: "My Quick Tools",
          source: "user",
          defaultVisible: true,
          defaultMode: "floating",
          groups: [
            {
              id: "user.quick.tools",
              items: [
                { commandId: "tool.select", title: "Selection Tool" },
                { commandId: "plugin.fixture.toolset.ping", title: "Fixture Toolset Command" }
              ]
            }
          ]
        }
      ]
    });
    const menu = getToolbarsMenuModel(new Set(["user.quick"]), registry);

    expect(registry.listToolsets().map((toolset) => toolset.id).slice(0, 3)).toEqual([
      "user.quick",
      "plugin.fixture",
      "core.main"
    ]);
    expect(registry.require("core.main").title).toBe("My Main Toolbar");
    expect(registry.require("core.main").defaultVisible).toBe(false);
    expect(menu[0]).toMatchObject({
      title: "My Quick Tools",
      commandId: "view.toolset.toggle.user.quick",
      checked: true,
      source: "user"
    });
    expect(getToolsetCommandGroups("core.main", registry)[0].map((command) => command.id)).toEqual([
      "tool.text",
      "tool.select",
      "tool.eraser"
    ]);
  });

  it("creates toggle commands for every registered toolset", () => {
    const toggles = getToolsetToggleActions();

    expect(toggles.map((command) => command.id)).toEqual(
      expect.arrayContaining(["view.toolset.toggle.core.structure", "view.toolset.toggle.plugin.fixture"])
    );
    expect(toggles.every((command) => command.category === "view")).toBe(true);
  });

  it("renders an independent plugin fixture toolset surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow, { toolsetId: "plugin.fixture" }));

    expect(markup).toContain('data-toolset-id="plugin.fixture"');
    expect(markup).toContain('data-command-id="plugin.fixture.toolset.ping"');
    expect(markup).toContain("Fixture");
    expect(markup).not.toContain("canvas-region");
  });

  it("keeps disabled placeholder tools from pretending to perform chemistry", () => {
    const disabledTools = getToolsetCommandSpecs().filter((command) => command.enabled === false);
    const enabledNativeStructureTools = [
      "tool.bond",
      "tool.wedgeBond",
      "tool.hashedBond",
      "tool.dashedBond",
      "tool.boldBond",
      "tool.cyclopentane",
      "tool.cyclohexane",
      "tool.benzene",
      "tool.chairCyclohexaneA",
      "tool.chairCyclohexaneB"
    ];

    expect(disabledTools.length).toBeGreaterThan(20);
    expect(disabledTools.every((command) => command.disabledReason)).toBe(true);
    enabledNativeStructureTools.forEach((commandId) => {
      expect(disabledTools.some((command) => command.id === commandId)).toBe(false);
    });
    expect(disabledTools.some((command) => command.id === "tool.chain")).toBe(true);
    expect(disabledTools.some((command) => command.id === "tool.reactionArrow")).toBe(true);
  });

  it("exposes active tool state without rendering fake chemistry", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).toContain('data-active-tool="tool.select"');
    expect(markup).toContain('data-active-tool-kind="selection"');
    expect(markup).not.toContain("Atom Label Tool");
    expect(markup).not.toContain("Single Bond active");
  });

  it("uses custom toolbar assets for the expanded palette", () => {
    const toolCommands = paletteGroups.flat();

    expect(toolCommands.length).toBeGreaterThanOrEqual(48);
    expect(toolCommands.some((command) => command.assetName === "Custom_Bond_Wedge")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Arrow_Equilibrium")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Flip_Horizontal")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Structure_Cleanup")).toBe(true);
  });

  it("keeps toolbar shortcuts in delayed hover tooltips instead of visible icon badges", () => {
    const bondCommand = getToolsetCommandSpecs().find((command) => command.id === "tool.bond");
    const cleanupCommand = getToolsetCommandSpecs().find((command) => command.id === structureCleanupCommandId);
    if (!bondCommand || !cleanupCommand) {
      throw new Error("Expected toolbar commands.");
    }

    const markup = renderToStaticMarkup(
      createElement(ToolPalette, {
        groups: [[bondCommand, cleanupCommand]],
        mode: "floating",
        orientation: "horizontal",
        onInvoke: () => undefined
      })
    );
    const bondMarkup = buttonMarkupForCommand(markup, "tool.bond");
    const cleanupMarkup = buttonMarkupForCommand(markup, structureCleanupCommandId);
    const verticalMarkup = renderToStaticMarkup(
      createElement(ToolPalette, { groups: [[bondCommand]], onInvoke: () => undefined })
    );
    const verticalBondMarkup = buttonMarkupForCommand(verticalMarkup, "tool.bond");

    expect(bondMarkup).toContain('data-command-id="tool.bond"');
    expect(bondMarkup).toContain('data-shortcut-label="M"');
    expect(bondMarkup).toContain('data-tooltip="Single Bond (M)"');
    expect(bondMarkup).toContain('class="tool-tooltip"');
    expect(bondMarkup).toContain(">Single Bond (M)</span>");
    expect(bondMarkup).not.toContain('title="Single Bond (M)"');
    expect(verticalBondMarkup).not.toContain('title="Single Bond (M)"');
    expect(bondMarkup).not.toContain("with-shortcut");
    expect(markup).not.toContain('class="shortcut"');
    expect(markup).toContain('class="icon-button-shell"');
    expect(markup).toContain('data-tooltip-delay-ms="1000"');
    expect(markup).toContain('data-tooltip-owner-id="');
    expect(markup).not.toContain("data-tooltip-visible");
    expect(cleanupMarkup).toContain('class="icon-button structure-cleanup-button"');
    expect(cleanupMarkup).toContain('data-tooltip="Clean up Structure 2D (⌘⇧K)"');
    expect(cleanupMarkup).toContain(">Clean up Structure 2D (⌘⇧K)</span>");
    expect(appCss).toContain(".tool-tooltip");
    expect(appCss).not.toContain("@keyframes cd-tooltip-auto-hide");
    expect(appCss).not.toContain(".icon-button-shell:hover .tool-tooltip");
    expect(appCss).toContain('.icon-button-shell[data-tooltip-visible="true"] .tool-tooltip');
    expect(appCss).toContain(".tool-palette.horizontal .tool-tooltip");
    expect(appCss).toContain(".tool-palette.vertical .tool-tooltip");
    expect(appCss).not.toContain("animation: cd-tooltip-auto-hide");
    expect(appCss).not.toContain("transition-delay: 450ms;");
    expect(appCss).toContain("white-space: normal;");
    expect(appCss).toContain("overflow-wrap: anywhere;");
    expect(appCss).toContain('.icon-button[data-command-id="structure.cleanup2d"] .tool-icon-image');
    expect(toolPaletteSource).toContain("const TOOLTIP_DELAY_MS = 1000");
    expect(toolPaletteSource).not.toContain("setTimeout(clearVisibleTooltip, 3200)");
  });

  it("keeps functional metadata on asset-backed palette commands", () => {
    const assetCommands = paletteGroups.flat().filter((command) => command.assetName);

    expect(assetCommands.length).toBeGreaterThanOrEqual(48);
    expect(assetCommands.every((command) => command.category)).toBe(true);
    expect(assetCommands.every((command) => command.description)).toBe(true);
    expect(assetCommands.find((command) => command.assetName === "Custom_Bond_Wedge")).toMatchObject({
      id: "tool.wedgeBond",
      title: "Solid Wedge Bond",
      category: "structure"
    });
    expect(assetCommands.find((command) => command.assetName === "Custom_Structure_Cleanup")).toMatchObject({
      id: structureCleanupCommandId,
      title: "Clean up Structure 2D",
      shortcut: "Shift+Cmd+K",
      shortcutLabel: "⌘⇧K",
      category: "structure"
    });
  });

  it("places cleanup in the main toolbar chrome cluster instead of a vague disabled options button", () => {
    const mainGroups = getToolsetCommandGroups("core.main");
    const styleGroupIds = mainGroups.at(-1)?.map((command) => command.id) ?? [];

    expect(styleGroupIds).toEqual([
      "style.color",
      "tool.settings",
      structureCleanupCommandId,
      "tool.templateGrid"
    ]);
    expect(styleGroupIds).not.toContain("tool.toolOptions");
    expect(mainGroups.flat().filter((command) => command.id === structureCleanupCommandId)).toHaveLength(1);
  });

  it("routes palette events as command ids only", () => {
    expect(createPaletteCommandPayload("tool.select")).toEqual({ commandId: "tool.select" });
    expect(Object.keys(createPaletteCommandPayload("tool.select"))).toEqual(["commandId"]);
    expect(createToolsetActiveToolPayload("tool.text")).toEqual({ commandId: "tool.text" });
    expect(createToolsetTextStylePayload({
      ...DefaultNativeTextStyle,
      color: "#1f5fbf",
      textAlign: "right"
    }, "superscript")).toEqual({
      currentTextStyle: {
        ...DefaultNativeTextStyle,
        color: "#1f5fbf",
        textAlign: "right"
      },
      currentTextScript: "superscript"
    });
    expect(createToolsetCommandPayload("plugin.fixture.toolset.ping")).toEqual({
      commandId: "plugin.fixture.toolset.ping"
    });
  });

  it("keeps native toolset window state events narrow and serializable", () => {
    expect(TOOLSET_ACTIVE_TOOL_EVENT).toBe("chemdraft://toolset-active-tool");
    expect(TOOLSET_ACTIVE_TOOL_REQUEST_EVENT).toBe("chemdraft://toolset-active-tool-request");
    expect(TOOLSET_TEXT_STYLE_EVENT).toBe("chemdraft://toolset-text-style");
    expect(TOOLSET_TEXT_STYLE_REQUEST_EVENT).toBe("chemdraft://toolset-text-style-request");
    expect(TOOLSET_WINDOW_STATE_EVENT).toBe("chemdraft://toolset-window-state");
    expect(createToolsetWindowStatePayload("core.structure", true, false, { x: 120, y: 180 })).toEqual({
      toolsetId: "core.structure",
      open: true,
      focused: false,
      position: { x: 120, y: 180 }
    });
  });

  it("does not show fake chemistry objects on a blank document", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).not.toContain("molecule-object");
    expect(markup).not.toContain("reaction");
    expect(markup).not.toContain("product");
    expect(markup).not.toContain("CCO");
  });

  it("renders Phase 5 chemistry properties only for real selected molecule objects", () => {
    const document = applyAnalysisToSelectedMolecule(
      insertAdapterFallbackMolecule(createPhase4Document("Chemistry Fixture")),
      {
        input: { format: "smiles", value: "CCO" },
        validation: { valid: true, errors: [], warnings: [] },
        properties: {
          formula: "C2H6O",
          averageMass: 46.069,
          exactMass: 46.0419,
          totalCharge: 0,
          atomCount: 3,
          bondCount: 2,
          stereochemistry: []
        },
        warnings: []
      }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("molecule-object");
    expect(markup).toContain("C2H6O");
    expect(markup).toContain("avg 46.069");
    expect(markup).toContain("exact 46.0419");
  });

  it("renders native single-bond molecules as document-backed bond geometry", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Bond Render"), { x: 200, y: 220 });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("native-single-bond");
    expect(markup).toContain('data-page-svg-surface="true"');
    expect(markup).not.toContain('class="molecule-glyph"');
    expect(markup).toContain('data-structure="CC"');
    expect(markup).toContain('data-style-preset-id="chemdraft.synthetic"');
    expect(markup).toContain('stroke-width="2"');
    expect(markup).toContain('stroke-linecap="butt"');
    expect(markup).toContain("native-molecule-selected");
    expect(markup).toContain("native-molecule-selection-blob");
    expect(markup).toContain('data-selection-blob="true"');
    expect(markup).toContain("native-whole-selection-bond");
    expect(markup).toContain("native-bond-selection-connector");
    expect(markup).toContain("native-selection-blob-bond");
    expect(markup).toContain("native-selection-blob-atom");
    expect(markup).toContain('data-bond-selection-connectors="true"');
    expect(markup).toContain("native-whole-selection-atom");
    expect(markup).toContain('data-whole-molecule-selection="true"');
    expect(markup).toContain('data-selection-rotate-handle="true"');
    expect(markup).toContain('data-rotate-icon="double-headed"');
    expect(markup).not.toContain('data-rotate-readout="true"');
    expect(markup.match(/data-molecule-resize-corner=/g) ?? []).toHaveLength(4);
    expect(markup).toContain('data-molecule-resize-corner="top-left"');
    expect(markup).toContain('data-molecule-resize-corner="top-right"');
    expect(markup).toContain('data-molecule-resize-corner="bottom-left"');
    expect(markup).toContain('data-molecule-resize-corner="bottom-right"');
    expect(markup).not.toContain('data-molecule-resize-readout="true"');
    expect(markup).not.toContain("data-text-resize-edge");
    expect(markup).toContain("Rotate selected molecule");
    expect(markup).toContain("native-bond-hit-target");
    expect(markup).toContain("native-atom-hit-target");
    expect(markup).toContain("Molecule C2H6");
    expect(markup).not.toContain("adapter-backed");
  });

  it("hides molecule transform handles when the bond tool is active", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Bond Tool Selection Chrome"), { x: 200, y: 220 });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-active-tool-kind="bond"');
    expect(markup).toContain("native-single-bond");
    expect(markup).not.toContain("native-molecule-selection-blob");
    expect(markup).not.toContain('data-selection-rotate-handle="true"');
    expect(markup).not.toContain("data-molecule-resize-corner");
  });

  it("keeps selected labeled atoms visibly highlighted above label backgrounds", () => {
    const carbon = insertNativeSingleBondMolecule(createPhase4Document("Labeled Atom Highlight"), { x: 200, y: 220 });
    const oxygen = applyNativeAtomElementTarget(carbon, {
      objectId: carbon.selection.objectIds[0] ?? "",
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    }, "O");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: oxygen,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const labelBackgroundIndex = markup.indexOf("native-atom-label-background");
    const selectionBlobIndex = markup.indexOf("native-molecule-selection-blob");
    const labelTextIndex = markup.indexOf('data-atom-label="OH"');

    expect(markup).toContain('data-atom-label="OH"');
    expect(markup).toContain('data-selected-atom-id="atom_002"');
    expect(labelBackgroundIndex).toBeGreaterThan(-1);
    expect(selectionBlobIndex).toBeGreaterThan(labelBackgroundIndex);
    expect(labelTextIndex).toBeGreaterThan(-1);
  });

  it("does not render native bond selection connectors for unselected molecules", () => {
    const selectedDocument = insertNativeSingleBondMolecule(createPhase4Document("Unselected Bond Render"), { x: 200, y: 220 });
    const document = applyPatch(selectedDocument, {
      op: "setSelection",
      pageId: selectedDocument.pages[0].id,
      objectIds: []
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("native-single-bond");
    expect(markup).not.toContain("native-molecule-selection-blob");
    expect(markup).not.toContain('data-selection-blob="true"');
    expect(markup).not.toContain("native-bond-selection-connector");
    expect(markup).not.toContain('data-bond-selection-connectors="true"');
    expect(markup).not.toContain('data-selection-rotate-handle="true"');
    expect(markup).not.toContain("data-molecule-transform-frame");
    expect(markup).not.toContain("data-molecule-resize-corner");
  });

  it("does not treat stale native molecule fragment targets as visible selections", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Stale Native Part"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!molecule) {
      throw new Error("Expected native molecule fixture.");
    }

    expect(nativeMoleculeSelectionHasVisibleTargets(molecule, false, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "missing_bond"
    })).toBe(false);
    expect(nativeMoleculeSelectionHasVisibleTargets(molecule, false, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001"
    })).toBe(true);
  });

  it("renders selected text objects with resize and rotate handles", () => {
    const document = insertNativeTextObject(
      createPhase4Document("Text Box Render"),
      { x: 160, y: 180 },
      "reaction note"
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("text-object");
    expect(markup).toContain('data-text-sizing-mode="auto"');
    expect(markup).toContain('data-text-resize-edge="left"');
    expect(markup).toContain('data-text-resize-edge="right"');
    expect(markup).toContain('data-text-resize-edge="top"');
    expect(markup).toContain('data-text-resize-edge="bottom"');
    expect(markup).toContain('aria-label="Rotate selected text box"');
    expect(markup).toContain('data-selection-rotate-handle="true"');
    expect(markup).toContain('data-rotate-icon="double-headed"');
    expect(markup).toContain("reaction note");
  });

  it("renders native text object script spans", () => {
    const document = insertNativeTextObject(
      createPhase4Document("Text Script Render"),
      { x: 160, y: 180 },
      "x2"
    );
    const textObject = document.pages[0].objects.find((object) => object.type === "text");
    if (!textObject) {
      throw new Error("Expected inserted text object.");
    }
    const scripted = applyPatch(document, {
      op: "updateObject",
      objectId: textObject.id,
      changes: {
        spans: [
          { text: "x", script: "normal", style: {} },
          { text: "2", script: "superscript", style: { color: "#b3261e" } }
        ]
      }
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: scripted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-object-type="text"');
    expect(markup).toContain('baseline-shift="super"');
    expect(markup).toContain('fill="#b3261e"');
  });

  it("renders native molecule part colors for selected-style atom labels and bonds", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Molecule Part Color Render"),
      { x: 220, y: 240 }
    );
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const atomId = molecule?.atoms[0]?.id;
    const bondId = molecule?.bonds[0]?.id;
    if (!molecule || !atomId || !bondId) {
      throw new Error("Expected native molecule fixture.");
    }
    const nitrogen = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId,
      distanceToPointer: 0
    }, "N");
    const colored = applyPatch(nitrogen, {
      op: "updateObject",
      objectId: molecule.id,
      changes: {
        style: {
          ...molecule.style,
          atomLabelColors: { [atomId]: "#c75c12" },
          bondColors: { [bondId]: "#b3261e" }
        }
      }
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: colored,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('stroke="#b3261e"');
    expect(markup).toContain('fill="#c75c12"');
    expect(markup).toContain('data-atom-label="NH2"');
    expect(appCss).not.toMatch(/\\.native-bond-line\\s*{[^}]*stroke\\s*:/);
    expect(appCss).not.toMatch(/\\.native-atom-label\\s*{[^}]*fill\\s*:/);
  });

  it("renders native styled bonds and template molecules on the ChemDraft canvas", () => {
    const wedgeDocument = insertNativeSingleBondMolecule(
      createPhase4Document("Styled Bond Render"),
      { x: 200, y: 220 },
      { bondStyle: "wedge" }
    );
    const document = insertNativeTemplateMolecule(wedgeDocument, { x: 360, y: 260 }, "benzene");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("<polygon");
    expect(markup).toContain('data-bond-style="wedge"');
    expect(markup).toContain('data-atom-count="6"');
    expect(markup).toContain('data-bond-count="6"');
    expect(markup).toContain("bond_001:double");
  });

  it("renders invalid-valence markers for over-coordinated native atoms", () => {
    const growFromAtom = (document: ReturnType<typeof insertNativeSingleBondMolecule>, atomId: string, angleDegrees: number) => {
      const molecule = document.pages[0].objects[0];
      if (molecule.type !== "molecule") {
        throw new Error("Expected molecule fixture.");
      }
      const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
      if (!atom) {
        throw new Error(`Expected atom "${atomId}".`);
      }

      const steerDistance = nativeAtomHitRadiusPx * 0.65;
      return applySingleBondToolAtPoint(document, {
        x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steerDistance,
        y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steerDistance
      });
    };
    const overValent = [-120, 120, 180, 0].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Invalid Carbon Render"), { x: 300, y: 300 })
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: overValent,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-invalid-atom-ids="atom_001"');
    expect(markup).toContain("native-atom-invalid-marker");
    expect(markup).toContain('data-invalid-atom-id="atom_001"');
  });

  it("renders bonded non-carbon atom labels from native molecule state", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Oxygen Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    const updated = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    }, "O");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: updated,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-structure="CO"');
    expect(markup).toContain("native-atom-label-background");
    expect(markup).toContain('font-family="Arial, Helvetica, sans-serif"');
    expect(markup).toContain('data-atom-label="OH"');
    expect(markup).toContain('data-atom-label-run="normal"');
    expect(markup).toContain(">OH</text>");
    expect(markup).not.toContain(">C</text>");
  });

  it("renders explicit quaternary ammonium charge as a compact affix without an invalid marker", () => {
    const ammoniumMolecule = {
      id: "mol_ammonium",
      type: "molecule",
      x: 120,
      y: 120,
      width: 180,
      height: 180,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "C[N+](C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 1 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 1,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Ammonium Render"),
      { op: "addObject", pageId: "page_001", object: ammoniumMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const nLabelMarkup = markup.match(/<g [^>]*class="native-atom-label"[^>]*data-atom-label="N\+"[\s\S]*?<\/g>/)?.[0] ?? "";
    const leftBondMarkup = markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_left"[^>]*>/)?.[0] ?? "";
    const rightBondMarkup = markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_right"[^>]*>/)?.[0] ?? "";

    expect(markup).toContain('data-atom-label="N+"');
    expect(nLabelMarkup).toContain('data-atom-label-run="normal"');
    expect(nLabelMarkup).toContain('text-anchor="middle">N</text>');
    expect(nLabelMarkup).toContain('data-atom-label-run="charge"');
    expect(nLabelMarkup).toContain('font-size="13.2"');
    expect(nLabelMarkup).toContain(">+</text>");
    expect(markup).not.toContain("native-atom-invalid-marker");
    expect(markup).not.toContain("native-atom-invalid-ring");
    expect(leftBondMarkup).not.toContain('x2="80"');
    expect(rightBondMarkup).not.toContain('x1="80"');
  });

  it("marks neutral hypervalent nitrogen invalid instead of auto-placing a charge", () => {
    const neutralNitrogenMolecule = {
      id: "mol_neutral_hypervalent_n",
      type: "molecule",
      x: 120,
      y: 120,
      width: 180,
      height: 180,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CN(C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Neutral Hypervalent Nitrogen Render"),
      { op: "addObject", pageId: "page_001", object: neutralNitrogenMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-atom-label="N"');
    expect(markup).not.toContain('data-atom-label="N+"');
    expect(markup).toContain('data-invalid-atom-ids="atom_n"');
    expect(markup).toContain('data-invalid-atom-id="atom_n"');
  });

  it("renders movable charge marks as valence-resolution objects only while close to the atom", () => {
    const neutralNitrogenMolecule = {
      id: "mol_charge_resolution",
      type: "molecule",
      x: 120,
      y: 120,
      width: 180,
      height: 180,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CN(C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const chargeMark = {
      id: "charge_001",
      type: "electron-mark",
      x: 202,
      y: 180,
      width: 18,
      height: 18,
      rotation: 0,
      style: { source: "test-charge" },
      markKind: "charge",
      anchor: { kind: "point", point: { x: 211, y: 189 } },
      charge: 1
    } satisfies DocumentObject;
    const document = applyPatch(
      createPhase4Document("Charge Resolution Render"),
      { op: "addObject", pageId: "page_001", object: neutralNitrogenMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const withCharge = applyPatch(
      document,
      { op: "addObject", pageId: "page_001", object: chargeMark },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const resolvedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: withCharge,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const movedAway = applyPatch(
      withCharge,
      { op: "moveObject", objectId: "charge_001", x: 420, y: 360 },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const unresolvedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: movedAway,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(resolvedMarkup).toContain("charge-mark-object");
    expect(resolvedMarkup).toContain('data-charge="1"');
    expect(resolvedMarkup).toContain('data-resolved-charge-atom-ids="atom_n"');
    expect(resolvedMarkup).not.toContain("native-atom-invalid-marker");
    expect(unresolvedMarkup).not.toContain('data-resolved-charge-atom-ids="atom_n"');
    expect(unresolvedMarkup).toContain('data-invalid-atom-id="atom_n"');
  });

  it("stress-renders charged and hydrogen-count atom labels without recentering the element glyph", () => {
    const labelStressMolecule = {
      id: "mol_label_stress",
      type: "molecule",
      x: 100,
      y: 100,
      width: 520,
      height: 360,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "[B-]([C])([C])([C])[C].[N+]([C])([C])([C])[C].[O+]([C])([C])[C].C.O",
      atoms: [
        { id: "atom_b", element: "B", x: 180, y: 180, formalCharge: -1 },
        { id: "atom_b1", element: "C", x: 130, y: 180, formalCharge: 0 },
        { id: "atom_b2", element: "C", x: 185, y: 130, formalCharge: 0 },
        { id: "atom_b3", element: "C", x: 150, y: 220, formalCharge: 0 },
        { id: "atom_b4", element: "C", x: 235, y: 205, formalCharge: 0 },
        { id: "atom_n", element: "N", x: 330, y: 180, formalCharge: 1 },
        { id: "atom_n1", element: "C", x: 280, y: 180, formalCharge: 0 },
        { id: "atom_n2", element: "C", x: 335, y: 130, formalCharge: 0 },
        { id: "atom_n3", element: "C", x: 300, y: 220, formalCharge: 0 },
        { id: "atom_n4", element: "C", x: 385, y: 205, formalCharge: 0 },
        { id: "atom_o", element: "O", x: 470, y: 180, formalCharge: 1 },
        { id: "atom_o1", element: "C", x: 430, y: 180, formalCharge: 0 },
        { id: "atom_o2", element: "C", x: 485, y: 135, formalCharge: 0 },
        { id: "atom_o3", element: "C", x: 500, y: 220, formalCharge: 0 },
        { id: "atom_ch4", element: "C", x: 230, y: 300, formalCharge: 0 },
        { id: "atom_oh2", element: "O", x: 360, y: 300, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_b1", fromAtomId: "atom_b", toAtomId: "atom_b1", order: "single" },
        { id: "bond_b2", fromAtomId: "atom_b", toAtomId: "atom_b2", order: "single" },
        { id: "bond_b3", fromAtomId: "atom_b", toAtomId: "atom_b3", order: "single" },
        { id: "bond_b4", fromAtomId: "atom_b", toAtomId: "atom_b4", order: "single" },
        { id: "bond_n1", fromAtomId: "atom_n", toAtomId: "atom_n1", order: "single" },
        { id: "bond_n2", fromAtomId: "atom_n", toAtomId: "atom_n2", order: "single" },
        { id: "bond_n3", fromAtomId: "atom_n", toAtomId: "atom_n3", order: "single" },
        { id: "bond_n4", fromAtomId: "atom_n", toAtomId: "atom_n4", order: "single" },
        { id: "bond_o1", fromAtomId: "atom_o", toAtomId: "atom_o1", order: "single" },
        { id: "bond_o2", fromAtomId: "atom_o", toAtomId: "atom_o2", order: "single" },
        { id: "bond_o3", fromAtomId: "atom_o", toAtomId: "atom_o3", order: "single" }
      ],
      chemistry: {
        formula: "BNO",
        atomCount: 16,
        bondCount: 11,
        totalCharge: 1,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Label Stress Render"),
      { op: "addObject", pageId: "page_001", object: labelStressMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    for (const label of ["B-", "N+", "O+", "CH4", "OH2"]) {
      expect(markup).toContain(`data-atom-label="${label}"`);
    }
    expect(markup.match(/data-atom-label-run="charge"/g) ?? []).toHaveLength(3);
    expect(markup.match(/data-atom-label-run="subscript"/g) ?? []).toHaveLength(2);
    expect(markup.match(/text-anchor="middle">[BNO]<\/text>/g) ?? []).toHaveLength(3);
    expect(markup).not.toContain("native-atom-invalid-marker");
  });

  it("renders disconnected methane labels after deleting a central native carbon", () => {
    const growFromAtom = (document: ReturnType<typeof insertNativeSingleBondMolecule>, atomId: string, angleDegrees: number) => {
      const molecule = document.pages[0].objects[0];
      if (molecule.type !== "molecule") {
        throw new Error("Expected molecule fixture.");
      }
      const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
      if (!atom) {
        throw new Error(`Expected atom "${atomId}".`);
      }

      const steerDistance = nativeAtomHitRadiusPx * 0.65;
      return applySingleBondToolAtPoint(document, {
        x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steerDistance,
        y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steerDistance
      });
    };
    const neopentane = [-120, 120, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Methane Labels"), { x: 300, y: 300 })
    );
    const molecule = neopentane.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected neopentane molecule fixture.");
    }
    const deleted = applyNativeMoleculeDeleteTarget(neopentane, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: deleted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup.match(/data-atom-label="CH4"/g) ?? []).toHaveLength(4);
    expect(markup.match(/data-atom-label-run="subscript"[^>]*>4<\/text>/g) ?? []).toHaveLength(4);
    expect(markup).toContain('data-structure="C.C.C.C"');
    expect(markup).toContain("Molecule C4H16");
    expect(markup).not.toContain("native-bond-line");
  });

  it("renders explicit hydrogen atom labels from native molecule state", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Hydrogen Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const sourceAtom = molecule.atoms.find((atom) => atom.id === "atom_001");
    if (!sourceAtom) {
      throw new Error("Expected source atom.");
    }
    const withHydrogenBond = applyFreeformSingleBondToolAtPoint(
      document,
      molecule.id,
      "atom_001",
      { x: sourceAtom.x - nativeBondLengthPx * 0.7, y: sourceAtom.y },
      { forceCustomLength: true }
    );
    const hydrogenMolecule = withHydrogenBond.pages[0].objects[0];
    if (hydrogenMolecule.type !== "molecule") {
      throw new Error("Expected hydrogen molecule fixture.");
    }
    const hydrogenAtomId = hydrogenMolecule.atoms.at(-1)?.id;
    if (!hydrogenAtomId) {
      throw new Error("Expected explicit hydrogen atom.");
    }
    const updated = applyNativeAtomElementTarget(withHydrogenBond, {
      objectId: hydrogenMolecule.id,
      kind: "atom",
      atomId: hydrogenAtomId,
      distanceToPointer: 0
    }, "H");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: updated,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-atom-label="H"');
    expect(markup).toContain('data-atom-label-run="normal"');
    expect(markup).toContain(">H</text>");
    expect(markup).toContain('data-atom-count="3"');
  });

  it("keeps the narrow Ketcher host closed for document selection alone", () => {
    const blankMarkup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "hidden", nativePalette: true })
    );
    const document = insertNativeSingleBondMolecule(createPhase4Document("Ketcher Host"), { x: 200, y: 220 });
    const selectedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(blankMarkup).not.toContain("ketcher-editor-host");
    expect(selectedMarkup).not.toContain("ketcher-editor-host");
    expect(selectedMarkup).not.toContain("Loading Ketcher molecule editor");
  });

  it("keeps molecule-editor activation out of selection clicks", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Active Molecule"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    const label = {
      id: "label_001",
      type: "text",
      x: 120,
      y: 120,
      width: 80,
      height: 24,
      rotation: 0,
      style: {},
      text: "Label",
      spans: []
    } satisfies DocumentObject;

    expect(shouldActivateDocumentObject(molecule, "bond")).toBe(false);
    expect(shouldActivateDocumentObject(molecule, "selection")).toBe(true);
    expect(shouldActivateDocumentObject(label, "bond")).toBe(false);
    expect(shouldActivateDocumentObject(label, "selection")).toBe(true);
    expect(shouldOpenMoleculeEditorFromObjectClick(molecule, "selection", 1)).toBe(false);
    expect(shouldOpenMoleculeEditorFromObjectClick(molecule, "selection", 2)).toBe(false);
    expect(shouldOpenMoleculeEditorFromObjectClick(molecule, "bond", 2)).toBe(false);
    expect(shouldOpenMoleculeEditorFromObjectClick(label, "selection", 2)).toBe(false);
  });

  it("resolves selected native atom and bond parts into command targets", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Selected Part Target"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }

    expect(nativeDeleteTargetFromSelectionPart(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002"
    })).toEqual({
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    });
    expect(nativeDeleteTargetFromSelectionPart(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001"
    })).toEqual({
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });
    expect(nativeDeleteTargetFromSelectionPart(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "missing_atom"
    })).toBeUndefined();
  });

  it("keeps whole selected native molecule drags ahead of atom and bond part drags", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Whole Molecule Drag Intent"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const atomHit = {
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    } as const;
    const bondHit = {
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    } as const;

    expect(nativeMoleculeSelectionDragIntent(document, molecule.id, undefined, atomHit)).toEqual({ kind: "whole-object" });
    expect(nativeMoleculeSelectionDragIntent(document, molecule.id, undefined, bondHit)).toEqual({ kind: "whole-object" });
    expect(nativeMoleculeSelectionDragIntent(document, molecule.id, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001"
    }, atomHit)).toEqual({
      kind: "native-part",
      target: {
        objectId: molecule.id,
        kind: "atom",
        atomId: "atom_001"
      }
    });
  });

  it("lets existing charge marks move while charge tools stay active", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Charge Drag"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    const chargeMark = {
      id: "charge_001",
      type: "electron-mark",
      x: 240,
      y: 180,
      width: 18,
      height: 18,
      rotation: 0,
      style: {},
      markKind: "charge",
      anchor: { kind: "point", point: { x: 249, y: 189 } },
      charge: 1
    } satisfies DocumentObject;

    expect(shouldDragDocumentObject(chargeMark, "charge")).toBe(true);
    expect(shouldDragDocumentObject(chargeMark, "selection")).toBe(true);
    expect(shouldDragDocumentObject(molecule, "charge")).toBe(false);
    expect(shouldDragDocumentObject(chargeMark, "bond")).toBe(false);
  });

  it("renders connected native molecule graphs from one document object", () => {
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Connected Render"), { x: 200, y: 220 });
    const initialMolecule = initial.pages[0].objects[0];
    if (initialMolecule.type !== "molecule") {
      throw new Error("Expected native molecule fixture.");
    }
    const terminalAtom = initialMolecule.atoms.find((atom) => atom.id === "atom_002");
    if (!terminalAtom) {
      throw new Error("Expected terminal atom.");
    }
    const document = applySingleBondToolAtPoint(initial, {
      x: terminalAtom.x + nativeAtomHitRadiusPx * 0.65,
      y: terminalAtom.y
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("native-carbon-chain");
    expect(markup).toContain('data-structure="CCC"');
    expect(markup).toContain('data-atom-count="3"');
    expect(markup).toContain('data-bond-count="2"');
    expect((markup.match(/native-bond-line/g) ?? []).length).toBe(2);
    expect(document.pages[0].objects).toHaveLength(1);
  });

  it("renders asymmetric double bonds with overlap clearance strokes", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Double Bond Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const doubleBond = applyNativeMoleculeBondOrderTarget(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: doubleBond,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect((markup.match(/native-bond-line/g) ?? []).length).toBe(2);
    expect(markup).not.toContain("native-bond-knockout");
    expect(markup).toContain('data-bond-segment="primary"');
    expect(markup).toContain('data-bond-segment="secondary"');
    expect(markup).toContain('data-double-bond-side="left"');
  });

  it("renders terminal heteroatom double bonds as centered equal-length pairs", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Carbonyl Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const withOxygen = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    }, "O");
    const carbonyl = applyNativeMoleculeBondOrderTarget(withOxygen, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: carbonyl,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const carbonylLineMarkups = markup.match(
      /<line class="native-bond-line native-bond-double" data-bond-id="bond_001" data-bond-order="double" data-bond-segment="(?:primary|secondary)"[^>]*>/g
    ) ?? [];
    const primaryLineMarkup = carbonylLineMarkups.find((line) => line.includes('data-bond-segment="primary"')) ?? "";
    const secondaryLineMarkup = carbonylLineMarkups.find((line) => line.includes('data-bond-segment="secondary"')) ?? "";

    expect(markup).toContain('data-structure="C=O"');
    expect(markup).toContain('data-atom-label="O"');
    expect(carbonylLineMarkups).toHaveLength(2);
    expect(primaryLineMarkup).not.toBe("");
    expect(secondaryLineMarkup).not.toBe("");
    expect(svgLineLength(primaryLineMarkup)).toBeCloseTo(svgLineLength(secondaryLineMarkup), 3);
    expect(svgLineNumberAttribute(primaryLineMarkup, "x1")).toBeCloseTo(svgLineNumberAttribute(secondaryLineMarkup, "x1"), 3);
    expect(svgLineNumberAttribute(primaryLineMarkup, "x2")).toBeCloseTo(svgLineNumberAttribute(secondaryLineMarkup, "x2"), 3);
    expect(Math.abs(svgLineNumberAttribute(primaryLineMarkup, "y1") - svgLineNumberAttribute(secondaryLineMarkup, "y1"))).toBeGreaterThan(0);
  });

  it("renders document object order as explicit visual layers for molecule over-under crossings", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Layer Render"), { x: 200, y: 220 });
    const second = insertNativeSingleBondMolecule(first, { x: 200, y: 220 });
    const sentBackward = reorderSelectedDocumentObject(second, "backward");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: sentBackward,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const backObjectIndex = markup.indexOf('data-object-id="mol_bond_002"');
    const frontObjectIndex = markup.indexOf('data-object-id="mol_bond_001"');

    expect(sentBackward.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_002", "mol_bond_001"]);
    expect(backObjectIndex).toBeGreaterThan(-1);
    expect(frontObjectIndex).toBeGreaterThan(-1);
    expect(backObjectIndex).toBeLessThan(frontObjectIndex);
    expect(markup).toContain('data-object-id="mol_bond_002" data-layer-index="0"');
    expect(markup).toContain('data-object-id="mol_bond_001" data-layer-index="1"');
    expect(markup).toContain("z-index:1");
    expect(markup).toContain("z-index:2");

    expect(markup).not.toContain("native-bond-knockout");
  });

  it("renders selected atom layer controls in the object context menu", () => {
    const markup = renderToStaticMarkup(
      createElement(ObjectLayerContextMenu, {
        objectId: "mol_depth",
        objectIndex: 0,
        objectCount: 2,
        targetKind: "atom",
        position: { x: 20, y: 30 },
        onInvoke: () => undefined
      })
    );

    expect(markup).toContain('data-context-object-id="mol_depth"');
    expect(markup).toContain('data-context-target-kind="atom"');
    expect(markup).toContain("Molecule layer");
    expect(markup).not.toContain("Bond depth");
    expect(markup).not.toContain("Bring Bond In Front");
    expect(markup).toContain('data-command-id="layout.bringForward"');
    expect(markup).toContain("Move Object Forward");
    expect(markup).toContain('data-command-id="layout.bringToFront"');
    expect(markup).toContain("Move Object to Front");
    expect(markup).toContain('data-command-id="layout.sendBackward"');
    expect(markup).toContain("Move Object Backward");
    expect(markup).toContain('data-command-id="layout.sendToBack"');
    expect(markup).toContain("Move Object to Back");
  });

  it("renders bond depth controls in the object context menu", () => {
    const markup = renderToStaticMarkup(
      createElement(ObjectLayerContextMenu, {
        objectId: "mol_front",
        objectIndex: 1,
        objectCount: 2,
        targetKind: "bond",
        bondDepthContext: {
          targetBondRefs: [{ objectId: "mol_front", bondId: "bond_001" }],
          relevantCrossings: [{
            key: "mol_back::bond_001|mol_front::bond_001",
            bonds: [
              { objectId: "mol_back", bondId: "bond_001" },
              { objectId: "mol_front", bondId: "bond_001" }
            ],
            front: { objectId: "mol_front", bondId: "bond_001" },
            back: { objectId: "mol_back", bondId: "bond_001" },
            hasOverride: true
          }],
          hasOverrides: true
        },
        position: { x: 20, y: 30 },
        onInvoke: () => undefined
      })
    );

    expect(markup).toContain('data-context-target-kind="bond"');
    expect(markup).toContain("Bond depth");
    expect(markup).toContain('data-command-id="bondDepth.bringInFront"');
    expect(markup).toContain("Bring Bond In Front");
    expect(markup).toContain('data-command-id="bondDepth.sendBehind"');
    expect(markup).toContain("Send Bond Behind");
    expect(markup).toContain('data-command-id="bondDepth.useDefault"');
    expect(markup).toContain("Use Default Bond Depth");
    expect(markup).toContain("Molecule layer");
    expect(markup).not.toContain("Flip Crossing");
    expect(markup).not.toContain("Clear Crossing Override");
  });

  it("uses selected-bonds labels for multi-bond depth context", () => {
    const markup = renderToStaticMarkup(
      createElement(ObjectLayerContextMenu, {
        objectId: "mol_front",
        objectIndex: 1,
        objectCount: 2,
        targetKind: "parts",
        bondDepthContext: {
          targetBondRefs: [
            { objectId: "mol_front", bondId: "bond_001" },
            { objectId: "mol_front", bondId: "bond_002" }
          ],
          relevantCrossings: [{
            key: "mol_back::bond_001|mol_front::bond_001",
            bonds: [
              { objectId: "mol_back", bondId: "bond_001" },
              { objectId: "mol_front", bondId: "bond_001" }
            ],
            front: { objectId: "mol_front", bondId: "bond_001" },
            back: { objectId: "mol_back", bondId: "bond_001" },
            hasOverride: false
          }],
          hasOverrides: false
        },
        position: { x: 20, y: 30 },
        onInvoke: () => undefined
      })
    );

    expect(markup).toContain('data-context-target-kind="parts"');
    expect(markup).toContain("Molecule layer");
    expect(markup).toContain("Bring Selected Bonds In Front");
    expect(markup).toContain("Send Selected Bonds Behind");
    expect(markup).not.toContain("Use Default Bond Depth");
  });

  it("preserves whole-molecule selection when right-clicking native geometry inside it", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Whole Right Click"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const selectedDocument = {
      ...document,
      selection: {
        objectIds: [molecule.id]
      }
    };

    expect(nativeContextMenuSelectionResolutionFromHit(
      selectedDocument,
      molecule.id,
      {
        kind: "bond",
        bondId: "bond_001",
        fromAtomId: "atom_001",
        toAtomId: "atom_002",
        distanceToPointer: 0
      },
      undefined
    )).toEqual({ targetKind: "object" });
  });

  it("right-click selection still resolves a native bond when the whole molecule is not selected", () => {
    const selection = nativeContextMenuSelectionResolutionFromHit(
      createPhase4Document("Part Right Click"),
      "mol_depth",
      {
        kind: "bond",
        bondId: "bond_bridge",
        fromAtomId: "atom_002",
        toAtomId: "atom_003",
        distanceToPointer: 0
      },
      undefined
    );

    expect(selection).toEqual({
      selectedPart: {
        objectId: "mol_depth",
        kind: "bond",
        bondId: "bond_bridge"
      },
      targetKind: "bond"
    });
  });

  it("derives object-qualified bond depth refs from native selections", () => {
    expect(bondDepthRefsFromNativeSelection({
      objectId: "mol_depth",
      kind: "bond",
      bondId: "bond_bridge"
    })).toEqual([{ objectId: "mol_depth", bondId: "bond_bridge" }]);
    expect(bondDepthRefsFromNativeSelection({
      objectId: "mol_depth",
      kind: "parts",
      atomIds: ["atom_001"],
      bondIds: ["bond_left", "bond_bridge"]
    })).toEqual([
      { objectId: "mol_depth", bondId: "bond_left" },
      { objectId: "mol_depth", bondId: "bond_bridge" }
    ]);
    expect(bondDepthRefsFromNativeSelection({
      objectId: "mol_depth",
      kind: "atom",
      atomId: "atom_001"
    })).toEqual([]);
  });

  it("derives relevant crossing context from selected bonds", () => {
    const target = { objectId: "mol_depth", bondId: "bond_bridge" };
    const other = { objectId: "mol_other", bondId: "bond_001" };
    const context = bondDepthContextFromNativeSelection({
      objectId: "mol_depth",
      kind: "parts",
      atomIds: ["atom_001"],
      bondIds: ["bond_bridge"]
    }, [{
      key: "mol_depth::bond_bridge|mol_other::bond_001",
      bonds: [target, other] as [typeof target, typeof other],
      front: other,
      back: target,
      point: { x: 160, y: 180 },
      clearancePx: 8,
      hasOverride: true
    }]);

    expect(context).toEqual({
      targetBondRefs: [target],
      relevantCrossings: [{
        key: "mol_depth::bond_bridge|mol_other::bond_001",
        bonds: [target, other],
        front: other,
        back: target,
        hasOverride: true
      }],
      hasOverrides: true
    });
  });

  it("plans bond-depth patches across all relevant crossings", () => {
    const target = { objectId: "mol_depth", bondId: "bond_bridge" };
    const bondA = { objectId: "mol_a", bondId: "bond_a" };
    const bondB = { objectId: "mol_b", bondId: "bond_b" };
    const crossingOne = {
      key: "mol_a::bond_a|mol_depth::bond_bridge",
      bonds: [bondA, target] as [typeof bondA, typeof target],
      front: bondA,
      back: target,
      hasOverride: false
    };
    const crossingTwo = {
      key: "mol_b::bond_b|mol_depth::bond_bridge",
      bonds: [bondB, target] as [typeof bondB, typeof target],
      front: bondB,
      back: target,
      hasOverride: false
    };
    const context = {
      targetBondRefs: [target],
      relevantCrossings: [crossingOne, crossingTwo],
      hasOverrides: false
    };

    expect(planBondDepthPatches("page_001", context, "bondDepth.bringInFront")).toEqual([
      {
        op: "setCrossingOverride",
        pageId: "page_001",
        crossing: { bonds: crossingOne.bonds, front: target }
      },
      {
        op: "setCrossingOverride",
        pageId: "page_001",
        crossing: { bonds: crossingTwo.bonds, front: target }
      }
    ]);
    expect(planBondDepthPatches("page_001", {
      ...context,
      relevantCrossings: [{ ...crossingOne, front: target, back: bondA }]
    }, "bondDepth.sendBehind")).toEqual([{
      op: "setCrossingOverride",
      pageId: "page_001",
      crossing: { bonds: crossingOne.bonds, front: bondA }
    }]);
  });

  it("skips selected-selected crossings for directional depth and clears defaults", () => {
    const left = { objectId: "mol_depth", bondId: "bond_left" };
    const right = { objectId: "mol_depth", bondId: "bond_right" };
    const crossing = {
      key: "mol_depth::bond_left|mol_depth::bond_right",
      bonds: [left, right] as [typeof left, typeof right],
      front: left,
      back: right,
      hasOverride: true
    };
    const context = {
      targetBondRefs: [left, right],
      relevantCrossings: [crossing],
      hasOverrides: true
    };

    expect(planBondDepthPatches("page_001", context, "bondDepth.bringInFront")).toEqual([]);
    expect(planBondDepthPatches("page_001", context, "bondDepth.sendBehind")).toEqual([]);
    expect(planBondDepthPatches("page_001", context, "bondDepth.useDefault")).toEqual([{
      op: "clearCrossingOverride",
      pageId: "page_001",
      bonds: crossing.bonds
    }]);
  });

  it("clears cross-object crossing overrides for object layer moves", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Layer Crossing Defaults"), { x: 200, y: 220 });
    const document = insertNativeSingleBondMolecule(first, { x: 200, y: 220 });
    const page = document.pages[0];
    const selectedRef = { objectId: "mol_bond_001", bondId: "bond_001" };
    const neighborRef = { objectId: "mol_bond_002", bondId: "bond_001" };
    const withCrossing = {
      ...document,
      pages: [{
        ...page,
        crossings: [{
          bonds: [selectedRef, neighborRef] as [typeof selectedRef, typeof neighborRef],
          front: neighborRef
        }]
      }]
    };

    expect(crossingClearPatchesForObjectLayerPlacement(
      withCrossing.pages[0],
      "mol_bond_001",
      "forward"
    )).toEqual([{
      op: "clearCrossingOverride",
      pageId: page.id,
      bonds: [selectedRef, neighborRef]
    }]);

    const moved = reorderSelectedDocumentObjectWithCrossingDefaults({
      ...withCrossing,
      selection: { pageId: page.id, objectIds: ["mol_bond_001"] }
    }, "forward");

    expect(moved.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_002", "mol_bond_001"]);
    expect(moved.pages[0].crossings).toEqual([]);
  });

  it("limits one-step layer crossing resets to the object being passed", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Layer Crossing Neighbor"), { x: 200, y: 220 });
    const second = insertNativeSingleBondMolecule(first, { x: 200, y: 220 });
    const document = insertNativeSingleBondMolecule(second, { x: 200, y: 220 });
    const page = document.pages[0];
    const selectedRef = { objectId: "mol_bond_001", bondId: "bond_001" };
    const neighborRef = { objectId: "mol_bond_002", bondId: "bond_001" };
    const nonNeighborRef = { objectId: "mol_bond_003", bondId: "bond_001" };
    const withCrossings = {
      ...document,
      pages: [{
        ...page,
        crossings: [
          {
            bonds: [selectedRef, neighborRef] as [typeof selectedRef, typeof neighborRef],
            front: neighborRef
          },
          {
            bonds: [selectedRef, nonNeighborRef] as [typeof selectedRef, typeof nonNeighborRef],
            front: nonNeighborRef
          }
        ]
      }]
    };

    expect(crossingClearPatchesForObjectLayerPlacement(
      withCrossings.pages[0],
      "mol_bond_001",
      "forward"
    )).toEqual([{
      op: "clearCrossingOverride",
      pageId: page.id,
      bonds: [selectedRef, neighborRef]
    }]);
    expect(crossingClearPatchesForObjectLayerPlacement(
      withCrossings.pages[0],
      "mol_bond_001",
      "front"
    )).toHaveLength(2);
  });

  it("renders later bonds over earlier crossing bonds inside one molecule", () => {
    const crossingMolecule = {
      id: "mol_crossing",
      type: "molecule",
      x: 120,
      y: 120,
      width: 120,
      height: 120,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CC.CC",
      atoms: [
        { id: "atom_back_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_back_002", element: "C", x: 220, y: 180, formalCharge: 0 },
        { id: "atom_front_001", element: "C", x: 180, y: 140, formalCharge: 0 },
        { id: "atom_front_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_back", fromAtomId: "atom_back_001", toAtomId: "atom_back_002", order: "single" },
        { id: "bond_front", fromAtomId: "atom_front_001", toAtomId: "atom_front_002", order: "single" }
      ],
      chemistry: {
        formula: "C4H12",
        atomCount: 4,
        bondCount: 2,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Crossing Bond Render"),
      { op: "addObject", pageId: "page_001", object: crossingMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const backLayerIndex = markup.indexOf('data-bond-layer-id="bond_back"');
    const frontLayerIndex = markup.indexOf('data-bond-layer-id="bond_front"');
    const backLayerMarkup = markup.slice(backLayerIndex, frontLayerIndex);
    const frontLayerMarkup = markup.slice(frontLayerIndex);

    expect(markup).toContain('class="page-svg-surface"');
    expect(markup).not.toContain('class="molecule-glyph"');
    expect(backLayerIndex).toBeGreaterThan(-1);
    expect(frontLayerIndex).toBeGreaterThan(-1);
    expect(backLayerIndex).toBeLessThan(frontLayerIndex);
    expect((backLayerMarkup.match(/native-bond-line/g) ?? []).length).toBe(2);
    expect((frontLayerMarkup.match(/native-bond-line/g) ?? []).length).toBe(1);
    expect(markup).toContain("native-crossing-hit-target");
    expect(markup).toContain("native-bond-hover-decorator");
    expect(markup).not.toContain("native-bond-knockout");
  });

  it("does not render over-under gaps for bonds sharing one atom", () => {
    const geminalMolecule = {
      id: "mol_geminal",
      type: "molecule",
      x: 120,
      y: 120,
      width: 130,
      height: 130,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CC(C)C",
      atoms: [
        { id: "atom_center", element: "C", x: 180, y: 180, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 200, y: 140, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 220, y: 165, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_center", order: "single" },
        { id: "bond_up", fromAtomId: "atom_center", toAtomId: "atom_up", order: "single" },
        { id: "bond_right", fromAtomId: "atom_center", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H10",
        atomCount: 4,
        bondCount: 3,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Geminal Render"),
      { op: "addObject", pageId: "page_001", object: geminalMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const upLine = markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_up"[^>]*>/)?.[0] ?? "";

    expect(upLine).toContain('x1="180"');
    expect(upLine).toContain('y1="180"');
    expect(markup).not.toContain("native-bond-knockout");
  });


  it("renders canvas geometry from the active document page layout", () => {
    const document = setDocumentPageSize(createPhase4Document("A4 Canvas"), "a4");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain(`--page-layout-width:${document.pages[0].width}px`);
    expect(markup).toContain(`--page-layout-height:${document.pages[0].height}px`);
  });

  it("sets ruler units from the active document page family", () => {
    const a4Document = setDocumentPageSize(createPhase4Document("Metric Canvas"), "a4");
    const legalDocument = setDocumentPageSize(createPhase4Document("US Legal Canvas"), "legal");
    const a4Markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: a4Document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const legalMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: legalDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(a4Markup).toContain(">cm</span>");
    expect(a4Markup).toContain("crosshair-tick-half");
    expect(legalMarkup).toContain(">in</span>");
    expect(legalMarkup).toContain("crosshair-tick-quarter");
  });

  it("updates page size and orientation without mutating molecule payloads", () => {
    const document = applyAnalysisToSelectedMolecule(
      insertAdapterFallbackMolecule(createPhase4Document("Payload Fixture")),
      {
        input: { format: "smiles", value: "CCO" },
        validation: { valid: true, errors: [], warnings: [] },
        properties: {
          formula: "C2H6O",
          averageMass: 46.069,
          exactMass: 46.0419,
          totalCharge: 0,
          atomCount: 3,
          bondCount: 2,
          stereochemistry: []
        },
        warnings: []
      }
    );
    const moleculeBefore = document.pages[0].objects[0];
    const resized = setDocumentPageOrientation(setDocumentPageSize(document, "a1"), "landscape");

    expect(resized.pages[0].layout).toMatchObject({ presetId: "a1", orientation: "landscape" });
    expect(resized.pages[0].objects[0]).toEqual(moleculeBefore);
    expect(resized.selection).toEqual(document.selection);
  });

  it("uses active page dimensions as the PNG fallback instead of hard-coded Letter", () => {
    expect(resolvePngCanvasSize(0, 0, { width: 1122.5, height: 793.7 })).toEqual({
      width: 1123,
      height: 794
    });
    expect(resolvePngCanvasSize(640, 480, { width: 1122.5, height: 793.7 })).toEqual({
      width: 640,
      height: 480
    });
  });
});
