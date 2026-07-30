import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import iro from "@jaames/iro";
import { useDraggable } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ToolsetGridLayout } from "@chemdraft/toolset-registry";
import type { CommandSpec } from "./commands";
import {
  ToolbarWidgetStateContext,
  TOOLBAR_WIDGET_IDS,
  isGridWidgetItem,
  isToolbarWidgetItem,
  useToolbarWidgetState,
  type ToolbarWidgetGridMode,
  type ToolbarWidgetState
} from "./toolbars/toolbarWidgets";
import {
  ScriptGlyph,
  TextFontSelect,
  ToolbarAlignButton,
  ToolbarColorSwatchButton,
  ToolbarTextButton,
  closestSizeCommandId,
  defaultFontFaces,
  fontFamilyLabel,
  usePaletteButtonInvoke
} from "./toolbars/toolbarCells";
import {
  normalizeHexColor,
  distributeModeCommandIds,
  objectFillOpacityCommandId,
  objectOpacityCommandId,
  objectColorCommands,
  objectCustomColorCommandId,
  objectGradientAddStopCommand,
  objectGradientDeleteStopCommandId,
  objectGradientReverseCommand,
  objectGradientRotateCommand,
  objectGradientStopColorCommandId,
  objectGradientStopOffsetCommandId,
  objectGradientStopOpacityCommandId,
  objectEffectCommands,
  objectEffectColorCommandId,
  objectEffectDisableCommandId,
  objectEffectOpacityCommandId,
  objectEffectSizeCommandId,
  objectPaintTypeCommandId,
  objectPaintTypeCommands,
  objectStrokeDashCommands,
  objectStrokeLineCapCommands,
  objectStrokeLineJoinCommands,
  objectStrokeOpacityCommandId,
  objectStrokeWidthCommands,
  moleculeRingEffectColorCommandId,
  moleculeRingEffectCommandId,
  moleculeRingEffectDisableCommandId,
  moleculeRingEffectOpacityCommandId,
  moleculeRingEffectSizeCommandId,
  moleculeRingFillColorCommandId,
  moleculeRingFillNoneCommandId,
  moleculeRingFillOpacityCommandId,
  moleculeStructureChainAngleCommandId,
  moleculeStructureBondLengthCommandId,
  moleculeStructureBondStrokeWidthCommandId,
  moleculeStructureBondBoldWidthCommandId,
  moleculeStructureBondColorCommandId,
  moleculeStructureBondLineCapCommandId,
  moleculeStructureBondSpacingModeCommandId,
  moleculeStructureBondSpacingPercentCommandId,
  moleculeStructureMultipleBondGapCommandId,
  moleculeStructureDoubleBondInsetCommandId,
  moleculeStructureBondMarginWidthCommandId,
  moleculeStructureBondHashSpacingCommandId,
  moleculeStructureOverlapClearanceCommandId,
  moleculeStructureAtomQueryIndicatorsCommandId,
  moleculeStructureAtomStereochemistryCommandId,
  moleculeStructureAtomEnhancedStereochemistryCommandId,
  moleculeStructureAtomNumbersCommandId,
  moleculeStructureBondQueryIndicatorsCommandId,
  moleculeStructureBondStereochemistryCommandId,
  moleculeStructureBondReactionIndicatorsCommandId,
  moleculeStructureNumberRanges,
  moleculeAtomLabelFontFamilyCommandId,
  moleculeAtomLabelFontFaceCommandId,
  moleculeAtomLabelFontSizeCommandId,
  moleculeAtomLabelColorCommandId,
  moleculeAtomLabelBackgroundColorCommandId,
  moleculeAtomLabelBackgroundCommandId,
  moleculeAtomLabelPaddingCommandId,
  moleculeAtomLabelBondClearanceCommandId,
  moleculeAtomLabelAlignmentCommandId,
  moleculeAtomLabelPlacementCommandId,
  moleculeAtomLabelShowTerminalCarbonsCommandId,
	  moleculeAtomLabelHideImplicitHydrogensCommandId,
	  moleculeAtomLabelNumberRanges,
	  moleculeInspectorTemplateExportCommandId,
	  moleculeInspectorTemplateImportCommandId,
	  structureCleanupCommandId,
	  textCustomColorCommandId,
	  textAlignmentCommands,
  textColorCommands,
  textFontCommands,
  textLetterSpacingCommands,
  textLineHeightCommands,
  textParagraphSpacingCommands,
  textScriptCommands,
  textSizeCommands
} from "./commands";
import { Icon } from "./icons";
import { toolbarAsset } from "./toolbarAssets";
import { PALETTE_GRID_METRIC_DEFAULTS, type ToolbarPaletteItemModel } from "./toolsets";
import type { ArtInspectorEffectKind } from "./artInspectorModel";
import { loadSystemFonts, type SystemFontFamily, type SystemFontFace } from "./systemFonts";
import type { ToolsetArtPaintTarget, ToolsetFlyoutSnapshot } from "./window-manager";

export type ToolPaletteMode = "docked" | "floating";
export type ToolPaletteOrientation = "vertical" | "horizontal";
export type ToolPaletteDistributeMode = "centers" | "spacing";

/**
 * Client-rect of a popover trigger (relative to the palette webview's viewport), handed up so
 * the native palette can open the popover in its own floating window at the anchor. When a
 * consumer supplies `onRequestColorPopover`, the color picker opens as a separate window instead
 * of an inline (clipped) popover.
 */
export type ToolbarPopoverAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** A flyout dropdown asking to open in its own floating window: where to anchor + what to render. */
export type ToolbarFlyoutRequest = {
  anchor: ToolbarPopoverAnchor;
  flyout: ToolsetFlyoutSnapshot;
};

const mainToolbarTextColorCommands = textColorCommands.filter((command) => (
  command.id === "text.color.black"
  || command.id === "text.color.white"
  || command.id === "text.color.blue"
  || command.id === "text.color.red"
  || command.id === "text.color.green"
  || command.id === "text.color.gray"
));
const TOOLTIP_DELAY_MS = 500;
const GRADIENT_STOP_DIRECT_DRAG_GAP = 0.01;
const DISTRIBUTE_MENU_HOLD_MS = 150;
const COMMAND_FLYOUT_HOLD_MS = 150;

const ART_SHAPE_COMMAND_IDS = [
  "tool.art.rect",
  "tool.art.roundedRect",
  "tool.art.circle",
  "tool.art.ellipse"
] as const;

const ART_SELECTION_COLUMN_COMMAND_IDS = [
  "tool.select",
  "tool.eraser",
  "tool.lasso",
  "tool.text"
] as const;

const ART_PATH_COMMAND_IDS = [
  "tool.art.line",
  "tool.art.lineWavy",
  "tool.art.pen",
  "tool.art.polyline",
  "tool.art.scissors",
  "tool.art.measure",
  "tool.art.arrow",
  "tool.art.arc270",
  "tool.art.arc90",
  "tool.art.pencil",
  "tool.art.eyedropper"
] as const;

const ART_BOOLEAN_COMMAND_IDS = [
  "art.boolean.union",
  "art.boolean.subtract",
  "art.boolean.intersect",
  "art.boolean.split"
] as const;

const ART_ARRANGE_COLUMN_ITEM_IDS = [
  "layout.alignLeft",
  "layout.distributeHorizontal",
  "layout.distributeVertical",
  "layout.bringToFront",
  "layout.flipHorizontal",
  "layout.group"
] as const;

export function ToolPalette({
  groups,
  itemGroups,
  gridLayout,
  activeTool = "tool.select",
  mode = "docked",
  orientation = "vertical",
  title = "Drawing tools",
  currentDistributeMode = "centers",
  onRequestFlyout,
  onInvoke,
  widgetState,
  customize
}: {
  groups?: CommandSpec[][];
  itemGroups?: ToolbarPaletteItemModel[][];
  gridLayout?: ToolsetGridLayout;
  activeTool?: string;
  mode?: ToolPaletteMode;
  orientation?: ToolPaletteOrientation;
  title?: string;
  currentDistributeMode?: ToolPaletteDistributeMode;
  onRequestFlyout?: (request: ToolbarFlyoutRequest) => void;
  onInvoke: (commandId: string) => void;
  /** Live state + callbacks for the widget sections (style controls, inspectors), provided via
   *  context to the widgets declared as manifest `control` items. */
  widgetState?: ToolbarWidgetState;
  /** When set, render in-place customize mode: each grid item becomes a dnd-kit sortable slot (no
   *  invoke/flyout/tooltip handlers), grouped by these group ids (aligned with the item groups,
   *  BEFORE the widget filter). A DndContext must wrap this component (ToolbarCustomizeController). */
  customize?: { groupIds: readonly (string | undefined)[] };
}) {
  const {
    visibleTooltipId,
    requestTooltip,
    clearTooltip
  } = usePaletteTooltipState();

  const effectiveItemGroups = itemGroups ?? commandGroupsToPaletteItemGroups(groups ?? []);
  const renderPaletteItem = (
    item: ToolbarPaletteItemModel,
    tooltipId: string,
    key: string | number
  ) => (
    <ToolbarPaletteItem
      key={key}
      item={item}
      activeTool={activeTool}
      tooltipId={tooltipId}
      tooltipVisible={visibleTooltipId === tooltipId}
      distributeMode={currentDistributeMode}
      onTooltipEnter={() => requestTooltip(tooltipId)}
      onTooltipLeave={() => clearTooltip(tooltipId)}
      onRequestFlyout={onRequestFlyout}
      onInvoke={onInvoke}
    />
  );

  const gridStyle = toolPaletteGridStyle(gridLayout);
  // Widget items (manifest `control` items) don't render as grid slots — they drive the widget
  // sections below and can replace/hide the grid. Strip them from the grid content + sizing so a
  // widget placeholder never shows as a disabled button. Pair each group's id (from `customize`,
  // aligned to the UNFILTERED groups) BEFORE filtering so per-group reorder edits address the right
  // group even when a widget-only group drops out.
  const gridGroups = effectiveItemGroups
    .map((group, index) => ({
      id: customize?.groupIds[index],
      // Widgets with declared grid spans stay IN the grid (grid citizens, freely placeable); only
      // span-less widgets drop out to the appended-section path below.
      items: group.filter((item) => !isToolbarWidgetItem(item) || isGridWidgetItem(item))
    }))
    .filter((group) => group.items.length > 0);
  const gridItemGroups = gridGroups.map((group) => group.items);
  // Pair each present widget with the id of the group it lives in (from `customize`, aligned to the
  // UNFILTERED groups), so a customize drag-out can address it. Deduped, first-seen order.
  const presentWidgets = effectiveItemGroups
    .flatMap((group, index) =>
      group
        .filter((item) => isToolbarWidgetItem(item) && !isGridWidgetItem(item) && item.primary.type === "control")
        .map((item) => ({
          widgetId: item.primary.type === "control" ? item.primary.controlId : item.id,
          groupId: customize?.groupIds[index]
        }))
    )
    .filter(
      (widget, index, all): widget is { widgetId: keyof typeof TOOLBAR_WIDGET_REGISTRY; groupId: string | undefined } =>
        widget.widgetId in TOOLBAR_WIDGET_REGISTRY && all.findIndex((other) => other.widgetId === widget.widgetId) === index
    )
    .map((widget) => ({ ...widget, ...TOOLBAR_WIDGET_REGISTRY[widget.widgetId] }));
  const hidesGrid = presentWidgets.some((widget) => widget.gridMode === "hide-grid");
  const replacesGrid = presentWidgets.some((widget) => widget.gridMode === "replace-grid");
  // Palette-level class hooks (main-style-palette height cap, tooltip direction) follow ALL present
  // widgets — including grid citizens, which presentWidgets deliberately excludes from rendering.
  const widgetClassNames = [
    ...new Set(
      effectiveItemGroups
        .flatMap((group) => group.filter((item) => isToolbarWidgetItem(item) && item.primary.type === "control"))
        .map((item) =>
          item.primary.type === "control" ? TOOLBAR_WIDGET_REGISTRY[item.primary.controlId]?.className : undefined
        )
        .filter((className): className is string => Boolean(className))
    )
  ];

  const toolGroupElements = gridGroups.map((group, groupIndex) => {
    const content = group.items.map((tool, toolIndex) => {
      const tooltipId = `${groupIndex}-${toolIndex}-${tool.id}`;
      return customize
        ? <CustomizeSortableSlot key={tool.id} item={tool} groupId={group.id} />
        : renderPaletteItem(tool, tooltipId, tool.id);
    });
    return (
      <div
        className={["tool-group", gridStyle ? "tool-group-grid" : ""].filter(Boolean).join(" ")}
        key={group.id ?? group.items.map((tool) => tool.id).join("-")}
        style={gridStyle}
      >
        {customize ? (
          <SortableContext items={group.items.map((tool) => tool.id)} strategy={rectSortingStrategy}>
            {content}
          </SortableContext>
        ) : (
          content
        )}
      </div>
    );
  });

  const artCommandColumnElements = replacesGrid
    ? artToolbarCommandColumns(gridItemGroups).map((column, columnIndex) => {
        const elements = column.items.map((item, itemIndex) => {
          const tooltipId = `art-column-${columnIndex}-${itemIndex}-${item.id}`;
          return renderPaletteItem(item, tooltipId, item.id);
        });

        return (
          <div
            className="art-toolbar-command-column"
            data-art-command-column={column.id}
            data-art-arrange-column={column.containsArrangeItems ? "true" : undefined}
            data-art-shape-flyout-column={column.containsShapeFlyout ? "true" : undefined}
            key={column.id}
          >
            {elements}
          </div>
        );
      })
    : [];

  // Widgets learn about customize mode through the context so variant-swapping widgets can pin
  // themselves to their default layout while being dragged around.
  const effectiveWidgetState = useMemo<ToolbarWidgetState>(
    () => ({ ...(widgetState ?? { onInvoke }), customizing: customize !== undefined }),
    [customize, onInvoke, widgetState]
  );

  return (
    <ToolbarWidgetStateContext.Provider value={effectiveWidgetState}>
      <aside
        className={[
          "tool-palette",
          mode,
          orientation,
          customize ? "customizing" : "",
          ...widgetClassNames
        ].filter(Boolean).join(" ")}
        aria-label={title}
        data-tool-palette-orientation={orientation}
        data-tooltip-delay-ms={TOOLTIP_DELAY_MS}
      >
        {mode === "floating" && !customize ? (
          // The OS-drag grip would hijack a customize drag, so it's removed in customize mode.
          <span
            className="palette-content-drag-grip"
            aria-hidden="true"
            data-palette-content-drag-grip="true"
            data-tauri-drag-region="true"
          />
        ) : null}
        {hidesGrid ? null : replacesGrid ? (
          <div className="art-toolbar-command-band" data-art-command-band="true">
            <div className="art-toolbar-command-grid" data-art-command-grid="true">
              {artCommandColumnElements}
            </div>
          </div>
        ) : toolGroupElements}
        {presentWidgets.map((widget) =>
          customize ? (
            <CustomizeWidgetSlot
              key={widget.widgetId}
              widgetId={widget.widgetId}
              groupId={widget.groupId}
              title={widget.title}
            >
              {widget.render()}
            </CustomizeWidgetSlot>
          ) : (
            <Fragment key={widget.widgetId}>{widget.render()}</Fragment>
          )
        )}
      </aside>
    </ToolbarWidgetStateContext.Provider>
  );
}

/**
 * A grid item rendered as a dnd-kit sortable in customize mode. Deliberately a SEPARATE component
 * from ToolbarPaletteItem: none of that component's interactive handlers (invoke-on-pointerdown,
 * setPointerCapture, 420ms hold-to-flyout timers, tooltips) are mounted here, which is what keeps a
 * drag from firing the tool's command. Carries `data-palette-control` so PaletteWindow's shell-drag
 * and popover-dismiss `closest()` checks skip it (else pressing it would move the whole window).
 */
function CustomizeSortableSlot({ item, groupId }: { item: ToolbarPaletteItemModel; groupId?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { groupId, kind: item.kind }
  });
  const isSeparator = item.kind === "separator";
  const isBlank = item.kind === "spacer" || isSeparator;
  // A grid-citizen widget rides inside its sortable slot, inert (the slot owns the drag; the
  // customize-mode CSS already turns the widget's own controls off).
  const gridWidget =
    isGridWidgetItem(item) && item.primary.type === "control" ? TOOLBAR_WIDGET_REGISTRY[item.primary.controlId] : undefined;
  const style: CSSProperties = {
    ...toolbarItemGridStyle(item.layout),
    transform: CSS.Translate.toString(transform),
    transition,
    touchAction: "none",
    opacity: isDragging ? 0.4 : undefined
  };
  return (
    <span
      ref={setNodeRef}
      className={[
        "toolbar-item-grid-slot",
        "customize-slot",
        isBlank ? "customize-slot-blank" : "",
        isSeparator ? "customize-slot-separator" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      data-toolbar-item-id={item.id}
      data-palette-control="true"
      data-toolbar-layout-col-span={item.layout.colSpan}
      data-toolbar-layout-row-span={item.layout.rowSpan}
      title={item.label}
      {...attributes}
      {...listeners}
    >
      {gridWidget ? (
        <span className="customize-widget-grid-content">{gridWidget.render()}</span>
      ) : isSeparator ? (
        // Show the actual divider line, so a Divider and a Space are tellable apart while editing.
        <span className="customize-slot-divider-line" aria-hidden="true" />
      ) : isBlank ? (
        <span className="customize-slot-placeholder" aria-hidden="true" />
      ) : (
        <span className="icon-button customize-slot-icon" aria-label={item.label}>
          <ToolbarItemIcon item={item} command={item.primary.type === "command" ? item.primary.command : undefined} />
        </span>
      )}
    </span>
  );
}

/**
 * A section-widget (style controls, inspector) wrapped for customize mode: a drag handle overlays the
 * (inert, dimmed) widget so it can be grabbed and dragged out of the palette to remove it. Uses
 * `useDraggable` (not sortable) — the widget renders as an appended panel, not a grid slot, so it
 * doesn't reorder among the icons; dropping it back inside the palette is a no-op (see the controller).
 * Carries `data-palette-control` so the shell-drag / popover-dismiss `closest()` checks skip it.
 */
function CustomizeWidgetSlot({
  widgetId,
  groupId,
  title,
  children
}: {
  widgetId: string;
  groupId?: string;
  title: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: widgetId,
    data: { widget: true, widgetId, groupId, kind: "control" }
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    touchAction: "none",
    opacity: isDragging ? 0.4 : undefined
  };
  return (
    <div
      ref={setNodeRef}
      className="customize-widget-slot"
      style={style}
      data-toolbar-item-id={widgetId}
      data-palette-control="true"
    >
      <button
        type="button"
        className="customize-widget-handle"
        data-palette-control="true"
        title={`${title} — drag out to remove`}
        aria-label={`${title} — drag out to remove`}
        {...attributes}
        {...listeners}
      >
        <span className="customize-widget-handle-grip" aria-hidden="true">⠿</span>
        <span className="customize-widget-handle-label">{title}</span>
      </button>
      {children}
    </div>
  );
}

/**
 * Maps a manifest widget id (a `control` item's `controlId`) to the component that renders it and how
 * it sits relative to the tool grid. Components read their live state from {@link ToolbarWidgetStateContext};
 * ring vs. molecule share MoleculeInspectorControls (ring passes `ringOnly`).
 */
const TOOLBAR_WIDGET_REGISTRY: Record<
  string,
  { gridMode: ToolbarWidgetGridMode; className: string; title: string; render: () => ReactNode }
> = {
  [TOOLBAR_WIDGET_IDS.mainStyleControls]: {
    gridMode: "append",
    className: "main-style-palette",
    title: "Style Controls",
    render: () => <MainToolbarStyleControls />
  },
  [TOOLBAR_WIDGET_IDS.textStyleControls]: {
    gridMode: "append",
    className: "text-style-palette",
    title: "Text Style",
    render: () => <TextToolbarStyleControls />
  },
  [TOOLBAR_WIDGET_IDS.artStyleControls]: {
    gridMode: "replace-grid",
    className: "art-style-palette",
    title: "Art Style",
    render: () => <ArtToolbarStyleControls />
  },
  [TOOLBAR_WIDGET_IDS.ringInspector]: {
    gridMode: "hide-grid",
    className: "ring-inspector-palette",
    title: "Ring Inspector",
    render: () => <MoleculeInspectorControls ringOnly />
  },
  [TOOLBAR_WIDGET_IDS.moleculeInspector]: {
    gridMode: "hide-grid",
    className: "molecule-inspector-palette",
    title: "Molecule Inspector",
    render: () => <MoleculeInspectorControls />
  }
};

/** Public widget catalog (id + title) for the customize gallery's "Widgets" tiles. */
export const TOOLBAR_WIDGET_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TOOLBAR_WIDGET_REGISTRY).map(([id, entry]) => [id, entry.title])
);

