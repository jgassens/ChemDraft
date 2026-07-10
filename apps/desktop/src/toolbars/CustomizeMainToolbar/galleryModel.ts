import type { CommandSpec } from "../../commands";
import type { IconName } from "../../icons";
import type { ToolbarAssetName } from "../../toolbarAssets";

/** The structural tiles the gallery always offers (Safari's "Space" plus a thin divider). */
export type GalleryStructuralKind = "spacer" | "separator";
export type GalleryEntryKind = "command" | "widget" | GalleryStructuralKind;

export const GALLERY_DRAG_ID_PREFIX = "gallery:";

/** dnd-kit droppable id for the tray as a whole. Dropping an in-toolbar item here removes it (Safari
 *  behavior: drag an item off the bar and into the gallery to take it out). */
export const GALLERY_TRAY_DROPPABLE_ID = "gallery-tray";

/** dnd-kit draggable id for a gallery tile. Command/widget tiles embed their id so a drop can read it
 *  straight off `active.id` without a lookup; structural tiles are a fixed pair. */
export function galleryDragId(kind: GalleryEntryKind, id?: string): string {
  return kind === "command" || kind === "widget" ? `${GALLERY_DRAG_ID_PREFIX}${kind}:${id}` : `${GALLERY_DRAG_ID_PREFIX}${kind}`;
}

/** A toolset section-widget the gallery can offer (e.g. the Main style controls) — its control id
 *  plus a human title/icon for the tile. */
export interface GalleryWidgetDescriptor {
  id: string;
  title: string;
  icon?: IconName;
}

export interface GalleryEntry {
  /** dnd-kit draggable id (see `galleryDragId`). */
  dragId: string;
  kind: GalleryEntryKind;
  /** Present on command entries. */
  commandId?: string;
  /** Present on widget entries (the control id). */
  widgetId?: string;
  title: string;
  icon?: IconName;
  assetName?: ToolbarAssetName;
  /** The command spec, for icon rendering; undefined for non-command entries. */
  command?: CommandSpec;
  /** True when this item is already in the toolbar — the tile is shown grayed and is not draggable
   *  (a command/widget id is unique in a toolset, so it can appear at most once). */
  present: boolean;
}

/** How many command tiles to show at once — the same soft cap the Customize dialog uses so a long
 *  catalog doesn't balloon the tray. Structural tiles are always shown on top of this. */
export const GALLERY_COMMAND_LIMIT = 40;

const STRUCTURAL_ENTRIES: ReadonlyArray<{ kind: GalleryStructuralKind; title: string; icon: IconName }> = [
  { kind: "spacer", title: "Space", icon: "palette" },
  { kind: "separator", title: "Divider", icon: "palette" }
];

function matchesSearch(query: string, ...fields: (string | undefined)[]): boolean {
  if (query.length === 0) {
    return true;
  }
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(query));
}

/**
 * Build the gallery entries for the tray: the two structural tiles (Space, Divider) first, then any
 * section widgets (style controls, inspectors) the toolset declares, then the command catalog deduped
 * by id (first spec wins, matching the Customize dialog), filtered by the search box, and capped.
 * `presentItemIds` are the customization ids already in the toolbar — present command/widget tiles
 * render grayed and inert so an item can't be added twice.
 */
export function buildGalleryModel(
  commands: readonly CommandSpec[],
  widgets: readonly GalleryWidgetDescriptor[],
  presentItemIds: ReadonlySet<string>,
  search: string
): GalleryEntry[] {
  const query = search.trim().toLowerCase();

  const structural: GalleryEntry[] = STRUCTURAL_ENTRIES.filter((entry) =>
    matchesSearch(query, entry.title, entry.kind)
  ).map((entry) => ({
    dragId: galleryDragId(entry.kind),
    kind: entry.kind,
    title: entry.title,
    icon: entry.icon,
    present: false
  }));

  const widgetEntries: GalleryEntry[] = widgets
    .filter((widget) => matchesSearch(query, widget.title, widget.id))
    .map((widget) => ({
      dragId: galleryDragId("widget", widget.id),
      kind: "widget" as const,
      widgetId: widget.id,
      title: widget.title,
      icon: widget.icon,
      present: presentItemIds.has(widget.id)
    }));

  const seen = new Set<string>();
  const commandEntries: GalleryEntry[] = [];
  for (const command of commands) {
    if (seen.has(command.id)) {
      continue;
    }
    seen.add(command.id);
    if (!matchesSearch(query, command.title, command.id)) {
      continue;
    }
    commandEntries.push({
      dragId: galleryDragId("command", command.id),
      kind: "command",
      commandId: command.id,
      title: command.title,
      icon: command.icon,
      assetName: command.assetName,
      command,
      present: presentItemIds.has(command.id)
    });
    if (commandEntries.length >= GALLERY_COMMAND_LIMIT) {
      break;
    }
  }

  return [...structural, ...widgetEntries, ...commandEntries];
}
