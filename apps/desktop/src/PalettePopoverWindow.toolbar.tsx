import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ToolbarCommandMenuItem, ToolbarPaletteItem } from "./ToolPalette";
import { ToolbarWidgetStateContext } from "./toolbars/toolbarWidgets";
import { PALETTE_GRID_METRIC_DEFAULTS } from "./toolsets";
import type { CommandSpec } from "./commands";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";
import type { ToolsetFlyoutSnapshot, ToolsetToolbarSnapshot } from "./window-manager";
import "./PalettePopoverWindow.toolbar.css";

const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]"
)].filter(element => !element.matches(":disabled") && !element.closest("[hidden]") && element.tabIndex >= 0);

/** One native popover per palette: replace the strip with its item's submenu plus Back.
 * Never request another native window for a submenu of an overflow/folded toolbar item. */
export function ToolbarItemsPopover({ toolbar, maxWidth, maxHeight, onInvoke, onPreview, onCommit, onCancel }: {
  toolbar: ToolsetToolbarSnapshot; maxWidth: number; maxHeight: number;
  onInvoke: (commandId: string, keepOpen: boolean) => void;
  onPreview: (commandId: string) => void;
  onCommit: (commandId: string) => void;
  onCancel: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<string | undefined>(undefined);
  const [submenu, setSubmenu] = useState<{ ownerId: string; flyout: ToolsetFlyoutSnapshot }>();
  const owner = toolbar.items.find(item => item.id === submenu?.ownerId);
  const menu = owner && (owner.submenu?.items.length || submenu?.flyout.variant === "distribute") ? submenu : undefined;
  const backFocus = useRef<string | undefined>(undefined);
  const previousMenu = useRef<string | undefined>(undefined);
  const commands: CommandSpec[] = owner?.submenu?.items ?? menu?.flyout.commands.map(command => ({
    ...command, icon: command.icon as IconName, assetName: command.assetName as ToolbarAssetName | undefined
  })) ?? [];
  const invoke = (id: string, item: (typeof toolbar.items)[number]) => {
    onInvoke(id, item.keepOpen ?? (item.kind === "toggle" || item.kind === "control"));
  };

  useLayoutEffect(() => {
    if (submenu && !menu) setSubmenu(undefined);
    const element = root.current;
    if (!element) return;
    const candidates = focusable(element);
    const menuChanged = previousMenu.current !== menu?.ownerId;
    previousMenu.current = menu?.ownerId;
    if (menu && menuChanged) candidates[0]?.focus({ preventScroll: true });
    else if (!candidates.includes(document.activeElement as HTMLElement)) {
      const restoreId = backFocus.current ?? lastFocused.current;
      (candidates.find(candidate => candidate.dataset.commandId === restoreId) ?? candidates[0])?.focus({ preventScroll: true });
    }
    backFocus.current = undefined;
  }, [toolbar, menu?.ownerId]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    // A field keeps its native editing keys; Tab still moves between toolbar controls.
    if (target.matches("input, select, textarea, [contenteditable]")) return;
    const candidates = focusable(event.currentTarget);
    const index = candidates.indexOf(document.activeElement as HTMLElement);
    const delta = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1
      : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? candidates.length - 1
      : delta ? (index + delta + candidates.length) % candidates.length : undefined;
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation();
    candidates[next]?.focus({ preventScroll: true });
  };
  const { gap } = PALETTE_GRID_METRIC_DEFAULTS;
  // Match ToolPalette's compact native cells (its registry grid uses 24px too).
  const cellWidth = 24, cellHeight = 24;
  const availableColumns = Math.max(1, Math.floor((maxWidth - 8 + gap) / (cellWidth + gap)));
  const columns = Math.min(availableColumns, Math.max(1, toolbar.items.reduce((sum, item) => sum + item.layout.colSpan, 0)));
  const bounds: CSSProperties = { maxWidth, maxHeight, overflow: "auto", boxSizing: "border-box" };
  const style: CSSProperties = { ...bounds, display: "grid", gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)`,
    gridAutoRows: `${cellHeight}px`, gap, padding: 4, width: "max-content", height: "max-content" };
  return <ToolbarWidgetStateContext.Provider value={{ ...toolbar.widgetState,
    onInvoke: id => onInvoke(id, true),
    onArtStylePreview: onPreview, onArtStyleCommit: onCommit, onArtStyleCancel: onCancel,
    onMoleculeInspectorPreview: onPreview, onMoleculeInspectorCommit: onCommit, onMoleculeInspectorCancel: onCancel
  }}>
    <div ref={root} className={menu ? "toolbar-command-flyout-menu toolbar-popover-submenu" : "tool-palette horizontal toolbar-popover-strip"}
      role={menu ? "menu" : "toolbar"} aria-label={menu ? menu.flyout.title : toolbar.title || "More tools"}
      aria-orientation={menu ? undefined : "horizontal"} style={menu ? bounds : style}
      onKeyDownCapture={navigate}
      onFocusCapture={event => { lastFocused.current = (event.target as HTMLElement).dataset.commandId; }}>
      {menu && owner ? <>
        <button type="button" role="menuitem" className="toolbar-popover-back" onClick={() => {
          backFocus.current = owner.primary.type === "command" ? owner.primary.command.id : undefined;
          setSubmenu(undefined);
        }}>Back</button>
        {commands.map(command => <ToolbarCommandMenuItem key={command.id} command={command}
          active={toolbar.activeTool !== undefined ? command.id === toolbar.activeTool
            : menu.flyout.commands.find(item => item.id === command.id)?.active}
          onInvoke={id => invoke(id, owner)} />)}
      </> : toolbar.items.map(item => <ToolbarPaletteItem key={item.id}
        item={{ ...item, layout: { colSpan: Math.min(columns, item.layout.colSpan), rowSpan: item.layout.rowSpan } }}
        active={item.active} checked={item.checked} activeTool={toolbar.activeTool} standalone
        distributeMode={toolbar.currentDistributeMode} onInvoke={id => invoke(id, item)}
        onRequestFlyout={request => setSubmenu({ ownerId: item.id, flyout: request.flyout })} />)}
    </div>
  </ToolbarWidgetStateContext.Provider>;
}
