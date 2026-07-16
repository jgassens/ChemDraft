import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DefaultNativeTextStyle,
  applyPatch,
  applyPatches,
  createDocumentHistory,
  ChemDraftSyntheticStylePreset,
  stylePresetToObjectStyle,
  type DocumentObject,
  type GraphicObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import {
  projectGraphicObjectPoint
} from "@chemdraft/art-engine";
import {
  nativeMoleculeRings
} from "@chemdraft/layout-engine";
import { inchRulerUnit } from "@chemdraft/viewport-engine";
import {
  allShellCommands,
  atomElementActions,
  createLayerActions,
  createQuickActions,
  editActions,
  normalizeHexColor,
  objectColorForCommand,
  objectCustomColorCommandId,
  objectGradientDeleteStopCommandId,
  objectGradientDeleteStopIndexForCommand,
  objectGradientStopColorCommandId,
  objectGradientStopColorForCommand,
  objectGradientStopOffsetCommandId,
  objectGradientStopOffsetForCommand,
  objectGradientStopOpacityCommandId,
  objectGradientStopOpacityForCommand,
  objectStyleActions,
  pageOrientationActions,
  pageSizeActions,
  paletteGroups,
  structureCleanup3dCommandId,
  structureCleanupCommandId,
  structureInteractive3dCommandId,
  structureSpin3dCommandId,
  structureRotate3dCommandId,
  textCustomColorCommandId,
  textStylePatchForCommand,
  textToolbarActions,
  toolbarCustomizationActions,
  viewActions
} from "./commands";
import {
  applyAnalysisToSelectedMolecule,
  applyObjectColorToDocumentObjects,
  applyDocumentObjectProjectedPlaneTilt,
  applyFreeformSingleBondToolAtPoint,
  applyGraphicObjectColorToSelection,
  applyGraphicObjectOpacityToSelection,
  applyNativeAtomElementTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeDeleteTarget,
  applySingleBondToolAtPoint,
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE,
  createNativeArtGraphicObject,
  createPhase4Document,
  createSelectionClipboardPayload,
  groupSelectedDocumentObjects,
  insertAdapterFallbackMolecule,
  insertNativeArtGraphicObject,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  insertNativeTextObject,
  nativeAtomHitRadiusPx,
  nativeBondLengthPx,
  nativeFreehandStrokeDocument,
  nativeGraphicPathEditPoints,
  nativePolylinePathDocument,
  openNativeDocument,
  reorderSelectedDocumentObject,
  selectDocumentObjectWithinGroup,
  selectDocumentObjects,
  selectionBounds,
  selectionClipboardPlainText,
  setDocumentPageOrientation,
  setDocumentPageSize,
  tiltNativeMoleculeProjectedPlane,
  updateNativeGraphicPathHandle
} from "./documentWorkflow";
import {
  MainWindow,
  ObjectLayerContextMenu,
  SelectionLassoOverlay,
  SelectionMarqueeOverlay,
  TapeMeasureOverlay,
  activeNativeTargetShortcutCommand,
  cumulativeObjectResizeScale,
  cumulativeRotationReadoutDegrees,
  hoveredNativeTargetShortcutCommand,
  objectResizeReadoutPercent,
  objectResizeInputDraftPercent,
  objectResizeScaleFromDrag,
  applyLayerCommandToDocumentSelection,
  bondDepthContextFromNativeSelection,
  bondDepthRefsFromNativeSelection,
  crossingClearPatchesForObjectLayerPlacement,
  nativeContextMenuSelectionResolutionFromHit,
  nativePlacementRotationDegrees,
  nativeDeleteTargetFromSelectionPart,
  nativeMoleculeCanvasHoverTarget,
  nativeMoleculeObjectAtPoint,
  nativeMoleculeSelectionHasVisibleTargets,
  nativePathDirname,
  nativePathJoin,
  nativePathWithBasename,
  isSelectionDoublePress,
  manualRotationDeltaDegrees,
  nativeMoleculeRingSelectionFromPoint,
  planBondDepthPatches,
  reorderSelectedDocumentObjectWithCrossingDefaults,
  nativeMoleculeSelectionDragIntent,
  nativeSelectionWithHitToggled,
  pagePointFromRenderedPageRect,
  documentObjectProjectedPlaneTiltVectorFromDrag,
  initialSelectionClipboardPasteState,
  nextSelectionClipboardPastePlacement,
  parseRotationInputDegrees,
  parseObjectResizeInputPercent,
  projectedPlaneTiltCommitHistory,
  projectedPlaneTiltRadiansFromDrag,
  projectedPlaneTiltReadoutDegrees,
  projectedPlaneTiltReadoutLabel,
  projectedPlaneTiltVectorFromDrag,
  rotationDeltaDegrees,
  rotationInputHomeDraftDegrees,
  rotationInputDraftDegrees,
  rotationReadoutDegrees,
  eraserObjectIdsInSelectionRect,
  graphicArtTransformPreviewSvgDataUrl,
  groupedDragObjectIdsForPointer,
  selectionInSelectionLasso,
  selectionInSelectionRect,
  selectionInSelectionPolygon,
  shouldActivateDocumentObject,
  shouldDragDocumentObject,
  shouldLetSystemClipboardHandleCommand,
  shouldOpenMoleculeEditorFromObjectClick,
  selectionClipboardTextItems,
  visualSelectionBounds,
  shouldUseViewportWheelZoom
} from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createDesktopPluginRuntime } from "./plugins/pluginRuntime";
import { createToolbarCatalog } from "./toolbars/toolbarCatalog";
import {
  FIXTURE_PLUGIN_PING_COMMAND_ID,
  FIXTURE_PLUGIN_TOOLSET_ID,
  createFixturePluginOptions,
  fixturePluginManifest
} from "./plugins/fixturePlugin";
import type { DesktopToolsetRegistry } from "./toolsets";
import { ToolPalette, cmykToRgbColor, hexToRgbColor, rgbToCmykColor, rgbToHexColor } from "./ToolPalette";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  DEFAULT_TOOLSET_ID,
  PALETTE_COMMAND_CANCEL_EVENT,
  PALETTE_COMMAND_COMMIT_EVENT,
  PALETTE_COMMAND_PREVIEW_EVENT,
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
  getToolsetItemGroups,
  getToolsetToggleActions,
  type ToolbarPaletteItemModel
} from "./toolsets";