/** Widgets the customize gallery can add to a grid toolbar: only `append`-mode sections (they render
 *  below the grid). `hide-grid` / `replace-grid` widgets (inspectors, art style) ARE that toolbar's
 *  whole content — adding one to the Main grid would erase it — so they're not offered here. */
export const APPENDABLE_TOOLBAR_WIDGETS: ReadonlyArray<{ id: string; title: string }> = Object.entries(
  TOOLBAR_WIDGET_REGISTRY
)
  .filter(([, entry]) => entry.gridMode === "append")
  .map(([id, entry]) => ({ id, title: entry.title }));

function commandGroupsToPaletteItemGroups(groups: CommandSpec[][]): ToolbarPaletteItemModel[][] {
  return groups.map((group) => group.map((command) => ({
    id: command.id,
    kind: "button",
    label: command.title ?? command.id,
    icon: command.icon,
    assetName: command.assetName,
    primary: { type: "command", command },
    submenu: null,
    tooltip: {
      title: command.title ?? command.id,
      description: command.description ?? null,
      shortcut: command.shortcut ?? command.defaultShortcut ?? null,
      shortcutLabel: command.shortcutLabel ?? command.shortcut ?? command.defaultShortcut ?? null
    },
    layout: { colSpan: 1, rowSpan: 1 },
    disabledReason: command.disabledReason,
    category: command.category
  })));
}

function toolPaletteGridStyle(gridLayout: ToolsetGridLayout | undefined): CSSProperties | undefined {
  if (!gridLayout) {
    return undefined;
  }

  const cellWidth = gridLayout.cellWidth ?? PALETTE_GRID_METRIC_DEFAULTS.cellWidth;
  const cellHeight = gridLayout.cellHeight ?? PALETTE_GRID_METRIC_DEFAULTS.cellHeight;
  const gap = gridLayout.gap ?? PALETTE_GRID_METRIC_DEFAULTS.gap;
  const padding = gridLayout.padding ?? PALETTE_GRID_METRIC_DEFAULTS.padding;

  return {
    "--toolbar-cell-width": `${cellWidth}px`,
    "--toolbar-cell-height": `${cellHeight}px`,
    "--toolbar-grid-gap": `${gap}px`,
    "--toolbar-grid-padding": `${padding}px`,
    gridTemplateColumns: gridLayout.columns ? `repeat(${gridLayout.columns}, var(--toolbar-cell-width))` : undefined,
    gridAutoRows: "var(--toolbar-cell-height)"
  } as CSSProperties;
}

function toolbarItemGridStyle(layout: ToolbarPaletteItemModel["layout"]): CSSProperties {
  return {
    gridColumn: layout.column !== undefined
      ? `${layout.column + 1} / span ${layout.colSpan}`
      : `span ${layout.colSpan}`,
    gridRow: layout.row !== undefined
      ? `${layout.row + 1} / span ${layout.rowSpan}`
      : `span ${layout.rowSpan}`
  };
}

function usePaletteTooltipState() {
  const [visibleTooltipId, setVisibleTooltipId] = useState<string | undefined>();
  const visibleTooltipIdRef = useRef<string | undefined>(undefined);
  const pendingTooltipRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTooltipIdRef = useRef<string | undefined>(undefined);
  visibleTooltipIdRef.current = visibleTooltipId;

  const clearPendingTooltip = useCallback(() => {
    if (pendingTooltipRef.current !== undefined) {
      clearTimeout(pendingTooltipRef.current);
      pendingTooltipRef.current = undefined;
    }
    pendingTooltipIdRef.current = undefined;
  }, []);

  const requestTooltip = useCallback((tooltipId: string) => {
    if (visibleTooltipIdRef.current === tooltipId || pendingTooltipIdRef.current === tooltipId) {
      return;
    }

    clearPendingTooltip();
    setVisibleTooltipId(undefined);
    pendingTooltipIdRef.current = tooltipId;
    pendingTooltipRef.current = setTimeout(() => {
      pendingTooltipRef.current = undefined;
      pendingTooltipIdRef.current = undefined;
      setVisibleTooltipId(tooltipId);
    }, TOOLTIP_DELAY_MS);
  }, [clearPendingTooltip]);

  const clearTooltip = useCallback((tooltipId?: string) => {
    clearPendingTooltip();
    setVisibleTooltipId((current) => (
      tooltipId && current !== tooltipId ? current : undefined
    ));
  }, [clearPendingTooltip]);

  useEffect(() => {
    if (!visibleTooltipId) {
      return undefined;
    }

    const clearWhenPointerLeavesOwner = (event: MouseEvent | PointerEvent) => {
      const target = event.target;
      const targetElement = target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : undefined;
      const ownerElement = targetElement?.closest<HTMLElement>("[data-tooltip-owner-id]");

      if (ownerElement?.dataset.tooltipOwnerId !== visibleTooltipId) {
        clearTooltip(visibleTooltipId);
      }
    };

    const clearVisibleTooltip = () => {
      clearTooltip(visibleTooltipId);
    };

    document.addEventListener("mousemove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("pointermove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("mouseleave", clearVisibleTooltip, true);
    document.addEventListener("pointerdown", clearWhenPointerLeavesOwner, true);
    window.addEventListener("blur", clearVisibleTooltip);

    return () => {
      document.removeEventListener("mousemove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("pointermove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("mouseleave", clearVisibleTooltip, true);
      document.removeEventListener("pointerdown", clearWhenPointerLeavesOwner, true);
      window.removeEventListener("blur", clearVisibleTooltip);
    };
  }, [visibleTooltipId, clearTooltip]);

  useEffect(() => {
    const clearPendingOnBlur = () => {
      clearTooltip();
    };

    window.addEventListener("blur", clearPendingOnBlur);
    return () => {
      window.removeEventListener("blur", clearPendingOnBlur);
    };
  }, [clearTooltip]);

  useEffect(() => () => {
    clearPendingTooltip();
  }, [clearPendingTooltip]);

  return {
    visibleTooltipId,
    requestTooltip,
    clearTooltip
  };
}

/** Tooltip visibility announcement from a shell to its hosting window. In the native palette
 *  windows the in-DOM tooltip span is hidden (a content-fit window clips anything outside it), and
 *  PaletteWindow relays these events into the shared floating tooltip window instead. A DOM event
 *  keeps ToolPalette runtime-agnostic — no desktop imports in the shared component. */
export const PALETTE_TOOLTIP_DOM_EVENT = "chemdraft:palette-tooltip";

export interface PaletteTooltipDomDetail {
  visible: boolean;
  title?: string;
  description?: string;
  shortcut?: string;
  anchor?: { left: number; top: number; right: number; bottom: number };
}

/** Pull the structured tooltip parts back out of the (hidden) in-DOM span. The span holds the
 *  title as plain text/an unclassed span plus optional description/shortcut sub-spans AND a
 *  visually-hidden flat copy for screen readers — flattening the whole thing with textContent
 *  would concatenate all of them into garbage. */
function extractTooltipParts(tooltip: Element): { title: string; description?: string; shortcut?: string } {
  const description = tooltip.querySelector(".tool-tooltip-description")?.textContent ?? undefined;
  const shortcut = tooltip.querySelector(".tool-tooltip-shortcut")?.textContent ?? undefined;
  let title = "";
  for (const node of Array.from(tooltip.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      title += node.textContent ?? "";
    } else if (node instanceof Element && node.tagName === "SPAN" && node.classList.length === 0) {
      title += node.textContent ?? "";
    }
  }
  return { title: title.trim(), description: description || undefined, shortcut: shortcut || undefined };
}

/**
 * Announce this shell's tooltip to the hosting native palette window. The default in-DOM span is
 * unusable there: the content-fit palette window clips anything positioned outside it (a webview
 * cannot paint past its window), so the span is display:none in palette windows (App.css) and the
 * visible tooltip is the shared floating tooltip window, which can overflow the palette freely —
 * the same reason popovers/flyouts live in their own windows. Browser and in-window palettes keep
 * the pure-CSS span; this hook is a no-op for them.
 */
function useNativeFloatingTooltip(shellRef: { current: HTMLElement | null }, visible: boolean) {
  useEffect(() => {
    if (!document.body.classList.contains("palette-window-body")) {
      return;
    }
    const shell = shellRef.current;
    if (!visible || !shell) {
      return;
    }
    const tooltip = shell.querySelector(".tool-tooltip");
    if (!tooltip) {
      return;
    }
    const { title, description, shortcut } = extractTooltipParts(tooltip);
    if (!title && !description) {
      return;
    }
    const rect = shell.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent<PaletteTooltipDomDetail>(PALETTE_TOOLTIP_DOM_EVENT, {
        detail: {
          visible: true,
          title,
          description,
          shortcut,
          anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        }
      })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent<PaletteTooltipDomDetail>(PALETTE_TOOLTIP_DOM_EVENT, { detail: { visible: false } })
      );
    };
  }, [shellRef, visible]);
}

function MainToolbarStyleControls() {
  const { currentTextStyle, currentTextScript = "normal", onInvoke } = useToolbarWidgetState();
  const sizeCommandId = closestSizeCommandId(currentTextStyle?.fontSizePx);
  const textAlign = currentTextStyle?.textAlign ?? "left";
  const currentColor = normalizeHexColor(currentTextStyle?.color) ?? textColorCommands[0].color;
  const boldActive = (currentTextStyle?.fontWeight ?? 400) >= 600;
  const italicActive = currentTextStyle?.fontStyle === "italic";
  const underlineActive = currentTextStyle?.textDecoration === "underline";
  // Superscript rides the top row (above subscript on the bottom row — they stack in the last
  // column); subscript stays with the B/I/U toggles on the bottom row. Both rows are the same total
  // cell count, so their right edges align and the x²/x₂ pair lines up vertically.
  const superscriptCommand = textScriptCommands.find((command) => command.script === "superscript");
  const subscriptCommand = textScriptCommands.find((command) => command.script === "subscript");

  return (
    <div className="main-toolbar-style-controls" data-toolbar-style-controls="main">
      <div className="toolbar-style-row toolbar-style-row-primary">
        <div className="toolbar-swatch-group" role="group" aria-label="Text color">
          {mainToolbarTextColorCommands.map((command) => (
            <ToolbarColorSwatchButton
              active={normalizeHexColor(command.color) === currentColor}
              command={command}
              key={command.id}
              onInvoke={onInvoke}
            />
          ))}
        </div>
        <div className="toolbar-align-group" role="group" aria-label="Text alignment">
          {textAlignmentCommands.map((command) => (
            <ToolbarAlignButton
              active={textAlign === command.textAlign}
              command={command}
              key={command.id}
              onInvoke={onInvoke}
            />
          ))}
        </div>
        {superscriptCommand ? (
          <ToolbarTextButton
            commandId={superscriptCommand.id}
            label={superscriptCommand.title}
            active={currentTextScript === "superscript"}
            onInvoke={onInvoke}
          >
            <span className="toolbar-script-glyph" data-text-script="superscript">
              x<span>2</span>
            </span>
          </ToolbarTextButton>
        ) : null}
      </div>
      <div className="toolbar-style-row toolbar-style-row-secondary">
        <TextFontSelect
          currentTextStyle={currentTextStyle}
          labelClassName="toolbar-control-label toolbar-font-control"
          onInvoke={onInvoke}
        />
        <label className="toolbar-control-label toolbar-size-control">
          <span className="visually-hidden">Text size</span>
          <select
            className="toolbar-select toolbar-size-select"
            value={sizeCommandId}
            aria-label="Text size"
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {textSizeCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.title.replace("Size: ", "")}
              </option>
            ))}
          </select>
        </label>
        <div className="toolbar-type-group" role="group" aria-label="Text style">
          <ToolbarTextButton
            commandId="text.bold"
            label="Bold Text"
            active={boldActive}
            onInvoke={onInvoke}
          >
            B
          </ToolbarTextButton>
          <ToolbarTextButton
            commandId="text.italic"
            label="Italic Text"
            active={italicActive}
            onInvoke={onInvoke}
          >
            I
          </ToolbarTextButton>
          <ToolbarTextButton
            commandId="text.underline"
            label="Underline Text"
            active={underlineActive}
            onInvoke={onInvoke}
          >
            U
          </ToolbarTextButton>
          {subscriptCommand ? (
            <ToolbarTextButton
              commandId={subscriptCommand.id}
              label={subscriptCommand.title}
              active={currentTextScript === "subscript"}
              onInvoke={onInvoke}
            >
              <span className="toolbar-script-glyph" data-text-script="subscript">
                x<span>2</span>
              </span>
            </ToolbarTextButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TextToolbarStyleControls() {
  const { currentTextStyle, currentTextScript = "normal", onColorPickerOpenChange, onInvoke } = useToolbarWidgetState();
  const sizeCommandId = closestSizeCommandId(currentTextStyle?.fontSizePx);
  const textAlign = currentTextStyle?.textAlign ?? "left";
  const currentColor = normalizeHexColor(currentTextStyle?.color) ?? textColorCommands[0].color;
  const letterSpacingCommandId = closestLetterSpacingCommandId(currentTextStyle?.letterSpacingPx);
  const lineHeightCommandId = closestLineHeightCommandId(currentTextStyle?.lineHeight);
  const paragraphSpacingCommandId = closestParagraphSpacingCommandId(currentTextStyle?.paragraphSpacingPx);
  const boldActive = (currentTextStyle?.fontWeight ?? 400) >= 600;
  const italicActive = currentTextStyle?.fontStyle === "italic";
  const underlineActive = currentTextStyle?.textDecoration === "underline";

  return (
    <div className="text-toolbar-style-controls" data-toolbar-style-controls="text">
      <div className="text-toolbar-row text-toolbar-row-font">
        <TextFontSelect
          currentTextStyle={currentTextStyle}
          labelClassName="toolbar-control-label text-toolbar-font-control"
          onInvoke={onInvoke}
        />
        <label className="toolbar-control-label text-toolbar-size-control">
          <span className="visually-hidden">Text size</span>
          <select
            className="toolbar-select toolbar-size-select"
            value={sizeCommandId}
            aria-label="Text size"
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {textSizeCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.title.replace("Size: ", "")}
              </option>
            ))}
          </select>
        </label>
        <ColorPickerControl
          currentColor={currentColor}
          onOpenChange={onColorPickerOpenChange}
          onInvoke={onInvoke}
        />
      </div>
      <div className="text-toolbar-row">
        <div className="toolbar-type-group" role="group" aria-label="Text style">
          <ToolbarTextButton commandId="text.bold" label="Bold Text" active={boldActive} onInvoke={onInvoke}>
            B
          </ToolbarTextButton>
          <ToolbarTextButton commandId="text.italic" label="Italic Text" active={italicActive} onInvoke={onInvoke}>
            I
          </ToolbarTextButton>
          <ToolbarTextButton commandId="text.underline" label="Underline Text" active={underlineActive} onInvoke={onInvoke}>
            U
          </ToolbarTextButton>
          {textScriptCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={currentTextScript === command.script}
              key={command.id}
              onInvoke={onInvoke}
            >
              <ScriptGlyph script={command.script} />
            </ToolbarTextButton>
          ))}
        </div>
        <div className="toolbar-align-group" role="group" aria-label="Text alignment">
          {textAlignmentCommands.map((command) => (
            <ToolbarAlignButton
              active={textAlign === command.textAlign}
              command={command}
              key={command.id}
              onInvoke={onInvoke}
            />
          ))}
        </div>
      </div>
      <div className="text-toolbar-row">
        <div className="toolbar-metric-group" role="group" aria-label="Letter spacing">
          {textLetterSpacingCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={letterSpacingCommandId === command.id}
              key={command.id}
              onInvoke={onInvoke}
            >
              {command.letterSpacingPx < 0 ? "AV-" : command.letterSpacingPx > 0 ? "AV+" : "AV"}
            </ToolbarTextButton>
          ))}
        </div>
        <div className="toolbar-metric-group" role="group" aria-label="Line spacing">
          {textLineHeightCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={lineHeightCommandId === command.id}
              key={command.id}
              onInvoke={onInvoke}
            >
              {command.lineHeight.toFixed(command.lineHeight % 1 === 0 ? 0 : 1)}
            </ToolbarTextButton>
          ))}
        </div>
        <div className="toolbar-metric-group" role="group" aria-label="Paragraph spacing">
          {textParagraphSpacingCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={paragraphSpacingCommandId === command.id}
              key={command.id}
              onInvoke={onInvoke}
            >
              {`P${command.paragraphSpacingPx}`}
            </ToolbarTextButton>
          ))}
        </div>
      </div>
    </div>
  );
}

function closestObjectStrokeWidthCommandId(strokeWidth: number | undefined): string {
  if (strokeWidth === undefined) {
    return objectStrokeWidthCommands[1]?.id ?? objectStrokeWidthCommands[0].id;
  }

  return objectStrokeWidthCommands.reduce((best, command) => (
    Math.abs(command.strokeWidth - strokeWidth) < Math.abs(best.strokeWidth - strokeWidth) ? command : best
  ), objectStrokeWidthCommands[0]).id;
}

function objectStrokeDashCommandId(strokeDasharray: string | undefined): string {
  const normalized = strokeDasharray === undefined || strokeDasharray === "solid" ? undefined : strokeDasharray;
  return objectStrokeDashCommands.find((command) => command.strokeDasharray === normalized)?.id ??
    objectStrokeDashCommands[0].id;
}

const MOLECULE_INSPECTOR_TABS = ["structure", "atom-labels", "templates"] as const;

