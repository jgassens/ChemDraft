import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { ToolsetLayoutEdit } from "../../window-manager";
import { ToolbarItemIcon } from "../../ToolPalette";
import type { ToolbarPaletteGroupModel, ToolbarPaletteItemModel } from "../../toolsets";
import type { CommandSpec } from "../../commands";
import { GALLERY_TRAY_DROPPABLE_ID, type GalleryEntryKind } from "./galleryModel";

/** dnd-kit `active.data.current` shape a customize slot or gallery tile carries. In-toolbar slots set
 *  `groupId`/`kind`; gallery tiles set `gallery` plus what the drop and the drag ghost need. */
export interface CustomizeDragData {
  groupId?: string;
  kind?: string;
  /** True for an in-toolbar section-widget (style controls) — it can be dragged out to remove but does
   *  not reorder among the icon grid (it renders as an appended panel, not a grid slot). */
  widget?: boolean;
  /** True for a gallery tile being dragged into the toolbar. */
  gallery?: boolean;
  galleryKind?: GalleryEntryKind;
  /** Command id for a gallery command tile. */
  commandId?: string;
  /** Control id for a gallery/in-toolbar widget tile. */
  widgetId?: string;
  /** A ready-to-render item model + command for the drag ghost (gallery tiles only). */
  iconItem?: ToolbarPaletteItemModel;
  command?: CommandSpec;
}

/** Collision detection that keys off the POINTER, not the dragged item's rect-center. A gallery tile
 *  is much larger than a 24px toolbar slot, so `closestCenter` (rect-center based) can miss the slot
 *  under the cursor and report the tray (or nothing); `pointerWithin` returns whatever droppable the
 *  cursor is actually over. Fall back to `closestCenter` when the pointer is within nothing (e.g. a
 *  keyboard drag, or the gap between slots) so reorder/remove still resolve. */
const pointerFirstCollision: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

/** Find which group an item id lives in and at what index (used to place a gallery add). */
function locateItem(
  groups: readonly ToolbarPaletteGroupModel[],
  itemId: string
): { groupId: string; index: number } | undefined {
  for (const group of groups) {
    if (!group.id) {
      continue;
    }
    const index = group.items.findIndex((item) => item.id === itemId);
    if (index >= 0) {
      return { groupId: group.id, index };
    }
  }
  return undefined;
}

/**
 * Resolve one drag-end into a layout edit (pure, unit-tested).
 *
 * Gallery tile (`activeData.gallery`) dragged INTO the toolbar:
 *  - over an in-toolbar slot → add its command/spacer/divider at that slot's index
 *  - over the tray / off the bar (over === null or the tray id) → no-op
 *
 * In-toolbar slot dragged:
 *  - onto the tray, or off the bar (over === null) → remove the item
 *  - onto a sibling in the SAME group → reorder that group
 *  - onto another group (base items can't be re-homed; itemOrder is per-group) → snap back
 *  - onto itself → no-op
 */
/** The release point of a drag, in client coordinates: the activator (pointerdown) position plus the
 *  drag delta. Null for a keyboard drag (no client coords). */
function dragEndPoint(event: DragEndEvent): { x: number; y: number } | null {
  const activator = event.activatorEvent;
  if (activator instanceof MouseEvent) {
    return { x: activator.clientX + event.delta.x, y: activator.clientY + event.delta.y };
  }
  return null;
}