// Phase 5: widgets are declared as manifest `control` items and read state from context. This
// isolates just a toolset's widget item (no grid commands), the way the old `groups: []` +
// `show*Controls` props rendered only the widget section.
function widgetOnlyItemGroups(toolsetId: string): ToolbarPaletteItemModel[][] {
  return [getToolsetItemGroups(toolsetId).flat().filter((item) => item.primary.type === "control")];
}

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
const mainWindowSource = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
const documentWorkflowSource = readFileSync(new URL("./documentWorkflow.ts", import.meta.url), "utf8");
const commandsSource = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
const desktopToolsetsSource = readFileSync(new URL("./toolsets/desktop-toolsets.json", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const sevenCarbonVisibleCdxml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="External CDXML Fixture">
  <page id="page_001" BoundingBox="0 0 792 612">
    <fragment id="1" BoundingBox="145.6553 124.875 224.6208 168.0677">
      <n id="2" p="157.6553 130.875"/>
      <n id="3" p="157.6553 147.375"/>
      <n id="4" p="173.2089 152.8828"/>
      <n id="5" p="183.5926 140.0599"/>
      <n id="6" p="199.1462 145.5677"/>
      <n id="7" p="199.1462 162.0677"/>
      <n id="8" p="212.6208 136.0448"/>
      <b id="9" B="2" E="3" Order="1"/>
      <b id="10" B="3" E="4" Order="1"/>
      <b id="11" B="4" E="5" Order="1"/>
      <b id="12" B="5" E="6" Order="1"/>
      <b id="13" B="6" E="7" Order="1"/>
      <b id="14" B="6" E="8" Order="1"/>
    </fragment>
  </page>
</CDXML>`;

// The fixture toolset is contributed by a real plugin now (not baked into the core
// manifest), so tests that assert on it compose it through the runtime + catalog exactly
// like MainWindow does.
function buildRegistryWithFixture(): DesktopToolsetRegistry {
  const runtime = createDesktopPluginRuntime({
    commandRegistry: new CommandRegistry(),
    getActiveDocument: () => undefined
  });
  runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
  const catalog = createToolbarCatalog();
  catalog.setPluginToolsets(runtime.listPluginToolsets());
  return catalog.registry();
}

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
    expect(appCss).not.toMatch(/\.native-bond-line\s*{[^}]*vector-effect:\s*non-scaling-stroke;/s);
    expect(appCss).toMatch(/\.native-bond-hit-target\s*{[^}]*vector-effect:\s*non-scaling-stroke;/s);
    // The crossing knockout masks the visible bond, so it must scale with the bond (no
    // non-scaling-stroke) — same decision as .native-bond-line, kept in sync here.
    expect(appCss).not.toMatch(/\.native-bond-knockout\s*{[^}]*vector-effect:\s*non-scaling-stroke;/s);
    // The bond highlight is no longer driven by CSS :hover (a second opinion that used the
    // DOM catcher's geometry); it is rendered from the resolver result so it matches the
    // click target. The old :hover decorator rule must be gone, and the new resolver-driven
    // class must exist.
    expect(appCss).not.toMatch(/g\[data-bond-layer-id\]:hover/);
    expect(appCss).toMatch(/\.native-bond-hover\s*{[^}]*stroke-opacity:\s*0\.32;/s);
    expect(appCss).not.toContain(".native-bond-hit-target:hover");
    expect(appCss).not.toContain(".native-atom-hit-target:hover");
    expect(appCss).toMatch(/\.graphic-glyph-hit-target\s*{[^}]*pointer-events:\s*stroke;/s);
    expect(appCss).toMatch(/\.graphic-object,\s*\.graphic-visual-shell,\s*\.graphic-glyph-shell\s*{[^}]*pointer-events:\s*none;/s);
    expect(appCss).toMatch(/\.graphic-glyph-stroke\s*{[^}]*pointer-events:\s*visiblePainted;/s);
    expect(appCss).toMatch(/\.graphic-glyph-shape,\s*\.graphic-glyph-projected-shape,\s*\.graphic-glyph-path\s*{[^}]*pointer-events:\s*visiblePainted;/s);
    expect(appCss).toMatch(/\.graphic-glyph-hit-target\[data-graphic-hit-fill="true"\]\s*{[^}]*pointer-events:\s*all;/s);
  });

  it("keeps toolbar 3D cleanup separate from projected-plane rotate without conformer imports", () => {
    const implementationSource = [mainWindowSource, documentWorkflowSource].join("\n");

    expect(desktopToolsetsSource).toContain(structureCleanup3dCommandId);
    expect(desktopToolsetsSource).toContain('"title": "3D Cleanup"');
    // 3D Cleanup is wired now: the manifest no longer disables it, and the handler routes through
    // the lazy engine re-layout instead of the old stub status.
    expect(desktopToolsetsSource).not.toContain('"disabledReason": "requires conformer-backed 3D cleanup engine"');
    expect(desktopToolsetsSource).not.toContain('"commandId": "structure.rotate3d"');
    expect(desktopToolsetsSource).not.toContain('"title": "3D Rotate"');
    expect(mainWindowSource).toContain("cleanUpSelectedStructure3d");
    expect(mainWindowSource).toContain("applyNativeMoleculeEngineRelayout");
    expect(mainWindowSource).toContain("relayoutMolfile2D");
    expect(mainWindowSource).not.toContain("tool.id === structureRotate3dCommandId");
    expect(implementationSource).toContain("tiltNativeMoleculeProjectedPlane");
    expect(implementationSource).toContain("tiltNativeMoleculePartsProjectedPlane");
    expect(mainWindowSource).toContain("selectedFragmentBounds ? documentObjectCenter(selectedFragmentBounds) : documentObjectCenter(object)");
    expect(mainWindowSource).toContain('title={`3D rotate ${transformTargetLabel}`}');
    expect(mainWindowSource).toContain('data-tilt3d-icon="circular-arrow"');
    expect(appCss).toMatch(/\.object-tilt3d-handle\s*{[^}]*color:\s*var\(--cd-accent\);/s);
    expect(appCss).toContain(".object-tilt3d-arrowhead");
    // NOTE: a blanket "no conformer imports" assertion used to live here, but the Spin 3D
    // feature now legitimately uses the conformer worker/OCL adapter in MainWindow's overlay
    // path (and SMILES paste references OpenChemLib in a status message). 3D Cleanup itself now
    // lazy-loads the same adapter for its clean re-layout — asserted above.
  });

  it("renders compact web-preview workspace regions with a floating fallback palette", () => {
    const markup = renderToStaticMarkup(createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false }));

    expect(markup).toContain("app-shell");
    expect(markup).toContain("dev-browser-menu-shell");
    expect(markup).toContain("dev-browser-menu-bar");
    expect(markup).toContain('data-dev-browser-menu-bar="true"');
    expect(markup).toContain('data-dev-browser-menu-button="file"');
    expect(markup).toContain('data-dev-browser-menu-button="view"');
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
    // The browser build recreates the native menu in-viewport (no OS menu on the web).
    expect(markup).toContain("menu-bar");
    expect(markup).toContain('aria-label="Application menu"');
    expect(markup).toContain('data-menu-section="file"');
    expect(markup).toContain('data-menu-section="analyze"');
    expect(markup).not.toContain("command-bar");
    expect(markup).not.toContain("statusbar");
    expect(markup).not.toContain("EditorAdapter not connected");
    expect(markup).not.toContain("tool-palette docked");
    expect(markup.indexOf("web-floating-palette")).toBeLessThan(markup.indexOf('class="workspace"'));
  });

  it("keeps the browser-only menu bar out of Tauri runtime renders", () => {
    const tauriGlobal = globalThis as typeof globalThis & { __TAURI__?: unknown };
    tauriGlobal.__TAURI__ = {};
    try {
      const markup = renderToStaticMarkup(
        createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false })
      );

      expect(markup).toContain("web-shell");
      expect(markup).not.toContain("dev-browser-menu-shell");
      expect(markup).not.toContain('data-dev-browser-menu-bar="true"');
      expect(markup).not.toContain("dev-browser-menu-bar");
    } finally {
      delete tauriGlobal.__TAURI__;
    }
  });

  it("renders the main desktop document window without an in-window palette by default", () => {
    // Simulate the Tauri desktop runtime: the native OS menu owns the menus there, so the
    // in-viewport menu bar (a browser-only fallback) must stay hidden.
    const tauriGlobal = globalThis as { __TAURI_INTERNALS__?: unknown };
    tauriGlobal.__TAURI_INTERNALS__ = {};
    try {
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
    } finally {
      delete tauriGlobal.__TAURI_INTERNALS__;
    }
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

  it("detects a whole-molecule double-press by resolved molecule, not just screen distance", () => {
    // The whole-molecule double-click must not depend solely on event.detail (unreliable once
    // the first press mutates selection) nor on a tight screen distance (a small low-zoom
    // molecule spans more than the fallback radius). Two presses resolving to the SAME molecule
    // within the time window count, even when they land on different visible parts.
    const onMolecule = { time: 1_000, x: 200, y: 220, objectId: "mol_bond_001" };

    // Same molecule, well beyond the 6px screen fallback (opposite ends of a low-zoom bond).
    expect(isSelectionDoublePress(onMolecule, { time: 1_180, x: 240, y: 220, objectId: "mol_bond_001" })).toBe(true);
    // Same molecule but too slow → two deliberate single clicks.
    expect(isSelectionDoublePress(onMolecule, { time: 1_600, x: 201, y: 220, objectId: "mol_bond_001" })).toBe(false);
    // A different molecule → not a double-press, even at the same instant/spot.
    expect(isSelectionDoublePress(onMolecule, { time: 1_100, x: 201, y: 220, objectId: "mol_bond_002" })).toBe(false);
    // No resolved molecule on either side → tight SCREEN-distance fallback (empty canvas).
    const empty = { time: 1_000, x: 200, y: 220 };
    expect(isSelectionDoublePress(empty, { time: 1_180, x: 203, y: 222 })).toBe(true);
    expect(isSelectionDoublePress(empty, { time: 1_180, x: 240, y: 220 })).toBe(false);
    // No prior press → never a double-press.
    expect(isSelectionDoublePress(undefined, onMolecule)).toBe(false);
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
    expect(appCss).toContain("width: calc(var(--cd-control-height) * 4 + var(--cd-space-2) * 3);");
    expect(appCss).toContain("grid-template-columns: 170px 70px auto;");
    expect(appCss).toContain("appearance: none;");
    expect(appCss).toContain("linear-gradient(45deg, transparent 50%, var(--cd-text-secondary) 50%)");
    expect(appCss).toContain("min-width: 70px;");
    expect(appCss).toContain("font-variant-numeric: tabular-nums;");
  });

  it("renders in-window fallback palette titles as explicit drag surfaces", () => {
    const markup = renderToStaticMarkup(createElement(MainWindow, { nativePalette: false }));

    expect(markup).toContain('aria-label="Floating Main Toolbar"');
    expect(markup).toContain('aria-label="Floating Art Toolbar"');
    expect(markup).toContain('data-palette-title-drag-surface="true"');
    expect(markup).toContain('data-web-palette-drag-region="true"');
    expect(markup).toContain("palette-title-label");
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

  it("renders the lasso overlay in page coordinates", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionLassoOverlay, {
        points: [
          { x: 20, y: 30 },
          { x: 70, y: 35 },
          { x: 65, y: 90 }
        ],
        latestPoint: { x: 22, y: 88 },
        pageWidth: 792,
        pageHeight: 612
      })
    );

    expect(markup).toContain("selection-lasso-surface");
    expect(markup).toContain('viewBox="0 0 792 612"');
    expect(markup).toContain("width:calc(792px * var(--page-scale))");
    expect(markup).toContain("height:calc(612px * var(--page-scale))");
    expect(markup).toContain('d="M 20 30 L 70 35 L 65 90 L 22 88 Z"');
  });

  it("renders the tape measure overlay in ruler units", () => {
    const markup = renderToStaticMarkup(
      createElement(TapeMeasureOverlay, {
        measurement: {
          startPoint: { x: 96, y: 96 },
          latestPoint: { x: 288, y: 96 },
          constrained: true,
          dragging: false
        },
        pageWidth: 816,
        pageHeight: 1056,
        rulerUnit: inchRulerUnit
      })
    );

    expect(markup).toContain("tape-measure-overlay");
    expect(markup).toContain('data-tape-measure-constrained="true"');
    expect(markup).toContain('viewBox="0 0 816 1056"');
    expect(markup).toContain('x1="96"');
    expect(markup).toContain('x2="288"');
    expect(markup).toContain(">2.00 in</div>");
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

  it("selects every whole native molecule inside a lasso polygon", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Multi Lasso"), { x: 220, y: 240 });
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
    const selection = selectionInSelectionLasso(second.pages[0].objects, [
      { x: bounds.left - 6, y: bounds.top - 8 },
      { x: bounds.right + 8, y: bounds.top - 4 },
      { x: bounds.right + 4, y: bounds.bottom + 8 },
      { x: bounds.left - 8, y: bounds.bottom + 6 }
    ]);

    expect(selection.objectIds).toEqual(molecules.map((molecule) => molecule.id));
    expect(selection.nativeSelection).toBeUndefined();
  });

  it("promotes marquee, lasso, and drag hits on grouped native molecules to the group", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Grouped Molecule Selection"), { x: 220, y: 240 });
    const second = insertNativeSingleBondMolecule(first, { x: 360, y: 260 });
    const molecules = second.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
    const grouped = groupSelectedDocumentObjects(selectDocumentObjects(
      second,
      second.pages[0].id,
      molecules.map((molecule) => molecule.id)
    ));
    const groupId = grouped.selection.objectIds[0];
    const child = grouped.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && object.id === molecules[0].id
    );
    const atom = child?.atoms[0];
    if (!groupId || !child || !atom) {
      throw new Error("Expected grouped molecule fixture.");
    }

    const rectSelection = selectionInSelectionRect(grouped.pages[0].objects, {
      x: atom.x - 3,
      y: atom.y - 3
    }, {
      x: atom.x + 3,
      y: atom.y + 3
    });
    const lassoSelection = selectionInSelectionLasso(grouped.pages[0].objects, [
      { x: atom.x - 5, y: atom.y - 5 },
      { x: atom.x + 5, y: atom.y - 5 },
      { x: atom.x + 5, y: atom.y + 5 },
      { x: atom.x - 5, y: atom.y + 5 }
    ]);

    expect(rectSelection).toEqual({ objectIds: [groupId], nativeSelection: undefined });
    expect(lassoSelection).toEqual({ objectIds: [groupId], nativeSelection: undefined });
    expect(nativeMoleculeSelectionDragIntent(
      grouped,
      child.id,
      undefined,
      { kind: "atom", atomId: atom.id, distanceToPointer: 0 }
    )).toEqual({ kind: "whole-object" });
    expect(groupedDragObjectIdsForPointer(grouped, child.id)).toEqual(molecules.map((molecule) => molecule.id));

    const drilledIntoChild = selectDocumentObjectWithinGroup(grouped, child.id);
    expect(drilledIntoChild.selection.objectIds).toEqual([child.id]);
    expect(groupedDragObjectIdsForPointer(drilledIntoChild, child.id)).toBeUndefined();
    expect(nativeMoleculeSelectionDragIntent(
      drilledIntoChild,
      child.id,
      undefined,
      { kind: "atom", atomId: atom.id, distanceToPointer: 0 }
    )).toEqual({ kind: "whole-object" });
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

  it("uses touched-object hit rules for eraser marquee deletion", () => {
    const withRect = insertNativeArtGraphicObject(
      createPhase4Document("Eraser Marquee Touch"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const rect = withRect.pages[0].objects.find((object): object is GraphicObject =>
      object.type === "graphic" && object.id === withRect.selection.objectIds[0]
    );
    if (!rect) {
      throw new Error("Expected rectangle graphic fixture.");
    }
    const edgeStart = {
      x: rect.x + rect.width - 2,
      y: rect.y + rect.height / 2 - 3
    };
    const edgeEnd = {
      x: rect.x + rect.width + 10,
      y: rect.y + rect.height / 2 + 3
    };

    expect(selectionInSelectionRect(withRect.pages[0].objects, edgeStart, edgeEnd).objectIds).toEqual([]);
    expect(eraserObjectIdsInSelectionRect(withRect.pages[0].objects, edgeStart, edgeEnd)).toEqual([rect.id]);

    const withText = insertNativeTextObject(createPhase4Document("Eraser Text Touch"), { x: 260, y: 210 }, "touch");
    const text = withText.pages[0].objects.find((object): object is DocumentObject =>
      object.type === "text" && object.text === "touch"
    );
    if (!text) {
      throw new Error("Expected text fixture.");
    }

    expect(eraserObjectIdsInSelectionRect(withText.pages[0].objects, {
      x: text.x + text.width - 1,
      y: text.y + text.height / 2 - 2
    }, {
      x: text.x + text.width + 8,
      y: text.y + text.height / 2 + 2
    })).toEqual([text.id]);
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

  it("selects a straight graphic line when the marquee crosses the stroke, not the whole bounds", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Line Marquee"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0];
    const graphic = document.pages[0].objects.find((object): object is GraphicObject =>
      object.id === objectId && object.type === "graphic"
    );
    if (!objectId || !graphic) {
      throw new Error("Expected line graphic fixture.");
    }
    const rectCenter = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const selection = selectionInSelectionRect(document.pages[0].objects, {
      x: rectCenter.x - 5,
      y: rectCenter.y - 5
    }, {
      x: rectCenter.x + 5,
      y: rectCenter.y + 5
    });

    expect(selection.objectIds).toEqual([objectId]);
  });

  it("selects a straight graphic line when the lasso crosses the stroke", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Line Lasso"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = document.selection.objectIds[0];
    const graphic = document.pages[0].objects.find((object): object is GraphicObject =>
      object.id === objectId && object.type === "graphic"
    );
    if (!objectId || !graphic) {
      throw new Error("Expected line graphic fixture.");
    }
    const strokePoint = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const selection = selectionInSelectionLasso(document.pages[0].objects, [
      { x: strokePoint.x - 9, y: strokePoint.y - 6 },
      { x: strokePoint.x + 8, y: strokePoint.y - 4 },
      { x: strokePoint.x + 7, y: strokePoint.y + 8 },
      { x: strokePoint.x - 8, y: strokePoint.y + 7 }
    ]);

    expect(selection.objectIds).toEqual([objectId]);
  });

  it("selects a rotated graphic line where its projected stroke crosses the marquee", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Rotated Line Marquee"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected line graphic fixture.");
    }
    const graphic = inserted.pages[0].objects.find((object): object is GraphicObject =>
      object.id === objectId && object.type === "graphic"
    );
    if (!graphic) {
      throw new Error("Expected line graphic fixture.");
    }
    const document = applyPatch(inserted, {
      op: "updateObject",
      objectId,
      changes: {
        rotation: 90
      }
    });
    const rotatedGraphic = document.pages[0].objects.find((object): object is GraphicObject =>
      object.id === objectId && object.type === "graphic"
    );
    if (!rotatedGraphic) {
      throw new Error("Expected rotated line graphic fixture.");
    }
    // The visible stroke is rotated about the object center, so the marquee must be placed at the
    // rotated stroke position — matching how hit testing now projects, translates, and rotates.
    const projectedBeforeRotation = projectGraphicObjectPoint(
      rotatedGraphic,
      { x: rotatedGraphic.x + 3, y: rotatedGraphic.y + 3 },
      { coordinateSpace: "page" }
    );
    const rotationRad = (rotatedGraphic.rotation * Math.PI) / 180;
    const rotationCenter = {
      x: rotatedGraphic.x + rotatedGraphic.width / 2,
      y: rotatedGraphic.y + rotatedGraphic.height / 2
    };
    const rotationDx = projectedBeforeRotation.x - rotationCenter.x;
    const rotationDy = projectedBeforeRotation.y - rotationCenter.y;
    const projectedStrokePoint = {
      x: rotationCenter.x + rotationDx * Math.cos(rotationRad) - rotationDy * Math.sin(rotationRad),
      y: rotationCenter.y + rotationDx * Math.sin(rotationRad) + rotationDy * Math.cos(rotationRad)
    };
    const selection = selectionInSelectionRect(document.pages[0].objects, {
      x: projectedStrokePoint.x - 5,
      y: projectedStrokePoint.y - 5
    }, {
      x: projectedStrokePoint.x + 5,
      y: projectedStrokePoint.y + 5
    });

    expect(selection.objectIds).toEqual([objectId]);
  });

  it("uses rotated art visual bounds for multi-selection transform frames", () => {
    const firstInserted = insertNativeArtGraphicObject(
      createPhase4Document("Rotated Art Group Bounds"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const secondInserted = insertNativeArtGraphicObject(firstInserted, { x: 340, y: 180 }, "tool.art.circle");
    const graphics = secondInserted.pages[0].objects.filter((object): object is GraphicObject =>
      object.type === "graphic"
    );
    if (graphics.length !== 2) {
      throw new Error("Expected two graphic fixtures.");
    }
    const rotated = applyPatch(secondInserted, {
      op: "updateObject",
      objectId: graphics[0].id,
      changes: {
        width: 120,
        height: 30,
        rotation: 45
      }
    });
    const ids = graphics.map((graphic) => graphic.id);
    const rawBounds = selectionBounds(rotated.pages[0].objects, ids);
    const visualBounds = visualSelectionBounds(rotated.pages[0].objects, ids);

    expect(rawBounds).toBeDefined();
    expect(visualBounds).toBeDefined();
    expect(visualBounds!.y).toBeLessThan(rawBounds!.y);
    expect(visualBounds!.height).toBeGreaterThan(rawBounds!.height + 20);
  });

  it("selects a quadratic graphic when the marquee crosses the sampled curve", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Quadratic Marquee"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected line graphic fixture.");
    }
    const graphic = inserted.pages[0].objects.find((object): object is GraphicObject =>
      object.id === objectId && object.type === "graphic"
    );
    const points = graphic ? nativeGraphicPathEditPoints(graphic) : undefined;
    if (!points) {
      throw new Error("Expected line edit points.");
    }
    const middle = { x: points.middle.x + 12, y: points.middle.y - 34 };
    const document = updateNativeGraphicPathHandle(inserted, objectId, "middle", middle);
    const selection = selectionInSelectionRect(document.pages[0].objects, {
      x: middle.x - 5,
      y: middle.y - 5
    }, {
      x: middle.x + 5,
      y: middle.y + 5
    });

    expect(selection.objectIds).toEqual([objectId]);
  });

  it("selects a semantic arc graphic when the marquee crosses the sampled arc", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Arc Marquee"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = document.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected arc graphic fixture.");
    }
    const object = document.pages[0].objects.find((candidate) => candidate.id === objectId);
    const points = object?.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
    const middle = points?.middle;
    if (!middle) {
      throw new Error("Expected arc edit points.");
    }
    const selection = selectionInSelectionRect(document.pages[0].objects, {
      x: middle.x - 5,
      y: middle.y - 5
    }, {
      x: middle.x + 5,
      y: middle.y + 5
    });

    expect(selection.objectIds).toEqual([objectId]);
  });

  it("selects a wavy graphic line when the marquee crosses its sampled stroke", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Wavy Marquee"),
      { x: 220, y: 180 },
      "tool.art.lineWavy"
    );
    const objectId = document.selection.objectIds[0];
    const graphic = document.pages[0].objects.find((object): object is GraphicObject =>
      object.id === objectId && object.type === "graphic"
    );
    if (!objectId || !graphic) {
      throw new Error("Expected wavy graphic fixture.");
    }
    const strokePoint = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const selection = selectionInSelectionRect(document.pages[0].objects, {
      x: strokePoint.x - 5,
      y: strokePoint.y - 5
    }, {
      x: strokePoint.x + 5,
      y: strokePoint.y + 5
    });

    expect(selection.objectIds).toEqual([objectId]);
  });

  it("selects every whole native molecule inside a lasso polygon", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Multi Lasso"), { x: 220, y: 240 });
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
    const selection = selectionInSelectionPolygon(second.pages[0].objects, [
      { x: bounds.left - 12, y: bounds.top - 12 },
      { x: bounds.right + 12, y: bounds.top - 8 },
      { x: bounds.right + 8, y: bounds.bottom + 12 },
      { x: bounds.left - 8, y: bounds.bottom + 8 }
    ]);

    expect(selection.objectIds).toEqual(molecules.map((molecule) => molecule.id));
    expect(selection.nativeSelection).toBeUndefined();
  });

  it("does not pull adjacent text into a lasso unless the text box is enclosed", () => {
    const withMolecule = insertNativeSingleBondMolecule(createPhase4Document("Lasso Text Guard"), { x: 220, y: 240 });
    const withText = insertNativeTextObject(withMolecule, { x: 264, y: 212 }, "hello");
    const molecule = withText.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const text = withText.pages[0].objects.find((object): object is DocumentObject =>
      object.type === "text" && object.text === "hello"
    );
    if (!molecule || !text) {
      throw new Error("Expected molecule and text fixtures.");
    }
    const moleculeSelection = selectionInSelectionPolygon(withText.pages[0].objects, [
      { x: molecule.x - 8, y: molecule.y - 8 },
      { x: molecule.x + molecule.width + 8, y: molecule.y - 8 },
      { x: molecule.x + molecule.width + 8, y: molecule.y + molecule.height + 8 },
      { x: molecule.x - 8, y: molecule.y + molecule.height + 8 }
    ]);
    const fullSelection = selectionInSelectionPolygon(withText.pages[0].objects, [
      { x: Math.min(molecule.x, text.x) - 8, y: Math.min(molecule.y, text.y) - 8 },
      { x: Math.max(molecule.x + molecule.width, text.x + text.width) + 8, y: Math.min(molecule.y, text.y) - 8 },
      { x: Math.max(molecule.x + molecule.width, text.x + text.width) + 8, y: Math.max(molecule.y + molecule.height, text.y + text.height) + 8 },
      { x: Math.min(molecule.x, text.x) - 8, y: Math.max(molecule.y + molecule.height, text.y + text.height) + 8 }
    ]);

    expect(moleculeSelection.objectIds).toEqual([molecule.id]);
    expect(moleculeSelection.objectIds).not.toContain(text.id);
    expect(fullSelection.objectIds).toEqual([molecule.id, text.id]);
  });

  it("keeps a tight lasso over one native atom as a partial native selection", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Atom Lasso"), { x: 220, y: 240 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const atom = molecule?.atoms.find((candidate) => candidate.id === "atom_001");
    if (!molecule || !atom) {
      throw new Error("Expected native molecule atom fixture.");
    }
    const selection = selectionInSelectionPolygon(document.pages[0].objects, [
      { x: atom.x, y: atom.y - 5 },
      { x: atom.x + 5, y: atom.y },
      { x: atom.x, y: atom.y + 5 },
      { x: atom.x - 5, y: atom.y }
    ]);

    expect(selection.objectIds).toEqual([]);
    expect(selection.nativeSelection).toEqual(
      expect.objectContaining({
        objectId: molecule.id
      })
    );
    expect(selection.nativeSelection?.kind).not.toBe("molecule");
  });

  it("keeps a one-atom lasso partial even when the path ends on a duplicated point", () => {
    // Releasing the pointer without moving appends a point identical to the last
    // recorded one, creating a zero-length polygon edge. pointOnSegment's degenerate
    // case used to test true for EVERY point, so pointInPolygon swallowed the whole
    // page and the lasso grabbed the whole molecule regardless of the drawn path.
    const document = insertNativeSingleBondMolecule(createPhase4Document("Degenerate Lasso Edge"), { x: 220, y: 240 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const atom = molecule?.atoms.find((candidate) => candidate.id === "atom_001");
    if (!molecule || !atom) {
      throw new Error("Expected native molecule atom fixture.");
    }
    const selection = selectionInSelectionPolygon(document.pages[0].objects, [
      { x: atom.x - 5, y: atom.y - 5 },
      { x: atom.x + 5, y: atom.y - 5 },
      { x: atom.x + 5, y: atom.y + 5 },
      { x: atom.x - 5, y: atom.y + 5 },
      { x: atom.x - 5, y: atom.y - 5 },
      { x: atom.x - 5, y: atom.y - 5 }
    ]);

    expect(selection.objectIds).toEqual([]);
    expect(selection.nativeSelection).toMatchObject({
      objectId: molecule.id,
      kind: "parts",
      atomIds: ["atom_001"]
    });
  });

  it("promotes a lasso that encloses every atom to a whole-object selection", () => {
    // A lasso catching all atoms IS a whole-molecule selection: the user drew around
    // the structure, so treat it as a movable/resizable unit. Gating this on the
    // padded object frame (not just atom coverage) made the outcome unpredictable.
    const document = insertNativeSingleBondMolecule(createPhase4Document("Whole Graph Lasso"), { x: 220, y: 240 });
    const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!molecule) {
      throw new Error("Expected native molecule fixture.");
    }
    const atomXs = molecule.atoms.map((atom) => atom.x);
    const atomY = molecule.atoms[0]?.y;
    if (atomY === undefined) {
      throw new Error("Expected native molecule atom fixture.");
    }
    const selection = selectionInSelectionPolygon(document.pages[0].objects, [
      { x: Math.min(...atomXs) - 1, y: atomY - 4 },
      { x: Math.max(...atomXs) + 1, y: atomY - 4 },
      { x: Math.max(...atomXs) + 1, y: atomY + 4 },
      { x: Math.min(...atomXs) - 1, y: atomY + 4 }
    ]);

    expect(selection.objectIds).toEqual([molecule.id]);
    expect(selection.nativeSelection).toBeUndefined();
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
    expect(commands.some((command) => command.id === "view.toggle3dDebugger")).toBe(true);
    expect(commands.some((command) => command.id === "view.toggleRulers")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.legal")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.a4")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.a0")).toBe(true);
    expect(commands.some((command) => command.id === "page.setOrientation.landscape")).toBe(true);
    expect(commands.some((command) => command.id === "export.open")).toBe(true);
    expect(commands.some((command) => command.id === "export.pdf")).toBe(false);
    expect(commands.some((command) => command.id === "export.png")).toBe(false);
    expect(commands.some((command) => command.id === "layout.bringForward")).toBe(true);
    expect(commands.some((command) => command.id === "layout.sendBackward")).toBe(true);
    expect(commands.some((command) => command.id === "layout.bringToFront")).toBe(true);
    expect(commands.some((command) => command.id === "layout.sendToBack")).toBe(true);
    expect(commands.some((command) => command.id === "layout.alignLeft")).toBe(true);
    expect(commands.some((command) => command.id === "layout.alignCenter")).toBe(true);
    expect(commands.some((command) => command.id === "layout.alignRight")).toBe(true);
    expect(commands.some((command) => command.id === "layout.alignTop")).toBe(true);
    expect(commands.some((command) => command.id === structureInteractive3dCommandId)).toBe(true);
    expect(commands.some((command) => command.id === "layout.alignMiddle")).toBe(true);
    expect(commands.some((command) => command.id === "layout.alignBottom")).toBe(true);
    expect(commands.some((command) => command.id === "layout.distributeHorizontal")).toBe(true);
    expect(commands.some((command) => command.id === "layout.distributeVertical")).toBe(true);
    expect(commands.some((command) => command.id === "layout.flipHorizontal")).toBe(true);
    expect(commands.some((command) => command.id === "layout.flipVertical")).toBe(true);
    expect(commands.some((command) => command.id === "layout.rotate90")).toBe(true);
    expect(commands.some((command) => command.id === "layout.duplicate")).toBe(true);
    expect(commands.some((command) => command.id === "layout.group")).toBe(true);
    expect(commands.some((command) => command.id === "layout.ungroup")).toBe(true);
    expect(commands.some((command) => command.id === "view.toolset.toggle.core.main")).toBe(true);
    expect(commands.some((command) => command.id === "tool.atom")).toBe(true);
    expect(commands.some((command) => command.id === "tool.art.circle")).toBe(true);
    expect(commands.some((command) => command.id === "atom.setHoveredElement.O")).toBe(true);
    expect(markup).toContain(".chemdraft,.cdxml,.xml,.json,chemical/x-cdxml,application/xml,text/xml,application/json");
    expect(markup).not.toContain("Open Native Document");
    expect(markup).not.toContain("Validate Selected Structure");
  });

  it("inserts native art objects with selectable color and projected-plane tilt style", () => {
    const document = createPhase4Document("Native Art");
    const created = createNativeArtGraphicObject(document, { x: 140, y: 160 }, "tool.art.rectGloss");

    expect(created).toMatchObject({
      type: "graphic",
      graphicKind: "rect",
      x: 104,
      y: 140,
      width: 72,
      height: 40,
      data: {
        artToolId: "rectGloss"
      },
      style: {
        source: "chemdraft-native-art",
        artToolCommandId: "tool.art.rectGloss",
        fillMode: "gloss",
        strokeColor: "#111111",
        fillColor: "#111111"
      }
    });

    const inserted = insertNativeArtGraphicObject(document, { x: 140, y: 160 }, "tool.art.rectGloss");
    const selectedId = inserted.selection.objectIds[0];
    const graphic = inserted.pages[0].objects.find((object) => object.id === selectedId);
    expect(graphic).toMatchObject({ type: "graphic", graphicKind: "rect" });

    const colored = applyObjectColorToDocumentObjects(inserted, "#1d7f68");
    const coloredGraphic = colored.pages[0].objects.find((object) => object.id === selectedId);
    expect(coloredGraphic?.style).toMatchObject({
      color: "#1d7f68",
      strokeColor: "#1d7f68",
      fillColor: "#1d7f68"
    });

    const tilted = applyDocumentObjectProjectedPlaneTilt(colored, selectedId ?? "", 24, -18);
    const tiltedGraphic = tilted.pages[0].objects.find((object) => object.id === selectedId);
    expect(tiltedGraphic?.style).toMatchObject({
      tiltXDegrees: 24,
      tiltYDegrees: -18
    });

    const outline = insertNativeArtGraphicObject(document, { x: 220, y: 160 }, "tool.art.circle");
    const recoloredOutline = applyObjectColorToDocumentObjects(outline, "#b3261e");
    const outlineId = recoloredOutline.selection.objectIds[0];
    const outlineGraphic = recoloredOutline.pages[0].objects.find((object) => object.id === outlineId);
    expect(outlineGraphic?.style).toMatchObject({
      color: "#b3261e",
      strokeColor: "#b3261e",
      fillColor: "none"
    });
    expect(mainWindowSource).toContain("const applyNativeArtDocumentAtPoint = useCallback");
    expect(mainWindowSource).toContain('const selectToolState = createActiveToolState("tool.select");');
    expect(mainWindowSource).toContain("broadcastToolsetActiveTool(selectToolState.activeCommandId)");
  });

  it("routes desktop exports through native save and file-write helpers", () => {
    expect(mainWindowSource).toContain("async function pickNativeExportPath(");
    expect(mainWindowSource).toContain('if (action.id === "export.open")');
    expect(mainWindowSource).toContain("<ExportDialog");
    expect(mainWindowSource).toContain("Export as");
    expect(mainWindowSource).toContain("Compress PDF");
    expect(mainWindowSource).toContain("Include warning metadata");
    expect(mainWindowSource).toContain("JPEG quality");
    expect(mainWindowSource).toContain("Creation program");
    expect(mainWindowSource).toContain("async function createDialogExportResult(");
    expect(mainWindowSource).toContain("async function writeNativeExportResult(");
    expect(mainWindowSource).toContain("const result = await createDialogExportResult(documentRef.current, dialog)");
    expect(mainWindowSource).toContain("const defaultPath = nativePathJoin(lastExportDirectoryRef.current, filename) ?? filename");
    expect(mainWindowSource).toContain("await pickNativeExportPath(defaultPath, descriptor.menuLabel, descriptor.extensions)");
    expect(mainWindowSource).toContain("await writeNativeExportResult(path, result)");
    expect(mainWindowSource).toContain("downloadExportResult(filename, result)");
    expect(mainWindowSource).toContain("rasterizeSvgNative(svgResult.contents, rasterFormat");
    expect(mainWindowSource).toContain("await writeNativeTextFile(path, result.contents)");
    expect(mainWindowSource).toContain("await writeNativeBinaryFile(path, result.bytes)");
    expect(mainWindowSource).toContain('if (result.kind === "text")');
    expect(mainWindowSource).toContain("descriptor.menuLabel");
    expect(mainWindowSource).toContain("setStatus(`Command failed: ${message}`)");
    expect(mainWindowSource).toContain('role="status"');
  });

  it("keeps native template dialogs on the fast path", () => {
    expect(mainWindowSource).toContain("prewarmNativeDialogModule()");
    expect(mainWindowSource).toContain("tauriDialogModulePromise ??= import(\"@tauri-apps/plugin-dialog\")");
    expect(mainWindowSource).toContain("const { open } = await loadTauriDialogModule();");
    expect(mainWindowSource).toContain("const { save } = await loadTauriDialogModule();");

    const saveDialogIndex = mainWindowSource.indexOf("const path = await pickNativeMoleculeTemplateSavePath(defaultPath);");
    const serializeIndex = mainWindowSource.indexOf("const contents = buildTemplateContents();", saveDialogIndex);
    expect(saveDialogIndex).toBeGreaterThan(-1);
    expect(serializeIndex).toBeGreaterThan(saveDialogIndex);
  });

  it("offers a page-size choice when imported CDXML content overflows the current page", () => {
    expect(mainWindowSource).toContain("recommendImportedPageFit(resolvedOpen.document)");
    expect(mainWindowSource).toContain("<ImportedPageFitPrompt");
    expect(mainWindowSource).toContain("applyImportedPageFitRecommendation(current, pageFitPrompt)");
    expect(mainWindowSource).toContain("Keep Current Page");
    expect(mainWindowSource).toContain("Use {recommendedLabel}");
  });

  it("also offers the page-size choice when a pasted structure overflows the current page", () => {
    // The SMILES paste path runs the same page-fit recommendation as the CDXML import path.
    expect(mainWindowSource).toContain("recommendImportedPageFit(nextDocument)");
    expect(mainWindowSource).toContain('displayName: "The pasted structure"');
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
    expect(registry.resolve({ key: "g", metaKey: true })).toBeUndefined();
    expect(registry.resolve({ key: "g", metaKey: true, shiftKey: true })).toBeUndefined();
    expect(registry.resolve({ key: "o" })).toBeUndefined();
    expect(registry.resolve({ key: "Backspace" })).toBe("edit.deleteHoveredNativeTarget");
    expect(registry.resolve({ key: "Delete" })).toBe("edit.forwardDeleteHoveredNativeTarget");
    expect(registry.conflicts()).toEqual([]);

    const detachedPaletteRegistry = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), {
      platform: "macos",
      includeDisabled: true
    });
    expect(detachedPaletteRegistry.resolve({ key: "g", metaKey: true })).toBe("layout.group");
    expect(detachedPaletteRegistry.resolve({ key: "g", metaKey: true, shiftKey: true })).toBe("layout.ungroup");
    expect(detachedPaletteRegistry.conflicts()).toEqual([]);

    let layoutDocument = insertNativeArtGraphicObject(createPhase4Document("Layout Shortcuts"), { x: 120, y: 120 }, "tool.art.rect");
    layoutDocument = insertNativeArtGraphicObject(layoutDocument, { x: 240, y: 160 }, "tool.art.circle");
    layoutDocument = insertNativeArtGraphicObject(layoutDocument, { x: 360, y: 220 }, "tool.art.ellipse");
    const layoutPage = layoutDocument.pages[0];
    const selectedLayoutDocument = selectDocumentObjects(
      layoutDocument,
      layoutPage.id,
      layoutPage.objects.map((object) => object.id)
    );
    const layoutRegistry = createDesktopShortcutRegistry(allShellCommands(selectedLayoutDocument), "macos");

    expect(layoutRegistry.resolve({ key: "l", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.alignLeft");
    expect(layoutRegistry.resolve({ key: "c", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.alignCenter");
    expect(layoutRegistry.resolve({ key: "r", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.alignRight");
    expect(layoutRegistry.resolve({ key: "t", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.alignTop");
    expect(layoutRegistry.resolve({ key: "m", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.alignMiddle");
    expect(layoutRegistry.resolve({ key: "b", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.alignBottom");
    expect(layoutRegistry.resolve({ key: "h", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.distributeHorizontal");
    expect(layoutRegistry.resolve({ key: "v", metaKey: true, shiftKey: true, altKey: true })).toBe("layout.distributeVertical");
    expect(layoutRegistry.resolve({ key: "g", metaKey: true })).toBe("layout.group");
    expect(layoutRegistry.resolve({ key: "]", metaKey: true, shiftKey: true })).toBe("layout.bringToFront");
    expect(layoutRegistry.resolve({ key: "]", metaKey: true })).toBe("layout.bringForward");
    expect(layoutRegistry.resolve({ key: "[", metaKey: true })).toBe("layout.sendBackward");
    expect(layoutRegistry.resolve({ key: "[", metaKey: true, shiftKey: true })).toBe("layout.sendToBack");
    expect(layoutRegistry.conflicts()).toEqual([]);

    const groupedLayoutDocument = groupSelectedDocumentObjects(selectedLayoutDocument);
    const groupedRegistry = createDesktopShortcutRegistry(allShellCommands(groupedLayoutDocument), "macos");
    expect(groupedRegistry.resolve({ key: "g", metaKey: true, shiftKey: true })).toBe("layout.ungroup");
    expect(groupedRegistry.conflicts()).toEqual([]);
  });

  it("lets system clipboard events own copy cut and paste shortcuts", () => {
    expect(shouldLetSystemClipboardHandleCommand("clipboard.copy")).toBe(true);
    expect(shouldLetSystemClipboardHandleCommand("clipboard.cut")).toBe(true);
    expect(shouldLetSystemClipboardHandleCommand("clipboard.paste")).toBe(true);
    expect(shouldLetSystemClipboardHandleCommand("layout.group")).toBe(false);
    expect(mainWindowSource).toContain('window.addEventListener("copy", handleCopy)');
    expect(mainWindowSource).toContain('window.addEventListener("cut", handleCut)');
    expect(mainWindowSource).toContain("writeClipboardDataTransfer(event.clipboardData, selectionClipboardTextItems(payload))");
  });

  it("copies a graphic-only ChemDraft selection with the payload in the private flavor only", () => {
    let document = insertNativeArtGraphicObject(createPhase4Document("Selection Clipboard"), { x: 120, y: 140 }, "tool.art.rect");
    document = insertNativeArtGraphicObject(document, { x: 220, y: 140 }, "tool.art.circle");
    const payload = createSelectionClipboardPayload(document);

    if (!payload) {
      throw new Error("Expected selected object clipboard payload.");
    }

    const items = selectionClipboardTextItems(payload);
    // A graphic-only selection has no human-readable text, so only the private flavor is written —
    // the raw selection JSON is never published as public text/plain.
    expect(items.map((item) => item.type)).toEqual([CHEMDRAFT_SELECTION_CLIPBOARD_TYPE]);
    expect(JSON.parse(items[0].text)).toMatchObject({
      kind: "chemdraft-selection",
      version: 1
    });
  });

  it("publishes human-readable text — not selection JSON — as the public text/plain flavor", () => {
    const document = insertNativeTextObject(createPhase4Document("Text Clipboard"), { x: 120, y: 140 }, "Catalyst A");
    const payload = createSelectionClipboardPayload(document);

    if (!payload) {
      throw new Error("Expected selected object clipboard payload.");
    }

    expect(selectionClipboardPlainText(payload)).toBe("Catalyst A");

    const items = selectionClipboardTextItems(payload);
    const plain = items.find((item) => item.type === "text/plain");
    expect(plain?.text).toBe("Catalyst A");
    expect(plain?.text).not.toContain("chemdraft-selection");
  });

  it("offsets copied selection pastes and steps repeated pastes", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Offset Selection Clipboard"),
      { x: 120, y: 140 },
      "tool.art.rect"
    );
    const payload = createSelectionClipboardPayload(document);
    if (!payload) {
      throw new Error("Expected selected object clipboard payload.");
    }

    const copyState = initialSelectionClipboardPasteState(payload, "copy");
    const firstPaste = nextSelectionClipboardPastePlacement(payload, copyState, document.pages[0]);
    const secondPaste = nextSelectionClipboardPastePlacement(payload, firstPaste.state, document.pages[0]);

    expect(firstPaste.point).toMatchObject({
      x: payload.bounds.centerX + 24,
      y: payload.bounds.centerY + 24
    });
    expect(secondPaste.point).toMatchObject({
      x: payload.bounds.centerX + 48,
      y: payload.bounds.centerY + 48
    });
  });

  it("keeps the first cut paste at the source point, then offsets repeated pastes", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Cut Selection Clipboard"),
      { x: 160, y: 180 },
      "tool.art.rect"
    );
    const payload = createSelectionClipboardPayload(document);
    if (!payload) {
      throw new Error("Expected selected object clipboard payload.");
    }

    const cutState = initialSelectionClipboardPasteState(payload, "cut");
    const firstPaste = nextSelectionClipboardPastePlacement(payload, cutState, document.pages[0]);
    const secondPaste = nextSelectionClipboardPastePlacement(payload, firstPaste.state, document.pages[0]);

    expect(firstPaste.point).toMatchObject({
      x: payload.bounds.centerX,
      y: payload.bounds.centerY
    });
    expect(secondPaste.point).toMatchObject({
      x: payload.bounds.centerX + 24,
      y: payload.bounds.centerY + 24
    });
  });

  it("flips the selection paste offset when the normal offset would leave the page", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Edge Offset Selection Clipboard"),
      { x: 120, y: 140 },
      "tool.art.rect"
    );
    const payload = createSelectionClipboardPayload(document);
    if (!payload) {
      throw new Error("Expected selected object clipboard payload.");
    }

    const page = document.pages[0];
    const edgePayload = {
      ...payload,
      bounds: {
        ...payload.bounds,
        centerX: page.width - payload.bounds.width / 2 - 2,
        centerY: page.height - payload.bounds.height / 2 - 2
      }
    };
    const paste = nextSelectionClipboardPastePlacement(
      edgePayload,
      initialSelectionClipboardPasteState(edgePayload, "copy"),
      page
    );

    expect(paste.point.x).toBeLessThan(edgePayload.bounds.centerX);
    expect(paste.point.y).toBeLessThan(edgePayload.bounds.centerY);
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
        expect.objectContaining({ id: "view.toggle3dDebugger", title: "Toggle 3D Debugger" }),
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

  it("exposes a custom page-size command and wires it to the custom-size dialog", () => {
    const commands = allShellCommands(createPhase4Document());
    expect(commands.some((command) => command.id === "page.setSizeCustom")).toBe(true);
    // The command opens the dialog, which applies a custom size via the workflow helper.
    expect(mainWindowSource).toContain("register(pageCustomSizeAction");
    expect(mainWindowSource).toContain("openCustomPageSizeDialog()");
    expect(mainWindowSource).toContain("setDocumentCustomPageSize(current, size)");
    expect(mainWindowSource).toContain("<CustomPageSizeDialog");
  });

  it("enables the customize-toolbars command; reset/create/clone remain dialog-driven placeholders", () => {
    // view.customizeToolbars now opens the editor; the reset/create/clone actions are performed
    // inside that dialog, so their standalone command entries stay disabled placeholders for now.
    expect(toolbarCustomizationActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "view.customizeToolbars", enabled: true }),
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

  it("keeps object color commands explicit and separate from text style patches", () => {
    expect(objectStyleActions.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "object.color.black",
        "object.color.green",
        "object.color.magenta",
        "object.gradient.addStop",
        "object.gradient.deleteStop",
        "object.gradient.reverseStops",
        "object.gradient.rotateStops"
      ])
    );
    expect(objectColorForCommand("object.color.green")).toBe("#1d7f68");
    expect(objectColorForCommand(objectCustomColorCommandId("#A0B1C2"))).toBe("#a0b1c2");
    expect(objectGradientStopColorForCommand(objectGradientStopColorCommandId(2, "#A0B1C2"))).toEqual({
      stopIndex: 2,
      color: "#a0b1c2"
    });
    expect(objectGradientStopOpacityForCommand(objectGradientStopOpacityCommandId(2, 0.42))).toEqual({
      stopIndex: 2,
      opacity: 0.42
    });
    expect(objectGradientStopOffsetForCommand(objectGradientStopOffsetCommandId(2, 0.37))).toEqual({
      stopIndex: 2,
      offset: 0.37
    });
    expect(objectGradientDeleteStopIndexForCommand(objectGradientDeleteStopCommandId(2))).toBe(2);
    expect(textStylePatchForCommand("object.color.green")).toBeUndefined();
    expect(allShellCommands(createPhase4Document()).some((command) => command.id === "object.color.green")).toBe(true);
    expect(allShellCommands(createPhase4Document()).some((command) => command.id === "object.gradient.addStop")).toBe(true);
    expect(allShellCommands(createPhase4Document()).some((command) => command.id === "object.gradient.deleteStop")).toBe(true);
    expect(allShellCommands(createPhase4Document()).some((command) => command.id === "object.gradient.reverseStops")).toBe(true);
    expect(allShellCommands(createPhase4Document()).some((command) => command.id === "object.gradient.rotateStops")).toBe(true);
    expect(mainWindowSource).toContain("const currentToolbarObjectColor = useMemo");
    expect(mainWindowSource).toContain("currentObjectColor: currentToolbarObjectColor");
    expect(mainWindowSource).not.toContain("currentObjectColor: currentToolbarTextStyle.color");
    expect(mainWindowSource).toContain("const objectStyleObjectIds = currentDocument.selection.objectIds.filter");
    expect(mainWindowSource).toContain("findDocumentObject(currentDocument, objectId)?.type !== \"text\"");
    expect(mainWindowSource).toContain("const objectStyleTarget = toolbarStyleTarget");
    expect(mainWindowSource).toContain("objectIds: objectStyleObjectIds");
    expect(mainWindowSource).not.toContain("textRange: activeTextObject?.type === \"text\"");
  });

  it("renders mutually exclusive text toolbar active states from current style", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolPalette, {
        itemGroups: widgetOnlyItemGroups("core.main"),
        mode: "floating",
        orientation: "horizontal",
        onInvoke: () => undefined,
        widgetState: {
          currentTextStyle: {
            ...DefaultNativeTextStyle,
            color: "#1f5fbf",
            textAlign: "right"
          },
          currentTextScript: "superscript",
          onInvoke: () => undefined
        }
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
      "tool.lasso",
      "tool.eraser",
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
      "tool.lasso",
      "tool.eraser",
      structureCleanupCommandId,
      structureSpin3dCommandId,
      structureInteractive3dCommandId,
      structureCleanup3dCommandId,
      "tool.plus",
      "tool.minus",
      "layout.bringToFront",
      "layout.bringForward",
      "layout.sendBackward",
      "layout.sendToBack",
      "layout.flipHorizontal",
      "layout.flipVertical",
      "layout.rotate90",
      "layout.duplicate",
      "layout.group",
      "layout.ungroup"
    ]);
    const disabledTools = paletteGroups.flat().filter((command) => !enabledToolIds.has(command.id));

    expect(paletteGroups.flat().find((command) => command.id === "tool.bond")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.text")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === structureCleanupCommandId)).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === structureCleanup3dCommandId)).toMatchObject({
      enabled: true
    });
    expect(paletteGroups.flat().find((command) => command.id === "tool.plus")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.minus")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.wedgeBond")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.benzene")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.eraser")).toMatchObject({ enabled: true });
    expect(disabledTools.length).toBeGreaterThanOrEqual(20);
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

  it("merges live layout command state into the main toolbar distribute buttons", () => {
    const document = createPhase4Document("Main Toolbar Distribute");
    const pageId = document.pages[0].id;
    const objects: DocumentObject[] = [
      { id: "main_toolbar_a", type: "text", x: 120, y: 180, width: 40, height: 24, rotation: 0, style: {}, text: "A", spans: [] },
      { id: "main_toolbar_b", type: "text", x: 260, y: 210, width: 40, height: 24, rotation: 0, style: {}, text: "B", spans: [] },
      { id: "main_toolbar_c", type: "text", x: 440, y: 190, width: 40, height: 24, rotation: 0, style: {}, text: "C", spans: [] }
    ];
    const selected = applyPatches(document, [
      ...objects.map((object) => ({ op: "addObject" as const, pageId, object })),
      { op: "setSelection" as const, pageId, objectIds: objects.map((object) => object.id) }
    ]);
    const overrides = new Map(createLayerActions(selected).map((command) => [command.id, command] as const));
    const markup = renderToStaticMarkup(
      createElement(ToolPalette, {
        groups: getToolsetCommandGroups("core.main", desktopToolsetRegistry, overrides),
        currentDistributeMode: "spacing",
        orientation: "horizontal",
        onInvoke: () => undefined
      })
    );

    expect(buttonMarkupForCommand(markup, "layout.distributeHorizontal")).not.toContain("disabled");
    expect(buttonMarkupForCommand(markup, "layout.distributeVertical")).not.toContain("disabled");
    expect(buttonMarkupForCommand(markup, "layout.distributeHorizontal")).toContain('data-distribute-mode="spacing"');
    expect(buttonMarkupForCommand(markup, "layout.distributeHorizontal")).toContain("Distribute Horizontally: equal gaps");
    expect(toolPaletteSource).toContain("toolbar-distribute-menu");
    expect(toolPaletteSource).toContain("distributeModeCommandIds.spacing");
  });

  it("matches rotate-handle tangential drag speed to projected-plane tilt speed", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 0, y: -20 };

    expect(rotationDeltaDegrees(center, start, { x: 360, y: -20 })).toBe(360);
    expect(rotationDeltaDegrees(center, start, { x: -360, y: -20 })).toBe(-360);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 0, y: -380 }))).toBe(0);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 0, y: -390 }))).toBe(10);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 0, y: 340 }))).toBe(0);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 0, y: 350 }))).toBe(10);
  });

  it("keeps short rotate-handle drags smooth instead of jumpy", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 0, y: -20 };

    expect(rotationDeltaDegrees(center, start, { x: 4, y: -20 })).toBe(4);
    expect(rotationDeltaDegrees(center, start, { x: 8, y: -20 })).toBe(8);
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

  it("parses manual rotation entries and resolves absolute Z targets", () => {
    expect(parseRotationInputDegrees(" 42.5 ")).toBe(42.5);
    expect(parseRotationInputDegrees("")).toBeUndefined();
    expect(parseRotationInputDegrees("x")).toBeUndefined();
    expect(rotationInputDraftDegrees(45.1234)).toBe("45.123");
    expect(rotationInputHomeDraftDegrees("z")).toEqual({ draftZDegrees: "0" });
    expect(rotationInputHomeDraftDegrees("xy")).toEqual({ draftXDegrees: "0", draftYDegrees: "0" });
    expect(manualRotationDeltaDegrees(350, 10)).toBe(20);
    expect(manualRotationDeltaDegrees(10, 350)).toBe(-20);
    expect(manualRotationDeltaDegrees(0, 360)).toBe(0);
  });

  it("maps projected-plane 3D rotate drags to a wrapping full-turn tilt readout", () => {
    const start = { x: 80, y: 100 };

    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 80, y: 100 }))).toBe(0);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 80, y: 30 }))).toBe(70);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 80, y: -120 }))).toBe(220);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 80, y: 320 }))).toBe(220);
    expect(projectedPlaneTiltReadoutDegrees(projectedPlaneTiltRadiansFromDrag(start, { x: 80, y: -320 }))).toBe(60);
  });

  it("maps projected-plane 3D rotate diagonal drags to X and Y tilt", () => {
    const start = { x: 80, y: 100 };
    const diagonal = projectedPlaneTiltVectorFromDrag(start, { x: 150, y: 30 });
    const wrapped = projectedPlaneTiltVectorFromDrag(start, { x: 500, y: -300 });

    expect(projectedPlaneTiltReadoutDegrees(diagonal.xRad)).toBe(70);
    expect(projectedPlaneTiltReadoutDegrees(diagonal.yRad)).toBe(70);
    expect(projectedPlaneTiltReadoutLabel(diagonal.xRad, diagonal.yRad)).toBe("X 70° / Y 70°");
    expect(projectedPlaneTiltReadoutDegrees(wrapped.xRad)).toBe(40);
    expect(projectedPlaneTiltReadoutDegrees(wrapped.yRad)).toBe(60);
    expect(projectedPlaneTiltReadoutLabel(wrapped.xRad, wrapped.yRad)).toBe("X 40° / Y 60°");
  });

  it("maps native art X/Y rotate drags to the same wrapping full-turn tilt range as molecules", () => {
    const start = { x: 80, y: 100 };
    const diagonal = documentObjectProjectedPlaneTiltVectorFromDrag(start, { x: 150, y: 30 });
    const moleculeDiagonal = projectedPlaneTiltVectorFromDrag(start, { x: 150, y: 30 });
    const beyondSixty = documentObjectProjectedPlaneTiltVectorFromDrag(start, { x: 170, y: 10 });
    const wrapped = documentObjectProjectedPlaneTiltVectorFromDrag(start, { x: 500, y: -300 });

    expect(diagonal).toEqual(moleculeDiagonal);
    expect(projectedPlaneTiltReadoutLabel(diagonal.xRad, diagonal.yRad)).toBe("X 70° / Y 70°");
    expect(projectedPlaneTiltReadoutLabel(beyondSixty.xRad, beyondSixty.yRad)).toBe("X 90° / Y 90°");
    expect(projectedPlaneTiltReadoutLabel(wrapped.xRad, wrapped.yRad)).toBe("X 40° / Y 60°");
  });

  it("keeps projected-plane 3D rotate handle scoped to X/Y tilt", () => {
    expect(projectedPlaneTiltReadoutLabel(0, 0)).toBe("0°");
    expect(projectedPlaneTiltReadoutLabel(Math.PI / 6, -Math.PI / 4)).toBe("X 30° / Y -45°");
    expect(mainWindowSource).not.toContain("projectedPlaneZRotationDegreesFromDrag");
    expect(mainWindowSource).not.toContain("rawRotationDegrees");
    expect(mainWindowSource).not.toContain("full-turn tilt limit");
  });

  it("wires manual rotation entry to Z and X/Y rotation handles", () => {
    expect(mainWindowSource).toContain("data-rotation-input-popover=\"true\"");
    expect(mainWindowSource).toContain("data-rotation-input-kind={input.kind}");
    expect(mainWindowSource).toContain("onDoubleClick={handleRotateDoubleClick}");
    expect(mainWindowSource).toContain("onDoubleClick={handleProjectedPlaneTiltDoubleClick}");
    expect(mainWindowSource).toContain("onRotationInputChange={handleRotationInputChange}");
    expect(mainWindowSource).toContain("onRotationInputHome={handleRotationInputHome}");
    expect(mainWindowSource).toContain("onRotationInputKeep={handleRotationInputKeep}");
    expect(mainWindowSource).toContain("aria-label={input.kind === \"z\" ? \"Set Z rotation to 0 degrees\" : \"Set X/Y rotation to 0 degrees\"}");
    expect(mainWindowSource).toContain("title={input.kind === \"z\" ? \"Set Z rotation to 0 degrees\" : \"Set X/Y rotation to 0 degrees\"}");
    expect(mainWindowSource).toContain('rotationInputHomeDraftDegrees("z")');
    expect(mainWindowSource).toContain('draftXDegrees: "0", draftYDegrees: "0"');
    expect(mainWindowSource).toContain("aria-label=\"Z rotation degrees\"");
    expect(mainWindowSource).toContain("aria-label=\"X rotation degrees\"");
    expect(mainWindowSource).toContain("aria-label=\"Y rotation degrees\"");
    expect(mainWindowSource).not.toContain("ApplyRotationInputIcon");
    expect(mainWindowSource).not.toContain("Apply X Y rotation");
    expect(mainWindowSource).not.toContain("Apply Z rotation");
  });

  it("threads Spin 3D placement through modeled typed rotation while preserving legacy X/Y tilt", () => {
    // The numeric-rotation flatten must run the stereo read-back guard (spin3dFlattenStereoOptions),
    // not commit geometry-only, so a typed rotation can't silently persist a different stereoisomer.
    expect(mainWindowSource).toMatch(/flattenSpunMolecule\(\s*input\.startDocument,\s*input\.objectId,\s*coords3d,\s*quatToViewMatrix\(nextQuat\),\s*{\s*placement,\s*\.\.\.spin3dFlattenStereoOptions\(input\.startDocument,\s*input\.objectId\)\s*}\s*\)/s);
    expect(mainWindowSource).toContain("modeledRotationEntry ? 0");
    expect(mainWindowSource).toMatch(/quatFromAxisAngle\(SPIN_AXIS_Z,\s*-deltaDegrees \* Math\.PI \/ 180\)/);
    expect(mainWindowSource).toMatch(/attachSpin3dModelFromConformer\(nextDocument,\s*input\.objectId/s);
    expect(mainWindowSource).toMatch(/tiltNativeMoleculeProjectedPlane\(\s*input\.startDocument,\s*input\.objectId/s);
    expect(mainWindowSource).toMatch(/applyDocumentObjectProjectedPlaneTilt\(\s*input\.startDocument,\s*input\.objectId/s);
  });

  it("gates the browser agent bridge behind explicit QA flags", () => {
    expect(mainWindowSource).toContain("window[AGENT_BRIDGE_GLOBAL_NAME] = installedBridge");
    expect(mainWindowSource).toContain('params.get("agentBridge") === "1"');
    expect(mainWindowSource).toContain('window.localStorage.getItem("chemdraft.agentBridge") === "enabled"');
    expect(mainWindowSource).toContain("openDocumentContents(payload.contents, payload.displayName, payload.path)");
    expect(mainWindowSource).toContain("agentBridgeDocumentPayloadFromHash");
    expect(mainWindowSource).toContain('params.get("openDocumentText")');
    expect(mainWindowSource).toContain('params.get("openDocumentBase64")');
    expect(mainWindowSource).toContain("window.atob(encoded)");
    expect(mainWindowSource).toContain("document: currentDocument");
    expect(mainWindowSource).toContain("objectTypes: candidate.objects.reduce");
    expect(mainWindowSource).toContain('window.addEventListener("hashchange", openPayloadFromHash)');
    expect(mainWindowSource).toContain('window.removeEventListener("hashchange", openPayloadFromHash)');
  });

  it("gates the art transform QA helper to local browser QA surfaces", () => {
    expect(mainWindowSource).toContain("ArtTransformQaLayer");
    expect(mainWindowSource).toContain("shouldEnableArtTransformQaLayer");
    expect(mainWindowSource).toContain("ArtStyleQaLayer");
    expect(mainWindowSource).toContain("shouldEnableArtStyleQaLayer");
    expect(mainWindowSource).toContain("artStyleQaStressDocument");
    expect(mainWindowSource).toContain('params.get("artQa") === "1"');
    expect(mainWindowSource).toContain('params.get("artStyleQa") === "1"');
    expect(mainWindowSource).toContain('params.get("agentBridge") === "1"');
    expect(mainWindowSource).toContain('data-art-transform-qa-layer="true"');
    expect(mainWindowSource).toContain('data-art-transform-qa-action="scene"');
    expect(mainWindowSource).toContain('data-art-style-qa-panel="true"');
    expect(mainWindowSource).toContain('data-art-style-qa-action="stress"');
    expect(appCss).toContain(".art-transform-qa-overlay");
    expect(appCss).toContain(".art-transform-qa-panel");
    expect(appCss).toContain(".art-style-qa-panel");
  });

  it("keeps transform handle double-clicks out of whole-molecule selection promotion", () => {
    expect(mainWindowSource).toContain("if (object.type === \"molecule\" && doublePress)");
    expect(mainWindowSource).not.toContain("tryWholeMoleculeDoublePress");
    expect(mainWindowSource).not.toContain("Sharing this through every entry point");
    expect(mainWindowSource).toContain("isTransformHandleSecondPress");
    expect(mainWindowSource).toContain("lastTransformHandlePressRef");
    expect(mainWindowSource).toContain("openObjectRotateInput(objectId);");
    expect(mainWindowSource).toContain("openProjectedPlaneTiltInput(objectId);");
    expect(mainWindowSource).toContain("openObjectResizeInput(objectId, corner);");
    expect(mainWindowSource.match(/const selectedDocument = selectedFragmentTarget/g)?.length).toBe(3);
  });

  it("keeps double-click numeric entry whole-molecule only for transform handles", () => {
    expect(mainWindowSource).toContain("Double-click entry is available for whole molecules only");
    expect(mainWindowSource).not.toContain("fragmentRotationDegreesRef");
    expect(mainWindowSource).not.toContain("rememberedFragmentRotationDegrees");
    expect(mainWindowSource).not.toContain("rememberFragmentRotationDegrees");
  });

  it("centers the paired Z and X/Y rotation handles over the selection box", () => {
    expect(mainWindowSource).toContain('data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}');
    expect(appCss).toContain('.object-transform-frame[data-has-tilt3d="true"] .object-rotate-handle');
    expect(appCss).toContain("left: calc(50% - 17px);");
    expect(appCss).toContain("left: calc(50% + 17px);");
    expect(appCss).not.toContain("left: calc(50% + 34px);");
  });

  it("wires manual stretch entry to molecule resize corners", () => {
    expect(mainWindowSource).toContain("data-scale-input-popover=\"true\"");
    expect(mainWindowSource).toContain("data-scale-input-corner={input.corner}");
    expect(mainWindowSource).toContain("onDoubleClick={onResizeDoubleClick(corner)}");
    expect(mainWindowSource).toContain("onObjectResizeInputChange={handleObjectResizeInputChange}");
    expect(mainWindowSource).toContain("onObjectResizeInputHome={handleObjectResizeInputHome}");
    expect(mainWindowSource).toContain("onObjectResizeInputKeep={handleObjectResizeInputKeep}");
    expect(mainWindowSource).toContain("aria-label=\"Restore stretch home\"");
    expect(mainWindowSource).toContain("aria-label=\"X stretch percent\"");
    expect(mainWindowSource).toContain("aria-label=\"Y stretch percent\"");
    expect(mainWindowSource).not.toContain("Apply stretch");
  });

  it("wires group 3D rotate to native molecule multi-selections", () => {
    expect(mainWindowSource).toContain("nativeMoleculeObjectIdsForGroupProjectedPlaneTilt");
    expect(mainWindowSource).toContain('data-group-tilt3d-handle="true"');
    expect(mainWindowSource).toContain("handleGroupProjectedPlaneTiltPointerDown");
    expect(mainWindowSource).toContain('"group-projected-plane-tilt"');
    expect(mainWindowSource).toContain("center: { x: bounds.centerX, y: bounds.centerY }");
    expect(mainWindowSource).toContain("tiltNativeMoleculeObjectsProjectedPlane");
  });

  it("parses manual stretch percentages", () => {
    expect(parseObjectResizeInputPercent("150")).toBe(150);
    expect(parseObjectResizeInputPercent(" 62.5 ")).toBe(62.5);
    expect(parseObjectResizeInputPercent("0")).toBeUndefined();
    expect(parseObjectResizeInputPercent("-4")).toBeUndefined();
    expect(parseObjectResizeInputPercent("")).toBeUndefined();
    expect(objectResizeInputDraftPercent(1.5)).toBe("150");
  });

  it("commits projected-plane 3D rotate as exactly one history entry", () => {
    const startDocument = insertNativeSingleBondMolecule(createPhase4Document("3D Rotate History"), { x: 200, y: 220 });
    const molecule = startDocument.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!molecule) {
      throw new Error("Expected native molecule fixture.");
    }

    const result = tiltNativeMoleculeProjectedPlane(
      startDocument,
      molecule.id,
      { x: molecule.x + molecule.width / 2, y: molecule.y + molecule.height / 2 },
      0,
      Math.PI / 6,
      { tiltYRad: Math.PI / 6 }
    );
    const startHistory = createDocumentHistory(startDocument);
    const committedHistory = projectedPlaneTiltCommitHistory(startHistory, startDocument, result.document);

    expect(result.changed).toBe(true);
    expect(committedHistory.past).toHaveLength(1);
    expect(committedHistory.past[0]).toBe(startDocument);
    expect(committedHistory.present).toBe(result.document);
    expect(committedHistory.future).toEqual([]);
  });

  it("restores the drag-start document on projected-plane 3D rotate cancel paths", () => {
    expect(mainWindowSource.match(/replacePresentDocument\(projectedPlaneTiltDrag\.startDocument\)/g) ?? []).toHaveLength(3);
    expect(mainWindowSource).toContain('setStatus("3D rotate canceled")');
  });

  it("keeps selected molecule fragments highlighted while projected-plane 3D rotate drags", () => {
    expect(mainWindowSource.match(/setSelectedNativeMoleculePart\(projectedPlaneTiltDrag\.target\)/g) ?? []).toHaveLength(4);
    expect(mainWindowSource).not.toContain("projectedPlaneTiltDrag.dragging = true;\n        setActiveEditorObjectId(undefined);\n        setActiveTextEditObjectId(undefined);\n        setActiveAtomLabelEdit(undefined);\n        setHoveredNativeAtom(undefined);\n        setSelectedNativeMoleculePart(undefined);");
  });

  it("resolves molecule corner resize drag as proportional unless shift stretch is active", () => {
    const center = { x: 100, y: 100 };
    const start = { x: 60, y: 60 };

    expect(objectResizeScaleFromDrag(center, start, { x: 40, y: 40 }, false)).toEqual({ x: 1.5, y: 1.5 });
    expect(objectResizeScaleFromDrag(center, start, { x: 20, y: 60 }, false)).toEqual({ x: 1.5, y: 1.5 });
    expect(objectResizeScaleFromDrag(center, start, { x: 40, y: 80 }, false)).toEqual({ x: 1, y: 1 });
    expect(objectResizeScaleFromDrag(center, start, { x: 40, y: 80 }, true)).toEqual({ x: 1.5, y: 0.5 });
    expect(objectResizeReadoutPercent(1.254)).toBe(125);
  });

  it("multiplies molecule resize readouts by the starting molecule scale", () => {
    expect(cumulativeObjectResizeScale({ x: 2, y: 2 }, { x: 1.5, y: 1.5 })).toEqual({ x: 3, y: 3 });
    expect(cumulativeObjectResizeScale({ x: 2, y: 0.5 }, { x: 1.25, y: 0.8 })).toEqual({ x: 2.5, y: 0.4 });
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
    expect(appCss).toContain(".color-picker-color-panel");
    expect(appCss).toContain(".color-wheel-face");
    expect(appCss).toContain(".color-channel-group");
    expect(appCss).toContain(".color-hex-field");
    expect(appCss).toContain(".color-palette-section");
    expect(appCss).toContain(".color-palette-swatch");
    expect(toolPaletteSource).toContain("8 color Crayola box");
    expect(toolPaletteSource).toContain("Colorblind safe");
    expect(toolPaletteSource).toContain("Seasonal colors:");
  });

  it("renders the art toolbar as a command-backed object surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow, { toolsetId: "core.art" }));
    const artGroups = getToolsetCommandGroups("core.art");
    const rectDocument = insertNativeArtGraphicObject(
      createPhase4Document("Art Inspector Rect"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const rectArtStyle = createArtInspectorModel({
      document: rectDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(rectDocument),
      requestedPaintTarget: "fill"
    });
    const rectStrokeArtStyle = createArtInspectorModel({
      document: rectDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(rectDocument),
      requestedPaintTarget: "stroke"
    });
    const lineDocument = insertNativeArtGraphicObject(
      createPhase4Document("Art Inspector Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const lineArtStyle = createArtInspectorModel({
      document: lineDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(lineDocument),
      requestedPaintTarget: "fill"
    });
    const freehandDocument = nativeFreehandStrokeDocument(
      createPhase4Document("Art Inspector Freehand"),
      [
        { x: 180, y: 180, pressure: 0.3 },
        { x: 220, y: 196, pressure: 0.8 }
      ],
      "tool.art.pencil"
    );
    const freehandArtStyle = createArtInspectorModel({
      document: freehandDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(freehandDocument),
      requestedPaintTarget: "fill"
    });
    const gradientObjectId = rectDocument.selection.objectIds[0] ?? "";
    const gradientDocument = applyPatches(rectDocument, [{
      op: "updateObject",
      objectId: gradientObjectId,
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
              { offset: 1, color: "#ffffff", opacity: 0.35 }
            ]
          },
          fillColor: "#1d7f68",
          fillMode: "solid"
        }
      }
    }]);
    const gradientArtStyle = createArtInspectorModel({
      document: gradientDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(gradientDocument),
      requestedPaintTarget: "fill"
    });
    const effectObjectId = rectDocument.selection.objectIds[0] ?? "";
    const effectDocument = applyPatches(rectDocument, [{
      op: "updateObject",
      objectId: effectObjectId,
      changes: {
        style: {
          effects: [{ kind: "glow", color: "#1d7f68", opacity: 0.42, blurPx: 7, spreadPx: 1.2 }]
        }
      }
    }]);
    const effectArtStyle = createArtInspectorModel({
      document: effectDocument,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(effectDocument),
      requestedPaintTarget: "fill"
    });
    const artInspectorMarkup = (
      currentArtStyle: ReturnType<typeof createArtInspectorModel>,
      currentArtStyleTarget: "fill" | "stroke" = "fill"
    ) =>
      renderToStaticMarkup(createElement(ToolPalette, {
        itemGroups: widgetOnlyItemGroups("core.art"),
        activeTool: "tool.select",
        orientation: "horizontal",
        title: "ChemDraft floating Art Toolbar",
        onInvoke: () => undefined,
        widgetState: {
          currentObjectColor: "#111111",
          currentArtStyleTarget,
          currentArtStyle,
          onInvoke: () => undefined
        }
      }));
    const rectInspectorMarkup = artInspectorMarkup(rectArtStyle, "fill");
    const rectStrokeInspectorMarkup = artInspectorMarkup(rectStrokeArtStyle, "stroke");
    const lineInspectorMarkup = artInspectorMarkup(lineArtStyle, "fill");
    const freehandInspectorMarkup = artInspectorMarkup(freehandArtStyle, "fill");
    const gradientInspectorMarkup = artInspectorMarkup(gradientArtStyle, "fill");
    const effectInspectorMarkup = artInspectorMarkup(effectArtStyle, "fill");

    expect(markup).toContain('aria-label="ChemDraft floating Art Toolbar"');
    expect(markup).toContain('data-toolset-id="core.art"');
    expect(markup).toContain('data-command-id="tool.select"');
    expect(markup).toContain('data-command-id="tool.lasso"');
    expect(markup).not.toContain('data-command-id="tool.art.directEdit"');
    expect(markup).toContain('data-command-id="tool.text"');
    expect(markup).toContain('data-command-id="tool.art.rect"');
    expect(markup).toContain('data-command-id="tool.art.roundedRect"');
    expect(markup).toContain('data-command-id="tool.art.circle"');
    expect(markup).toContain('data-command-id="tool.art.ellipse"');
    expect(markup).toContain('data-command-id="tool.art.line"');
    expect(markup).toContain('data-command-id="tool.art.lineWavy"');
    expect(markup).toContain('data-command-id="tool.art.pen"');
    expect(markup).toContain('data-command-id="tool.art.polyline"');
    expect(markup).toContain('data-command-id="tool.art.scissors"');
    expect(markup).toContain('data-command-id="tool.art.measure"');
    expect(markup).toContain('data-command-id="tool.eraser"');
    expect(markup).toContain('data-command-id="tool.art.arrow"');
    expect(markup).toContain('data-command-id="tool.art.arc270"');
    expect(markup).toContain('data-command-id="tool.art.arc90"');
    expect(markup).toContain('data-command-id="tool.art.pencil"');
    expect(markup).toContain('data-command-id="layout.bringForward"');
    expect(markup).toContain('data-command-id="layout.sendToBack"');
    expect(markup).toContain('data-command-id="layout.alignLeft"');
    expect(markup).toContain('data-command-id="layout.alignCenter"');
    expect(markup).toContain('data-command-id="layout.alignRight"');
    expect(markup).toContain('data-command-id="layout.alignTop"');
    expect(markup).toContain('data-command-id="layout.alignMiddle"');
    expect(markup).toContain('data-command-id="layout.alignBottom"');
    expect(markup).toContain('data-command-id="layout.distributeHorizontal"');
    expect(markup).toContain('data-command-id="layout.distributeVertical"');
    expect(markup).toContain('data-command-id="layout.flipHorizontal"');
    expect(markup).toContain('data-command-id="layout.flipVertical"');
    expect(markup).toContain('data-command-id="layout.rotate90"');
    expect(markup).toContain('data-command-id="layout.duplicate"');
    expect(markup).toContain('data-command-id="layout.group"');
    expect(markup).toContain('data-command-id="layout.ungroup"');
    expect(markup).toContain('data-art-command-grid="true"');
    expect(markup.match(/data-art-command-column=/g) ?? []).toHaveLength(4);
    expect(markup).toContain('data-art-command-column="selection"');
    expect(markup).toContain('data-art-command-column="drawing"');
    expect(markup).toContain('data-art-command-column="arrange"');
    expect(markup).toContain('data-art-command-column="boolean"');
    expect(markup).toContain('data-art-shape-flyout-column="true"');
    expect(markup).toContain('data-command-flyout="shapes"');
    expect(markup).toContain('data-command-flyout-menu="shapes"');
    expect(markup.match(/data-art-arrange-column="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain('data-command-flyout="align"');
    expect(markup).toContain('data-command-flyout="layer"');
    expect(markup).toContain('data-command-flyout="transform"');
    expect(markup).toContain('data-command-flyout-menu="group"');
    expect(markup).toContain('data-art-command-band="true"');
    expect(markup).toContain('data-command-id="art.boolean.union"');
    expect(markup).toContain('data-command-id="art.boolean.subtract"');
    expect(markup).toContain('data-command-id="art.boolean.intersect"');
    expect(markup).toContain('data-command-id="art.boolean.split"');
    expect(markup).not.toContain('data-command-id="tool.art.circleGloss"');
    expect(markup).not.toContain('data-command-id="tool.art.rectShadow"');
    expect(markup).not.toContain('data-command-id="tool.art.arc90Dashed"');
    const booleanCommandIds = new Set(["art.boolean.union", "art.boolean.subtract", "art.boolean.intersect", "art.boolean.split"]);
    expect(artGroups.flat().filter((command) => !booleanCommandIds.has(command.id)).every((command) => command.assetName)).toBe(true);
    expect(artGroups.flat().filter((command) => booleanCommandIds.has(command.id)).every((command) => command.assetName === undefined)).toBe(true);
    expect(markup).not.toContain("data-art-tool-icon=");
    expect(buttonMarkupForCommand(markup, "tool.art.rect")).toContain('data-command-flyout-button="shapes"');
    expect(buttonMarkupForCommand(markup, "tool.art.rect")).toContain('data-toolbar-asset="Art_Shapes"');
    expect(buttonMarkupForCommand(markup, "tool.art.roundedRect")).toContain('data-toolbar-asset="Art_Rounded_Rectangle"');
    expect(buttonMarkupForCommand(markup, "tool.art.pen")).toContain('data-toolbar-asset="Art_Pen"');
    expect(buttonMarkupForCommand(markup, "tool.art.polyline")).toContain('data-toolbar-asset="Art_Polyline"');
    expect(buttonMarkupForCommand(markup, "tool.art.scissors")).toContain('data-toolbar-asset="Art_Scissors"');
    expect(buttonMarkupForCommand(markup, "tool.art.measure")).toContain('data-toolbar-asset="Art_Tape_Measure"');
    expect(buttonMarkupForCommand(markup, "tool.eraser")).toContain('data-toolbar-asset="Art_Eraser"');
    expect(buttonMarkupForCommand(markup, "tool.lasso")).toContain('data-toolbar-asset="Custom_Lasso"');
    expect(buttonMarkupForCommand(markup, "tool.art.arrow")).toContain('data-toolbar-asset="Art_Arrow"');
    expect(buttonMarkupForCommand(markup, "tool.art.arc270")).toContain('data-toolbar-asset="Art_Arc_Circular"');
    expect(buttonMarkupForCommand(markup, "tool.art.arc90")).toContain('data-toolbar-asset="Art_Arc_Quarter"');
    expect(buttonMarkupForCommand(markup, "tool.art.pencil")).toContain('data-toolbar-asset="Art_Pencil"');
    expect(buttonMarkupForCommand(markup, "layout.alignLeft")).toContain('data-toolbar-asset="Custom_Left"');
    expect(buttonMarkupForCommand(markup, "layout.alignLeft")).toContain('data-shortcut-label="⌥⇧⌘L"');
    expect(buttonMarkupForCommand(markup, "layout.distributeHorizontal")).toContain('data-toolbar-asset="Custom_Horizontal"');
    expect(buttonMarkupForCommand(markup, "layout.distributeHorizontal")).toContain('data-distribute-mode="centers"');
    expect(buttonMarkupForCommand(markup, "layout.distributeHorizontal")).toContain('data-shortcut-label="⌥⇧⌘H"');
    expect(buttonMarkupForCommand(markup, "layout.sendToBack")).toContain('data-toolbar-asset="Art_Send_To_Back"');
    expect(buttonMarkupForCommand(markup, "layout.sendToBack")).toContain('data-shortcut-label="⇧⌘["');
    expect(buttonMarkupForCommand(markup, "layout.flipHorizontal")).toContain('data-toolbar-asset="Custom_Flip_Horizontal"');
    expect(buttonMarkupForCommand(markup, "layout.flipVertical")).toContain('data-toolbar-asset="Custom_Flip_Vertical"');
    expect(buttonMarkupForCommand(markup, "layout.rotate90")).toContain('data-toolbar-asset="Custom_Rotation"');
    expect(buttonMarkupForCommand(markup, "layout.duplicate")).toContain('data-toolbar-asset="Art_Bring_Forward"');
    expect(buttonMarkupForCommand(markup, "layout.group")).toContain('data-toolbar-asset="Custom_Group"');
    expect(buttonMarkupForCommand(markup, "layout.ungroup")).toContain('data-toolbar-asset="Custom_Ungroup"');
    expect(rectInspectorMarkup).toContain('data-toolbar-style-controls="art"');
    expect(rectInspectorMarkup).toContain('aria-label="Fill color"');
    expect(rectInspectorMarkup).toContain('aria-label="Open object color picker"');
    expect(rectInspectorMarkup).toContain('data-color-picker="true"');
    expect(rectInspectorMarkup).toContain('data-command-id="object.style.target.fill"');
    expect(rectInspectorMarkup).toContain('data-command-id="object.style.swapFillStroke"');
    expect(rectInspectorMarkup).toContain('aria-label="Art effects"');
    expect(rectInspectorMarkup).toContain('data-art-effect-button="none"');
    expect(rectInspectorMarkup).toContain('data-art-effect-button="shadow"');
    expect(rectInspectorMarkup).toContain('data-art-effect-button="glow"');
    expect(rectInspectorMarkup).toContain('data-art-effect-button="sketch"');
    expect(rectInspectorMarkup).toMatch(/class="art-inspector-row art-inspector-main-row"[\s\S]*data-art-effect-button="sketch"[\s\S]*aria-label="Stroke width"/);
    expect(rectInspectorMarkup).not.toMatch(/class="art-inspector-row art-inspector-stroke-row"[\s\S]*aria-label="Stroke width"/);
    expect(rectInspectorMarkup).not.toContain('data-art-effect-controls=');
    expect(effectInspectorMarkup).toContain('data-art-effect-button="glow"');
    expect(effectInspectorMarkup).toContain('data-art-effect-controls="glow"');
    expect(effectInspectorMarkup).toContain('data-art-effect-present-count="1"');
    expect(effectInspectorMarkup).toContain('data-art-effect-present-all="true"');
    expect(effectInspectorMarkup).toContain('data-art-effect-color-trigger="glow"');
    expect(effectInspectorMarkup).toContain('data-art-inspector-slider="glow-effect-opacity"');
    expect(effectInspectorMarkup).toContain('data-art-inspector-slider="glow-effect-size"');
    expect(rectInspectorMarkup).toContain('aria-label="Stroke width"');
    expect(rectInspectorMarkup).toContain('data-art-inspector-slider="object-opacity"');
    expect(rectInspectorMarkup).toContain('data-art-inspector-slider="fill-opacity"');
    expect(rectInspectorMarkup).toContain('data-art-inspector-slider="stroke-opacity"');
    expect(rectInspectorMarkup).toContain("Obj");
    expect(rectInspectorMarkup).toContain("Fill");
    expect(rectInspectorMarkup).toContain("Stroke");
    expect(rectInspectorMarkup).not.toContain('class="art-stroke-control-label">Width</span>');
    expect(rectInspectorMarkup).not.toContain('aria-label="Dash pattern"');
    expect(rectStrokeInspectorMarkup).toMatch(/class="art-inspector-row art-inspector-main-row"[\s\S]*class="toolbar-color-trigger-label">Stroke<\/span>[\s\S]*aria-label="Dash pattern"[\s\S]*aria-label="No stroke"/);
    expect(rectStrokeInspectorMarkup).not.toContain('class="art-stroke-control-label">Dash</span>');
    expect(rectStrokeInspectorMarkup).not.toMatch(/class="art-inspector-row art-inspector-stroke-row"[\s\S]*aria-label="Dash pattern"/);
    expect(rectInspectorMarkup).not.toContain("Corners");
    expect(rectInspectorMarkup).not.toContain("Line ends");
    expect(gradientInspectorMarkup).toContain('data-art-gradient-controls="fill"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-rail="fill"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-type="linear-gradient"');
    expect(gradientInspectorMarkup).toContain('data-command-id="object.gradient.addStop"');
    expect(gradientInspectorMarkup).toContain('data-command-id="object.gradient.deleteStop.0"');
    expect(gradientInspectorMarkup).toContain('data-command-id="object.gradient.reverseStops"');
    expect(gradientInspectorMarkup).toContain('data-command-id="object.gradient.rotateStops"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-stop-editor="fill"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-active-stop="0"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-stop-color="#1d7f68"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-stop-offset="0"');
    expect(gradientInspectorMarkup).toContain('data-art-gradient-stop-color-trigger="true"');
    expect(gradientInspectorMarkup).toContain('data-art-inspector-slider="gradient-stop-opacity"');
    expect(gradientInspectorMarkup).toContain('aria-label="Drag gradient stop 1 at 0%"');
    expect(gradientInspectorMarkup).toContain('data-command-id="object.gradient.stopOffset.0.0"');
    expect(gradientInspectorMarkup.match(/data-art-gradient-stop=/g) ?? []).toHaveLength(2);
    expect(gradientInspectorMarkup).toContain('data-art-gradient-stop-active="true"');
    expect(gradientInspectorMarkup).toContain("--art-gradient-stop-offset:0%");
    expect(gradientInspectorMarkup).toContain("--art-gradient-stop-offset:100%");
    expect(lineInspectorMarkup).toContain('data-art-fill-supported-count="0"');
    expect(lineInspectorMarkup).toContain('data-art-line-ends-supported-count="1"');
    expect(lineInspectorMarkup).toContain('data-art-fill-support-all="false"');
    expect(lineInspectorMarkup).toContain('data-art-line-ends-support-all="true"');
    expect(lineInspectorMarkup).not.toContain('data-command-id="object.style.target.fill"');
    expect(lineInspectorMarkup).not.toContain('data-art-inspector-slider="fill-opacity"');
    expect(lineInspectorMarkup).toContain('aria-label="Stroke color"');
    expect(lineInspectorMarkup).not.toContain("Line ends");
    expect(lineInspectorMarkup).not.toContain("Corners");
    expect(freehandInspectorMarkup).toContain('data-art-fill-supported-count="0"');
    expect(freehandInspectorMarkup).toContain('data-art-stroke-supported-count="1"');
    expect(freehandInspectorMarkup).not.toContain('data-command-id="object.style.target.fill"');
    expect(freehandInspectorMarkup).toContain('data-command-id="object.style.target.stroke"');
    expect(freehandInspectorMarkup).toContain('aria-label="Stroke color"');
    expect(freehandInspectorMarkup).toContain(">Stroke</span>");
    expect(freehandInspectorMarkup).not.toContain('aria-label="Stroke width"');
    expect(freehandInspectorMarkup).not.toContain('data-art-inspector-slider="fill-opacity"');
    expect(markup).not.toContain('data-command-id="text.color.black"');
    expect(desktopToolsetsSource).toContain('"commandId": "tool.art.eyedropper"');
    expect(desktopToolsetsSource).toContain('"assetName": "Art_Eyedropper"');
    expect(mainWindowSource).toContain("toolBeforeEyedropperRef");
    expect(mainWindowSource).toContain("restoreToolAfterEyedropper");
    expect(mainWindowSource).toContain('tool.id === "tool.art.eyedropper" && activeToolState.activeCommandId === "tool.art.eyedropper"');
    expect(mainWindowSource).toContain('event.key === "Escape" && activeToolCommandIdRef.current === "tool.art.eyedropper"');
    expect(toolPaletteSource).toContain("function ArtToolIcon");
    expect(toolPaletteSource).toContain("IroColorWheel");
    expect(toolPaletteSource).toContain('sliderType: "value"');
    expect(toolPaletteSource).not.toContain("wheelLightness: false");
    expect(toolPaletteSource).toContain("ColorPickerPopoverBody");
    expect(toolPaletteSource).toContain("objectOpacityCommandId");
    expect(toolPaletteSource).toContain("objectStrokeDashCommands");
    expect(toolPaletteSource).toContain("supportsFillAny");
    expect(appCss).toContain('.app-shell[data-active-tool="tool.art.eyedropper"] .page');
    expect(appCss).toContain("cursor: crosshair;");
    expect(appCss).toContain(".art-toolbar-style-controls");
    expect(appCss).toContain("grid-template-rows: 58px auto;");
    expect(appCss).toContain(".art-toolbar-command-band");
    expect(appCss).toContain(".art-toolbar-command-grid");
    expect(appCss).toContain("grid-template-columns: repeat(4, max-content);");
    expect(appCss).toContain("grid-template-rows: auto;");
    expect(appCss).toContain("grid-auto-rows: auto;");
    expect(appCss).toContain("grid-template-columns: minmax(260px, 520px);");
    expect(appCss).toContain("grid-template-columns: 50px minmax(180px, 1fr) 48px;");
    expect(appCss).toContain(".art-inspector-slider-value");
    expect(appCss).toContain(".art-stroke-control-label");
    expect(appCss).toContain(".iro-color-picker .IroColorPicker");
    expect(appCss).toContain('.color-channel-group input[type="number"]::-webkit-inner-spin-button');
    expect(appCss).toContain("appearance: textfield;");
    expect(readFileSync(join(__dirname, "PaletteWindow.tsx"), "utf8")).toContain("new ResizeObserver");
  });

  it("keeps the art inspector color picker dependency license acceptable", () => {
    const iroPackage = JSON.parse(readFileSync(
      join(dirname(require.resolve("@jaames/iro")), "../package.json"),
      "utf8"
    )) as { license: string };

    expect(iroPackage.license).toBe("MPL-2.0");
  });

  it("keeps art boolean commands disabled for a closed shape plus open line", () => {
    const withRect = insertNativeArtGraphicObject(
      createPhase4Document("Mixed Boolean Selection"),
      { x: 220, y: 180 },
      "tool.art.rectFilled"
    );
    const rectId = withRect.selection.objectIds[0];
    const withLine = insertNativeArtGraphicObject(withRect, { x: 320, y: 220 }, "tool.art.line");
    const lineId = withLine.selection.objectIds[0];
    if (!rectId || !lineId) {
      throw new Error("Expected a rectangle and a line.");
    }

    const selected = selectDocumentObjects(withLine, withLine.pages[0].id, [rectId, lineId]);
    const booleanCommands = createLayerActions(selected).filter((command) => command.id.startsWith("art.boolean."));

    expect(booleanCommands).toHaveLength(4);
    expect(booleanCommands.every((command) => command.enabled === false)).toBe(true);
    expect(booleanCommands.every((command) => command.disabledReason === "Select at least two closed art shapes")).toBe(true);
  });

  it("preserves the last native export folder while changing export basenames", () => {
    expect(nativePathDirname("/Users/me/Desktop/figure.svg")).toBe("/Users/me/Desktop");
    expect(nativePathDirname("figure.svg")).toBeUndefined();
    expect(nativePathJoin("/Users/me/Desktop", "figure.pdf")).toBe("/Users/me/Desktop/figure.pdf");
    expect(nativePathJoin(undefined, "figure.pdf")).toBeUndefined();
    expect(nativePathWithBasename("/Users/me/Desktop/figure.svg", "renamed.pdf")).toBe("/Users/me/Desktop/renamed.pdf");
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
        "core.art",
        "core.orbitals",
        "core.layout",
        "core.style",
        "core.text",
        "core.ringInspector",
        "core.moleculeInspector"
      ])
    );
    expect(ids).not.toContain(FIXTURE_PLUGIN_TOOLSET_ID);
    expect(desktopToolsetRegistry.require("core.main").defaultVisible).toBe(true);
    expect(desktopToolsetRegistry.require("core.art").preferredWindowSize).toMatchObject({
      width: 420,
      minWidth: 760
    });
    expect(desktopToolsetRegistry.require("core.art").groups.find((group) => group.id === "core.art.freehand")?.items.map((item) => item.commandId)).toEqual([
      "tool.art.pencil",
      "tool.art.brush"
    ]);
    // The fixture toolset comes from the plugin runtime, not the core manifest.
    expect(buildRegistryWithFixture().require(FIXTURE_PLUGIN_TOOLSET_ID).source).toBe("plugin");
  });

  it("keeps duplicated toolbar commands on a shared material-style asset", () => {
    const assetNamesByCommandId = new Map<string, Set<string>>();
    desktopToolsetRegistry.listToolsets().forEach((toolset) => {
      toolset.groups.forEach((group) => {
        group.items.forEach((item) => {
          if (!item.assetName || !item.commandId) {
            return;
          }
          const assetNames = assetNamesByCommandId.get(item.commandId) ?? new Set<string>();
          assetNames.add(item.assetName);
          assetNamesByCommandId.set(item.commandId, assetNames);
        });
      });
    });

    assetNamesByCommandId.forEach((assetNames, commandId) => {
      expect([...assetNames], commandId).toHaveLength(1);
    });
    expect([...assetNamesByCommandId.get("tool.select") ?? []]).toEqual(["Art_Select"]);
    expect([...assetNamesByCommandId.get("tool.text") ?? []]).toEqual(["Art_Text"]);
    expect([...assetNamesByCommandId.get("tool.eraser") ?? []]).toEqual(["Art_Eraser"]);
    expect([...assetNamesByCommandId.get("tool.art.rect") ?? []]).toEqual(["Art_Shapes"]);
    expect([...assetNamesByCommandId.get("layout.alignLeft") ?? []]).toEqual(["Custom_Left"]);
    expect([...assetNamesByCommandId.get("layout.alignCenter") ?? []]).toEqual(["Custom_Center"]);
    expect([...assetNamesByCommandId.get("layout.alignRight") ?? []]).toEqual(["Custom_Right"]);
    expect([...assetNamesByCommandId.get("layout.alignTop") ?? []]).toEqual(["Custom_Top"]);
    expect([...assetNamesByCommandId.get("layout.alignMiddle") ?? []]).toEqual(["Custom_Middle"]);
    expect([...assetNamesByCommandId.get("layout.alignBottom") ?? []]).toEqual(["Custom_Bottom"]);
    expect([...assetNamesByCommandId.get("layout.distributeHorizontal") ?? []]).toEqual(["Custom_Horizontal"]);
    expect([...assetNamesByCommandId.get("layout.distributeVertical") ?? []]).toEqual(["Custom_Vertical"]);
    expect([...assetNamesByCommandId.get("layout.bringToFront") ?? []]).toEqual(["Art_Bring_To_Front"]);
    expect([...assetNamesByCommandId.get("layout.bringForward") ?? []]).toEqual(["Art_Bring_Forward"]);
    expect([...assetNamesByCommandId.get("layout.sendBackward") ?? []]).toEqual(["Art_Send_Backward"]);
    expect([...assetNamesByCommandId.get("layout.sendToBack") ?? []]).toEqual(["Art_Send_To_Back"]);
    expect([...assetNamesByCommandId.get("layout.rotate90") ?? []]).toEqual(["Custom_Rotation"]);
    expect([...assetNamesByCommandId.get("layout.duplicate") ?? []]).toEqual(["Art_Bring_Forward"]);
    expect([...assetNamesByCommandId.get("layout.group") ?? []]).toEqual(["Custom_Group"]);
    expect([...assetNamesByCommandId.get("layout.ungroup") ?? []]).toEqual(["Custom_Ungroup"]);
    expect([...assetNamesByCommandId.get(structureSpin3dCommandId) ?? []]).toEqual(["Custom_Spin_3D"]);
    // Interactive 3D Workspace no longer shares Spin 3D's asset — it renders a title-generated "3D"
    // monogram so the two 3D buttons are visually distinct.
    expect(assetNamesByCommandId.has(structureInteractive3dCommandId)).toBe(false);
  });

  it("keeps sparse floating toolsets compact", () => {
    const mainToolset = desktopToolsetRegistry.require("core.main");
    const textToolset = desktopToolsetRegistry.require("core.text");
    const verticalSizes = desktopToolsetRegistry
      .listToolsets()
      .filter((toolset) => toolset.gridLayout?.orientation !== "horizontal")
      .map((toolset) => toolset.preferredWindowSize?.height ?? 0);

    expect(mainToolset.preferredWindowSize).toMatchObject({ width: 1138, height: 128, minWidth: 860, minHeight: 124 });
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
    // Two 24px rows, content-sized (no fixed 344px width / `1fr` filler), with the font box exactly
    // 4 grid cells and the size box 3 — so both rows are the same width and columns line up.
    expect(appCss).toContain("grid-template-rows: 24px 24px;");
    expect(appCss).toContain("width: calc(var(--cd-control-height) * 4 + var(--cd-space-2) * 3);");
    expect(appCss).toContain("width: calc(var(--cd-control-height) * 3 + var(--cd-space-2) * 2);");
    expect(appCss).toContain(".tool-palette.floating.horizontal.main-style-palette");
    expect(appCss).toContain("max-height: 64px;");
    expect(appCss).toContain(".tool-palette.horizontal.main-style-palette .tool-group:last-of-type");
    expect(appCss).toContain(
      ".tool-palette.horizontal.main-style-palette,\n.tool-palette.floating.horizontal.main-style-palette {\n  padding-right: 10px;"
    );
    expect(appCss).not.toContain(
      ".tool-palette.horizontal .tool-group:last-of-type,\n.tool-palette.floating.horizontal .tool-group:last-of-type {"
    );
    expect(appCss).not.toContain(
      ".tool-palette.horizontal,\n.tool-palette.floating.horizontal {\n  padding-right: 10px;"
    );
  });

  it("clips narrow palette titles away from the close control", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow, { toolsetId: "plugin.fixture" }));

    expect(markup).toContain('data-palette-title-drag-surface="true"');
    expect(appCss).toContain(".palette-title-label");
    expect(appCss).toContain("text-overflow: ellipsis;");
    expect(appCss).toContain("left: 4px;");
  });

  it("builds View > Toolbars menu items from registered toolsets", () => {
    const menu = getToolbarsMenuModel(new Set(["core.main"]), buildRegistryWithFixture());

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
          title: "Art Toolbar",
          commandId: "view.toolset.toggle.core.art",
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
      toolsetOrder: ["user.quick", "core.text", "core.main"],
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
                { commandId: "tool.eraser", title: "Eraser Tool" }
              ]
            }
          ]
        }
      ]
    });
    const menu = getToolbarsMenuModel(new Set(["user.quick"]), registry);

    expect(registry.listToolsets().map((toolset) => toolset.id).slice(0, 3)).toEqual([
      "user.quick",
      "core.text",
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
    const mainCommands = getToolsetCommandGroups("core.main", registry)[0].map((command) => command.id);
    // The legacy per-group order folds onto the flattened single-group Main toolbar: the listed ids
    // lead, the hidden lasso is gone, and the rest of the toolbar follows in manifest order.
    expect(mainCommands.slice(0, 3)).toEqual(["tool.text", "tool.select", "tool.eraser"]);
    expect(mainCommands).not.toContain("tool.lasso");
  });

  it("creates toggle commands for every registered toolset", () => {
    const toggles = getToolsetToggleActions(buildRegistryWithFixture());

    expect(toggles.map((command) => command.id)).toEqual(
      expect.arrayContaining(["view.toolset.toggle.core.structure", "view.toolset.toggle.plugin.fixture"])
    );
    expect(toggles.every((command) => command.category === "view")).toBe(true);
  });

  it("builds the shell catalog from the effective registry and current history availability", () => {
    const pluginCommands = allShellCommands(createPhase4Document(), undefined, {
      registry: buildRegistryWithFixture()
    });
    expect(pluginCommands).toContainEqual(
      expect.objectContaining({
        id: "view.toolset.toggle.plugin.fixture",
        title: "Toggle Fixture Plugin Toolbar"
      })
    );

    const customizedRegistry = createDesktopToolsetRegistry({
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", title: "My Lab Toolbar" }],
      userToolsets: [
        {
          id: "user.quick",
          title: "My Quick Tools",
          source: "user",
          defaultVisible: false,
          defaultMode: "floating",
          groups: [
            {
              id: "user.quick.items",
              items: [{ commandId: "tool.select", title: "Selection Tool" }]
            }
          ]
        }
      ]
    });
    const commands = allShellCommands(createPhase4Document(), undefined, {
      availability: { canUndo: true, canRedo: false },
      registry: customizedRegistry
    });

    expect(commands).toContainEqual(
      expect.objectContaining({ id: "view.toolset.toggle.core.main", title: "Toggle My Lab Toolbar" })
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ id: "view.toolset.toggle.user.quick", title: "Toggle My Quick Tools" })
    );
    expect(commands.find((command) => command.id === "edit.undo")?.enabled).toBe(true);
    expect(commands.find((command) => command.id === "edit.redo")?.enabled).toBe(false);
  });

  it("renders an independent plugin fixture toolset surface", () => {
    const markup = renderToStaticMarkup(
      createElement(PaletteWindow, {
        toolsetId: FIXTURE_PLUGIN_TOOLSET_ID,
        initialRegistry: buildRegistryWithFixture()
      })
    );

    expect(markup).toContain(`data-toolset-id="${FIXTURE_PLUGIN_TOOLSET_ID}"`);
    expect(markup).toContain(`data-command-id="${FIXTURE_PLUGIN_PING_COMMAND_ID}"`);
    expect(markup).toContain("Ping");
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

    expect(disabledTools.length).toBeGreaterThanOrEqual(20);
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

    expect(toolCommands.length).toBeGreaterThanOrEqual(49);
    expect(toolCommands.some((command) => command.assetName === "Custom_Bond_Wedge")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Arrow_Equilibrium")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Flip_Horizontal")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Structure_Cleanup")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Spin_3D")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Structure_Cleanup_3D")).toBe(true);
    expect(toolCommands.some((command) => command.id === structureCleanup3dCommandId)).toBe(true);
  });

  it("keeps toolbar shortcuts in delayed hover tooltips instead of visible icon badges", () => {
    const bondCommand = getToolsetCommandSpecs().find((command) => command.id === "tool.bond");
    const wedgeCommand = getToolsetCommandSpecs().find((command) => command.id === "tool.wedgeBond");
    const cleanupCommand = getToolsetCommandSpecs().find((command) => command.id === structureCleanupCommandId);
    const pOrbitalCommand = getToolsetCommandSpecs().find((command) => command.id === "tool.pOrbital");
    if (!bondCommand || !wedgeCommand || !cleanupCommand || !pOrbitalCommand) {
      throw new Error("Expected toolbar commands.");
    }

    const markup = renderToStaticMarkup(
      createElement(ToolPalette, {
        groups: [[bondCommand, wedgeCommand, cleanupCommand, pOrbitalCommand]],
        mode: "floating",
        orientation: "horizontal",
        onInvoke: () => undefined
      })
    );
    const bondMarkup = buttonMarkupForCommand(markup, "tool.bond");
    const wedgeMarkup = buttonMarkupForCommand(markup, "tool.wedgeBond");
    const cleanupMarkup = buttonMarkupForCommand(markup, structureCleanupCommandId);
    const pOrbitalMarkup = buttonMarkupForCommand(markup, "tool.pOrbital");
    const verticalMarkup = renderToStaticMarkup(
      createElement(ToolPalette, { groups: [[bondCommand]], onInvoke: () => undefined })
    );
    const verticalBondMarkup = buttonMarkupForCommand(verticalMarkup, "tool.bond");

    expect(bondMarkup).toContain('data-command-id="tool.bond"');
    expect(bondMarkup).toContain('data-shortcut-label="M"');
    expect(bondMarkup).toContain('data-tooltip="Single Bond: Draw a bond. Long-press for bond variants. (M)"');
    expect(bondMarkup).toContain('class="tool-tooltip"');
    expect(bondMarkup).toContain(">Single Bond</span>");
    expect(bondMarkup).toContain(">Draw a bond. Long-press for bond variants.</span>");
    expect(bondMarkup).toContain(">M</span>");
    expect(bondMarkup).not.toContain("toolset action");
    expect(wedgeMarkup).toContain('data-shortcut-label="No shortcut"');
    expect(wedgeMarkup).toContain('data-tooltip="Solid Wedge Bond"');
    expect(wedgeMarkup).toContain(">Solid Wedge Bond</span>");
    expect(wedgeMarkup).not.toContain("toolset action");
    expect(pOrbitalMarkup).toContain('data-shortcut-label="No shortcut"');
    expect(pOrbitalMarkup).toContain('data-tooltip="p Orbital Tool: Requires an active structure editor"');
    expect(pOrbitalMarkup).toContain(">Requires an active structure editor</span>");
    expect(pOrbitalMarkup).not.toContain("EditorAdapter");
    expect(pOrbitalMarkup).not.toContain("p Orbital Tool (No shortcut)");
    expect(bondMarkup).not.toContain('title="Single Bond (M)"');
    expect(verticalBondMarkup).not.toContain('title="Single Bond (M)"');
    expect(bondMarkup).not.toContain("with-shortcut");
    expect(markup).not.toContain('class="shortcut"');
    expect(markup).toContain("icon-button-shell");
    expect(markup).toContain('data-tooltip-delay-ms="500"');
    expect(markup).toContain('data-tooltip-owner-id="');
    expect(markup).not.toContain("data-tooltip-visible");
    expect(cleanupMarkup).toContain('class="icon-button structure-cleanup-button"');
    expect(cleanupMarkup).toContain('data-tooltip="Clean up Structure 2D (⇧⌘K)"');
    expect(cleanupMarkup).toContain(">Clean up Structure 2D</span>");
    expect(cleanupMarkup).toContain(">⇧⌘K</span>");
    expect(cleanupMarkup).not.toContain("toolset action");
    expect(appCss).toContain(".tool-tooltip");
    expect(appCss).not.toContain("@keyframes cd-tooltip-auto-hide");
    expect(appCss).not.toContain(".icon-button-shell:hover .tool-tooltip");
    expect(appCss).toContain('.icon-button-shell[data-tooltip-visible="true"] .tool-tooltip');
    expect(appCss).toContain(".tool-palette.horizontal .tool-tooltip");
    expect(appCss).toContain(".tool-palette.vertical .tool-tooltip");
    expect(appCss).toContain(".tool-palette.floating.horizontal.main-style-palette .tool-tooltip");
    expect(appCss).toMatch(/\.web-floating-palette \{[\s\S]*overflow: visible;/);
    expect(appCss).toMatch(/\.tool-palette\.horizontal \.tool-tooltip,[\s\S]*top: calc\(100% \+ 7px\);[\s\S]*bottom: auto;/);
    expect(appCss).not.toMatch(/\.tool-palette\.horizontal \.tool-tooltip,[\s\S]*bottom: calc\(100% \+ 6px\);/);
    expect(appCss).toContain("top: calc(200% + 8px);");
    expect(appCss).toContain("overflow: visible;");
    expect(appCss).not.toContain("animation: cd-tooltip-auto-hide");
    expect(appCss).not.toContain("transition-delay: 450ms;");
    expect(appCss).toContain("white-space: normal;");
    expect(appCss).toContain("overflow-wrap: anywhere;");
    expect(appCss).toContain('.icon-button[data-command-id="structure.cleanup2d"] .tool-icon-image');
    expect(toolPaletteSource).toContain("const TOOLTIP_DELAY_MS = 500");
    expect(toolPaletteSource).toContain("pendingTooltipIdRef.current === tooltipId");
    expect(toolPaletteSource).toContain("onClickCapture={() => onTooltipLeave?.()}");
    expect(toolPaletteSource).not.toContain("onMouseEnter={() => onTooltipEnter?.()}");
    expect(toolPaletteSource).not.toContain("onMouseLeave={() => onTooltipLeave?.()}");
    expect(toolPaletteSource).not.toContain("setTimeout(clearVisibleTooltip, 3200)");
  });

  it("keeps functional metadata on asset-backed palette commands", () => {
    const assetCommands = paletteGroups.flat().filter((command) => command.assetName);
    const eyedropperCommand = getToolsetCommandSpecs().find((command) => command.id === "tool.art.eyedropper");
    const measureCommand = getToolsetCommandSpecs().find((command) => command.id === "tool.art.measure");

    expect(assetCommands.length).toBeGreaterThanOrEqual(50);
    expect(assetCommands.every((command) => command.category)).toBe(true);
    expect(assetCommands.some((command) => command.description?.includes("toolset action"))).toBe(false);
    expect(eyedropperCommand).toMatchObject({
      id: "tool.art.eyedropper",
      title: "Eyedropper",
      assetName: "Art_Eyedropper",
      category: "art"
    });
    expect(measureCommand).toMatchObject({
      id: "tool.art.measure",
      title: "Tape Measure",
      assetName: "Art_Tape_Measure",
      category: "art"
    });
    expect(assetCommands.find((command) => command.assetName === "Custom_Bond_Wedge")).toMatchObject({
      id: "tool.wedgeBond",
      title: "Solid Wedge Bond",
      category: "structure"
    });
    expect(assetCommands.find((command) => command.assetName === "Custom_Structure_Cleanup")).toMatchObject({
      id: structureCleanupCommandId,
      title: "Clean up Structure 2D",
      shortcut: "Shift+Cmd+K",
      shortcutLabel: "⇧⌘K",
      category: "structure"
    });
    expect(assetCommands.find((command) => command.id === structureSpin3dCommandId)).toMatchObject({
      id: structureSpin3dCommandId,
      title: "Spin 3D",
      assetName: "Custom_Spin_3D",
      category: "structure"
    });
    // Interactive 3D Workspace is asset-less now (title-generated "3D" monogram), so it isn't among
    // the asset-backed commands.
    expect(assetCommands.find((command) => command.id === structureInteractive3dCommandId)).toBeUndefined();
    expect(assetCommands.find((command) => command.id === structureCleanup3dCommandId)).toMatchObject({
      id: structureCleanup3dCommandId,
      title: "3D Cleanup",
      assetName: "Custom_Structure_Cleanup_3D",
      category: "structure"
    });
    expect(assetCommands.find((command) => command.id === structureRotate3dCommandId)).toBeUndefined();
  });

  it("places cleanup in the main toolbar chrome cluster instead of a vague disabled options button", () => {
    // The Main toolbar is one flattened group now; the chrome cluster is its tail segment (after the
    // last divider), so assert its contiguous order at the end instead of indexing a per-section group.
    const mainCommandIds = getToolsetCommandGroups("core.main")[0].map((command) => command.id);
    const chromeCluster = [
      "style.color",
      "tool.settings",
      structureCleanupCommandId,
      structureSpin3dCommandId,
      structureInteractive3dCommandId,
      structureCleanup3dCommandId,
      "tool.templateGrid"
    ];

    expect(mainCommandIds.slice(-chromeCluster.length)).toEqual(chromeCluster);
    expect(mainCommandIds).not.toContain("tool.toolOptions");
    expect(mainCommandIds.filter((id) => id === structureCleanupCommandId)).toHaveLength(1);
    expect(mainCommandIds.filter((id) => id === structureInteractive3dCommandId)).toHaveLength(1);
    expect(mainCommandIds.filter((id) => id === structureCleanup3dCommandId)).toHaveLength(1);
    expect(mainCommandIds.filter((id) => id === structureRotate3dCommandId)).toHaveLength(0);
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
    expect(PALETTE_COMMAND_PREVIEW_EVENT).toBe("chemdraft://palette-command-preview");
    expect(PALETTE_COMMAND_COMMIT_EVENT).toBe("chemdraft://palette-command-commit");
    expect(PALETTE_COMMAND_CANCEL_EVENT).toBe("chemdraft://palette-command-cancel");
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
    expect(markup).not.toContain('data-selection-rotate-handle="true"');
    expect(markup).not.toContain('data-rotate-icon="double-headed"');
    expect(markup).not.toContain('data-rotate-readout="true"');
    expect(markup).not.toContain('data-selection-tilt3d-handle="true"');
    expect(markup).not.toContain('data-tilt3d-icon="circular-arrow"');
    expect(markup).not.toContain('data-tilt3d-readout="true"');
    expect(markup.match(/data-object-resize-corner=/g) ?? []).toHaveLength(4);
    expect(markup).toContain('data-object-resize-corner="top-left"');
    expect(markup).toContain('data-object-resize-corner="top-right"');
    expect(markup).toContain('data-object-resize-corner="bottom-left"');
    expect(markup).toContain('data-object-resize-corner="bottom-right"');
    expect(markup).not.toContain('data-object-resize-readout="true"');
    expect(markup).not.toContain("data-text-resize-edge");
    expect(markup).not.toContain("Rotate selected molecule");
    expect(markup).not.toContain("3D rotate selected molecule");
    expect(markup).toContain("native-bond-hit-target");
    expect(markup).toContain("native-atom-hit-target");
    expect(markup).toContain("Molecule C2H6");
    expect(markup).not.toContain("adapter-backed");
  });

  it("renders selected native art with generic object transform controls", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Art Render"),
      { x: 220, y: 180 },
      "tool.art.roundedRectShadow"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("graphic-object");
    expect(markup).not.toContain("art-transform-qa-panel");
    expect(markup).toContain('data-graphic-kind="rect"');
    expect(markup).not.toContain('data-object-type="graphic"');
    expect(markup).not.toContain("art-object-content");
    expect(markup).not.toContain("graphic-object selected");
    expect(markup).toContain('id="graphic-effects-');
    expect(markup).toContain('filterUnits="userSpaceOnUse"');
    expect(markup).not.toContain('x="-40%"');
    expect(markup).toContain("feOffset");
    expect(markup).toContain('data-graphic-effect-source="true"');
    expect(markup).toContain('filter="url(#graphic-effects-');
    expect(markup).toContain('rx="7"');
    expect(markup).toContain('data-graphic-corner-radius-handle="true"');
    expect(markup).toContain('data-graphic-corner-radius-readout="true"');
    expect(markup).toContain('data-graphic-interaction-mode="corner-radius-edit"');
    expect(markup).toContain("Radius: 7 px");
    expect(markup).toContain('data-art-transform-frame="true"');
    expect(markup).toContain('data-has-tilt3d="true"');
    expect(markup).not.toContain("art-object-transform-frame");
    expect(markup).toContain("object-resize-handle");
    expect(markup).toContain('data-object-resize-corner="top-left"');
    expect(markup).not.toContain("object-rotate-handle");
    expect(markup).not.toContain("object-tilt3d-handle");
    expect(markup).not.toContain("art-object-tilt-handle");
    expect(markup).not.toContain("native-molecule-transform-frame");
    expect(markup).not.toContain("molecule-resize-handle");

    const glowLineDocument = insertNativeArtGraphicObject(
      createPhase4Document("Art Glow Line Render"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const glowLineObjectId = glowLineDocument.selection.objectIds[0] ?? "";
    const glowLineWithEffect = applyPatches(glowLineDocument, [{
      op: "updateObject",
      objectId: glowLineObjectId,
      changes: {
        style: {
          effects: [{ kind: "glow", color: "#fdd835", opacity: 0.65, blurPx: 8, spreadPx: 2 }]
        }
      }
    }]);
    const glowLineMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: glowLineWithEffect,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(glowLineMarkup).toContain('filterUnits="userSpaceOnUse"');
    expect(glowLineMarkup).toContain('y="-38"');
    expect(glowLineMarkup).toContain('flood-color="#fdd835"');

    const radiusReadoutRotated = applyPatches(document, [{
      op: "updateObject",
      objectId,
      changes: { rotation: 37 }
    }]);
    const radiusReadoutRotatedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: radiusReadoutRotated,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(radiusReadoutRotatedMarkup).toContain('data-graphic-corner-radius-readout="true"');
    expect(radiusReadoutRotatedMarkup).toContain("rotate(-37deg)");

    const noFillRectDocument = insertNativeArtGraphicObject(
      createPhase4Document("No Fill Rect Hit Render"),
      { x: 220, y: 180 },
      "tool.art.roundedRect"
    );
    const noFillRectMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: noFillRectDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(noFillRectMarkup).toContain('data-graphic-kind="rect"');
    expect(noFillRectMarkup).toContain("graphic-glyph-hit-target");
    expect(noFillRectMarkup).toContain('data-graphic-hit-fill="true"');
    expect(noFillRectMarkup).toContain('fill="transparent"');
    expect(noFillRectMarkup).toContain('pointer-events="all"');

    const transparentFillRectDocument = applyGraphicObjectOpacityToSelection(
      applyGraphicObjectColorToSelection(noFillRectDocument, "fill", "#1d7f68"),
      "fillOpacity",
      0
    );
    const transparentFillRectMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: transparentFillRectDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(transparentFillRectMarkup).toContain('fill="#1d7f68"');
    expect(transparentFillRectMarkup).toContain('fill-opacity="0"');
    expect(transparentFillRectMarkup).toContain('data-graphic-hit-fill="true"');
    expect(transparentFillRectMarkup).toContain('pointer-events="all"');

    const lineDocument = insertNativeArtGraphicObject(
      createPhase4Document("Line Art Render"),
      { x: 260, y: 220 },
      "tool.art.line"
    );
    const lineMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: lineDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(lineMarkup).toContain('data-graphic-kind="path"');
    expect(lineMarkup).toContain('data-graphic-interaction-mode="path-edit"');
    expect(lineMarkup).toContain('data-graphic-path-handle="start"');
    expect(lineMarkup).toContain('data-graphic-path-handle="middle"');
    expect(lineMarkup).toContain('data-graphic-path-handle="end"');
    expect(lineMarkup).toContain("graphic-glyph-hit-target");
    expect(lineMarkup).toContain('pointer-events="stroke"');
    expect(lineMarkup).not.toContain('data-graphic-hit-fill="true"');
    expect(lineMarkup).not.toContain('data-graphic-corner-radius-handle="true"');
    expect(lineMarkup).not.toContain('data-art-transform-frame="true"');
    expect(lineMarkup).not.toContain("object-resize-handle");

    const pencilDocument = nativeFreehandStrokeDocument(
      createPhase4Document("Pencil Hit Render"),
      [
        { x: 220, y: 210, pressure: 0.4 },
        { x: 250, y: 230, pressure: 0.7 },
        { x: 285, y: 218, pressure: 0.5 }
      ],
      "tool.art.pencil"
    );
    const pencilMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: pencilDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(pencilMarkup).toContain("graphic-glyph-hit-target");
    expect(pencilMarkup).toContain('data-graphic-hit-fill="true"');

    const arrowDocument = insertNativeArtGraphicObject(
      createPhase4Document("Arrow Art Render"),
      { x: 260, y: 220 },
      "tool.art.arrow"
    );
    const arrowObjectId = arrowDocument.selection.objectIds[0] ?? "";
    const arrowMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: arrowDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(arrowMarkup).toContain(`id="graphic-marker-end-${arrowObjectId}"`);
    expect(arrowMarkup).toContain('data-graphic-marker="end"');
    expect(arrowMarkup).not.toContain("data-graphic-marker-connector");
    expect(arrowMarkup).not.toContain(`marker-end="url(#graphic-marker-end-${arrowObjectId})"`);
    expect(arrowMarkup).not.toContain('markerUnits="userSpaceOnUse"');
    const ellipseDocument = insertNativeArtGraphicObject(
      createPhase4Document("Ellipse Art Render"),
      { x: 260, y: 220 },
      "tool.art.circle"
    );
    const ellipseMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: ellipseDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(ellipseMarkup).toContain('data-graphic-kind="ellipse"');
    expect(ellipseMarkup).not.toContain('data-graphic-corner-radius-handle="true"');
    expect(mainWindowSource).toContain("const svgObjects = plannedDisplayPage.objects.filter((object) => editorPageSvgSurfaceIncludesObject(object))");
    expect(mainWindowSource).toContain('return object.type !== "molecule" || !isNativeMoleculeGraph(object);');
    expect(mainWindowSource).toContain('planNativeArtVisual(object, { coordinateSpace: "local" })');
    expect(mainWindowSource).toContain("left: pageScaledCssPx(plan.frameBounds.x)");
    expect(mainWindowSource).toContain('data-graphic-corner-radius-handle="true"');
    expect(mainWindowSource).toContain('setActiveGraphicTransformObjectId(objectId)');
    expect(mainWindowSource).not.toContain("setActiveArtPaintTarget(currentArtStyle.activePaintTarget)");
    expect(mainWindowSource).not.toContain("function graphicPathD(object: GraphicObject");
    expect(mainWindowSource).not.toContain("function documentObjectProjectedEllipseBounds");

    const rotated = applyPatch(document, {
      op: "updateObject",
      objectId: document.selection.objectIds[0] ?? "",
      changes: { rotation: 45 }
    });
    const rotatedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: rotated,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(rotatedMarkup).toMatch(/class="graphic-visual-shell"[^>]*data-art-z-rotation="45"[^>]*style="transform:rotate\(45deg\)"/);
    expect(rotatedMarkup).not.toMatch(/class="document-object document-object-overlay graphic-object"[^>]*transform:rotate\(45deg\)/);
    expect(rotatedMarkup).not.toContain("graphic-glyph-projected-shape");
    expect(rotatedMarkup).toContain("graphic-glyph-shape");
    expect(rotatedMarkup).not.toContain('data-object-type="graphic"');

    const sphere = insertNativeArtGraphicObject(
      createPhase4Document("Sphere Rotation"),
      { x: 160, y: 160 },
      "tool.art.circleGloss"
    );
    const rotatedSphere = applyPatch(sphere, {
      op: "updateObject",
      objectId: sphere.selection.objectIds[0] ?? "",
      changes: { rotation: 45 }
    });
    const rotatedSphereMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: rotatedSphere,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(rotatedSphereMarkup).not.toContain("graphic-glyph-projected-shape");
    expect(rotatedSphereMarkup).toMatch(/class="graphic-visual-shell"[^>]*data-art-z-rotation="45"[^>]*style="transform:rotate\(45deg\)"/);
    expect(rotatedSphereMarkup).not.toMatch(/class="document-object document-object-overlay graphic-object"[^>]*transform:rotate\(45deg\)/);
    expect(rotatedSphereMarkup).toContain(
      "left:calc(0px * var(--page-scale));top:calc(0px * var(--page-scale));width:calc(48px * var(--page-scale));height:calc(48px * var(--page-scale))"
    );
    expect(rotatedSphereMarkup).toContain('gradientUnits="userSpaceOnUse"');
    expect(rotatedSphereMarkup).not.toContain('gradientTransform="matrix(');
    expect(rotatedSphereMarkup).not.toContain('cx="34%"');
    expect(rotatedSphereMarkup).not.toContain('cy="28%"');
    expect(rotatedSphereMarkup).not.toContain("66.423");

    const tilted = applyDocumentObjectProjectedPlaneTilt(document, document.selection.objectIds[0] ?? "", 35, -20);
    const tiltedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: tilted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    expect(tiltedMarkup).toContain("graphic-glyph-projected-shape");
    expect(tiltedMarkup).not.toContain("graphic-glyph-shape");
    expect(tiltedMarkup).not.toContain("graphic-glyph-transform");
    expect(tiltedMarkup).not.toContain("perspective(");
    expect(appCss).toContain(".graphic-glyph-transform .graphic-glyph-stroke");
    expect(appCss).toContain("vector-effect: none;");
  });

  it("keeps graphic path handle edits immediate and rollback-free", () => {
    expect(mainWindowSource).toContain("const GRAPHIC_HANDLE_DRAG_THRESHOLD = 1");
    expect(mainWindowSource).toContain("workingDocument: selectedDocument");
    expect(mainWindowSource).toContain("drag.workingDocument");
    expect(mainWindowSource).toContain("drag.workingDocument = nextDocument");
    expect(mainWindowSource).not.toMatch(/clientPointDistance\(graphicPathEditDrag\.startPoint,\s*point\)\s*>=\s*OBJECT_DRAG_THRESHOLD/);
    expect(mainWindowSource).not.toMatch(/else\s*{\s*replacePresentDocument\(graphicPathEditDrag\.startDocument\);/);
  });

  it("renders native art paint plans in the editor glyph", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Art Paint Render"),
      { x: 220, y: 180 },
      "tool.art.roundedRect"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    const painted = applyPatches(document, [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          opacity: 0.75,
          fillPaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 1,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1648ff", opacity: 0.5 }
            ]
          },
          strokePaint: {
            kind: "solid",
            color: "#1d7",
            opacity: 0.65
          },
          strokeWidth: 5,
          strokeLineCap: "square",
          strokeLineJoin: "bevel",
          strokeMiterLimit: 7
        }
      }
    }]);

    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: painted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain(`id="graphic-fill-${objectId}"`);
    expect(markup).toContain(`fill="url(#graphic-fill-${objectId})"`);
    expect(markup).toContain('stroke="#11dd77"');
    expect(markup).toContain('stroke-opacity="0.65"');
    expect(markup).toContain('stroke-width="5"');
    expect(markup).toContain('stroke-linecap="square"');
    expect(markup).toContain('stroke-linejoin="bevel"');
    expect(markup).toContain('stroke-miterlimit="7"');
    expect(markup).toContain('opacity="0.75"');
    expect(markup).toContain('gradientUnits="userSpaceOnUse"');
    expect(markup).toContain('stop-color="#1648ff"');
    expect(markup).toContain('stop-opacity="0.5"');
    expect(markup).toContain('data-graphic-gradient-control-layer="fill"');
    expect(markup).toContain('data-graphic-gradient-control-line="fill"');
    expect(markup).toContain('data-graphic-gradient-target="fill"');
    expect(markup).toContain('data-graphic-gradient-handle="start"');
    expect(markup).toContain('data-graphic-gradient-handle="end"');
    expect(markup).toContain('data-graphic-interaction-mode="gradient-edit"');
    expect(markup).not.toContain('data-art-transform-frame="true"');
    expect(markup).not.toContain('id="graphic-gloss-');
  });

  it("renders radial gradient direct-edit handles without art transform chrome", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Radial Gradient Handles"),
      { x: 220, y: 180 },
      "tool.art.roundedRect"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    const painted = applyPatches(document, [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          fillColor: "#1d7f68",
          fillMode: "solid",
          fillPaint: {
            kind: "radial-gradient",
            units: "object",
            cx: 0.45,
            cy: 0.55,
            r: 0.5,
            fx: 0.25,
            fy: 0.3,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1d7f68" }
            ]
          }
        }
      }
    }]);

    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: painted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-graphic-gradient-control-layer="fill"');
    expect(markup).toContain('data-graphic-gradient-radius-ring="fill"');
    expect(markup).toContain('data-graphic-gradient-radius-line="fill"');
    expect(markup).toContain('data-graphic-gradient-focus-line="fill"');
    expect(markup).toContain('data-graphic-gradient-handle="center"');
    expect(markup).toContain('data-graphic-gradient-handle="radius"');
    expect(markup).toContain('data-graphic-gradient-handle="focus"');
    expect(markup).toContain('data-graphic-interaction-mode="gradient-edit"');
    expect(markup).not.toContain('data-art-transform-frame="true"');
  });

  it("renders molecule fill gradient handles instead of molecule transform chrome", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Molecule Gradient Handles"),
      { x: 300, y: 300 },
      "benzene"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    const painted = applyPatches(document, [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          fillColor: "#1d7f68",
          fillMode: "solid",
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
          }
        }
      }
    }]);

    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: painted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-graphic-gradient-control-layer="fill"');
    expect(markup).toContain('data-graphic-gradient-control-line="fill"');
    expect(markup).toContain('data-graphic-gradient-target="fill"');
    expect(markup).toContain('data-graphic-gradient-handle="start"');
    expect(markup).toContain('data-graphic-gradient-handle="end"');
    expect(markup).toContain('data-graphic-interaction-mode="gradient-edit"');
    expect(markup).not.toContain('data-molecule-transform-frame=');
  });

  it("renders gradient handles for closed complex path graphics instead of path-node chrome", () => {
    const document = nativePolylinePathDocument(
      createPhase4Document("Complex Path Gradient Handles"),
      [
        { x: 260, y: 230 },
        { x: 420, y: 360 },
        { x: 260, y: 350 },
        { x: 410, y: 215 },
        { x: 340, y: 420 }
      ],
      "tool.art.polyline",
      { closed: true }
    );
    const objectId = document.selection.objectIds[0] ?? "";
    const painted = applyPatches(document, [{
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
              { offset: 0, color: "#c86d6d" },
              { offset: 1, color: "#f3d7d7" }
            ]
          },
          strokePaint: { kind: "solid", color: "#111111", opacity: 1 }
        }
      }
    }]);

    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: painted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain(`fill="url(#graphic-fill-${objectId})"`);
    expect(markup).toContain('data-graphic-gradient-control-layer="fill"');
    expect(markup).toContain('data-graphic-gradient-control-line="fill"');
    expect(markup).toContain('data-graphic-gradient-handle="start"');
    expect(markup).toContain('data-graphic-gradient-handle="end"');
    expect(markup).toContain('data-graphic-interaction-mode="gradient-edit"');
    expect(markup).not.toContain('data-graphic-interaction-mode="path-edit"');
    expect(markup).not.toContain('data-graphic-path-node-index=');
    expect(markup).not.toContain('data-art-transform-frame="true"');
  });

  it("preserves gradient paints in native art drag preview proxies", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Art Gradient Drag Preview"),
      { x: 220, y: 180 },
      "tool.art.roundedRect"
    );
    const objectId = document.selection.objectIds[0] ?? "";
    const painted = applyPatches(document, [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          fillPaint: {
            kind: "radial-gradient",
            units: "object",
            cx: 0.5,
            cy: 0.5,
            r: 0.72,
            fx: 0.25,
            fy: 0.2,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1d7f68" }
            ]
          },
          strokePaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 0,
            stops: [
              { offset: 0, color: "#1648ff" },
              { offset: 1, color: "#d12b2b", opacity: 0.5 }
            ]
          },
          strokeWidth: 5
        }
      }
    }]);
    const object = painted.pages[0].objects.find((candidate): candidate is GraphicObject =>
      candidate.type === "graphic" && candidate.id === objectId
    );
    if (!object) {
      throw new Error("Expected gradient art object.");
    }

    const preview = graphicArtTransformPreviewSvgDataUrl(object);
    expect(preview).toBeDefined();
    const previewSvg = decodeURIComponent(preview?.imageUrl.split(",", 2)[1] ?? "");
    expect(previewSvg).toContain(`<radialGradient id="preview-fill-${objectId}"`);
    expect(previewSvg).toContain(`<linearGradient id="preview-stroke-${objectId}"`);
    expect(previewSvg).toContain(`fill="url(#preview-fill-${objectId})"`);
    expect(previewSvg).toContain(`stroke="url(#preview-stroke-${objectId})"`);
    expect(previewSvg).toContain('stop-color="#1d7f68"');
    expect(previewSvg).toContain('stop-color="#d12b2b"');
    expect(previewSvg).toContain('stop-opacity="0.5"');

    const glossDocument = insertNativeArtGraphicObject(
      createPhase4Document("Art Gloss Drag Preview"),
      { x: 220, y: 180 },
      "tool.art.roundedRectGloss"
    );
    const glossObject = glossDocument.pages[0].objects.find((candidate): candidate is GraphicObject =>
      candidate.type === "graphic" && candidate.id === (glossDocument.selection.objectIds[0] ?? "")
    );
    if (!glossObject) {
      throw new Error("Expected gloss art object.");
    }

    const glossPreview = graphicArtTransformPreviewSvgDataUrl(glossObject);
    expect(glossPreview).toBeDefined();
    const glossPreviewSvg = decodeURIComponent(glossPreview?.imageUrl.split(",", 2)[1] ?? "");
    expect(glossPreviewSvg).toContain(`<radialGradient id="preview-gloss-${glossObject.id}"`);
    expect(glossPreviewSvg).toContain(`fill="url(#preview-gloss-${glossObject.id})"`);
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
    expect(markup).not.toContain('data-selection-tilt3d-handle="true"');
    expect(markup).not.toContain("data-object-resize-corner");
  });

  it("keeps lasso selected objects highlighted with resize chrome as privileged targets", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Lasso Tool Selection Chrome"), { x: 200, y: 220 });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialActiveToolCommandId: "tool.lasso",
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-active-tool="tool.lasso"');
    expect(markup).toContain('data-active-tool-kind="selection"');
    expect(markup).toContain("native-molecule-selection-blob");
    expect(markup).toContain('data-whole-molecule-selection="true"');
    expect(markup).not.toContain('data-selection-rotate-handle="true"');
    expect(markup).not.toContain('data-selection-tilt3d-handle="true"');
    expect(markup.match(/data-object-resize-corner=/g) ?? []).toHaveLength(4);
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
    // The label's paper knockout is now a paint-order stroke on the label group (not a separate
    // background rect); the selection highlight must still paint above that group so it reads.
    const labelGroupIndex = markup.indexOf('class="native-atom-label"');
    const selectionBlobIndex = markup.indexOf("native-molecule-selection-blob");
    const labelTextIndex = markup.indexOf('data-atom-label="OH"');

    expect(markup).toContain('data-atom-label="OH"');
    expect(markup).toContain('data-selected-atom-id="atom_002"');
    expect(labelGroupIndex).toBeGreaterThan(-1);
    expect(selectionBlobIndex).toBeGreaterThan(labelGroupIndex);
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
    expect(markup).not.toContain('data-selection-tilt3d-handle="true"');
    expect(markup).not.toContain("data-molecule-transform-frame");
    expect(markup).not.toContain("data-object-resize-corner");
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

  it("renders selected text objects with resize handles while rotate is Shift-gated", () => {
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
    expect(markup).not.toContain('aria-label="Rotate selected text box"');
    expect(markup).not.toContain('data-selection-rotate-handle="true"');
    expect(markup).not.toContain('data-rotate-icon="double-headed"');
    expect(markup).not.toContain('data-selection-tilt3d-handle="true"');
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
    expect(markup).toContain("native-molecule-ring-hit-target");
    expect(markup).toContain('data-ring-hit-key="');
    const ringHitIndex = markup.indexOf("native-molecule-ring-hit-target");
    expect(markup.indexOf("native-bond-hit-target", ringHitIndex)).toBeGreaterThan(ringHitIndex);
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
    // Heteroatom labels carry a glyph-hugging paper knockout (paint-order stroke) in place of the
    // old opaque background rect.
    expect(markup).toContain('paint-order="stroke"');
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

  it("routes Delete through EVERY selected native molecule part before whole-object deletion", () => {
    // Phase 7: Delete removes all selected parts across molecules, not just the primary slot,
    // by folding the part-delete over every selected target.
    expect(mainWindowSource).toContain("for (const deleteTarget of selectedDeleteTargets)");
    expect(mainWindowSource).toContain("applyNativeMoleculePartDeleteTarget(nextDocument, deleteTarget)");
    // A lasso fragment or a genuine multi-molecule selection takes precedence over a hovered
    // atom/bond; a lone atom/bond part still defers to the hovered target.
    expect(mainWindowSource.indexOf("const selectionTakesPrecedence = selectedDeleteTargets.length > 1"))
      .toBeLessThan(mainWindowSource.indexOf("const target = selectionTakesPrecedence ? undefined : hoveredNativeDeleteTargetRef.current"));
    expect(mainWindowSource).toContain("Deleted selected molecule fragment");
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

  it("selects a native molecule ring from an interior point", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document("Ring Interior Hit"), { x: 300, y: 300 }, "benzene");
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected native molecule fixture.");
    }

    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected benzene ring.");
    }

    expect(nativeMoleculeRingSelectionFromPoint(molecule, ring.center)).toEqual({
      objectId: molecule.id,
      kind: "ring",
      ringKey: ring.ringKey,
      atomIds: ring.atomIds,
      bondIds: ring.bondIds
    });
    expect(nativeMoleculeRingSelectionFromPoint(molecule, {
      x: molecule.x + molecule.width + 16,
      y: molecule.y + molecule.height + 16
    })).toBeUndefined();
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

  it("renders a renamed visible CDXML file as the same horizontal seven-carbon structure", () => {
    const opened = openNativeDocument(sevenCarbonVisibleCdxml);
    if (!opened.document) {
      throw new Error(`Expected visible CDXML import, got warnings: ${opened.warnings.map((item) => item.code).join(", ")}`);
    }
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: opened.document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const firstBondMarkup =
      markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_001"[^>]*>/)?.[0] ?? "";
    const branchBondMarkup =
      markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_006"[^>]*>/)?.[0] ?? "";

    expect(opened.source).toBe("external-cdxml");
    expect(markup).toContain('data-atom-count="7"');
    expect(markup).toContain('data-bond-count="6"');
    expect((markup.match(/native-bond-line/g) ?? []).length).toBe(6);
    expect(svgLineNumberAttribute(firstBondMarkup, "x1")).toBeCloseTo(174.5);
    expect(svgLineNumberAttribute(firstBondMarkup, "y1")).toBeCloseTo(210.20706666666667);
    expect(svgLineNumberAttribute(firstBondMarkup, "x2")).toBeCloseTo(196.5);
    expect(svgLineNumberAttribute(firstBondMarkup, "y2")).toBeCloseTo(210.20706666666667);
    expect(svgLineNumberAttribute(branchBondMarkup, "x2")).toBeLessThan(svgLineNumberAttribute(branchBondMarkup, "x1"));
    expect(svgLineNumberAttribute(branchBondMarkup, "y2")).toBeGreaterThan(svgLineNumberAttribute(branchBondMarkup, "y1"));
  });

  it("renders the BactVue visible CDXML subset with text, molecules, and explicit compatibility fallbacks", () => {
    const opened = openNativeDocument(readFileSync("packages/fixtures/cdxml/bactvue-visible-subset.cdxml", "utf8"));
    if (!opened.document) {
      throw new Error(`Expected BactVue visible CDXML import, got warnings: ${opened.warnings.map((item) => item.code).join(", ")}`);
    }
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: opened.document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(opened.source).toBe("external-cdxml");
    expect(opened.document.pages[0].objects
      .filter((object): object is MoleculeObject => object.type === "molecule")
      .map((object) => object.atoms.length)
    ).toEqual([5, 2, 2]);
    expect(opened.document.pages[0].objects
      .filter((object): object is MoleculeObject => object.type === "molecule")
      .map((object) => object.bonds.length)
    ).toEqual([4, 1, 1]);
    expect(markup).toContain("DIPEA, DMSO");
    expect(markup).toContain("reaction-arrow-object");
    expect(markup).toContain('data-arrow-kind="unknown"');
    expect(markup).toContain("reaction-arrow-line");
    expect(markup).toContain("graphic-object");
    expect(markup).toContain('data-graphic-kind="unknown"');
    expect(markup).toContain("generic-object");
    expect(markup).toContain('data-atom-count="5"');
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

  it("renders native molecule visuals in the same object layer stack as art graphics", () => {
    const withMolecule = insertNativeSingleBondMolecule(createPhase4Document("Mixed Art Molecule Layers"), { x: 220, y: 240 });
    const moleculeId = withMolecule.selection.objectIds[0] ?? "";
    const withRect = insertNativeArtGraphicObject(withMolecule, { x: 220, y: 240 }, "tool.art.rect");
    const rectId = withRect.selection.objectIds[0] ?? "";
    const sentBack = reorderSelectedDocumentObject(withRect, "back");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: sentBack,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const pageSvgStart = markup.indexOf('data-page-svg-surface="true"');
    const rectOverlayIndex = markup.indexOf(`data-object-id="${rectId}" data-layer-index="0" data-graphic-kind="rect"`);
    const moleculeOverlayIndex = markup.indexOf(`data-object-id="${moleculeId}" data-layer-index="1" data-structure="CC"`);
    const moleculeVisualIndex = markup.indexOf('data-native-molecule-overlay-visual="true"', moleculeOverlayIndex);
    const moleculeBondIndex = markup.indexOf('class="native-bond-line native-bond-single"', moleculeVisualIndex);

    expect(sentBack.pages[0].objects.map((object) => object.id)).toEqual([rectId, moleculeId]);
    expect(pageSvgStart).toBeGreaterThan(-1);
    expect(rectOverlayIndex).toBeGreaterThan(-1);
    expect(moleculeOverlayIndex).toBeGreaterThan(-1);
    expect(markup.slice(pageSvgStart, rectOverlayIndex)).not.toContain(`data-object-id="${moleculeId}"`);
    expect(rectOverlayIndex).toBeLessThan(moleculeOverlayIndex);
    expect(moleculeVisualIndex).toBeGreaterThan(moleculeOverlayIndex);
    expect(moleculeBondIndex).toBeGreaterThan(moleculeVisualIndex);
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

  it("right-click over a selected bond's endpoint atom preserves the multi-part selection", () => {
    // The selection blob draws a selected bond's endpoint atoms as selected, so right-clicking
    // such an atom (the hit-test is atom-first) must NOT collapse a multi-part selection down to
    // that single atom. A genuinely unrelated atom still replaces the selection.
    const document = insertNativeTemplateMolecule(createPhase4Document("Endpoint Right Click"), { x: 300, y: 300 }, "benzene");
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const bond = molecule.bonds[0];
    const partsSelection = {
      objectId: molecule.id,
      kind: "parts" as const,
      atomIds: [] as string[],
      bondIds: [bond.id]
    };
    const unrelatedAtom = molecule.atoms.find(
      (atom) => atom.id !== bond.fromAtomId && atom.id !== bond.toAtomId
    );
    if (!unrelatedAtom) {
      throw new Error("expected a non-endpoint atom in the benzene fixture");
    }

    // Endpoint atom of the selected bond → multi-part selection preserved.
    expect(nativeContextMenuSelectionResolutionFromHit(
      document,
      molecule.id,
      { kind: "atom", atomId: bond.fromAtomId, distanceToPointer: 0 },
      partsSelection
    )).toEqual({ selectedPart: partsSelection, targetKind: "parts" });

    // Unrelated atom → selection collapses to that atom (strict, unchanged behavior).
    expect(nativeContextMenuSelectionResolutionFromHit(
      document,
      molecule.id,
      { kind: "atom", atomId: unrelatedAtom.id, distanceToPointer: 0 },
      partsSelection
    )).toEqual({
      selectedPart: { objectId: molecule.id, kind: "atom", atomId: unrelatedAtom.id },
      targetKind: "atom"
    });
  });

  it("dragging from a selected bond's endpoint atom targets the whole selected fragment", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document("Endpoint Drag"), { x: 300, y: 300 }, "benzene");
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const bond = molecule.bonds[0];
    const partsSelection = {
      objectId: molecule.id,
      kind: "parts" as const,
      atomIds: [] as string[],
      bondIds: [bond.id]
    };

    expect(nativeMoleculeSelectionDragIntent(
      document,
      molecule.id,
      partsSelection,
      { kind: "atom", atomId: bond.fromAtomId, distanceToPointer: 0 }
    )).toEqual({ kind: "native-part", target: partsSelection });
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

    const atomDocument = insertNativeSingleBondMolecule(createPhase4Document("Atom Depth Refs"), { x: 200, y: 220 });
    const atomMolecule = atomDocument.pages[0].objects[0] as MoleculeObject;
    expect(bondDepthRefsFromNativeSelection({
      objectId: atomMolecule.id,
      kind: "atom",
      atomId: "atom_001"
    }, atomDocument)).toEqual([{ objectId: atomMolecule.id, bondId: "bond_001" }]);
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

  it("routes layer commands on selected molecule parts to bond depth instead of object order", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Part Layer Command"), { x: 180, y: 180 });
    const document = insertNativeSingleBondMolecule(first, { x: 180, y: 180 });
    const horizontal = document.pages[0].objects[0] as MoleculeObject;
    const vertical = document.pages[0].objects[1] as MoleculeObject;
    const crossingDocument = applyPatch(document, {
      op: "updateObject",
      objectId: vertical.id,
      changes: {
        x: 158,
        y: 138,
        width: 44,
        height: 84,
        atoms: [
          { ...vertical.atoms[0], x: 180, y: 140 },
          { ...vertical.atoms[1], x: 180, y: 220 }
        ]
      }
    });
    const originalOrder = crossingDocument.pages[0].objects.map((object) => object.id);
    const bondSelection = {
      objectId: vertical.id,
      kind: "bond" as const,
      bondId: "bond_001"
    };
    const atomSelection = {
      objectId: vertical.id,
      kind: "atom" as const,
      atomId: "atom_001"
    };

    const bondResult = applyLayerCommandToDocumentSelection(crossingDocument, "layout.sendToBack", {
      selectedNativeMoleculePart: bondSelection
    });
    const atomResult = applyLayerCommandToDocumentSelection(crossingDocument, "layout.sendBackward", {
      selectedNativeMoleculePart: atomSelection
    });

    expect(bondResult.bondDepthCommandId).toBe("bondDepth.sendBehind");
    expect(atomResult.bondDepthCommandId).toBe("bondDepth.sendBehind");
    expect(bondResult.document.pages[0].objects.map((object) => object.id)).toEqual(originalOrder);
    expect(atomResult.document.pages[0].objects.map((object) => object.id)).toEqual(originalOrder);
    expect(bondResult.bondDepthContext?.targetBondRefs).toEqual([
      { objectId: vertical.id, bondId: "bond_001" }
    ]);
    expect(atomResult.bondDepthContext?.targetBondRefs).toEqual([
      { objectId: vertical.id, bondId: "bond_001" }
    ]);
    expect(bondResult.document.pages[0].crossings).toEqual([{
      bonds: [
        { objectId: horizontal.id, bondId: "bond_001" },
        { objectId: vertical.id, bondId: "bond_001" }
      ],
      front: { objectId: horizontal.id, bondId: "bond_001" }
    }]);
    expect(atomResult.document.pages[0].crossings).toEqual(bondResult.document.pages[0].crossings);
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
});