function MoleculeInspectorControls({ ringOnly = false }: { ringOnly?: boolean }) {
  const {
    currentMoleculeInspector,
    onMoleculeInspectorPreview: onPreview,
    onMoleculeInspectorCommit: onCommit,
    onMoleculeInspectorCancel: onCancel,
    onInvoke
  } = useToolbarWidgetState();
  const ringsModel = currentMoleculeInspector?.rings;
  const selectedRing = ringsModel?.selectedRing;
  const selectedRingKeys = ringsModel?.selectedRings.map((ring) => ring.ringKey) ?? [];
  const selectedCount = ringsModel?.selectedCount ?? 0;
  const selected = selectedRing !== undefined;
  const ringKey = selectedRing?.ringKey ?? "";
  const fillColorMixed = ringsModel?.values.fillColor.mixed === true;
  const currentColor = normalizeHexColor(ringsModel?.values.fillColor.value ?? "#111111") ?? "#111111";
  const fillOpacity = ringsModel?.values.fillOpacity.value ?? 1;
  const activeEffectValue = ringsModel?.values.effect.mixed
    ? "multiple"
    : ringsModel?.values.effect.value ?? "none";
  const activeEffectKinds = ringsModel?.effectKinds ?? [];
  const visibleEffectKind = activeEffectValue === "shadow" || activeEffectValue === "glow" || activeEffectValue === "sketch"
    ? activeEffectValue
    : activeEffectKinds[0];
  const visibleEffectModel = visibleEffectKind ? ringsModel?.effectControls[visibleEffectKind] : undefined;
  const currentEffectColor = normalizeHexColor(visibleEffectModel?.color.value ?? "#52616b") ?? "#52616b";
  const effectOpacity = visibleEffectModel?.opacity.value ?? 1;
  const effectSize = visibleEffectModel?.size.value ?? 0.25;
  const showEffectControls = selected && visibleEffectKind !== undefined && (visibleEffectModel?.presentCount ?? 0) > 0;
  const suggestedTab = currentMoleculeInspector?.suggestedTab === "atom-labels" ? "atom-labels" : "structure";
  const [activeTab, setActiveTab] = useState<"structure" | "atom-labels" | "templates">(suggestedTab);
  const initializedTabRef = useRef(false);
  const structure = currentMoleculeInspector?.structure;
  const atomLabels = currentMoleculeInspector?.atomLabels;
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const currentFontFamily = atomLabels?.values.fontFamily.value ?? undefined;
  const currentBackgroundColor = atomLabels?.values.backgroundColor.value ?? undefined;
  // Remember the last concrete background color so switching Transparent -> Solid
  // restores it rather than snapping to the default.
  const lastSolidBackgroundRef = useRef("#ffffff");
  useEffect(() => {
    const normalized = normalizeHexColor(currentBackgroundColor);
    if (normalized) {
      lastSolidBackgroundRef.current = normalized;
    }
  }, [currentBackgroundColor]);

  useEffect(() => {
    if (!initializedTabRef.current) {
      setActiveTab(suggestedTab);
      initializedTabRef.current = true;
    }
  }, [suggestedTab]);

  useEffect(() => {
    if (activeTab !== "atom-labels") {
      return;
    }
    // Single load per (tab, family): the cleanup below flips `disposed` before the
    // next run starts, so a slow earlier response can never clobber a newer one.
    let disposed = false;
    void loadSystemFonts(currentFontFamily ? [currentFontFamily] : [])
      .then((fonts) => {
        if (!disposed) {
          setSystemFonts(fonts);
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeTab, currentFontFamily]);

  const invokeOrCommit = (commandId: string) => {
    if (onCommit) {
      onCommit(commandId);
      return;
    }
    onInvoke(commandId);
  };
  const previewCommand = (commandId: string) => {
    onPreview?.(commandId);
  };
  const changeTab = (tabId: "structure" | "atom-labels" | "templates") => {
    onCancel?.();
    setActiveTab(tabId);
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: "structure" | "atom-labels" | "templates") => {
    const tabs = MOLECULE_INSPECTOR_TABS;
    const index = tabs.indexOf(tabId);
    const nextTab = event.key === "ArrowDown"
      ? tabs[Math.min(tabs.length - 1, index + 1)]
      : event.key === "ArrowUp"
        ? tabs[Math.max(0, index - 1)]
        : event.key === "Home"
          ? tabs[0]
          : event.key === "End"
            ? tabs[tabs.length - 1]
            : undefined;
    if (!nextTab) {
      return;
    }
    event.preventDefault();
    changeTab(nextTab);
    document.getElementById(`molecule-inspector-tab-${nextTab}`)?.focus();
  };
  const commitRingCommand = (commandId: string) => {
    if (!selected) {
      return;
    }
    invokeOrCommit(commandId);
  };
  const previewRingCommand = (commandId: string) => {
    if (!selected) {
      return;
    }
    previewCommand(commandId);
  };
  const applyColor = (color: string, commit: boolean) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    const commandId = moleculeRingFillColorCommandId(ringKey, normalized);
    if (commit) {
      commitRingCommand(commandId);
    } else {
      previewRingCommand(commandId);
    }
  };
  const applyEffectColor = (color: string, commit: boolean) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !visibleEffectKind) {
      return;
    }
    const commandId = moleculeRingEffectColorCommandId(ringKey, visibleEffectKind, normalized);
    if (commit) {
      commitRingCommand(commandId);
    } else {
      previewRingCommand(commandId);
    }
  };
  const slider = (
    label: string,
    value: number,
    commandId: (value: number) => string,
    disabled = !selected
  ) => {
    const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
    return (
      <label className="molecule-inspector-slider" data-molecule-inspector-slider={label.toLowerCase()}>
        <span className="art-inspector-slider-header">
          <span className="art-inspector-slider-label">{label}</span>
          <span className="art-inspector-slider-value">{percent}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          disabled={disabled}
          aria-label={`Ring ${label.toLowerCase()}`}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => previewRingCommand(commandId(Number(event.currentTarget.value) / 100))}
          onPointerUp={(event) => {
            event.stopPropagation();
            commitRingCommand(commandId(Number(event.currentTarget.value) / 100));
          }}
          onKeyUp={(event) => {
            commitRingCommand(commandId(Number(event.currentTarget.value) / 100));
          }}
          onBlur={(event) => {
            commitRingCommand(commandId(Number(event.currentTarget.value) / 100));
          }}
        />
      </label>
    );
  };

  const valueOrFallback = (value: number | null | undefined, fallback: number) => value ?? fallback;
  const numericControl = (
    label: string,
    value: number | null | undefined,
    mixed: boolean | undefined,
    range: { min: number; max: number; step: number },
    commandId: (value: number) => string,
    disabled: boolean
  ) => {
    const effectiveValue = valueOrFallback(value, range.min);
    const parseInputValue = (rawValue: string): number | undefined => {
      const trimmed = rawValue.trim();
      if (trimmed === "") {
        // Empty (cleared, or an unedited "Mixed") field: Number("") is 0, which would
        // silently stamp 0 onto every target. Treat blank as "leave unchanged".
        return undefined;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const commitValue = (rawValue: string) => {
      const nextValue = parseInputValue(rawValue);
      if (nextValue !== undefined) {
        invokeOrCommit(commandId(nextValue));
      }
    };
    return (
      <label className="molecule-inspector-field molecule-inspector-number-field">
        <span>{label}</span>
        <input
          type="number"
          min={range.min}
          max={range.max}
          step={range.step}
          value={mixed ? "" : formatInspectorNumber(effectiveValue)}
          placeholder={mixed ? "Mixed" : undefined}
          disabled={disabled}
          aria-label={label}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const nextValue = parseInputValue(event.currentTarget.value);
            if (nextValue !== undefined) {
              previewCommand(commandId(nextValue));
            }
          }}
          onBlur={(event) => commitValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitValue(event.currentTarget.value);
            }
            if (event.key === "Escape") {
              onCancel?.();
            }
          }}
        />
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={effectiveValue}
          disabled={disabled}
          aria-label={`${label} slider`}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => previewCommand(commandId(Number(event.currentTarget.value)))}
          onPointerUp={(event) => {
            event.stopPropagation();
            invokeOrCommit(commandId(Number(event.currentTarget.value)));
          }}
          onKeyUp={(event) => invokeOrCommit(commandId(Number(event.currentTarget.value)))}
        />
      </label>
    );
  };

  const colorControl = (
    label: string,
    value: string | null | undefined,
    mixed: boolean | undefined,
    commandId: (color: string) => string,
    disabled: boolean
  ) => {
    const color = normalizeHexColor(value ?? undefined) ?? "#000000";
    return (
      <label className="molecule-inspector-field molecule-inspector-color-field">
        <span>{label}</span>
        <span className="molecule-inspector-color-input">
          <span className="toolbar-color-trigger-swatch" style={{ "--current-color": mixed ? "#8a949e" : color } as CSSProperties} />
          <input
            type="color"
            value={color}
            disabled={disabled}
            aria-label={label}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => previewCommand(commandId(event.currentTarget.value))}
            onBlur={(event) => invokeOrCommit(commandId(event.currentTarget.value))}
          />
        </span>
      </label>
    );
  };

  const ringsPanel = (
    <div
      data-molecule-inspector-selection-count={selectedCount}
      data-selected-ring-key={selectedRing?.ringKey}
      data-selected-ring-keys={selectedRingKeys.length > 0 ? selectedRingKeys.join(",") : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel?.();
        }
      }}
    >
      <div className="molecule-inspector-target-row">
        <span className="molecule-inspector-target-label">{selected ? selectedCount === 1 ? "Ring" : "Rings" : "No ring"}</span>
        <span className="molecule-inspector-target-key">{selectedCount > 1 ? `${selectedCount} selected` : selectedRing?.ringKey ?? ""}</span>
      </div>
      {!selected ? <p className="molecule-inspector-empty-message">Select a ring interior to edit ring appearance.</p> : null}
      <div className="molecule-inspector-section" data-molecule-inspector-section="fill">
        <div className="molecule-inspector-swatch-grid" role="group" aria-label="Ring fill color">
          {objectColorCommands.slice(0, 8).map((command) => {
            const commandId = moleculeRingFillColorCommandId(ringKey, command.color);
            const active = !fillColorMixed && normalizeHexColor(command.color) === currentColor;
            return (
              <button
                type="button"
                className={["toolbar-color-swatch", active ? "active" : ""].filter(Boolean).join(" ")}
                title={command.title.replace("Object", "Ring")}
                aria-label={command.title.replace("Object", "Ring")}
                aria-pressed={active}
                disabled={!selected}
                data-command-id={commandId}
                data-palette-control="true"
                key={command.id}
                style={{ "--swatch-color": command.color } as CSSProperties}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => commitRingCommand(commandId)}
              />
            );
          })}
          <button
            type="button"
            className="toolbar-text-button molecule-inspector-none-button"
            title="Ring fill none"
            aria-label="Ring fill none"
            disabled={!selected}
            data-command-id={moleculeRingFillNoneCommandId(ringKey)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => commitRingCommand(moleculeRingFillNoneCommandId(ringKey))}
          >
            None
          </button>
          <label className="molecule-inspector-color-input" title="Custom ring fill color">
            <span className="toolbar-color-trigger-swatch" style={{ "--current-color": currentColor } as CSSProperties} />
            <input
              type="color"
              value={currentColor}
              disabled={!selected}
              aria-label="Custom ring fill color"
              data-palette-control="true"
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => applyColor(event.currentTarget.value, false)}
              onBlur={(event) => applyColor(event.currentTarget.value, true)}
            />
          </label>
        </div>
        {slider("Fill", fillOpacity, (value) => moleculeRingFillOpacityCommandId(ringKey, value))}
      </div>
      <div className="molecule-inspector-section" data-molecule-inspector-section="effects">
        <div className="molecule-inspector-effect-row" role="group" aria-label="Ring effect">
          {objectEffectCommands.map((command) => {
            const commandId = moleculeRingEffectCommandId(ringKey, command.effectKind);
            const active = activeEffectValue === command.effectKind || activeEffectKinds.includes(command.effectKind as ArtInspectorEffectKind);
            return (
              <button
                type="button"
                className={["toolbar-text-button", active ? "active" : ""].filter(Boolean).join(" ")}
                title={command.title.replace("Art", "Ring")}
                aria-label={command.title.replace("Art", "Ring")}
                aria-pressed={active}
                disabled={!selected}
                data-command-id={commandId}
                data-palette-control="true"
                key={command.id}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (active && command.effectKind !== "none") {
                    commitRingCommand(moleculeRingEffectDisableCommandId(ringKey, command.effectKind));
                    return;
                  }
                  commitRingCommand(commandId);
                }}
              >
                {command.label}
              </button>
            );
          })}
        </div>
        {showEffectControls && visibleEffectKind ? (
          <div className="molecule-inspector-effect-controls" data-visible-effect-kind={visibleEffectKind}>
            <label className="molecule-inspector-color-input" title="Ring effect color">
              <span className="toolbar-color-trigger-swatch" style={{ "--current-color": currentEffectColor } as CSSProperties} />
              <input
                type="color"
                value={currentEffectColor}
                disabled={!selected}
                aria-label="Ring effect color"
                data-palette-control="true"
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => applyEffectColor(event.currentTarget.value, false)}
                onBlur={(event) => applyEffectColor(event.currentTarget.value, true)}
              />
            </label>
            {slider("Effect", effectOpacity, (value) => moleculeRingEffectOpacityCommandId(ringKey, visibleEffectKind, value))}
            {slider("Size", effectSize, (value) => moleculeRingEffectSizeCommandId(ringKey, visibleEffectKind, value))}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (ringOnly) {
    return (
      <div
        className="molecule-inspector-controls ring-inspector-controls"
        data-toolbar-style-controls="ring-inspector"
      >
        <div className="molecule-inspector-tab-panel" role="group" aria-label="Rings">
          {ringsPanel}
        </div>
      </div>
    );
  }

  const structureDisabled = structure?.enabled !== true;
  const structureBondSpacingMode = structure?.values.bondSpacingMode.mixed
    ? "mixed"
    : structure?.values.bondSpacingMode.value ?? "absolute";
  const structureTargetLabel = structure?.targetCount
    ? structure.targetKind === "bond"
      ? `${structure.targetCount} bond${structure.targetCount === 1 ? "" : "s"}`
      : structure.targetKind === "atom"
        ? `${structure.targetCount} atom${structure.targetCount === 1 ? "" : "s"}`
        : `${structure.targetCount} molecule${structure.targetCount === 1 ? "" : "s"}`
    : "No molecule";
  const structurePanel = (
    <div className="molecule-inspector-panel-body" data-molecule-inspector-section="structure">
      <div className="molecule-inspector-target-row">
        <span className="molecule-inspector-target-label">Structure</span>
        <span className="molecule-inspector-target-key">{structureTargetLabel}</span>
      </div>
      {structureDisabled ? <p className="molecule-inspector-empty-message">Select a molecule, atom, bond, or ring to edit its parent molecule.</p> : null}
      {numericControl("Chain angle", structure?.values.chainAngleDegrees.value, structure?.values.chainAngleDegrees.mixed, moleculeStructureNumberRanges.chainAngleDegrees, moleculeStructureChainAngleCommandId, structureDisabled)}
      {numericControl("Target bond length", structure?.values.bondLengthPx.value, structure?.values.bondLengthPx.mixed, moleculeStructureNumberRanges.bondLengthPx, moleculeStructureBondLengthCommandId, structureDisabled)}
      {numericControl("Line width", structure?.values.bondStrokeWidthPx.value, structure?.values.bondStrokeWidthPx.mixed, moleculeStructureNumberRanges.bondStrokeWidthPx, moleculeStructureBondStrokeWidthCommandId, structureDisabled)}
      {numericControl("Bold width", structure?.values.bondBoldWidthPx.value, structure?.values.bondBoldWidthPx.mixed, moleculeStructureNumberRanges.bondBoldWidthPx, moleculeStructureBondBoldWidthCommandId, structureDisabled)}
      {colorControl("Bond color", structure?.values.bondColor.value, structure?.values.bondColor.mixed, moleculeStructureBondColorCommandId, structureDisabled)}
      <label className="molecule-inspector-field molecule-inspector-select-field">
        <span>Bond spacing</span>
        <select
          value={structureBondSpacingMode}
          disabled={structureDisabled}
          aria-label="Bond spacing mode"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.currentTarget.value !== "mixed") {
              invokeOrCommit(moleculeStructureBondSpacingModeCommandId(event.currentTarget.value as "absolute" | "percent"));
            }
          }}
        >
          {structure?.values.bondSpacingMode.mixed ? <option value="mixed">Mixed</option> : null}
          <option value="percent">% of length</option>
          <option value="absolute">Absolute</option>
        </select>
      </label>
      {numericControl("Spacing %", structure?.values.bondSpacingPercent.value, structure?.values.bondSpacingPercent.mixed, moleculeStructureNumberRanges.bondSpacingPercent, moleculeStructureBondSpacingPercentCommandId, structureDisabled)}
      {numericControl("Spacing abs.", structure?.values.multipleBondGapPx.value, structure?.values.multipleBondGapPx.mixed, moleculeStructureNumberRanges.multipleBondGapPx, moleculeStructureMultipleBondGapCommandId, structureDisabled)}
      {numericControl("Margin width", structure?.values.bondMarginWidthPx.value, structure?.values.bondMarginWidthPx.mixed, moleculeStructureNumberRanges.bondMarginWidthPx, moleculeStructureBondMarginWidthCommandId, structureDisabled)}
      {numericControl("Hash spacing", structure?.values.bondHashSpacingPx.value, structure?.values.bondHashSpacingPx.mixed, moleculeStructureNumberRanges.bondHashSpacingPx, moleculeStructureBondHashSpacingCommandId, structureDisabled)}
      {numericControl("Double-bond inset", structure?.values.doubleBondInsetPx.value, structure?.values.doubleBondInsetPx.mixed, moleculeStructureNumberRanges.doubleBondInsetPx, moleculeStructureDoubleBondInsetCommandId, structureDisabled)}
      {numericControl("Overlap clearance", structure?.values.bondOverlapClearancePx.value, structure?.values.bondOverlapClearancePx.mixed, moleculeStructureNumberRanges.bondOverlapClearancePx, moleculeStructureOverlapClearanceCommandId, structureDisabled)}
      <label className="molecule-inspector-field molecule-inspector-select-field">
        <span>Line cap</span>
        <select
          value={structure?.values.bondLineCap.mixed ? "mixed" : structure?.values.bondLineCap.value ?? "butt"}
          disabled={structureDisabled}
          aria-label="Bond line cap"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.currentTarget.value !== "mixed") {
              invokeOrCommit(moleculeStructureBondLineCapCommandId(event.currentTarget.value as "butt" | "round" | "square"));
            }
          }}
        >
          {structure?.values.bondLineCap.mixed ? <option value="mixed">Mixed</option> : null}
          <option value="butt">Flat</option>
          <option value="round">Round</option>
          <option value="square">Square</option>
        </select>
      </label>
      <div className="molecule-inspector-check-group" role="group" aria-label="Atom indicators">
        <span className="molecule-inspector-check-group-title">Atom Indicators</span>
        <MoleculeInspectorCheckbox
          label="Query indicators"
          value={structure?.values.atomIndicatorShowQuery.value}
          mixed={structure?.values.atomIndicatorShowQuery.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureAtomQueryIndicatorsCommandId}
          onInvoke={invokeOrCommit}
        />
        <MoleculeInspectorCheckbox
          label="Stereochemistry"
          value={structure?.values.atomIndicatorShowStereochemistry.value}
          mixed={structure?.values.atomIndicatorShowStereochemistry.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureAtomStereochemistryCommandId}
          onInvoke={invokeOrCommit}
        />
        <MoleculeInspectorCheckbox
          label="Enhanced stereochemistry"
          value={structure?.values.atomIndicatorShowEnhancedStereochemistry.value}
          mixed={structure?.values.atomIndicatorShowEnhancedStereochemistry.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureAtomEnhancedStereochemistryCommandId}
          onInvoke={invokeOrCommit}
        />
        <MoleculeInspectorCheckbox
          label="Atom numbers"
          value={structure?.values.atomIndicatorShowAtomNumbers.value}
          mixed={structure?.values.atomIndicatorShowAtomNumbers.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureAtomNumbersCommandId}
          onInvoke={invokeOrCommit}
        />
      </div>
      <div className="molecule-inspector-check-group" role="group" aria-label="Bond indicators">
        <span className="molecule-inspector-check-group-title">Bond Indicators</span>
        <MoleculeInspectorCheckbox
          label="Query indicators"
          value={structure?.values.bondIndicatorShowQuery.value}
          mixed={structure?.values.bondIndicatorShowQuery.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureBondQueryIndicatorsCommandId}
          onInvoke={invokeOrCommit}
        />
        <MoleculeInspectorCheckbox
          label="Stereochemistry"
          value={structure?.values.bondIndicatorShowStereochemistry.value}
          mixed={structure?.values.bondIndicatorShowStereochemistry.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureBondStereochemistryCommandId}
          onInvoke={invokeOrCommit}
        />
        <MoleculeInspectorCheckbox
          label="Reaction indicators"
          value={structure?.values.bondIndicatorShowReaction.value}
          mixed={structure?.values.bondIndicatorShowReaction.mixed}
          disabled={structureDisabled}
          commandId={moleculeStructureBondReactionIndicatorsCommandId}
          onInvoke={invokeOrCommit}
        />
      </div>
    </div>
  );

  const atomLabelsDisabled = atomLabels?.enabled !== true;
  const currentFontFace = atomLabels?.values.fontFace.value;
  const fontFamilyOptions = useMemo(
    () => systemFonts.length > 0
      ? systemFonts
      : fallbackFontFamilyOptions(currentFontFamily),
    [currentFontFamily, systemFonts]
  );
  const fontFaceOptions = useMemo(
    () => fontFacesForFamily(fontFamilyOptions, currentFontFamily, currentFontFace),
    [currentFontFace, currentFontFamily, fontFamilyOptions]
  );
  const atomLabelsPanel = (
    <div className="molecule-inspector-panel-body" data-molecule-inspector-section="atom-labels">
      <div className="molecule-inspector-target-row">
        <span className="molecule-inspector-target-label">Atom Labels</span>
        <span className="molecule-inspector-target-key">
          {atomLabels?.targetCount
            ? atomLabels.targetKind === "atom"
              ? `${atomLabels.targetCount} atom label${atomLabels.targetCount === 1 ? "" : "s"}`
              : `${atomLabels.targetCount} molecule${atomLabels.targetCount === 1 ? "" : "s"}`
            : "No molecule"}
        </span>
      </div>
      {atomLabelsDisabled ? <p className="molecule-inspector-empty-message">Select a molecule or one of its atoms, bonds, or rings to edit molecule label appearance.</p> : null}
      <label className="molecule-inspector-field">
        <span>Font family</span>
        <select
          value={atomLabels?.values.fontFamily.mixed ? "mixed" : currentFontFamily ?? textFontCommands[0].fontFamily}
          disabled={atomLabelsDisabled}
          aria-label="Atom label font family"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.currentTarget.value !== "mixed") {
              invokeOrCommit(moleculeAtomLabelFontFamilyCommandId(event.currentTarget.value));
            }
          }}
        >
          {atomLabels?.values.fontFamily.mixed ? <option value="mixed">Mixed</option> : null}
          {fontFamilyOptions.map((fontFamily) => (
            <option key={fontFamily.family} value={fontFamily.family}>{fontFamilyLabel(fontFamily.family)}</option>
          ))}
        </select>
      </label>
      <label className="molecule-inspector-field">
        <span>Font face</span>
        <select
          value={atomLabels?.values.fontFace.mixed ? "mixed" : `${currentFontFace?.weight ?? 400}:${currentFontFace?.style ?? "normal"}`}
          disabled={atomLabelsDisabled}
          aria-label="Atom label font face"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.currentTarget.value === "mixed") {
              return;
            }
            const [weight, style] = event.currentTarget.value.split(":");
            invokeOrCommit(moleculeAtomLabelFontFaceCommandId(Number(weight), style === "italic" ? "italic" : "normal"));
          }}
        >
          {atomLabels?.values.fontFace.mixed ? <option value="mixed">Mixed</option> : null}
          {fontFaceOptions.map((face) => (
            <option key={`${face.weight}:${face.style}`} value={`${face.weight}:${face.style}`}>
              {fontFaceLabel(face.weight, face.style)}
            </option>
          ))}
        </select>
      </label>
      {numericControl("Size", atomLabels?.values.fontSizePx.value, atomLabels?.values.fontSizePx.mixed, moleculeAtomLabelNumberRanges.fontSizePx, moleculeAtomLabelFontSizeCommandId, atomLabelsDisabled)}
      {colorControl("Label color", atomLabels?.values.color.value, atomLabels?.values.color.mixed, moleculeAtomLabelColorCommandId, atomLabelsDisabled)}
      <label className="molecule-inspector-field molecule-inspector-background-field">
        <span>Background</span>
        <select
          value={atomLabels?.values.backgroundColor.mixed ? "mixed" : atomLabels?.values.backgroundColor.value === "transparent" ? "transparent" : "solid"}
          disabled={atomLabelsDisabled}
          aria-label="Atom label background mode"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) =>
            invokeOrCommit(
              moleculeAtomLabelBackgroundCommandId(
                event.currentTarget.value,
                currentBackgroundColor,
                lastSolidBackgroundRef.current
              )
            )
          }
        >
          {atomLabels?.values.backgroundColor.mixed ? <option value="mixed">Mixed</option> : null}
          <option value="solid">Solid</option>
          <option value="transparent">Transparent</option>
        </select>
        {atomLabels?.values.backgroundColor.value !== "transparent"
          ? <span className="molecule-inspector-color-input">
              <span
                className="toolbar-color-trigger-swatch"
                style={{
                  "--current-color": normalizeHexColor(atomLabels?.values.backgroundColor.value ?? "#ffffff") ?? "#ffffff"
                } as CSSProperties}
              />
              <input
                type="color"
                value={normalizeHexColor(atomLabels?.values.backgroundColor.value ?? "#ffffff") ?? "#ffffff"}
                disabled={atomLabelsDisabled}
                aria-label="Atom label background color"
                data-palette-control="true"
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => previewCommand(moleculeAtomLabelBackgroundColorCommandId(event.currentTarget.value))}
                onBlur={(event) => invokeOrCommit(moleculeAtomLabelBackgroundColorCommandId(event.currentTarget.value))}
              />
            </span>
          : null}
      </label>
      {numericControl("Padding", atomLabels?.values.paddingPx.value, atomLabels?.values.paddingPx.mixed, moleculeAtomLabelNumberRanges.paddingPx, moleculeAtomLabelPaddingCommandId, atomLabelsDisabled)}
      {numericControl("Bond clearance", atomLabels?.values.bondClearancePx.value, atomLabels?.values.bondClearancePx.mixed, moleculeAtomLabelNumberRanges.bondClearancePx, moleculeAtomLabelBondClearanceCommandId, atomLabelsDisabled)}
      <label className="molecule-inspector-field">
        <span>Alignment</span>
        <select
          value={atomLabels?.values.alignment.mixed ? "mixed" : atomLabels?.values.alignment.value ?? "automatic"}
          disabled={atomLabelsDisabled}
          aria-label="Atom label alignment"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.currentTarget.value !== "mixed") {
              invokeOrCommit(moleculeAtomLabelAlignmentCommandId(event.currentTarget.value as "automatic" | "left" | "center" | "right"));
            }
          }}
        >
          {atomLabels?.values.alignment.mixed ? <option value="mixed">Mixed</option> : null}
          <option value="automatic">Automatic</option>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
      <label className="molecule-inspector-field">
        <span>Placement</span>
        <select
          value={atomLabels?.values.placement.mixed ? "mixed" : atomLabels?.values.placement.value ?? "automatic"}
          disabled={atomLabelsDisabled}
          aria-label="Atom label placement"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            if (event.currentTarget.value !== "mixed") {
              invokeOrCommit(moleculeAtomLabelPlacementCommandId(event.currentTarget.value as "automatic" | "above" | "below"));
            }
          }}
        >
          {atomLabels?.values.placement.mixed ? <option value="mixed">Mixed</option> : null}
          <option value="automatic">Automatic</option>
          <option value="above">Above</option>
          <option value="below">Below</option>
        </select>
      </label>
      <MoleculeInspectorCheckbox
        label="Terminal carbon labels"
        value={atomLabels?.values.showTerminalCarbons.value}
        mixed={atomLabels?.values.showTerminalCarbons.mixed}
        disabled={atomLabelsDisabled}
        commandId={moleculeAtomLabelShowTerminalCarbonsCommandId}
        onInvoke={invokeOrCommit}
      />
      <MoleculeInspectorCheckbox
        label="Hide implicit hydrogens"
        value={atomLabels?.values.hideImplicitHydrogens.value}
        mixed={atomLabels?.values.hideImplicitHydrogens.mixed}
        disabled={atomLabelsDisabled}
        commandId={moleculeAtomLabelHideImplicitHydrogensCommandId}
        onInvoke={invokeOrCommit}
      />
    </div>
  );
  const templateTargetCount = currentMoleculeInspector?.targets.moleculeObjectIds.length ?? 0;
  const templatesDisabled = templateTargetCount === 0;
  const templatesPanel = (
    <div className="molecule-inspector-panel-body" data-molecule-inspector-section="templates">
      <div className="molecule-inspector-target-row">
        <span className="molecule-inspector-target-label">Templates</span>
        <span className="molecule-inspector-target-key">
          {templateTargetCount > 0
            ? `${templateTargetCount} molecule${templateTargetCount === 1 ? "" : "s"}`
            : "No molecule"}
        </span>
      </div>
      {templatesDisabled ? <p className="molecule-inspector-empty-message">Select a molecule to apply or export Molecule Inspector settings.</p> : null}
      <div className="molecule-inspector-template-actions">
        <button
          type="button"
          className="toolbar-text-button molecule-inspector-template-button"
          data-command-id={moleculeInspectorTemplateImportCommandId}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onInvoke(moleculeInspectorTemplateImportCommandId)}
        >
          Load
        </button>
        <button
          type="button"
          className="toolbar-text-button molecule-inspector-template-button"
          disabled={templatesDisabled}
          data-command-id={moleculeInspectorTemplateExportCommandId}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onInvoke(moleculeInspectorTemplateExportCommandId)}
        >
          Export
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="molecule-inspector-controls"
      data-toolbar-style-controls="molecule-inspector"
      data-molecule-inspector-active-tab={activeTab}
    >
      <div className="molecule-inspector-tab-rail" role="tablist" aria-orientation="vertical">
        {([
          ["structure", "Structure"],
          ["atom-labels", "Atom Labels"],
          ["templates", "Templates"]
        ] as const).map(([tabId, label]) => (
          <button
            type="button"
            id={`molecule-inspector-tab-${tabId}`}
            className={["molecule-inspector-tab", activeTab === tabId ? "active" : ""].filter(Boolean).join(" ")}
            role="tab"
            aria-selected={activeTab === tabId}
            aria-controls={`molecule-inspector-panel-${tabId}`}
            tabIndex={activeTab === tabId ? 0 : -1}
            data-palette-control="true"
            key={tabId}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => handleTabKeyDown(event, tabId)}
            onClick={() => changeTab(tabId)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="molecule-inspector-tab-panel"
        id={`molecule-inspector-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`molecule-inspector-tab-${activeTab}`}
      >
        {activeTab === "structure"
          ? structurePanel
          : activeTab === "atom-labels" ? atomLabelsPanel : templatesPanel}
      </div>
    </div>
  );
}

function MoleculeInspectorCheckbox({
  commandId,
  disabled,
  label,
  mixed,
  onInvoke,
  value
}: {
  commandId: (value: boolean) => string;
  disabled: boolean;
  label: string;
  mixed?: boolean;
  onInvoke: (commandId: string) => void;
  value: boolean | null | undefined;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = mixed === true;
    }
  }, [mixed]);
  const checked = mixed ? false : value === true;
  return (
    <label className="molecule-inspector-field molecule-inspector-checkbox-field">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        data-palette-control="true"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={() => onInvoke(commandId(mixed ? true : !checked))}
      />
      <span>{label}</span>
    </label>
  );
}

function formatInspectorNumber(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "";
}

function fallbackFontFamilyOptions(current: string | null | undefined): SystemFontFamily[] {
  const options = [
    current,
    ...textFontCommands.map((command) => command.fontFamily),
    "Arial",
    "Helvetica",
    "Times New Roman",
    "Courier New",
    "sans-serif",
    "serif",
    "monospace"
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(options)].map((family) => ({ family, faces: defaultFontFaces() }));
}

function fontFacesForFamily(
  families: readonly SystemFontFamily[],
  currentFamily: string | undefined,
  currentFace: SystemFontFace | null | undefined
): SystemFontFace[] {
  const faces = families.find((family) => family.family === currentFamily)?.faces ?? defaultFontFaces();
  const currentFacePresent = currentFace
    ? faces.some((face) => face.weight === currentFace.weight && face.style === currentFace.style)
    : true;
  return (currentFace && !currentFacePresent ? [...faces, currentFace] : faces)
    .sort((left, right) => left.weight - right.weight || left.style.localeCompare(right.style));
}

function fontFaceLabel(weight: number, style: "normal" | "italic"): string {
  const weightLabel = weight === 400
    ? "Regular"
    : weight === 700
      ? "Bold"
      : `Weight ${weight}`;
  return style === "italic" ? `${weightLabel} Italic` : weightLabel;
}

function ArtToolbarStyleControls() {
  const {
    currentObjectColor,
    currentArtStyle,
    currentArtStyleTarget = "fill",
    onColorPickerOpenChange,
    onRequestColorPopover,
    onArtStylePreview: onPreview,
    onArtStyleCommit: onCommit,
    onArtStyleCancel: onCancel,
    onInvoke
  } = useToolbarWidgetState();
  const selectedCount = currentArtStyle?.selectedCount ?? 0;
  const selected = selectedCount > 0;
  const fillSupportedCount = currentArtStyle?.fillSupportedCount ?? 0;
  const strokeSupportedCount = currentArtStyle?.strokeSupportedCount ?? 0;
  const dashSupportedCount = currentArtStyle?.dashSupportedCount ?? 0;
  const lineEndsSupportedCount = currentArtStyle?.lineEndsSupportedCount ?? 0;
  const cornersSupportedCount = currentArtStyle?.cornersSupportedCount ?? 0;
  const supportsFill = currentArtStyle?.supportsFillAny ?? false;
  const supportsStroke = currentArtStyle?.supportsStrokeAny ?? false;
  const supportsDash = currentArtStyle?.supportsDashAny ?? false;
  const supportsLineEnds = currentArtStyle?.supportsLineEndsAny ?? false;
  const supportsCorners = currentArtStyle?.supportsCornersAny ?? false;
  const supportsFillAll = currentArtStyle?.supportsFillAll ?? false;
  const supportsStrokeAll = currentArtStyle?.supportsStrokeAll ?? false;
  const supportsDashAll = currentArtStyle?.supportsDashAll ?? false;
  const supportsLineEndsAll = currentArtStyle?.supportsLineEndsAll ?? false;
  const supportsCornersAll = currentArtStyle?.supportsCornersAll ?? false;
  const isMoleculeRingArtTarget = currentArtStyle?.appearanceTarget.kind === "molecule-rings";
  const effectiveArtStyleTarget: ToolsetArtPaintTarget = currentArtStyle?.activePaintTarget ?? currentArtStyleTarget;
  const activeTargetSupported = effectiveArtStyleTarget === "fill" ? supportsFill : supportsStroke;
  const supportsStrokeWidth = supportsStroke && supportsDash;
  const activeColor = effectiveArtStyleTarget === "fill"
    ? currentArtStyle?.values.fillColor.value
    : currentArtStyle?.values.strokeColor.value;
  const currentColor = normalizeHexColor(activeColor ?? currentObjectColor) ?? objectColorCommands[0]?.color ?? "#111111";
  const activePaintTypeValue = effectiveArtStyleTarget === "fill"
    ? currentArtStyle?.values.fillPaintType.value
    : currentArtStyle?.values.strokePaintType.value;
  const activePaintTypeMixed = effectiveArtStyleTarget === "fill"
    ? currentArtStyle?.values.fillPaintType.mixed ?? false
    : currentArtStyle?.values.strokePaintType.mixed ?? false;
  const activePaintTypeCommandId = activePaintTypeMixed
    ? "object.paint.type.mixed"
    : objectPaintTypeCommandId(activePaintTypeValue ?? "solid");
  const activePaintTypeCommands = objectPaintTypeCommands.filter((command) => {
    if (isMoleculeRingArtTarget) {
      return command.paintType === "none" || command.paintType === "solid";
    }
    return effectiveArtStyleTarget === "fill" || command.paintType !== "gloss";
  });
  const colorPickerRef = useRef<HTMLDivElement | null>(null);
  const effectColorPickerRef = useRef<HTMLDivElement | null>(null);
  const gradientRailRef = useRef<HTMLDivElement | null>(null);
  const gradientStopColorPickerRef = useRef<HTMLDivElement | null>(null);
  const gradientStopDragRef = useRef<{ stopIndex: number; moved: boolean } | null>(null);
  const sliderDragRef = useRef<{ sliderKey: string; pointerId: number } | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [effectColorOpen, setEffectColorOpen] = useState(false);
  const [draftColor, setDraftColor] = useState(currentColor);
  const [draftEffectColor, setDraftEffectColor] = useState("#52616b");
  const [focusedEffectKind, setFocusedEffectKind] = useState<ArtInspectorEffectKind | undefined>();
  const [selectedGradientStopIndex, setSelectedGradientStopIndex] = useState(0);
  const [gradientStopColorOpen, setGradientStopColorOpen] = useState(false);
  const [draftGradientStopColor, setDraftGradientStopColor] = useState("#111111");
  const selectedStyleObjectIdsKey = currentArtStyle?.selectedObjectIds.join("\u0000") ?? "";
  const objectOpacity = currentArtStyle?.values.objectOpacity.value ?? 1;
  const fillOpacity = currentArtStyle?.values.fillOpacity.value ?? 1;
  const strokeOpacity = currentArtStyle?.values.strokeOpacity.value ?? 1;
  const activeEffectValue = currentArtStyle?.values.effect.value ?? "none";
  const activeEffectKinds = currentArtStyle?.effectKinds ?? [];
  const activeEffectKindsKey = activeEffectKinds.join("|");
  const visibleEffectKind = focusedEffectKind && (activeEffectKinds.includes(focusedEffectKind) || selected)
    ? focusedEffectKind
    : activeEffectValue === "shadow" || activeEffectValue === "glow" || activeEffectValue === "sketch"
      ? activeEffectValue
      : activeEffectKinds[0];
  const visibleEffectModel = visibleEffectKind ? currentArtStyle?.effectControls[visibleEffectKind] : undefined;
  const currentEffectColor = visibleEffectModel?.color.value ?? "#52616b";
  const effectOpacity = visibleEffectModel?.opacity.value ?? 1;
  const effectSize = visibleEffectModel?.size.value ?? 0.25;
  const showEffectControls = selected && visibleEffectKind !== undefined && (visibleEffectModel?.presentCount ?? 0) > 0;
  const strokeWidthCommandId = closestObjectStrokeWidthCommandId(currentArtStyle?.values.strokeWidth.value ?? undefined);
  const strokeDashCommandId = objectStrokeDashCommandId(currentArtStyle?.values.dash.value ?? undefined);
  const strokeCap = currentArtStyle?.values.lineEnds.value ?? "butt";
  const strokeJoin = currentArtStyle?.values.corners.value ?? "miter";
  const activeGradient = currentArtStyle?.activeGradient;
  const showGradientControls = selected && activeTargetSupported && Boolean(activeGradient?.editable || activeGradient?.mixed);
  const activeGradientStops = activeGradient?.stops ?? [];
  const activeGradientStopsKey = activeGradientStops
    .map((stop) => `${stop.offset}:${stop.color}:${stop.opacity}`)
    .join("|");
  const activeGradientStopIndex = activeGradientStops.length > 0
    ? Math.min(selectedGradientStopIndex, activeGradientStops.length - 1)
    : 0;
  const activeGradientStop = activeGradientStops[activeGradientStopIndex];
  const currentGradientStopColor = activeGradientStop?.color ?? currentColor;
  const currentGradientStopOpacity = activeGradientStop?.opacity ?? 1;
  const currentGradientStopOffset = activeGradientStop?.offset ?? 0;
  const showGradientStopEditor = showGradientControls && activeGradient?.editable === true && activeGradientStop !== undefined;
  const supportTitle = (label: string, supportedCount: number, supportsAll = supportedCount === selectedCount) =>
    selected && supportedCount > 0 && !supportsAll
      ? `${label} applies to ${supportedCount} of ${selectedCount} selected graphics`
      : label;
  const strokeWidthControl = supportsStrokeWidth ? (
    <label className="toolbar-control-label art-stroke-width-control art-stroke-control">
      <select
        className="toolbar-select"
        value={strokeWidthCommandId}
        aria-label="Stroke width"
        disabled={!selected}
        title={supportTitle("Stroke width", strokeSupportedCount, supportsStrokeAll)}
        data-palette-control="true"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onInvoke(event.currentTarget.value)}
      >
        {objectStrokeWidthCommands.map((command) => (
          <option key={command.id} value={command.id}>
            {command.strokeWidth}px
          </option>
        ))}
      </select>
    </label>
  ) : null;
  const strokeDashControl = supportsDash && effectiveArtStyleTarget === "stroke" ? (
    <label className="toolbar-control-label art-stroke-dash-control art-stroke-control">
      <select
        className="toolbar-select"
        value={strokeDashCommandId}
        aria-label="Dash pattern"
        disabled={!selected}
        title={supportTitle("Dash pattern", dashSupportedCount, supportsDashAll)}
        data-palette-control="true"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onInvoke(event.currentTarget.value)}
      >
        {objectStrokeDashCommands.map((command) => (
          <option key={command.id} value={command.id}>
            {command.title.replace(" Stroke", "")}
          </option>
        ))}
      </select>
    </label>
  ) : null;
  const gradientRailStyle = {
    "--art-gradient-rail": activeGradientStops.length > 0
      ? artGradientRailCss(activeGradientStops)
      : "repeating-linear-gradient(135deg, var(--cd-bg-control) 0 5px, var(--cd-border-subtle) 5px 10px)"
  } as CSSProperties;
  const showAdvancedStrokeControls = false;

  useEffect(() => {
    onColorPickerOpenChange?.(colorOpen || effectColorOpen || gradientStopColorOpen);
  }, [colorOpen, effectColorOpen, gradientStopColorOpen, onColorPickerOpenChange]);

  useEffect(() => {
    if (!colorOpen) {
      setDraftColor(currentColor);
    }
  }, [colorOpen, currentColor]);

  useEffect(() => {
    if (!gradientStopColorOpen) {
      setDraftGradientStopColor(currentGradientStopColor);
    }
  }, [currentGradientStopColor, gradientStopColorOpen]);

  useEffect(() => {
    if (!effectColorOpen) {
      setDraftEffectColor(currentEffectColor);
    }
  }, [currentEffectColor, effectColorOpen]);

  useEffect(() => {
    const maxIndex = activeGradientStops.length - 1;
    setSelectedGradientStopIndex((current) => maxIndex < 0 ? 0 : Math.max(0, Math.min(maxIndex, current)));
  }, [activeGradientStops.length, activeGradientStopsKey]);

  useEffect(() => {
    if (!colorOpen && !effectColorOpen && !gradientStopColorOpen) {
      return undefined;
    }

    const closeForOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && colorPickerRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Node && effectColorPickerRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Node && gradientStopColorPickerRef.current?.contains(target)) {
        return;
      }
      setColorOpen(false);
      setEffectColorOpen(false);
      setGradientStopColorOpen(false);
    };
    const closeForEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setColorOpen(false);
      setEffectColorOpen(false);
      setGradientStopColorOpen(false);
      onCancel?.();
    };
    const closeForWindowBlur = () => {
      setColorOpen(false);
      setEffectColorOpen(false);
      setGradientStopColorOpen(false);
    };

    document.addEventListener("pointerdown", closeForOutsidePointer, true);
    document.addEventListener("keydown", closeForEscape, true);
    window.addEventListener("blur", closeForWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePointer, true);
      document.removeEventListener("keydown", closeForEscape, true);
      window.removeEventListener("blur", closeForWindowBlur);
    };
  }, [colorOpen, effectColorOpen, gradientStopColorOpen, onCancel]);

  useEffect(() => {
    setColorOpen(false);
    setEffectColorOpen(false);
    setGradientStopColorOpen(false);
  }, [selectedStyleObjectIdsKey]);

  useEffect(() => {
    setFocusedEffectKind((current) => {
      if (current && activeEffectKinds.includes(current)) {
        return current;
      }
      return activeEffectValue === "shadow" || activeEffectValue === "glow" || activeEffectValue === "sketch"
        ? activeEffectValue
        : activeEffectKinds[0];
    });
  }, [activeEffectKindsKey, activeEffectValue]);

  const invokeOrCommit = (commandId: string) => {
    if (onCommit) {
      onCommit(commandId);
      return;
    }
    onInvoke(commandId);
  };

  const previewCommand = (commandId: string) => {
    onPreview?.(commandId);
  };

  const updateColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    setDraftColor(normalized);
    previewCommand(objectCustomColorCommandId(normalized));
  };

  const commitColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    setDraftColor(normalized);
    invokeOrCommit(objectCustomColorCommandId(normalized));
  };

  const updateEffectColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !visibleEffectKind) {
      return;
    }
    setDraftEffectColor(normalized);
    previewCommand(objectEffectColorCommandId(visibleEffectKind, normalized));
  };

  const commitEffectColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !visibleEffectKind) {
      return;
    }
    setDraftEffectColor(normalized);
    invokeOrCommit(objectEffectColorCommandId(visibleEffectKind, normalized));
  };

  const updateGradientStopColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !activeGradientStop) {
      return;
    }
    setDraftGradientStopColor(normalized);
    previewCommand(objectGradientStopColorCommandId(activeGradientStopIndex, normalized));
  };

  const commitGradientStopColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !activeGradientStop) {
      return;
    }
    setDraftGradientStopColor(normalized);
    invokeOrCommit(objectGradientStopColorCommandId(activeGradientStopIndex, normalized));
  };

  const gradientStopOffsetForClientX = (stopIndex: number, clientX: number): number | undefined => {
    const railRect = gradientRailRef.current?.getBoundingClientRect();
    if (!railRect || railRect.width <= 0) {
      return undefined;
    }
    const rawOffset = Math.max(0, Math.min(1, (clientX - railRect.left) / railRect.width));
    const previousStop = activeGradientStops[stopIndex - 1];
    const nextStop = activeGradientStops[stopIndex + 1];
    const minimumOffset = previousStop
      ? Math.min(1, previousStop.offset + GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 0;
    const maximumOffset = nextStop
      ? Math.max(0, nextStop.offset - GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 1;
    if (minimumOffset > maximumOffset) {
      return rawOffset;
    }
    return Math.max(minimumOffset, Math.min(maximumOffset, rawOffset));
  };

  const previewGradientStopOffset = (stopIndex: number, clientX: number): boolean => {
    const offset = gradientStopOffsetForClientX(stopIndex, clientX);
    if (offset === undefined) {
      return false;
    }
    previewCommand(objectGradientStopOffsetCommandId(stopIndex, offset));
    return true;
  };

  const commitGradientStopOffset = (stopIndex: number, clientX: number): boolean => {
    const offset = gradientStopOffsetForClientX(stopIndex, clientX);
    if (offset === undefined) {
      return false;
    }
    invokeOrCommit(objectGradientStopOffsetCommandId(stopIndex, offset));
    return true;
  };

  const applyGradientStopOffsetKey = (
    stopIndex: number,
    currentOffset: number,
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) => {
    let nextOffset = currentOffset;
    if (event.key === "Home") {
      nextOffset = 0;
    } else if (event.key === "End") {
      nextOffset = 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextOffset = currentOffset - (event.shiftKey ? 0.1 : 0.01);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextOffset = currentOffset + (event.shiftKey ? 0.1 : 0.01);
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const previousStop = activeGradientStops[stopIndex - 1];
    const nextStop = activeGradientStops[stopIndex + 1];
    const minimumOffset = previousStop
      ? Math.min(1, previousStop.offset + GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 0;
    const maximumOffset = nextStop
      ? Math.max(0, nextStop.offset - GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 1;
    const clampedOffset = minimumOffset <= maximumOffset
      ? Math.max(minimumOffset, Math.min(maximumOffset, nextOffset))
      : Math.max(0, Math.min(1, nextOffset));
    invokeOrCommit(objectGradientStopOffsetCommandId(stopIndex, clampedOffset));
  };

  const opacitySlider = (
    label: string,
    shortLabel: string,
    value: number,
    commandId: (opacity: number) => string,
    supportedCount = selectedCount
  ) => {
    const percent = Math.round(value * 100);
    const sliderKey = label.toLowerCase().replace(/\s+/g, "-");
    const applySliderPercent = (nextPercent: number, commit: boolean) => {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(nextPercent)));
      const command = commandId(normalizedPercent / 100);
      if (commit) {
        invokeOrCommit(command);
      } else {
        previewCommand(command);
      }
    };
    const sliderOwnsPointer = (event: ReactPointerEvent<HTMLInputElement>) =>
      sliderDragRef.current?.sliderKey === sliderKey && sliderDragRef.current.pointerId === event.pointerId;
    const applySliderPointer = (event: ReactPointerEvent<HTMLInputElement>, commit: boolean) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const nextPercent = rect.width > 0 ? (event.clientX - rect.left) / rect.width * 100 : percent;
      event.currentTarget.value = `${Math.max(0, Math.min(100, Math.round(nextPercent)))}`;
      applySliderPercent(nextPercent, commit);
    };
    const applySliderKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const currentPercent = Number(event.currentTarget.value);
      const basePercent = Number.isFinite(currentPercent) ? currentPercent : percent;
      let nextPercent = basePercent;
      if (event.key === "Home") {
        nextPercent = 0;
      } else if (event.key === "End") {
        nextPercent = 100;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextPercent = basePercent - (event.shiftKey ? 10 : 1);
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextPercent = basePercent + (event.shiftKey ? 10 : 1);
      } else {
        return;
      }
      event.preventDefault();
      event.currentTarget.value = `${Math.max(0, Math.min(100, Math.round(nextPercent)))}`;
      applySliderPercent(nextPercent, true);
    };
    return (
      <label className="art-inspector-slider" data-art-inspector-slider={sliderKey}>
        <span className="art-inspector-slider-header">
          <span className="art-inspector-slider-label">{shortLabel}</span>
          <span className="art-inspector-slider-value">{percent}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          disabled={!selected || supportedCount === 0}
          aria-label={label}
          title={`${supportTitle(label, supportedCount)}: ${percent}%`}
          data-palette-control="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            sliderDragRef.current = { sliderKey, pointerId: event.pointerId };
            if (typeof event.currentTarget.setPointerCapture === "function") {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            applySliderPointer(event, false);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1 && sliderOwnsPointer(event)) {
              applySliderPointer(event, false);
            }
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            if (!sliderOwnsPointer(event)) {
              return;
            }
            if (
              typeof event.currentTarget.hasPointerCapture === "function" &&
              event.currentTarget.hasPointerCapture(event.pointerId) &&
              typeof event.currentTarget.releasePointerCapture === "function"
            ) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            sliderDragRef.current = null;
            applySliderPointer(event, true);
          }}
          onPointerCancel={(event) => {
            if (sliderOwnsPointer(event)) {
              if (
                typeof event.currentTarget.hasPointerCapture === "function" &&
                event.currentTarget.hasPointerCapture(event.pointerId) &&
                typeof event.currentTarget.releasePointerCapture === "function"
              ) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              sliderDragRef.current = null;
            }
          }}
          onChange={(event) => {
            if (sliderDragRef.current?.sliderKey === sliderKey) {
              previewCommand(commandId(Number(event.currentTarget.value) / 100));
            }
          }}
          onKeyDown={applySliderKey}
          onBlur={() => {
            if (sliderDragRef.current?.sliderKey === sliderKey) {
              sliderDragRef.current = null;
            }
          }}
        />
      </label>
    );
  };

  return (
    <div
      className="art-toolbar-style-controls"
      data-toolbar-style-controls="art"
      data-art-selection-count={currentArtStyle?.selectedCount ?? 0}
      data-art-fill-supported-count={fillSupportedCount}
      data-art-stroke-supported-count={strokeSupportedCount}
      data-art-dash-supported-count={dashSupportedCount}
      data-art-line-ends-supported-count={lineEndsSupportedCount}
      data-art-corners-supported-count={cornersSupportedCount}
      data-art-appearance-target={currentArtStyle?.appearanceTarget.kind ?? "none"}
      data-art-fill-support-all={currentArtStyle?.supportsFillAll ?? false}
      data-art-stroke-support-all={currentArtStyle?.supportsStrokeAll ?? false}
      data-art-dash-support-all={currentArtStyle?.supportsDashAll ?? false}
      data-art-line-ends-support-all={currentArtStyle?.supportsLineEndsAll ?? false}
      data-art-corners-support-all={currentArtStyle?.supportsCornersAll ?? false}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel?.();
          setColorOpen(false);
        }
      }}
    >
      <div className="art-inspector-row art-inspector-main-row">
        <div className="art-target-toggle" role="group" aria-label="Art paint target">
          {supportsFill ? (
            <button
              type="button"
              className={effectiveArtStyleTarget === "fill" ? "active" : ""}
              aria-label="Target fill"
              title={supportTitle("Target fill color", fillSupportedCount, supportsFillAll)}
              disabled={!selected}
              data-command-id="object.style.target.fill"
              data-palette-control="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onInvoke("object.style.target.fill")}
            >
              <span className="art-target-fill-glyph" aria-hidden="true" />
            </button>
          ) : null}
          {supportsStroke ? (
            <button
              type="button"
              className={effectiveArtStyleTarget === "stroke" ? "active" : ""}
              aria-label="Target stroke"
              title={supportTitle("Target stroke color", strokeSupportedCount, supportsStrokeAll)}
              disabled={!selected}
              data-command-id="object.style.target.stroke"
              data-palette-control="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onInvoke("object.style.target.stroke")}
            >
              <span className="art-target-stroke-glyph" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <label
          className="toolbar-control-label art-paint-type-control"
          title={`${effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"} paint type`}
        >
          <select
            className="toolbar-select"
            value={activePaintTypeCommandId}
            aria-label={`${effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"} paint type`}
            disabled={!selected || !activeTargetSupported}
            data-art-paint-type-select={effectiveArtStyleTarget}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {activePaintTypeMixed ? (
              <option value="object.paint.type.mixed">Mixed</option>
            ) : null}
            {activePaintTypeCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.label}
              </option>
            ))}
          </select>
        </label>
        <div
          className="art-color-picker"
          role="group"
          aria-label={`${effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"} color`}
          ref={colorPickerRef}
          data-color-picker="true"
          data-palette-control="true"
        >
          <button
            type="button"
            className="toolbar-color-trigger"
            aria-label="Open object color picker"
            aria-expanded={colorOpen}
            disabled={!selected || !activeTargetSupported}
            title={`Pick ${supportTitle(
              effectiveArtStyleTarget,
              effectiveArtStyleTarget === "fill" ? fillSupportedCount : strokeSupportedCount,
              effectiveArtStyleTarget === "fill" ? supportsFillAll : supportsStrokeAll
            )} color`}
            style={{ "--picker-color": currentColor } as CSSProperties}
            onClick={(event) => {
              // Native palettes hand the swatch's client rect up so the picker opens in its own
              // floating window (overflows the little palette, floats over the document). Web /
              // docked palettes fall through to the inline popover.
              if (onRequestColorPopover) {
                const rect = event.currentTarget.getBoundingClientRect();
                onRequestColorPopover({
                  left: rect.left,
                  top: rect.top,
                  right: rect.right,
                  bottom: rect.bottom
                });
                return;
              }
              setEffectColorOpen(false);
              setGradientStopColorOpen(false);
              setColorOpen((open) => !open);
            }}
          >
            <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
            <span className="toolbar-color-trigger-label">{effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"}</span>
          </button>
          {colorOpen && !onRequestColorPopover ? (
            <div className="art-color-popover" role="dialog" aria-label="Art color picker">
              <ColorPickerPopoverBody
                activeColor={currentColor}
                value={draftColor}
                onCommitColor={commitColor}
                onPreviewColor={updateColor}
              />
            </div>
          ) : null}
        </div>
        {strokeDashControl}
        <button
          type="button"
          className="art-inspector-symbol-button"
          aria-label={effectiveArtStyleTarget === "fill" ? "No fill" : "No stroke"}
          title={effectiveArtStyleTarget === "fill"
            ? supportTitle("No fill", fillSupportedCount, supportsFillAll)
            : supportTitle("No stroke", strokeSupportedCount, supportsStrokeAll)}
          disabled={!selected || !activeTargetSupported}
          data-command-id={effectiveArtStyleTarget === "fill" ? "object.style.fill.none" : "object.style.stroke.none"}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onInvoke(effectiveArtStyleTarget === "fill" ? "object.style.fill.none" : "object.style.stroke.none")}
        >
          ∅
        </button>
        {!isMoleculeRingArtTarget ? (
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Swap fill and stroke"
            title="Swap fill and stroke"
            disabled={!selected || !supportsFill || !supportsStroke}
            data-command-id="object.style.swapFillStroke"
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke("object.style.swapFillStroke")}
          >
            ⇄
          </button>
        ) : null}
        <div className="art-effect-button-group" role="group" aria-label="Art effects">
          {objectEffectCommands.map((command) => {
            const effectKind = command.effectKind;
            const active = effectKind !== "none" && activeEffectKinds.includes(effectKind);
            return (
              <button
                type="button"
                key={command.id}
                className={active ? "active" : ""}
                aria-pressed={active}
                aria-label={command.title}
                title={command.title}
                disabled={!selected}
                data-command-id={command.id}
                data-art-effect-button={effectKind}
                data-palette-control="true"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (effectKind !== "none") {
                    setFocusedEffectKind(effectKind);
                    if (!active) {
                      onInvoke(command.id);
                    }
                    return;
                  }

                  setFocusedEffectKind(undefined);
                  setEffectColorOpen(false);
                  onInvoke(command.id);
                }}
                onDoubleClick={() => {
                  if (effectKind === "none" || !active) {
                    return;
                  }

                  setFocusedEffectKind(undefined);
                  setEffectColorOpen(false);
                  onInvoke(objectEffectDisableCommandId(effectKind));
                }}
              >
                {command.label}
              </button>
            );
          })}
        </div>
        {strokeWidthControl}
      </div>
      <div className="art-inspector-row art-inspector-opacity-row">
        {!isMoleculeRingArtTarget ? opacitySlider("Object opacity", "Obj", objectOpacity, objectOpacityCommandId) : null}
        {supportsFill ? opacitySlider("Fill opacity", "Fill", fillOpacity, objectFillOpacityCommandId, fillSupportedCount) : null}
        {supportsStroke ? opacitySlider("Stroke opacity", "Stroke", strokeOpacity, objectStrokeOpacityCommandId, strokeSupportedCount) : null}
      </div>
      {showEffectControls && visibleEffectKind ? (
        <div
          className="art-inspector-row art-effect-row"
          data-art-effect-controls={visibleEffectKind}
          data-art-effect-present-count={visibleEffectModel?.presentCount ?? 0}
          data-art-effect-present-all={visibleEffectModel?.presentAll ?? false}
        >
          <div
            className="art-color-picker art-effect-color-picker"
            role="group"
            aria-label={`${effectLabel(visibleEffectKind)} effect color`}
            ref={effectColorPickerRef}
            data-color-picker="true"
            data-palette-control="true"
          >
            <button
              type="button"
              className="toolbar-color-trigger art-effect-color-trigger"
              aria-label={`Open ${effectLabel(visibleEffectKind)} effect color picker`}
              aria-expanded={effectColorOpen}
              title={`${effectLabel(visibleEffectKind)} effect color`}
              data-art-effect-color-trigger={visibleEffectKind}
              data-palette-control="true"
              style={{ "--picker-color": currentEffectColor } as CSSProperties}
              onClick={() => {
                setColorOpen(false);
                setGradientStopColorOpen(false);
                setEffectColorOpen((open) => !open);
              }}
            >
              <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
              <span className="toolbar-color-trigger-label">Effect</span>
            </button>
            {effectColorOpen ? (
              <div
                className="art-color-popover art-effect-color-popover"
                role="dialog"
                aria-label={`${effectLabel(visibleEffectKind)} effect color picker`}
              >
                <ColorPickerPopoverBody
                  activeColor={currentEffectColor}
                  value={draftEffectColor}
                  onCommitColor={commitEffectColor}
                  onPreviewColor={updateEffectColor}
                />
              </div>
            ) : null}
          </div>
          {opacitySlider(
            `${effectLabel(visibleEffectKind)} effect opacity`,
            "Eff",
            effectOpacity,
            (opacity) => objectEffectOpacityCommandId(visibleEffectKind, opacity),
            visibleEffectModel?.presentCount ?? 0
          )}
          {opacitySlider(
            `${effectLabel(visibleEffectKind)} effect size`,
            "Size",
            effectSize,
            (size) => objectEffectSizeCommandId(visibleEffectKind, size),
            visibleEffectModel?.presentCount ?? 0
          )}
        </div>
      ) : null}
      {showGradientControls ? (
        <div className="art-inspector-row art-gradient-row" data-art-gradient-controls={effectiveArtStyleTarget}>
          <div
            ref={gradientRailRef}
            className="art-gradient-rail"
            data-art-gradient-rail={effectiveArtStyleTarget}
            data-art-gradient-type={activeGradient?.paintType ?? undefined}
            data-art-gradient-mixed={activeGradient?.mixed ? "true" : undefined}
            style={gradientRailStyle}
          >
            {activeGradientStops.map((stop, index) => (
              <button
                type="button"
                key={`gradient-stop-${index}`}
                className={[
                  "art-gradient-stop-marker",
                  index === activeGradientStopIndex ? "active" : ""
                ].filter(Boolean).join(" ")}
                aria-label={`Drag gradient stop ${index + 1} at ${Math.round(stop.offset * 100)}%`}
                title="Drag to move gradient stop; use arrow keys for 1% nudges"
                data-command-id={objectGradientStopOffsetCommandId(index, stop.offset)}
                data-art-gradient-stop={index}
                data-art-gradient-stop-active={index === activeGradientStopIndex ? "true" : undefined}
                data-palette-control="true"
                style={{
                  "--art-gradient-stop-color": stop.color,
                  "--art-gradient-stop-offset": `${Math.round(stop.offset * 100)}%`,
                  opacity: stop.opacity
                } as CSSProperties}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setSelectedGradientStopIndex(index);
                  setGradientStopColorOpen(false);
                  gradientStopDragRef.current = { stopIndex: index, moved: false };
                  if (typeof event.currentTarget.setPointerCapture === "function") {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }
                }}
                onPointerMove={(event) => {
                  const drag = gradientStopDragRef.current;
                  if (drag?.stopIndex !== index || event.buttons !== 1) {
                    return;
                  }
                  event.stopPropagation();
                  event.preventDefault();
                  if (previewGradientStopOffset(index, event.clientX)) {
                    drag.moved = true;
                  }
                }}
                onPointerUp={(event) => {
                  const drag = gradientStopDragRef.current;
                  event.stopPropagation();
                  if (typeof event.currentTarget.hasPointerCapture === "function" &&
                    event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  if (drag?.stopIndex === index && drag.moved) {
                    commitGradientStopOffset(index, event.clientX);
                  }
                  gradientStopDragRef.current = null;
                }}
                onPointerCancel={(event) => {
                  const drag = gradientStopDragRef.current;
                  if (typeof event.currentTarget.hasPointerCapture === "function" &&
                    event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  gradientStopDragRef.current = null;
                  if (drag?.moved) {
                    onCancel?.();
                  }
                }}
                onKeyDown={(event) => applyGradientStopOffsetKey(index, stop.offset, event)}
                onClick={() => setSelectedGradientStopIndex(index)}
              />
            ))}
          </div>
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Add gradient stop"
            title="Add gradient stop"
            disabled={!activeGradient?.canAddStop}
            data-command-id={objectGradientAddStopCommand.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setSelectedGradientStopIndex(nextInsertedGradientStopIndex(activeGradientStops));
              onInvoke(objectGradientAddStopCommand.id);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Delete selected gradient stop"
            title="Delete selected gradient stop"
            disabled={!activeGradient?.canDeleteStop}
            data-command-id={objectGradientDeleteStopCommandId(activeGradientStopIndex)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setSelectedGradientStopIndex((current) => Math.max(0, current - 1));
              onInvoke(objectGradientDeleteStopCommandId(activeGradientStopIndex));
            }}
          >
            −
          </button>
            <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Reverse gradient stops"
            title="Reverse gradient stops"
            disabled={!activeGradient?.editable}
            data-command-id={objectGradientReverseCommand.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke(objectGradientReverseCommand.id)}
          >
            ⇆
          </button>
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Rotate gradient stops"
            title="Rotate gradient stops"
            disabled={!activeGradient?.editable}
            data-command-id={objectGradientRotateCommand.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke(objectGradientRotateCommand.id)}
          >
            ↻
          </button>
        </div>
      ) : null}
      {showGradientStopEditor ? (
        <div
          className="art-inspector-row art-gradient-stop-editor"
          data-art-gradient-stop-editor={effectiveArtStyleTarget}
          data-art-gradient-active-stop={activeGradientStopIndex}
          data-art-gradient-stop-color={currentGradientStopColor}
          data-art-gradient-stop-offset={currentGradientStopOffset}
        >
          <span className="art-gradient-stop-readout">
            {`Stop ${activeGradientStopIndex + 1} · ${Math.round(currentGradientStopOffset * 100)}%`}
          </span>
          <div
            className="art-color-picker art-gradient-stop-color-picker"
            role="group"
            aria-label="Gradient stop color"
            ref={gradientStopColorPickerRef}
            data-color-picker="true"
            data-palette-control="true"
          >
            <button
              type="button"
              className="toolbar-color-trigger art-gradient-stop-color-trigger"
              aria-label="Open gradient stop color picker"
              aria-expanded={gradientStopColorOpen}
              title="Pick gradient stop color"
              data-art-gradient-stop-color-trigger="true"
              data-palette-control="true"
              style={{ "--picker-color": currentGradientStopColor } as CSSProperties}
              onClick={() => {
                setColorOpen(false);
                setEffectColorOpen(false);
                setGradientStopColorOpen((open) => !open);
              }}
            >
              <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
              <span className="toolbar-color-trigger-label">Stop</span>
            </button>
            {gradientStopColorOpen ? (
              <div className="art-color-popover" role="dialog" aria-label="Gradient stop color picker">
                <ColorPickerPopoverBody
                  activeColor={currentGradientStopColor}
                  value={draftGradientStopColor}
                  onCommitColor={commitGradientStopColor}
                  onPreviewColor={updateGradientStopColor}
                />
              </div>
            ) : null}
          </div>
          {opacitySlider(
            "Gradient stop opacity",
            "Stop",
            currentGradientStopOpacity,
            (opacity) => objectGradientStopOpacityCommandId(activeGradientStopIndex, opacity)
          )}
        </div>
      ) : null}
      {showAdvancedStrokeControls && (supportsLineEnds || supportsCorners) ? (
      <div className="art-inspector-row art-inspector-stroke-row">
        {showAdvancedStrokeControls && supportsLineEnds ? (
        <label className="toolbar-control-label art-stroke-cap-control art-stroke-control">
          <span className="art-stroke-control-label">Line ends</span>
          <select
            className="toolbar-select"
            value={`object.stroke.cap.${strokeCap}`}
            aria-label="Line ends"
            disabled={!selected}
            title={supportTitle("Line ends", lineEndsSupportedCount, supportsLineEndsAll)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {objectStrokeLineCapCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {lineCapLabel(command.strokeLineCap)}
              </option>
            ))}
          </select>
        </label>
        ) : null}
        {showAdvancedStrokeControls && supportsCorners ? (
        <label className="toolbar-control-label art-stroke-join-control art-stroke-control">
          <span className="art-stroke-control-label">Corners</span>
          <select
            className="toolbar-select"
            value={`object.stroke.join.${strokeJoin}`}
            aria-label="Corners"
            disabled={!selected}
            title={supportTitle("Corners", cornersSupportedCount, supportsCornersAll)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {objectStrokeLineJoinCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {lineJoinLabel(command.strokeLineJoin)}
              </option>
            ))}
          </select>
        </label>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

function lineCapLabel(value: "butt" | "round" | "square"): string {
  if (value === "butt") {
    return "Flat";
  }
  if (value === "round") {
    return "Round";
  }
  return "Square";
}

function effectLabel(value: ArtInspectorEffectKind): string {
  if (value === "shadow") {
    return "Shadow";
  }
  if (value === "glow") {
    return "Glow";
  }
  return "Sketch";
}

function lineJoinLabel(value: "miter" | "round" | "bevel"): string {
  if (value === "miter") {
    return "Sharp";
  }
  if (value === "round") {
    return "Round";
  }
  return "Bevel";
}

function artGradientRailCss(stops: readonly { offset: number; color: string; opacity: number }[]): string {
  const stopCss = stops
    .map((stop) => `${hexToRgbaCss(stop.color, stop.opacity)} ${Math.round(stop.offset * 100)}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stopCss})`;
}

function nextInsertedGradientStopIndex(stops: readonly { offset: number }[]): number {
  if (stops.length <= 1) {
    return stops.length;
  }

  let leftIndex = 0;
  let widestGap = -1;
  for (let index = 0; index < stops.length - 1; index += 1) {
    const gap = stops[index + 1]!.offset - stops[index]!.offset;
    if (gap > widestGap) {
      widestGap = gap;
      leftIndex = index;
    }
  }

  return leftIndex + 1;
}

function hexToRgbaCss(color: string, opacity: number): string {
  const normalized = normalizeHexColor(color) ?? "#111111";
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgb(${red} ${green} ${blue} / ${Math.max(0, Math.min(1, opacity))})`;
}

type ColorPickerTab = "color" | "palettes";
type IroColorPickerInstance = ReturnType<typeof iro.ColorPicker>;
type IroColorLike = {
  hexString: string;
};
type ColorPaletteSet = {
  id: string;
  title: string;
  colors: ColorPaletteEntry[];
};
type ColorPaletteEntry = {
  title: string;
  color: string;
};

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface CmykColor {
  c: number;
  m: number;
  y: number;
  k: number;
}

const CRAYOLA_EIGHT_COLORS: ColorPaletteEntry[] = [
  { title: "Crayola red", color: "#ed0a3f" },
  { title: "Crayola orange", color: "#ff8833" },
  { title: "Crayola yellow", color: "#fbe870" },
  { title: "Crayola green", color: "#01a368" },
  { title: "Crayola blue", color: "#0066ff" },
  { title: "Crayola violet", color: "#8359a3" },
  { title: "Crayola brown", color: "#af593e" },
  { title: "Crayola black", color: "#000000" }
];

const COLORBLIND_SAFE_COLORS: ColorPaletteEntry[] = [
  { title: "Colorblind safe black", color: "#000000" },
  { title: "Colorblind safe orange", color: "#e69f00" },
  { title: "Colorblind safe sky blue", color: "#56b4e9" },
  { title: "Colorblind safe bluish green", color: "#009e73" },
  { title: "Colorblind safe yellow", color: "#f0e442" },
  { title: "Colorblind safe blue", color: "#0072b2" },
  { title: "Colorblind safe vermillion", color: "#d55e00" },
  { title: "Colorblind safe purple", color: "#cc79a7" }
];

const SEASONAL_COLORS_BY_SEASON: Record<string, ColorPaletteEntry[]> = {
  spring: [
    { title: "Spring leaf", color: "#78a85a" },
    { title: "Spring moss", color: "#a6c76c" },
    { title: "Spring sky", color: "#8cc7d9" },
    { title: "Spring rain", color: "#5f9eb7" },
    { title: "Spring blossom", color: "#f2a7b5" },
    { title: "Spring lilac", color: "#b89bd8" },
    { title: "Spring cream", color: "#f7e8a4" },
    { title: "Spring soil", color: "#8a6848" }
  ],
  summer: [
    { title: "Summer sun", color: "#f5c542" },
    { title: "Summer marigold", color: "#f28c28" },
    { title: "Summer coral", color: "#ef6f61" },
    { title: "Summer berry", color: "#b8336a" },
    { title: "Summer sea", color: "#1ca7a8" },
    { title: "Summer pool", color: "#3e8ed0" },
    { title: "Summer grass", color: "#55a630" },
    { title: "Summer night", color: "#294c60" }
  ],
  autumn: [
    { title: "Autumn maple", color: "#c0392b" },
    { title: "Autumn pumpkin", color: "#d97706" },
    { title: "Autumn gold", color: "#c49a2c" },
    { title: "Autumn olive", color: "#6f7d35" },
    { title: "Autumn bark", color: "#6b4f3f" },
    { title: "Autumn plum", color: "#7b3f61" },
    { title: "Autumn fog", color: "#9a8f80" },
    { title: "Autumn ink", color: "#2f3e46" }
  ],
  winter: [
    { title: "Winter ice", color: "#d8eef2" },
    { title: "Winter frost", color: "#9bc6d9" },
    { title: "Winter blue", color: "#3b6ea8" },
    { title: "Winter pine", color: "#1f5f4b" },
    { title: "Winter berry", color: "#a41623" },
    { title: "Winter mauve", color: "#8d6a9f" },
    { title: "Winter stone", color: "#7b8794" },
    { title: "Winter charcoal", color: "#263238" }
  ]
};

function colorPickerPaletteSets(now = new Date()): ColorPaletteSet[] {
  const month = now.getMonth();
  const season = month >= 2 && month <= 4
    ? "spring"
    : month >= 5 && month <= 7
      ? "summer"
      : month >= 8 && month <= 10
        ? "autumn"
        : "winter";

  return [
    { id: "crayola", title: "8 color Crayola box", colors: CRAYOLA_EIGHT_COLORS },
    { id: "colorblind", title: "Colorblind safe", colors: COLORBLIND_SAFE_COLORS },
    { id: "seasonal", title: `Seasonal colors: ${season}`, colors: SEASONAL_COLORS_BY_SEASON[season] }
  ];
}

function ColorPickerControl({
  compact = false,
  currentColor,
  customColorCommandId = textCustomColorCommandId,
  label = "Text color",
  triggerLabel = "Open text color picker",
  dialogLabel = "Text color picker",
  onOpenChange,
  onInvoke
}: {
  compact?: boolean;
  currentColor: string;
  customColorCommandId?: (color: string) => string;
  label?: string;
  triggerLabel?: string;
  dialogLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onInvoke: (commandId: string) => void;
}) {
  const normalizedCurrentColor = normalizeHexColor(currentColor) ?? textColorCommands[0].color;
  const [open, setOpen] = useState(false);
  const [draftHex, setDraftHex] = useState(normalizedCurrentColor);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) {
      setDraftHex(normalizedCurrentColor);
    }
  }, [normalizedCurrentColor, open]);

  const setOpenState = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setDraftHex(normalizedCurrentColor);
    }
  };

  const applyColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }

    setDraftHex(normalized);
    onInvoke(customColorCommandId(normalized));
  };

  return (
    <div
      className={["toolbar-color-picker", compact ? "compact" : ""].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
      data-color-picker="true"
      data-palette-control="true"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="toolbar-color-trigger"
        aria-label={triggerLabel}
        aria-expanded={open}
        data-color-picker-trigger="true"
        data-palette-control="true"
        style={{ "--picker-color": normalizedCurrentColor } as CSSProperties}
        onClick={() => setOpenState(!open)}
      >
        <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
        <span className="toolbar-color-trigger-label">Color</span>
      </button>
      {open ? (
        <div className="toolbar-color-popover" role="dialog" aria-label={dialogLabel}>
          <ColorPickerPopoverBody
            activeColor={normalizedCurrentColor}
            value={draftHex}
            onCommitColor={applyColor}
            onPreviewColor={applyColor}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ColorPickerPopoverBody({
  activeColor,
  value,
  onCommitColor,
  onPreviewColor
}: {
  activeColor?: string;
  value: string;
  onCommitColor: (color: string) => void;
  onPreviewColor: (color: string) => void;
}) {
  const normalizedValue = normalizeHexColor(value) ?? "#111111";
  const normalizedActiveColor = normalizeHexColor(activeColor ?? value) ?? normalizedValue;
  const [tab, setTab] = useState<ColorPickerTab>("color");
  const [hexInput, setHexInput] = useState(normalizedValue.toUpperCase());
  const draftRgb = useMemo(() => hexToRgbColor(normalizedValue) ?? { r: 17, g: 17, b: 17 }, [normalizedValue]);
  const draftCmyk = useMemo(() => rgbToCmykColor(draftRgb), [draftRgb]);
  const palettes = useMemo(() => colorPickerPaletteSets(), []);

  useEffect(() => {
    setHexInput(normalizedValue.toUpperCase());
  }, [normalizedValue]);

  const previewColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }

    setHexInput(normalized.toUpperCase());
    onPreviewColor(normalized);
  };

  const commitColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }

    setHexInput(normalized.toUpperCase());
    onCommitColor(normalized);
  };

  const applyAndCommitColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }

    setHexInput(normalized.toUpperCase());
    onPreviewColor(normalized);
    onCommitColor(normalized);
  };

  const updateRgbChannel = (channel: keyof RgbColor, channelValue: string) => {
    applyAndCommitColor(rgbToHexColor({
      ...draftRgb,
      [channel]: clampColorChannel(channelValue)
    }));
  };

  const updateCmykChannel = (channel: keyof CmykColor, channelValue: string) => {
    applyAndCommitColor(rgbToHexColor(cmykToRgbColor({
      ...draftCmyk,
      [channel]: clampPercentChannel(channelValue)
    })));
  };

  const updateHexInput = (nextValue: string) => {
    const cleaned = nextValue.replace(/[^0-9a-f]/gi, "").slice(0, 6);
    const displayValue = `#${cleaned}`.toUpperCase();
    setHexInput(displayValue);
    const normalized = normalizeHexColor(displayValue);
    if (normalized) {
      applyAndCommitColor(normalized);
    }
  };

  return (
    <>
      <div className="color-picker-tabs" role="tablist" aria-label="Color picker mode">
        <button
          type="button"
          className={tab === "color" ? "active" : ""}
          role="tab"
          aria-selected={tab === "color"}
          onClick={() => setTab("color")}
        >
          Color
        </button>
        <button
          type="button"
          className={tab === "palettes" ? "active" : ""}
          role="tab"
          aria-selected={tab === "palettes"}
          onClick={() => setTab("palettes")}
        >
          Palettes
        </button>
      </div>
      {tab === "color" ? (
        <div className="color-picker-color-panel" role="tabpanel" aria-label="Color wheel and channel values">
          <div className="color-picker-wheel-stack">
            <IroColorWheel
              color={normalizedValue}
              onCommitColor={commitColor}
              onPreviewColor={previewColor}
            />
            <label className="color-wheel-control">
              <span className="visually-hidden">System color wheel</span>
              <input
                className="color-wheel-input"
                type="color"
                value={normalizedValue}
                aria-label="System color wheel"
                onChange={(event) => applyAndCommitColor(event.currentTarget.value)}
              />
              <span className="color-wheel-face" aria-hidden="true">
                <span className="color-wheel-current" style={{ "--picker-color": normalizedValue } as CSSProperties} />
              </span>
            </label>
          </div>
          <div className="color-channel-groups">
            <div className="color-channel-group" aria-label="RGB color">
              {(["r", "g", "b"] as const).map((channel) => (
                <label key={channel}>
                  <span>{channel.toUpperCase()}</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={draftRgb[channel]}
                    onChange={(event) => updateRgbChannel(channel, event.currentTarget.value)}
                  />
                </label>
              ))}
            </div>
            <div className="color-channel-group" aria-label="CMYK color">
              {(["c", "m", "y", "k"] as const).map((channel) => (
                <label key={channel}>
                  <span>{channel.toUpperCase()}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={draftCmyk[channel]}
                    onChange={(event) => updateCmykChannel(channel, event.currentTarget.value)}
                  />
                </label>
              ))}
            </div>
            <label className="color-hex-field">
              <span>HEX</span>
              <input
                type="text"
                value={hexInput}
                spellCheck={false}
                onChange={(event) => updateHexInput(event.currentTarget.value)}
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="color-palette-panel" role="tabpanel" aria-label="Color palettes">
          {palettes.map((palette) => (
            <section className="color-palette-section" data-color-palette={palette.id} key={palette.id}>
              <h3>{palette.title}</h3>
              <div className="color-palette-grid">
                {palette.colors.map((entry) => (
                  <ColorPaletteSwatchButton
                    active={normalizeHexColor(entry.color) === normalizedActiveColor}
                    color={entry.color}
                    key={`${palette.id}-${entry.color}`}
                    paletteId={palette.id}
                    title={entry.title}
                    onApply={applyAndCommitColor}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function IroColorWheel({
  color,
  onCommitColor,
  onPreviewColor
}: {
  color: string;
  onCommitColor: (color: string) => void;
  onPreviewColor: (color: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<IroColorPickerInstance | null>(null);
  const onCommitRef = useRef(onCommitColor);
  const onPreviewRef = useRef(onPreviewColor);

  useEffect(() => {
    onCommitRef.current = onCommitColor;
  }, [onCommitColor]);

  useEffect(() => {
    onPreviewRef.current = onPreviewColor;
  }, [onPreviewColor]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const picker = iro.ColorPicker(host, {
      borderColor: "#9eb2ba",
      borderWidth: 1,
      color,
      handleRadius: 6,
      layout: [
        {
          component: iro.ui.Wheel
        },
        {
          component: iro.ui.Slider,
          options: {
            sliderType: "value"
          }
        }
      ],
      margin: 8,
      padding: 3,
      sliderSize: 13,
      width: 112
    });
    pickerRef.current = picker;

    const previewColor = (iroColor: IroColorLike) => {
      const normalized = normalizeHexColor(iroColor.hexString);
      if (normalized) {
        onPreviewRef.current(normalized);
      }
    };
    const commitColor = (iroColor: IroColorLike) => {
      const normalized = normalizeHexColor(iroColor.hexString);
      if (normalized) {
        onCommitRef.current(normalized);
      }
    };

    picker.on("input:change", previewColor);
    picker.on("input:end", commitColor);

    return () => {
      picker.off("input:change", previewColor);
      picker.off("input:end", commitColor);
      pickerRef.current = null;
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    const normalized = normalizeHexColor(color);
    const picker = pickerRef.current;
    if (!normalized || !picker) {
      return;
    }

    if (normalizeHexColor(picker.color.hexString) !== normalized) {
      picker.color.hexString = normalized;
    }
  }, [color]);

  return (
    <div
      ref={hostRef}
      className="iro-color-picker"
      aria-label="Iro color wheel"
      data-palette-control="true"
    />
  );
}

function ColorPaletteSwatchButton({
  active,
  color,
  paletteId,
  title,
  onApply
}: {
  active: boolean;
  color: string;
  paletteId: string;
  title: string;
  onApply: (color: string) => void;
}) {
  const normalizedColor = normalizeHexColor(color) ?? "#111111";

  return (
    <button
      type="button"
      className={["color-palette-swatch", active ? "active" : ""].filter(Boolean).join(" ")}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-color-palette-swatch={paletteId}
      data-palette-control="true"
      style={{ "--swatch-color": normalizedColor } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => onApply(normalizedColor)}
    />
  );
}

export function hexToRgbColor(hex: string): RgbColor | undefined {
  const normalized = normalizeHexColor(hex);
  if (!normalized) {
    return undefined;
  }

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16)
  };
}

export function rgbToHexColor(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbToCmykColor(color: RgbColor): CmykColor {
  const r = clampColorChannel(color.r) / 255;
  const g = clampColorChannel(color.g) / 255;
  const b = clampColorChannel(color.b) / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) {
    return { c: 0, m: 0, y: 0, k: 100 };
  }

  return {
    c: Math.round(((1 - r - k) / (1 - k)) * 100),
    m: Math.round(((1 - g - k) / (1 - k)) * 100),
    y: Math.round(((1 - b - k) / (1 - k)) * 100),
    k: Math.round(k * 100)
  };
}

export function cmykToRgbColor(color: CmykColor): RgbColor {
  const c = clampPercentChannel(color.c) / 100;
  const m = clampPercentChannel(color.m) / 100;
  const y = clampPercentChannel(color.y) / 100;
  const k = clampPercentChannel(color.k) / 100;

  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k))
  };
}

function clampColorChannel(value: string | number): number {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.min(255, Math.max(0, Math.round(numericValue)));
}

function clampPercentChannel(value: string | number): number {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}

function closestLetterSpacingCommandId(letterSpacingPx: number | undefined): string {
  if (letterSpacingPx === undefined) {
    return "text.spacing.normal";
  }

  return textLetterSpacingCommands.reduce((best, command) => (
    Math.abs(command.letterSpacingPx - letterSpacingPx) < Math.abs(best.letterSpacingPx - letterSpacingPx) ? command : best
  ), textLetterSpacingCommands[0]).id;
}

function closestLineHeightCommandId(lineHeight: number | undefined): string {
  if (lineHeight === undefined) {
    return "text.lineHeight.normal";
  }

  return textLineHeightCommands.reduce((best, command) => (
    Math.abs(command.lineHeight - lineHeight) < Math.abs(best.lineHeight - lineHeight) ? command : best
  ), textLineHeightCommands[0]).id;
}

function closestParagraphSpacingCommandId(paragraphSpacingPx: number | undefined): string {
  if (paragraphSpacingPx === undefined) {
    return "text.paragraph.none";
  }

  return textParagraphSpacingCommands.reduce((best, command) => (
    Math.abs(command.paragraphSpacingPx - paragraphSpacingPx) < Math.abs(best.paragraphSpacingPx - paragraphSpacingPx) ? command : best
  ), textParagraphSpacingCommands[0]).id;
}

function ToolbarPaletteItem({
  item,
  activeTool,
  tooltipId,
  tooltipVisible,
  distributeMode,
  onTooltipEnter,
  onTooltipLeave,
  onRequestFlyout,
  onInvoke
}: {
  item: ToolbarPaletteItemModel;
  activeTool?: string;
  tooltipId?: string;
  tooltipVisible?: boolean;
  distributeMode: ToolPaletteDistributeMode;
  onTooltipEnter?: () => void;
  onTooltipLeave?: () => void;
  onRequestFlyout?: (request: ToolbarFlyoutRequest) => void;
  onInvoke: (commandId: string) => void;
}) {
  const primaryCommand = item.primary.type === "command" ? item.primary.command : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const shellRef = useRef<HTMLSpanElement | null>(null);
  useNativeFloatingTooltip(shellRef, Boolean(tooltipVisible) && !menuOpen);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdOpenedRef = useRef(false);
  const pointerInvokedRef = useRef(false);
  const submenu = item.submenu;
  const submenuCommands = submenu?.items ?? [];
  const hasSubmenu = submenu !== null && submenuCommands.length > 0;
  const hasEnabledSubmenuCommand = submenuCommands.some((command) => command.enabled !== false);
  const primaryDisabled = primaryCommand ? primaryCommand.enabled === false : true;
  const buttonDisabled = primaryDisabled && (!hasSubmenu || !hasEnabledSubmenuCommand);
  const usesNativeFlyout = hasSubmenu && Boolean(onRequestFlyout);
  const activeState = primaryCommand?.enabled !== false && (
    primaryCommand?.id === activeTool
    || submenuCommands.some((command) => command.enabled !== false && command.id === activeTool)
  );
  const tooltipText = toolbarTooltipText(item, primaryCommand);
  // Injective sanitization: encode each disallowed char by code point so ids differing only in
  // punctuation (e.g. "plugin.foo:bar" vs "plugin.foo.bar") don't collapse to the same DOM id.
  const menuId = hasSubmenu
    ? `toolbar-submenu-${item.id.replace(/[^A-Za-z0-9_-]/g, (char) => `_${char.charCodeAt(0)}_`)}`
    : undefined;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== undefined) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = undefined;
    }
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  const openMenu = useCallback(() => {
    if (!hasSubmenu) {
      return;
    }

    holdOpenedRef.current = true;
    onTooltipLeave?.();
    if (onRequestFlyout) {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect || !submenu) {
        return;
      }
      onRequestFlyout({
        anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        flyout: {
          flyoutId: submenu.id,
          id: submenu.id,
          type: submenu.type,
          title: submenu.title ?? item.label,
          columns: submenu.columns,
          commands: submenu.items.map((command) => ({
            id: command.id,
            title: command.title,
            assetName: command.assetName,
            icon: command.icon,
            enabled: command.enabled !== false,
            active: command.id === activeTool,
            disabledReason: command.disabledReason,
            shortcutLabel: command.shortcutLabel ?? command.shortcut ?? command.defaultShortcut
          }))
        }
      });
      return;
    }
    setMenuOpen(true);
  }, [activeTool, hasSubmenu, item.label, onRequestFlyout, onTooltipLeave, submenu]);

  const invokePrimary = useCallback(() => {
    if (!primaryCommand || primaryCommand.enabled === false) {
      return;
    }
    onInvoke(primaryCommand.id);
    onTooltipLeave?.();
  }, [onInvoke, onTooltipLeave, primaryCommand]);

  const chooseCommand = useCallback((command: CommandSpec) => {
    if (command.enabled === false) {
      return;
    }
    onInvoke(command.id);
    setMenuOpen(false);
    onTooltipLeave?.();
  }, [onInvoke, onTooltipLeave]);

  useEffect(() => () => {
    clearHoldTimer();
  }, [clearHoldTimer]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (shellRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest("[data-palette-control]")) {
        return;
      }
      setMenuOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  if (primaryCommand && item.submenu === null && isDistributeCommandId(primaryCommand.id)) {
    return (
      <span
        className="toolbar-item-grid-slot"
        style={toolbarItemGridStyle(item.layout)}
        data-toolbar-item-id={item.id}
        data-toolbar-layout-col-span={item.layout.colSpan}
        data-toolbar-layout-row-span={item.layout.rowSpan}
      >
        <DistributeCommandIconButton
          active={primaryCommand.enabled !== false && activeTool === primaryCommand.id}
          command={primaryCommand}
          disabled={primaryCommand.enabled === false}
          distributeMode={distributeMode}
          tooltipId={tooltipId}
          tooltipVisible={tooltipVisible}
          onInvoke={onInvoke}
          onRequestFlyout={onRequestFlyout}
          onTooltipEnter={onTooltipEnter}
          onTooltipLeave={onTooltipLeave}
        />
      </span>
    );
  }

  if (item.kind === "separator") {
    return (
      <span
        className="toolbar-item-grid-slot toolbar-item-separator"
        role="separator"
        style={toolbarItemGridStyle(item.layout)}
        data-toolbar-item-id={item.id}
        data-toolbar-layout-col-span={item.layout.colSpan}
        data-toolbar-layout-row-span={item.layout.rowSpan}
      />
    );
  }

  // A spacer is deliberate empty space (Safari's "Space") — it occupies its grid cells but paints
  // nothing and carries no semantics. Customize mode gives it a visible dashed outline via CSS.
  if (item.kind === "spacer") {
    return (
      <span
        className="toolbar-item-grid-slot toolbar-item-spacer"
        aria-hidden="true"
        style={toolbarItemGridStyle(item.layout)}
        data-toolbar-item-id={item.id}
        data-toolbar-layout-col-span={item.layout.colSpan}
        data-toolbar-layout-row-span={item.layout.rowSpan}
      />
    );
  }

  // A grid-citizen widget renders its live component inside its spanning slot (it occupies
  // colSpan×rowSpan cells like any other item, so it moves freely in customize mode).
  if (isGridWidgetItem(item) && item.primary.type === "control") {
    const gridWidget = TOOLBAR_WIDGET_REGISTRY[item.primary.controlId];
    if (gridWidget) {
      return (
        <span
          className="toolbar-item-grid-slot toolbar-widget-grid-slot"
          style={toolbarItemGridStyle(item.layout)}
          data-toolbar-item-id={item.id}
          data-toolbar-layout-col-span={item.layout.colSpan}
          data-toolbar-layout-row-span={item.layout.rowSpan}
        >
          {gridWidget.render()}
        </span>
      );
    }
  }

  if (item.primary.type === "control") {
    return (
      <span
        className="toolbar-item-grid-slot"
        style={toolbarItemGridStyle(item.layout)}
        data-toolbar-item-id={item.id}
        data-toolbar-layout-col-span={item.layout.colSpan}
        data-toolbar-layout-row-span={item.layout.rowSpan}
      >
        <button type="button" className="icon-button" disabled aria-label={`${item.label} control unavailable`}>
          <ToolbarItemIcon item={item} />
        </button>
      </span>
    );
  }

  return (
    <span
      className={["toolbar-item-grid-slot", "icon-button-shell", hasSubmenu ? "command-flyout-shell" : ""].filter(Boolean).join(" ")}
      data-command-flyout={hasSubmenu ? submenu?.id : undefined}
      data-command-tooltip-owner={primaryCommand?.id ?? item.id}
      data-tooltip-owner-id={tooltipId}
      data-tooltip-visible={tooltipVisible && !menuOpen ? "true" : undefined}
      data-toolbar-has-submenu={hasSubmenu ? "true" : undefined}
      data-toolbar-item-id={item.id}
      data-toolbar-layout-col-span={item.layout.colSpan}
      data-toolbar-layout-row-span={item.layout.rowSpan}
      ref={shellRef}
      style={toolbarItemGridStyle(item.layout)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setMenuOpen(false);
          onTooltipLeave?.();
        }
      }}
      onClickCapture={() => onTooltipLeave?.()}
      onPointerCancel={() => {
        clearHoldTimer();
        onTooltipLeave?.();
      }}
      onPointerDownCapture={() => onTooltipLeave?.()}
      onPointerEnter={() => onTooltipEnter?.()}
      onPointerLeave={() => {
        clearHoldTimer();
        onTooltipLeave?.();
      }}
    >
      <button
        type="button"
        className={[
          "icon-button",
          hasSubmenu ? "command-flyout-button" : "",
          activeState ? "active" : "",
          primaryCommand?.id === structureCleanupCommandId ? "structure-cleanup-button" : ""
        ].filter(Boolean).join(" ")}
        aria-controls={hasSubmenu && !usesNativeFlyout && menuOpen ? menuId : undefined}
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        aria-disabled={primaryDisabled && hasEnabledSubmenuCommand ? "true" : undefined}
        aria-expanded={hasSubmenu && !usesNativeFlyout ? menuOpen : undefined}
        aria-haspopup={hasSubmenu ? "menu" : undefined}
        aria-label={tooltipText}
        aria-pressed={activeState || undefined}
        disabled={buttonDisabled}
        data-active={activeState ? "true" : undefined}
        data-command-flyout-button={hasSubmenu ? submenu?.id : undefined}
        data-command-flyout-ids={hasSubmenu ? submenuCommands.map((command) => command.id).join(" ") : undefined}
        data-command-id={primaryCommand?.id}
        data-disabled={primaryDisabled ? "true" : undefined}
        data-distribute-mode={primaryCommand && isDistributeCommandId(primaryCommand.id) ? distributeMode : undefined}
        data-shortcut-label={item.tooltip.shortcutLabel ?? item.tooltip.shortcut ?? "No shortcut"}
        data-toolbar-asset={item.assetName ?? primaryCommand?.assetName}
        data-tooltip={tooltipText}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button !== 0) {
            return;
          }
          holdOpenedRef.current = false;
          pointerInvokedRef.current = false;
          if (hasSubmenu) {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            clearHoldTimer();
            holdTimerRef.current = setTimeout(openMenu, COMMAND_FLYOUT_HOLD_MS);
          }
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          if (holdOpenedRef.current || menuOpen) {
            return;
          }
          if (!primaryDisabled) {
            pointerInvokedRef.current = true;
          }
          invokePrimary();
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (pointerInvokedRef.current) {
            pointerInvokedRef.current = false;
            return;
          }
          if (holdOpenedRef.current || menuOpen) {
            return;
          }
          invokePrimary();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            closeMenu();
            return;
          }
          if (hasSubmenu && (event.key === "ArrowDown" || (event.altKey && event.key === "ArrowDown"))) {
            event.preventDefault();
            openMenu();
            return;
          }
          if ((event.key === "Enter" || event.key === " ") && !primaryDisabled) {
            event.preventDefault();
            // Claim the invoke so the synthesized click (Space activates on keyup; preventDefault on
            // keydown doesn't reliably cancel it in WKWebView) is suppressed by onClick's guard
            // instead of firing the command a second time.
            pointerInvokedRef.current = true;
            invokePrimary();
          }
        }}
      >
        <ToolbarItemIcon item={item} command={primaryCommand} />
        {hasSubmenu ? <span className="command-flyout-indicator" aria-hidden="true" /> : null}
        <ToolbarItemTooltip
          disabledReason={primaryDisabled ? primaryCommand?.disabledReason ?? "unavailable" : undefined}
          id={tooltipId}
          item={item}
          text={tooltipText}
        />
      </button>
      {hasSubmenu ? (
        <div
          className="toolbar-command-flyout-menu"
          role="menu"
          aria-label={submenu?.title ?? item.label}
          data-command-flyout-menu={submenu?.id}
          data-toolbar-command-grid-columns={submenu?.columns && submenu.columns > 1 ? submenu.columns : undefined}
          data-toolbar-submenu="true"
          data-toolbar-submenu-owner-id={item.id}
          hidden={!menuOpen}
          id={menuId}
          style={toolbarCommandFlyoutGridStyle(submenu?.columns)}
        >
          {submenuCommands.map((command) => {
            const disabled = command.enabled === false;
            const itemShortcut = command.shortcutLabel ?? command.shortcut ?? command.defaultShortcut;
            const itemText = disabled
              ? `${command.title}: ${command.disabledReason ?? "unavailable"}`
              : command.title;
            return (
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                aria-disabled={disabled ? "true" : undefined}
                data-command-id={command.id}
                data-disabled={disabled ? "true" : undefined}
                data-shortcut-label={itemShortcut ?? "No shortcut"}
                data-toolbar-asset={command.assetName}
                data-tooltip={itemText}
                key={command.id}
                title={itemText}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  chooseCommand(command);
                }}
              >
                <ToolbarCommandIcon command={command} />
                <span>{command.title}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

export function toolbarCommandFlyoutGridStyle(columns: number | undefined): CSSProperties | undefined {
  if (columns === undefined || columns <= 1) {
    return undefined;
  }
  return {
    "--toolbar-command-flyout-columns": String(columns)
  } as CSSProperties;
}

function ToolbarItemTooltip({
  disabledReason,
  id,
  item,
  text
}: {
  disabledReason?: string;
  id?: string;
  item: ToolbarPaletteItemModel;
  text: string;
}) {
  const description = disabledReason ?? item.tooltip.description;
  const shortcut = disabledReason ? undefined : item.tooltip.shortcutLabel ?? item.tooltip.shortcut;
  return (
    <span className="tool-tooltip" id={id} role="tooltip" aria-hidden="true">
      <span>{item.tooltip.title}</span>
      {description ? <span className="tool-tooltip-description">{description}</span> : null}
      {shortcut ? (
        <span className="tool-tooltip-shortcut">{shortcut}</span>
      ) : null}
      <span className="visually-hidden">{text}</span>
    </span>
  );
}

export function ToolbarItemIcon({
  item,
  command
}: {
  item: ToolbarPaletteItemModel;
  command?: CommandSpec;
}) {
  if (item.iconDataUri) {
    return <img className="tool-icon-image" src={item.iconDataUri} alt="" aria-hidden="true" />;
  }
  // toolbarAsset() returns undefined for an unknown key (e.g. a plugin's unregistered assetName);
  // only render the image when it resolves, otherwise fall through to a real icon.
  const assetSrc = item.assetName ? toolbarAsset(item.assetName) : undefined;
  if (assetSrc) {
    return <img className="tool-icon-image" src={assetSrc} alt="" aria-hidden="true" />;
  }
  if (command) {
    return <ToolbarCommandIcon command={command} />;
  }
  if (item.icon && item.icon !== "palette") {
    return <Icon name={item.icon} />;
  }
  // No distinctive icon — derive one from the title (user ask): a boxed 1–2 letter monogram keeps
  // otherwise-identical fallback glyphs (toolbar launchers, widgets, unknowns) tellable apart.
  return <TitleGlyphIcon title={item.tooltip?.title || item.label || item.id} />;
}

function ToolbarCommandIcon({ command }: { command: CommandSpec }) {
  const assetSrc = command.assetName ? toolbarAsset(command.assetName) : undefined;
  if (assetSrc) {
    return <img className="tool-icon-image" src={assetSrc} alt="" aria-hidden="true" />;
  }
  if (command.id.startsWith("tool.art.")) {
    return <ArtToolIcon commandId={command.id} />;
  }
  if (!command.icon || command.icon === "palette") {
    return <TitleGlyphIcon title={command.title || command.id} />;
  }
  return <Icon name={command.icon} />;
}

const TITLE_GLYPH_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "or",
  "for",
  "tool",
  "tools",
  "toolbar",
  "toggle",
  "show",
  "hide",
  "set",
  "native"
]);

/** 1–2 char monogram from a title. A dimension token ("3D", "2D") reads far clearer as the whole
 *  glyph than its initial, so it wins ("Interactive 3D Workspace" → "3D"); otherwise the initials of
 *  the first two meaningful words ("Molecule Inspector" → "MI"), or the first two letters of a lone
 *  word ("Rings" → "Ri"). */
export function titleMonogram(title: string): string {
  const words = title.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0 && !TITLE_GLYPH_STOPWORDS.has(word.toLowerCase()));
  if (words.length === 0) {
    return title.trim().slice(0, 2) || "?";
  }
  const dimensionToken = words.find((word) => /^\d+D$/i.test(word));
  if (dimensionToken) {
    return dimensionToken.toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2);
  }
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/** Deterministic fallback glyph: a boxed monogram derived from the command title, in the same visual
 *  family as the B/I/U/x² text buttons. */
export function TitleGlyphIcon({ title }: { title: string }) {
  return (
    <span className="title-glyph-icon" aria-hidden="true">
      {titleMonogram(title)}
    </span>
  );
}

function toolbarTooltipText(item: ToolbarPaletteItemModel, primaryCommand: CommandSpec | undefined): string {
  const hasSubmenuChoices = Boolean(item.submenu && item.submenu.items.length > 0);
  if (primaryCommand?.enabled === false) {
    // The disabled reason replaces the description, so re-add the long-press affordance for flyouts.
    const holdHint = hasSubmenuChoices ? "; hold for choices" : "";
    return `${item.tooltip.title}: ${primaryCommand.disabledReason ?? "unavailable"}${holdHint}`;
  }
  const shortcut = item.tooltip.shortcutLabel ?? item.tooltip.shortcut ?? primaryCommand?.shortcutLabel ?? primaryCommand?.shortcut;
  const shortcutText = !shortcut ? "" : ` (${shortcut})`;
  const description = item.tooltip.description ? `: ${item.tooltip.description}` : "";
  // A flyout with no manifest description of its own (e.g. a plugin item) still needs to signal it
  // is long-pressable; a hand-written description is assumed to cover it already.
  const holdHint = hasSubmenuChoices && !item.tooltip.description ? "; hold for choices" : "";
  return `${item.tooltip.title}${description}${holdHint}${shortcutText}`;
}

export function CommandIconButton({
  command,
  active = false,
  tooltipId,
  tooltipVisible,
  distributeMode = "centers",
  onTooltipEnter,
  onTooltipLeave,
  separated = false,
  onRequestFlyout,
  onInvoke
}: {
  command: CommandSpec;
  active?: boolean;
  tooltipId?: string;
  tooltipVisible?: boolean;
  distributeMode?: ToolPaletteDistributeMode;
  onTooltipEnter?: () => void;
  onTooltipLeave?: () => void;
  separated?: boolean;
  onRequestFlyout?: (request: ToolbarFlyoutRequest) => void;
  onInvoke: (commandId: string) => void;
}) {
  const disabled = command.enabled === false;
  if (isDistributeCommandId(command.id)) {
    return (
      <DistributeCommandIconButton
        active={active}
        command={command}
        disabled={disabled}
        distributeMode={distributeMode}
        separated={separated}
        tooltipId={tooltipId}
        tooltipVisible={tooltipVisible}
        onInvoke={onInvoke}
        onRequestFlyout={onRequestFlyout}
        onTooltipEnter={onTooltipEnter}
        onTooltipLeave={onTooltipLeave}
      />
    );
  }

  const activeState = active && !disabled;
  const shortcut = command.shortcut ?? command.defaultShortcut;
  const shortcutLabel = command.shortcutLabel ?? shortcut;
  const visibleShortcutLabel = shortcutLabel ?? "No shortcut";
  const shortcutText = disabled ? "" : ` (${visibleShortcutLabel})`;
  const stateText = disabled ? `: ${command.disabledReason ?? "unavailable"}` : "";
  const tooltipText = `${command.title}${shortcutText}${stateText}`;
  const invokeHandlers = usePaletteButtonInvoke(command.id, onInvoke, disabled);
  // Resolve then guard: an unknown assetName yields undefined, which would render a broken <img>.
  const assetSrc = command.assetName ? toolbarAsset(command.assetName) : undefined;

  return (
    <span
      className={["icon-button-shell", separated ? "separated" : ""].filter(Boolean).join(" ")}
      data-command-tooltip-owner={command.id}
      data-tooltip-owner-id={tooltipId}
      data-tooltip-visible={tooltipVisible ? "true" : undefined}
      onBlur={() => onTooltipLeave?.()}
      onClickCapture={() => onTooltipLeave?.()}
      onPointerCancel={() => onTooltipLeave?.()}
      onPointerDownCapture={() => onTooltipLeave?.()}
      onPointerEnter={() => onTooltipEnter?.()}
      onPointerLeave={() => onTooltipLeave?.()}
    >
      <button
        type="button"
        className={[
          "icon-button",
          activeState ? "active" : "",
          command.id === "structure.cleanup2d" ? "structure-cleanup-button" : ""
        ].filter(Boolean).join(" ")}
        aria-label={tooltipText}
        aria-pressed={activeState || undefined}
        disabled={disabled}
        data-active={activeState ? "true" : undefined}
        data-command-id={command.id}
        data-shortcut-label={visibleShortcutLabel}
        data-toolbar-asset={command.assetName}
        data-tooltip={tooltipText}
        {...invokeHandlers}
      >
        {assetSrc ? (
          <img className="tool-icon-image" src={assetSrc} alt="" aria-hidden="true" />
        ) : command.id.startsWith("tool.art.") ? (
          <ArtToolIcon commandId={command.id} />
        ) : (
          <Icon name={command.icon} />
        )}
        <span className="tool-tooltip" id={tooltipId} aria-hidden="true">{tooltipText}</span>
      </button>
    </span>
  );
}

type ArtToolbarCommandColumn = {
  id: string;
  containsArrangeItems?: boolean;
  containsShapeFlyout?: boolean;
  items: ToolbarPaletteItemModel[];
};

function artToolbarCommandColumns(groups: ToolbarPaletteItemModel[][]): ArtToolbarCommandColumn[] {
  const items = groups.flat();
  const itemByCommandId = new Map<string, ToolbarPaletteItemModel>();
  items.forEach((item) => {
    const commandId = primaryCommandIdForToolbarItem(item);
    if (commandId) {
      itemByCommandId.set(commandId, item);
    }
  });
  const commandItems = (commandIds: readonly string[]): ToolbarPaletteItemModel[] =>
    commandIds.flatMap((commandId) => {
      const item = itemByCommandId.get(commandId);
      return item ? [item] : [];
    });

  const shapeItem = commandItems([ART_SHAPE_COMMAND_IDS[0]])[0];
  const drawingItems: ToolbarPaletteItemModel[] = commandItems(ART_PATH_COMMAND_IDS);
  if (shapeItem) {
    drawingItems.push(shapeItem);
  }

  return [
    {
      id: "selection",
      items: commandItems(ART_SELECTION_COLUMN_COMMAND_IDS)
    },
    {
      id: "drawing",
      containsShapeFlyout: Boolean(shapeItem?.submenu),
      items: drawingItems
    },
    {
      id: "arrange",
      containsArrangeItems: true,
      items: commandItems(ART_ARRANGE_COLUMN_ITEM_IDS)
    },
    {
      id: "boolean",
      items: commandItems(ART_BOOLEAN_COMMAND_IDS)
    }
  ];
}

function primaryCommandIdForToolbarItem(item: ToolbarPaletteItemModel): string | undefined {
  return item.primary.type === "command" ? item.primary.command.id : undefined;
}

function DistributeCommandIconButton({
  command,
  active,
  disabled,
  distributeMode,
  tooltipId,
  tooltipVisible,
  onTooltipEnter,
  onTooltipLeave,
  separated,
  onRequestFlyout,
  onInvoke
}: {
  command: CommandSpec;
  active: boolean;
  disabled: boolean;
  distributeMode: ToolPaletteDistributeMode;
  tooltipId?: string;
  tooltipVisible?: boolean;
  onTooltipEnter?: () => void;
  onTooltipLeave?: () => void;
  separated?: boolean;
  onRequestFlyout?: (request: ToolbarFlyoutRequest) => void;
  onInvoke: (commandId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shellRef = useRef<HTMLSpanElement | null>(null);
  useNativeFloatingTooltip(shellRef, Boolean(tooltipVisible) && !menuOpen);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdOpenedRef = useRef(false);
  const activeState = active && !disabled;
  const shortcut = command.shortcut ?? command.defaultShortcut;
  const shortcutLabel = command.shortcutLabel ?? shortcut;
  const visibleShortcutLabel = shortcutLabel ?? "No shortcut";
  const modeLabel = distributeMode === "spacing" ? "equal gaps" : "centers";
  const shortcutText = disabled ? "" : ` (${visibleShortcutLabel})`;
  const stateText = disabled ? `: ${command.disabledReason ?? "unavailable"}` : "";
  const tooltipText = `${command.title}: ${modeLabel}${shortcutText}${stateText}`;
  // Resolve then guard: toolbarAsset() returns undefined for an unknown key, so rendering it directly
  // would produce a broken <img>. Fall through to the named Icon when the asset can't resolve.
  const distributeAssetSrc = command.assetName ? toolbarAsset(command.assetName) : undefined;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== undefined) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = undefined;
    }
  }, []);

  const openMenu = useCallback(() => {
    holdOpenedRef.current = true;
    onTooltipLeave?.();
    // Native palettes open the mode chooser in its own floating window (overflows the palette).
    if (onRequestFlyout) {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      onRequestFlyout({
        anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        flyout: {
          flyoutId: `distribute.${command.id}`,
          title: command.title,
          variant: "distribute",
          commands: [
            {
              id: distributeModeCommandIds.centers,
              title: "Centers",
              enabled: true,
              active: distributeMode === "centers"
            },
            {
              id: distributeModeCommandIds.spacing,
              title: "Equal gaps",
              enabled: true,
              active: distributeMode === "spacing"
            }
          ]
        }
      });
      return;
    }
    setMenuOpen(true);
  }, [onRequestFlyout, onTooltipLeave, command.id, command.title, distributeMode]);

  const chooseMode = useCallback((commandId: string) => {
    onInvoke(commandId);
    setMenuOpen(false);
    onTooltipLeave?.();
  }, [onInvoke, onTooltipLeave]);

  useEffect(() => () => {
    clearHoldTimer();
  }, [clearHoldTimer]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shellRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  return (
    <span
      className={["icon-button-shell", "distribute-button-shell", separated ? "separated" : ""].filter(Boolean).join(" ")}
      data-command-tooltip-owner={command.id}
      data-distribute-menu-open={menuOpen ? "true" : undefined}
      data-tooltip-owner-id={tooltipId}
      data-tooltip-visible={tooltipVisible && !menuOpen ? "true" : undefined}
      ref={shellRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !menuOpen) {
          onTooltipLeave?.();
        }
      }}
      onClickCapture={() => onTooltipLeave?.()}
      onPointerCancel={() => onTooltipLeave?.()}
      onPointerDownCapture={() => onTooltipLeave?.()}
      onPointerEnter={() => onTooltipEnter?.()}
      onPointerLeave={() => onTooltipLeave?.()}
    >
      <button
        type="button"
        className={["icon-button", "distribute-mode-button", activeState ? "active" : ""].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={tooltipText}
        aria-pressed={activeState || undefined}
        data-active={activeState ? "true" : undefined}
        data-command-id={command.id}
        data-disabled={disabled ? "true" : undefined}
        data-distribute-mode={distributeMode}
        data-shortcut-label={visibleShortcutLabel}
        data-toolbar-asset={command.assetName}
        data-tooltip={tooltipText}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button !== 0) {
            return;
          }
          holdOpenedRef.current = false;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          clearHoldTimer();
          holdTimerRef.current = setTimeout(openMenu, DISTRIBUTE_MENU_HOLD_MS);
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          if (disabled || holdOpenedRef.current || menuOpen) {
            return;
          }
          onInvoke(command.id);
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            // Match the pointer path (onPointerUp): a disabled distribute command must not invoke.
            // The menu (ArrowDown / hold) stays reachable so the mode can still be changed.
            if (!disabled) {
              onInvoke(command.id);
            }
          }
        }}
      >
        {distributeAssetSrc ? (
          <img className="tool-icon-image" src={distributeAssetSrc} alt="" aria-hidden="true" />
        ) : (
          <Icon name={command.icon} />
        )}
        <span className="distribute-mode-indicator" data-distribute-mode={distributeMode} aria-hidden="true">
          <span />
          <span />
        </span>
        <span className="tool-tooltip" id={tooltipId} aria-hidden="true">{tooltipText}</span>
      </button>
      {menuOpen ? (
        <div className="toolbar-distribute-menu" role="menu" aria-label="Distribute mode">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={distributeMode === "centers"}
            data-command-id={distributeModeCommandIds.centers}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.centers);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.centers);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.centers);
            }}
          >
            Centers
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={distributeMode === "spacing"}
            data-command-id={distributeModeCommandIds.spacing}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.spacing);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.spacing);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.spacing);
            }}
          >
            Equal gaps
          </button>
        </div>
      ) : null}
    </span>
  );
}