function isPointInRect(point: { x: number; y: number }, rect: DOMRect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

export function customizeDragEndEdit(
  activeId: string,
  activeData: CustomizeDragData | undefined,
  overId: string | null,
  groups: readonly ToolbarPaletteGroupModel[]
): ToolsetLayoutEdit | undefined {
  if (activeData?.gallery) {
    if (overId === null || overId === GALLERY_TRAY_DROPPABLE_ID) {
      return undefined;
    }
    const target = locateItem(groups, overId);
    if (!target) {
      return undefined;
    }
    switch (activeData.galleryKind) {
      case "spacer":
        return { kind: "addSpacer", groupId: target.groupId, index: target.index };
      case "separator":
        return { kind: "addSeparator", groupId: target.groupId, index: target.index };
      case "command":
        return activeData.commandId === undefined
          ? undefined
          : { kind: "addCommand", groupId: target.groupId, index: target.index, commandId: activeData.commandId };
      case "widget":
        return activeData.widgetId === undefined
          ? undefined
          : { kind: "addWidget", groupId: target.groupId, index: target.index, widgetId: activeData.widgetId };
      default:
        return undefined;
    }
  }

  if (overId === null || overId === GALLERY_TRAY_DROPPABLE_ID) {
    return { kind: "removeItem", itemId: activeId };
  }
  // A section-widget panel can be dragged out to remove, but it doesn't reorder among the icon grid
  // (it renders as an appended panel, not a grid slot) — so any in-palette drop is a no-op.
  if (activeData?.widget) {
    return undefined;
  }
  if (overId === activeId) {
    return undefined;
  }
  const activeGroup = groups.find((group) => group.items.some((item) => item.id === activeId));
  const overGroup = groups.find((group) => group.items.some((item) => item.id === overId));
  if (!activeGroup?.id || !overGroup?.id || activeGroup.id !== overGroup.id) {
    return undefined;
  }
  const ids = activeGroup.items.map((item) => item.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) {
    return undefined;
  }
  return { kind: "reorderItems", groupId: activeGroup.id, orderedItemIds: arrayMove(ids, from, to) };
}

/** Reorder a group's item models to match an ordered id list, keeping any unlisted item at the end. */
function reorderModelItems(
  items: readonly ToolbarPaletteItemModel[],
  orderedItemIds: readonly string[]
): ToolbarPaletteItemModel[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = orderedItemIds
    .map((id) => byId.get(id))
    .filter((item): item is ToolbarPaletteItemModel => item !== undefined);
  const orderedIds = new Set(orderedItemIds);
  return [...ordered, ...items.filter((item) => !orderedIds.has(item.id))];
}

/**
 * Optimistically apply a resolved edit to the displayed group models so a reorder/remove shows
 * instantly instead of animating back to the old layout for the ~few ms until the main window's
 * broadcast lands. Returns `null` for edits that shouldn't be previewed locally (adds — synthesizing
 * a real icon model here would duplicate the applier; the ~1-frame gap is accepted).
 */
export function optimisticGroupsForEdit(
  groups: readonly ToolbarPaletteGroupModel[],
  edit: ToolsetLayoutEdit
): ToolbarPaletteGroupModel[] | null {
  switch (edit.kind) {
    case "reorderItems":
      return groups.map((group) =>
        group.id === edit.groupId ? { ...group, items: reorderModelItems(group.items, edit.orderedItemIds) } : group
      );
    case "removeItem":
      return groups.map((group) => ({ ...group, items: group.items.filter((item) => item.id !== edit.itemId) }));
    default:
      return null;
  }
}

/** A structure-only fingerprint of the groups (ids + item order) — changes exactly when the real
 *  layout updates, independent of array-reference churn, so it's a reliable "broadcast landed" signal. */
function groupsSignature(groups: readonly ToolbarPaletteGroupModel[]): string {
  return groups.map((group) => `${group.id ?? ""}:${group.items.map((item) => item.id).join(",")}`).join("|");
}

/**
 * Owns the single DndContext wrapping the customizable Main palette and the gallery tray. Every drop
 * is resolved to one edit op and handed to `onEdit`; the authoritative layout still comes from the
 * main window's re-broadcast, but the controller previews reorder/remove locally (optimistic display)
 * so the palette doesn't flash the old layout during the round-trip. `children` is a render-prop given
 * the groups to render (optimistic overlay ?? authoritative).
 */
export function ToolbarCustomizeController({
  groups,
  onEdit,
  children
}: {
  toolsetId: string;
  groups: readonly ToolbarPaletteGroupModel[];
  onEdit: (edit: ToolsetLayoutEdit) => void;
  children: (effectiveGroups: readonly ToolbarPaletteGroupModel[]) => ReactNode;
}) {
  const [activeItem, setActiveItem] = useState<ToolbarPaletteItemModel | null>(null);
  const [dbg, setDbg] = useState(""); // TEMP diagnostic overlay
  // A gallery tile being dragged (its id isn't in `groups`, so it's tracked separately for the ghost).
  const [activeGallery, setActiveGallery] = useState<CustomizeDragData | null>(null);
  // Optimistic overlay: the just-dropped reorder/remove shown before the broadcast round-trip lands.
  const [optimisticGroups, setOptimisticGroups] = useState<readonly ToolbarPaletteGroupModel[] | null>(null);
  const authoritativeSignature = useMemo(() => groupsSignature(groups), [groups]);
  // Clear the overlay once the authoritative structure catches up (or diverges) — the truth has landed.
  useEffect(() => {
    setOptimisticGroups(null);
  }, [authoritativeSignature]);
  const effectiveGroups = optimisticGroups ?? groups;
  // display:contents wrapper (no box of its own) so we can measure the palette's rect on drag-end
  // without changing the shell's grid layout.
  const containerRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    // 5px activation is required in WKWebView — without it micro-movements cancel the drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const clearActive = () => {
    setActiveItem(null);
    setActiveGallery(null);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as CustomizeDragData | undefined;
    if (data?.gallery) {
      setActiveGallery(data);
      setActiveItem(null);
      return;
    }
    const id = String(event.active.id);
    const item = effectiveGroups.flatMap((group) => group.items).find((candidate) => candidate.id === id) ?? null;
    setActiveItem(item);
    setActiveGallery(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    clearActive();
    let overId = event.over ? String(event.over.id) : null;
    // closestCenter always reports the nearest slot, even when the release point is far off the
    // palette — so `over` is never null and the "dragged out → remove" path would never fire. Detect
    // it geometrically: a release outside the palette's box is a remove (overId forced to null).
    const paletteRect = containerRef.current?.querySelector(".tool-palette")?.getBoundingClientRect();
    const point = dragEndPoint(event);
    if (paletteRect && point && !isPointInRect(point, paletteRect)) {
      overId = null;
    }
    const activeData = event.active.data.current as CustomizeDragData | undefined;
    const edit = customizeDragEndEdit(String(event.active.id), activeData, overId, effectiveGroups);
    if (edit) {
      // Preview reorder/remove locally so the drop lands instantly; the broadcast confirms it.
      const preview = optimisticGroupsForEdit(effectiveGroups, edit);
      if (preview) {
        setOptimisticGroups(preview);
      }
      onEdit(edit);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerFirstCollision}
      // The palette window resizes as the tray grows / items move, so re-measure droppables always.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={clearActive}
    >
      <div ref={containerRef} style={{ display: "contents" }}>
        {children(effectiveGroups)}
      </div>
      <DragOverlay>
        {activeItem ? (
          <span className="toolbar-item-grid-slot customize-drag-overlay">
            {activeItem.kind === "spacer" || activeItem.kind === "separator" ? (
              <span className="toolbar-item-spacer customize-slot-placeholder" aria-hidden="true" />
            ) : (
              <span className="icon-button">
                <ToolbarItemIcon
                  item={activeItem}
                  command={activeItem.primary.type === "command" ? activeItem.primary.command : undefined}
                />
              </span>
            )}
          </span>
        ) : activeGallery ? (
          <span className="toolbar-item-grid-slot customize-drag-overlay">
            {activeGallery.galleryKind === "command" && activeGallery.iconItem ? (
              <span className="icon-button">
                <ToolbarItemIcon item={activeGallery.iconItem} command={activeGallery.command} />
              </span>
            ) : (
              <span className="toolbar-item-spacer customize-slot-placeholder" aria-hidden="true" />
            )}
          </span>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
