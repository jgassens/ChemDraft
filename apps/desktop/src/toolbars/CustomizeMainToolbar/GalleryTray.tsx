import { useMemo, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ToolbarItemIcon } from "../../ToolPalette";
import type { ToolbarPaletteItemModel } from "../../toolsets";
import type { CommandSpec } from "../../commands";
import {
  GALLERY_TRAY_DROPPABLE_ID,
  buildGallerySections,
  type GalleryEntry,
  type GalleryWidgetDescriptor
} from "./galleryModel";

/** Build a full palette item model for a gallery entry so `ToolbarItemIcon` can render its icon. */
function entryIconItem(entry: GalleryEntry): ToolbarPaletteItemModel {
  return {
    id: entry.dragId,
    kind: "button",
    label: entry.title,
    icon: entry.icon,
    assetName: entry.assetName,
    primary: entry.command
      ? { type: "command", command: entry.command }
      : { type: "none" },
    submenu: null,
    tooltip: { title: entry.title },
    layout: { colSpan: 1, rowSpan: 1 }
  };
}

function GalleryTile({ entry }: { entry: GalleryEntry }) {
  const iconItem = useMemo(() => entryIconItem(entry), [entry]);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.dragId,
    disabled: entry.present,
    data: {
      gallery: true,
      galleryKind: entry.kind,
      commandId: entry.commandId,
      widgetId: entry.widgetId,
      iconItem,
      command: entry.command
    }
  });

  const structural = entry.kind === "spacer" || entry.kind === "separator";
  const className = [
    "gallery-tile",
    structural ? "gallery-tile-structural" : entry.kind === "widget" ? "gallery-tile-widget" : "gallery-tile-command",
    entry.present ? "gallery-tile-present" : "",
    isDragging ? "gallery-tile-dragging" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={className}
      // Opt out of PaletteWindow's shell-drag and popover-dismiss closest() checks so grabbing a tile
      // doesn't move the window or dismiss popovers.
      data-palette-control="true"
      disabled={entry.present}
      title={entry.present ? `${entry.title} (already in the toolbar)` : entry.title}
      aria-label={entry.title}
      {...attributes}
      {...listeners}
    >
      <span className="gallery-tile-icon" aria-hidden="true">
        {entry.kind === "spacer" ? (
          <span className="gallery-tile-spacer-glyph" />
        ) : entry.kind === "separator" ? (
          <span className="gallery-tile-separator-glyph" />
        ) : (
          <ToolbarItemIcon item={iconItem} command={entry.command} />
        )}
      </span>
      <span className="gallery-tile-label">{entry.title}</span>
    </button>
  );
}

/**
 * The gallery tray shown under the Main palette in customize mode. Drag a tile up into the toolbar to
 * add it; drag a toolbar item down onto the tray to remove it. Lives inside the palette window (a
 * webview can't paint outside its window), so the window grows to fit it via the shell ResizeObserver.
 */
export function GalleryTray({
  commands,
  widgets = [],
  presentItemIds
}: {
  commands: readonly CommandSpec[];
  widgets?: readonly GalleryWidgetDescriptor[];
  presentItemIds: ReadonlySet<string>;
}) {
  const [search, setSearch] = useState("");
  const sections = useMemo(
    () => buildGallerySections(commands, widgets, presentItemIds, search),
    [commands, widgets, presentItemIds, search]
  );
  const { setNodeRef, isOver } = useDroppable({ id: GALLERY_TRAY_DROPPABLE_ID });

  return (
    <section
      ref={setNodeRef}
      className={["customize-gallery-tray", isOver ? "customize-gallery-tray-over" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label="Toolbar item gallery"
    >
      <div className="customize-gallery-search">
        <input
          type="search"
          className="customize-gallery-search-input"
          placeholder="Search items…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search toolbar items"
        />
      </div>
      <div className="customize-gallery-sections">
        {sections.map((section) => (
          <section key={section.id} className="customize-gallery-section" aria-label={section.title}>
            <h4 className="customize-gallery-section-title">{section.title}</h4>
            <div className="customize-gallery-grid">
              {section.entries.map((entry) => (
                <GalleryTile key={entry.dragId} entry={entry} />
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 ? <p className="customize-gallery-empty">No items match.</p> : null}
      </div>
      <p className="customize-gallery-hint">Drag items to the toolbar. Drag a tool here to remove it.</p>
    </section>
  );
}