function isDistributeCommandId(commandId: string): boolean {
  return commandId === "layout.distributeHorizontal" || commandId === "layout.distributeVertical";
}

function ArtToolIcon({ commandId }: { commandId: string }) {
  const toolId = commandId.replace(/^tool\.art\./, "");
  const dashed = toolId.includes("Dashed");
  const filled = toolId.includes("Filled") || toolId.includes("Gloss");
  const gloss = toolId.includes("Gloss");
  const shadow = toolId.includes("Shadow");
  const strokeClass = ["art-tool-stroke", dashed ? "dashed" : "", filled ? "filled" : ""].filter(Boolean).join(" ");
  const shadowElement = shadow ? <path className="art-tool-shadow" d={artToolShapePath(toolId)} aria-hidden="true" /> : null;

  if (toolId === "pencil") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <g data-art-freehand-glyph="pencil">
          <path className="art-tool-stroke" d="M3 14 L4.2 10.4 L11.2 3.4 C11.9 2.7 12.9 2.7 13.6 3.4 C14.3 4.1 14.3 5.1 13.6 5.8 L6.6 12.8 Z" />
          <path className="art-tool-stroke filled" d="M3 14 L4.2 10.4 L6.6 12.8 Z" />
          <path className="art-tool-stroke" d="M10.4 4.2 L12.8 6.6" />
        </g>
      </svg>
    );
  }

  if (toolId === "brush") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <g data-art-freehand-glyph="brush">
          <path className="art-tool-stroke" d="M10.3 8.3 L13.9 4.7 C14.4 4.2 14.4 3.5 13.9 3 C13.4 2.5 12.7 2.5 12.2 3 L8.6 6.6" />
          <path className="art-tool-stroke filled" d="M5.1 13.9 C5.8 12.1 4.3 11.1 6.5 8.7 C7.7 7.4 9.2 6.6 10.7 7 L10 10.8 C8.4 12.5 6.9 13.3 5.1 13.9 Z" />
          <path className="art-tool-stroke bold" d="M2.6 13.4 C4.2 11.1 6.4 14.5 8.9 11.7" />
        </g>
      </svg>
    );
  }

  if (toolId === "eyedropper") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M11.5 2.4 L14.6 5.5 L6.7 13.4 L3.6 14.3 L4.5 11.2 Z" />
        <path className="art-tool-stroke filled" d="M4.5 11.2 L6.7 13.4 L3.6 14.3 Z" />
        <path className="art-tool-stroke" d="M9.8 4.1 L12.9 7.2" />
      </svg>
    );
  }

  if (toolId.startsWith("line")) {
    const path = toolId === "lineWavy"
      ? "M2 9 C4 4, 6 14, 8.5 9 S13 4, 15 9"
      : "M3 3 L14 14";
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path
          className={["art-tool-stroke", dashed ? "dashed" : "", toolId === "lineBold" ? "bold" : ""].filter(Boolean).join(" ")}
          d={path}
        />
      </svg>
    );
  }

  if (toolId === "polyline") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M2.5 12.5 L7 4.5 L14.5 9.5" />
      </svg>
    );
  }

  if (toolId === "pen") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M2.6 12.4 C5.4 4.2 10.8 3.4 14.4 8.4" />
        <path className="art-tool-stroke filled" d="M2.3 12.7 L4.5 11.9 L3.1 10.5 Z" />
        <circle className="art-tool-stroke" cx="8.3" cy="5.7" r="1" />
      </svg>
    );
  }

  if (toolId === "arrow") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M3 11 L13 5" />
        <path className="art-tool-stroke filled" d="M13 5 L10.2 5.2 L11.7 7.6 Z" />
      </svg>
    );
  }

  if (toolId === "reactionArrow" || toolId === "reactionArrowBold" || toolId === "reactionArrowDashed" || toolId === "noReactionArrow") {
    const bold = toolId === "reactionArrowBold";
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path
          className={["art-tool-stroke", toolId === "reactionArrowDashed" ? "dashed" : ""].filter(Boolean).join(" ")}
          d="M2 8.5 L13 8.5"
        />
        <path
          className="art-tool-stroke filled"
          d={bold ? "M15.4 8.5 L10.6 5.6 L10.6 11.4 Z" : "M15 8.5 L11.6 6.5 L11.6 10.5 Z"}
        />
        {toolId === "noReactionArrow" ? (
          <path className="art-tool-stroke" d="M5.6 5.6 L9.4 11.4 M9.4 5.6 L5.6 11.4" />
        ) : null}
      </svg>
    );
  }

  if (toolId === "resonanceArrow") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M4 8.5 L13 8.5" />
        <path className="art-tool-stroke filled" d="M15 8.5 L11.6 6.5 L11.6 10.5 Z" />
        <path className="art-tool-stroke filled" d="M2 8.5 L5.4 6.5 L5.4 10.5 Z" />
      </svg>
    );
  }

  if (toolId === "curvedArrow90" || toolId === "curvedArrow180") {
    const gentle = toolId === "curvedArrow90";
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d={gentle ? "M3 12.5 A8 8 0 0 1 11.5 4.5" : "M2.6 10.5 A6.1 6.1 0 0 1 14 8"} />
        {gentle
          ? <path className="art-tool-stroke filled" d="M13.6 3.9 L10.2 3.4 L11.6 6.6 Z" />
          : <path className="art-tool-stroke filled" d="M14.6 10.2 L14.7 6.6 L11.6 8.3 Z" />}
      </svg>
    );
  }

  if (toolId === "fishhookArrow") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M3 11 L13.5 5.5" />
        <path className="art-tool-stroke filled" d="M13.5 5.5 L10.6 5.4 L12.3 6.4 Z" />
      </svg>
    );
  }

  if (toolId === "fishhookCurved") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M2.6 10.5 A6.1 6.1 0 0 1 14 8" />
        <path className="art-tool-stroke filled" d="M14.6 9.8 L14.7 6.6 L13 7.9 Z" />
      </svg>
    );
  }

  if (toolId.startsWith("arc")) {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className={["art-tool-stroke", dashed ? "dashed" : ""].filter(Boolean).join(" ")} d={artToolArcPath(toolId)} />
      </svg>
    );
  }

  return (
    <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
      {shadowElement}
      <path className={strokeClass} d={artToolShapePath(toolId)} />
      {gloss ? <path className="art-tool-gloss" d={artToolGlossPath(toolId)} /> : null}
    </svg>
  );
}

