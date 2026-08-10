import { createContext, useContext } from "react";
import type { AnalysisReport } from "@chemdraft/analysis-core";
import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import type {
  ToolsetArtPaintTarget,
  ToolsetArtStylePayload,
  ToolsetMoleculeInspectorPayload
} from "../window-manager";
import type { ToolbarPaletteItemModel } from "../toolsets";
// Type-only import: erased at runtime, so this does not create an import cycle with ToolPalette
// (which imports the context *value* from here).
import type { ToolbarPopoverAnchor } from "../ToolPalette";
import type { ToolbarSelectionModel } from "./toolbarSelectionKind";

/**
 * Live state + callbacks a toolbar widget (style controls, ring/molecule inspector) needs to render
 * and route its edits. This mirrors the widget-related props ToolPalette used to fan out by hand:
 * the main window provides it from live document state, PaletteWindow from the broadcast payload.
 * Widgets are declared as manifest `control` items (see {@link toolbarWidgetIdsFromItemGroups}); the
 * renderer looks each one up in its registry rather than reading a hardcoded `show*Controls` boolean.
 */
export interface ToolbarWidgetState {
  currentTextStyle?: NativeTextStyle;
  currentTextScript?: TextSpan["script"];
  currentObjectColor?: string;
  currentArtStyle?: ToolsetArtStylePayload;
  currentArtStyleTarget?: ToolsetArtPaintTarget;
  currentMoleculeInspector?: ToolsetMoleculeInspectorPayload;
  /** What the selection is, for variant-swapping widgets. Absent (older payloads, tests, default
   *  context) reads as "none" — the text layout, i.e. the pre-variant behavior. */
  currentSelection?: ToolbarSelectionModel;
  /** True while the palette is in customize mode. Variant-swapping widgets pin themselves to their
   *  default layout so the user always customizes against the layout they'll see most. */
  customizing?: boolean;
  /** The latest analysis report, for the Molecular Inspector palette. Absent until one has run. */
  currentMolecularInspector?: AnalysisReport;
  /** True while a newer analysis for the same selection is in flight. */
  molecularInspectorBusy?: boolean;
  /** The report no longer describes the current selection. See MolecularInspectorPane. */
  molecularInspectorStale?: boolean;
  onInvoke: (commandId: string) => void;
  onColorPickerOpenChange?: (open: boolean) => void;
  onRequestColorPopover?: (anchor: ToolbarPopoverAnchor) => void;
  onArtStylePreview?: (commandId: string) => void;
  onArtStyleCommit?: (commandId: string) => void;
  onArtStyleCancel?: () => void;
  onMoleculeInspectorPreview?: (commandId: string) => void;
  onMoleculeInspectorCommit?: (commandId: string) => void;
  onMoleculeInspectorCancel?: () => void;
  onMolecularInspectorCopy?: (text: string) => void;
  onMolecularInspectorChangeInterpretation?: (interpretationId: string | undefined) => void;
}

const DEFAULT_TOOLBAR_WIDGET_STATE: ToolbarWidgetState = {
  onInvoke: () => undefined
};

export const ToolbarWidgetStateContext = createContext<ToolbarWidgetState>(DEFAULT_TOOLBAR_WIDGET_STATE);

export function useToolbarWidgetState(): ToolbarWidgetState {
  return useContext(ToolbarWidgetStateContext);
}

/**
 * How a widget occupies the palette relative to the normal tool grid:
 * - `append`: render below the tool grid (main/text style controls).
 * - `replace-grid`: render the widget's own primary content instead of the tool grid (art).
 * - `hide-grid`: hide the tool grid entirely and show only the widget (ring/molecule inspector).
 */
export type ToolbarWidgetGridMode = "append" | "replace-grid" | "hide-grid";

/** Section widgets are declared as `control` items whose `controlId` carries this prefix. This
 *  distinguishes them from inline grid controls (which occupy a grid slot and are sized normally). */
export const WIDGET_CONTROL_ID_PREFIX = "widget.";

/** Canonical widget ids, used both as manifest `controlId`s and registry keys. */
export const TOOLBAR_WIDGET_IDS = {
  mainStyleControls: "widget.core.mainStyleControls",
  textStyleControls: "widget.core.textStyleControls",
  artStyleControls: "widget.core.artStyleControls",
  ringInspector: "widget.core.ringInspector",
  drawnStructureSettings: "widget.core.drawnStructureSettings",
  molecularInspector: "widget.core.molecularInspector"
} as const;

export type ToolbarWidgetId = (typeof TOOLBAR_WIDGET_IDS)[keyof typeof TOOLBAR_WIDGET_IDS];

/** The section-widget ids present in a palette's items, in first-seen order. */
export function toolbarWidgetIdsFromItemGroups(
  itemGroups: readonly (readonly ToolbarPaletteItemModel[])[]
): string[] {
  const ids: string[] = [];
  for (const group of itemGroups) {
    for (const item of group) {
      if (isToolbarWidgetItem(item) && item.primary.type === "control" && !ids.includes(item.primary.controlId)) {
        ids.push(item.primary.controlId);
      }
    }
  }
  return ids;
}

/** True when the item is a section-widget placeholder (a `widget.`-prefixed `control` item) — the
 *  grid renderer skips these, since the widget renders as its own section rather than a grid slot.
 *  Inline `control` items without the prefix stay in the grid and are sized normally. */
export function isToolbarWidgetItem(item: ToolbarPaletteItemModel): boolean {
  return item.primary.type === "control" && item.primary.controlId.startsWith(WIDGET_CONTROL_ID_PREFIX);
}

/** A widget item with declared grid spans (>1×1) is a grid citizen: it occupies colSpan×rowSpan cells
 *  inside the tool grid — freely placeable and reorderable like any icon — instead of rendering as an
 *  appended section pinned to the end of the palette. */
export function isGridWidgetItem(item: ToolbarPaletteItemModel): boolean {
  return isToolbarWidgetItem(item) && (item.layout.colSpan > 1 || item.layout.rowSpan > 1);
}

/** Grid spans for widgets the customize gallery can (re)add as grid citizens, sized in icon cells
 *  (24px + gap) to fit each widget's intrinsic content. Widgets not listed here re-add as appended
 *  sections (legacy behavior). */
export const TOOLBAR_WIDGET_GRID_SPANS: Readonly<Record<string, { colSpan: number; rowSpan: number }>> = {
  [TOOLBAR_WIDGET_IDS.mainStyleControls]: { colSpan: 12, rowSpan: 2 }
};
