import { useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { ToolsetLayoutEdit } from "../../window-manager";
import { ToolbarItemIcon } from "../../ToolPalette";
import type { ToolbarPaletteGroupModel, ToolbarPaletteItemModel } from "../../toolsets";

/** dnd-kit `active.data.current` shape a customize slot carries. Gallery tiles (Phase 5) will add
 *  `gallery`/`commandId`; `groupId` is the source group of an in-toolbar slot. */
export interface CustomizeDragData {
  groupId?: string;
  kind?: string;
}

/**
 * Resolve one drag-end into a layout edit (pure, unit-tested). Phase 4 handles in-toolbar slots:
 *  - dropped outside any slot (over === null) → remove the item
 *  - dropped on a sibling in the SAME group → reorder that group
 *  - dropped on another group (base items can't be re-homed; itemOrder is per-group) → snap back
 *  - dropped on itself → no-op
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
  _activeData: CustomizeDragData | undefined,
  overId: string | null,
  groups: readonly ToolbarPaletteGroupModel[]
): ToolsetLayoutEdit | undefined {
  if (overId === null) {
    return { kind: "removeItem", itemId: activeId };
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

/**
 * Owns the single DndContext wrapping the customizable Main palette (and, in Phase 5, the gallery
 * tray). Every drop is resolved to one edit op and handed to `onEdit`; the palette repaints from the
 * main window's re-broadcast, never from a local mutation.
 */
export function ToolbarCustomizeController({
  groups,
  onEdit,
  children
}: {
  toolsetId: string;
  groups: readonly ToolbarPaletteGroupModel[];
  onEdit: (edit: ToolsetLayoutEdit) => void;
  children: ReactNode;
}) {
  const [activeItem, setActiveItem] = useState<ToolbarPaletteItemModel | null>(null);
  // display:contents wrapper (no box of its own) so we can measure the palette's rect on drag-end
  // without changing the shell's grid layout.
  const containerRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    // 5px activation is required in WKWebView — without it micro-movements cancel the drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const item = groups.flatMap((group) => group.items).find((candidate) => candidate.id === id) ?? null;
    setActiveItem(item);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveItem(null);
    let overId = event.over ? String(event.over.id) : null;
    // closestCenter always reports the nearest slot, even when the release point is far off the
    // palette — so `over` is never null and the "dragged out → remove" path would never fire. Detect
    // it geometrically: a release outside the palette's box is a remove (overId forced to null).
    const paletteRect = containerRef.current?.querySelector(".tool-palette")?.getBoundingClientRect();
    const point = dragEndPoint(event);
    if (paletteRect && point && !isPointInRect(point, paletteRect)) {
      overId = null;
    }
    const edit = customizeDragEndEdit(
      String(event.active.id),
      event.active.data.current as CustomizeDragData | undefined,
      overId,
      groups
    );
    if (edit) {
      onEdit(edit);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // The palette window resizes as the tray grows / items move, so re-measure droppables always.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveItem(null)}
    >
      <div ref={containerRef} style={{ display: "contents" }}>
        {children}
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
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