function artToolShapePath(toolId: string): string {
  if (toolId.startsWith("circle")) {
    return "M8.5 2.2 A6.3 6.3 0 1 1 8.45 2.2 Z";
  }

  if (toolId.startsWith("ellipse")) {
    return "M2 8.5 A6.5 3.7 0 1 1 15 8.5 A6.5 3.7 0 1 1 2 8.5 Z";
  }

  if (toolId.startsWith("roundedRect")) {
    return "M4.1 3 H12.9 Q14 3 14 4.1 V12.9 Q14 14 12.9 14 H4.1 Q3 14 3 12.9 V4.1 Q3 3 4.1 3 Z";
  }

  return "M3 4 H14 V13 H3 Z";
}

function artToolGlossPath(toolId: string): string {
  if (toolId.startsWith("circle")) {
    return "M5.2 5.2 C6.1 4.2, 7.6 3.7, 9.2 4";
  }

  if (toolId.startsWith("ellipse")) {
    return "M4.5 7.1 C6.5 5.8, 10.3 5.8, 12.5 7.1";
  }

  return "M5 5.2 H12";
}

function artToolArcPath(toolId: string): string {
  if (toolId.startsWith("arc270")) {
    return "M8.5 2.2 A6.3 6.3 0 1 1 2.2 8.5";
  }

  if (toolId.startsWith("arc180")) {
    return "M2.4 8.5 A6.1 6.1 0 0 1 14.6 8.5";
  }

  if (toolId.startsWith("arc120")) {
    return "M4 10.6 A5.9 5.9 0 0 1 13 5.6";
  }

  return "M5.2 11.8 A6 6 0 0 1 11.8 5.2";
}
