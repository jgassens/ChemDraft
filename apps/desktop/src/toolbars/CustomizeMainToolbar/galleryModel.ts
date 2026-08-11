import { parseToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import type { CommandSpec } from "../../commands";
import { isRenamedCommandId } from "../../renamedCommands";
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
 * section widgets (style controls) offered, then the FULL command catalog deduped by id (first spec
 * wins, matching the Customize dialog) and filtered by the search box. Not capped — the toolbar must
 * be able to host every tool, and the tray scrolls. `presentItemIds` are the customization ids already
 * in the toolbar — present command/widget tiles render grayed and inert so an item can't be added twice.
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
    // A retired alias is not a separate tool. Both ids pass the catalog's tool.* filter, so the
    // gallery listed two identically-titled "Reaction Arrow" tiles — and the legacy one built the
    // retired object type.
    if (isRenamedCommandId(command.id)) {
      continue;
    }
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
  }

  return [...structural, ...widgetEntries, ...commandEntries];
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Themed sections. The flat entry list groups into labeled sections so ~270 tiles read as a catalog,
// not a dump. Section membership is derived from the command-id families (tool.*, text.*, layout.*,
// atom.*, …) — chemistry-first ordering: draw the molecule (selection, bonds, rings, atoms), annotate
// the reaction (arrows, charges, orbitals), analyze it (3D/cleanup), then art/layout/housekeeping.
// ————————————————————————————————————————————————————————————————————————————————————————————————

export interface GallerySection {
  id: string;
  title: string;
  entries: GalleryEntry[];
}

/** Display order + titles. "layout" (Space/Divider), "widgets", and "toolbars" lead because they're
 *  the gallery-only items a user can't find anywhere else; command themes follow chemistry-first. */
const GALLERY_SECTIONS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "layout", title: "Layout" },
  { id: "widgets", title: "Widgets" },
  { id: "toolbars", title: "Toolbars (show/hide)" },
  { id: "selection", title: "Selection & Erase" },
  { id: "bonds", title: "Bonds & Chains" },
  { id: "rings", title: "Rings & Templates" },
  { id: "atoms", title: "Atoms & Elements" },
  { id: "arrows", title: "Arrows & Reactions" },
  { id: "symbols", title: "Charges, Brackets & Symbols" },
  { id: "orbitals", title: "Orbitals" },
  { id: "chemistry", title: "Chemistry & 3D" },
  { id: "text", title: "Text & Typography" },
  { id: "art", title: "Art & Shapes" },
  { id: "objectStyle", title: "Object Style" },
  { id: "arrange", title: "Arrange & Align" },
  { id: "editing", title: "Clipboard & History" },
  { id: "document", title: "Document & Pages" },
  { id: "view", title: "View & Zoom" },
  { id: "layers", title: "Layers" },
  { id: "stylePresets", title: "Style Presets" },
  { id: "other", title: "Other" }
];

/** First matching family wins. Kept as data (pattern → section) so new command families land in a
 *  sensible bucket by prefix without touching the tray. */
const COMMAND_SECTION_RULES: ReadonlyArray<{ pattern: RegExp; section: string }> = [
  // A button that shows/hides another toolbar — the way grid-replacing surfaces (Art, the inspectors)
  // are reachable from Main without embedding them.
  { pattern: /^view\.toolset\.toggle\./, section: "toolbars" },
  { pattern: /^view\.toggle(MoleculeInspector|RingInspector|ToolPalette)$/, section: "toolbars" },
  { pattern: /^tool\.(select|lasso|eraser)$/, section: "selection" },
  { pattern: /^tool\.(bond|wedgeBond|hashedBond|dashedBond|boldBond|chain)$/, section: "bonds" },
  { pattern: /^bond\./, section: "bonds" },
  { pattern: /^tool\.(cyclopentane|cyclohexane|benzene|chairCyclohexane)/, section: "rings" },
  { pattern: /^atom\./, section: "atoms" },
  // Keyed on the art-arrow family, which is what the arrow tools actually are since they gained
  // real art geometry. This used to name only the four retired aliases, so once those stopped being
  // offered the section emptied out — and even before that, every arrow a user could usefully add
  // was filed under the generic "Art" heading by the `tool.art.` rule below.
  {
    pattern: /^tool\.art\.(arrow|reactionArrow|reactionArrowBold|reactionArrowDashed|resonanceArrow|equilibriumArrow|retroArrow|noReactionArrow)$/,
    section: "arrows"
  },
  // `tool.symbol` also has per-glyph variants (tool.symbol.degree, …), so the family is matched by
  // prefix rather than anchored exactly.
  { pattern: /^tool\.(plus|minus|plusPlain|minusPlain|radicalCation|radicalAnion|radical|lonePair|mechanismArrow|mechanismFishhook|bracket|squareBracket|dagger)$|^tool\.(symbol|charge)(\.|$)/, section: "symbols" },
  { pattern: /^tool\.(lobe|shadedLobe|pOrbital|sOrbital)$/, section: "orbitals" },
  { pattern: /^(structure|chemistry)\./, section: "chemistry" },
  { pattern: /^tool\.text$/, section: "text" },
  { pattern: /^text\./, section: "text" },
  { pattern: /^style\.formulaText$/, section: "text" },
  { pattern: /^tool\.art\./, section: "art" },
  { pattern: /^tool\.(shape|shapeShadow)$/, section: "art" },
  { pattern: /^art\./, section: "art" },
  { pattern: /^object\./, section: "objectStyle" },
  { pattern: /^style\.color$/, section: "objectStyle" },
  { pattern: /^layout\./, section: "arrange" },
  { pattern: /^(edit|clipboard)\./, section: "editing" },
  { pattern: /^(document|export|page)\./, section: "document" },
  { pattern: /^view\.(zoom|toggle)/, section: "view" },
  { pattern: /^layer\./, section: "layers" },
  { pattern: /^style\./, section: "stylePresets" }
];

function commandSectionId(commandId: string): string {
  for (const rule of COMMAND_SECTION_RULES) {
    if (rule.pattern.test(commandId)) {
      return rule.section;
    }
  }
  return "other";
}

/** "Toggle Art Toolbar" reads redundantly under the "Toolbars (show/hide)" header — show "Art
 *  Toolbar" on the tile (the command title itself is untouched). */
function sectionDisplayTitle(section: string, entry: GalleryEntry): string {
  if (section === "toolbars" && entry.title.startsWith("Toggle ")) {
    return entry.title.slice("Toggle ".length);
  }
  return entry.title;
}

const LEGACY_TOOLBAR_LAUNCHER_TARGETS: Readonly<Record<string, string>> = {
  "view.toggleToolPalette": "core.main",
  "view.toggleRingInspector": "core.ringInspector",
  "view.toggleDrawnStructureSettings": "core.drawnStructureSettings"
};

/** Resolve aliases that show/hide the same toolbar to one stable target identity. */
function toolbarLauncherTargetId(entry: GalleryEntry): string {
  const commandId = entry.commandId ?? "";
  return parseToolsetToggleCommandId(commandId)
    ?? LEGACY_TOOLBAR_LAUNCHER_TARGETS[commandId]
    ?? `command:${commandId}`;
}

function isGeneratedToolbarLauncher(entry: GalleryEntry): boolean {
  return parseToolsetToggleCommandId(entry.commandId ?? "") !== undefined;
}

/**
 * Keep one launcher per target toolbar. Prefer the generated `view.toolset.toggle.*` command because
 * it carries the target id directly and its title follows live toolbar naming; display titles are not
 * identities (two distinct user toolbars may legitimately share one title).
 */
function dedupeToolbarLaunchers(entries: readonly GalleryEntry[]): GalleryEntry[] {
  const result: GalleryEntry[] = [];
  const indexByTarget = new Map<string, number>();
  for (const entry of entries) {
    const target = toolbarLauncherTargetId(entry);
    const existingIndex = indexByTarget.get(target);
    if (existingIndex === undefined) {
      indexByTarget.set(target, result.length);
      result.push(entry);
      continue;
    }
    const existing = result[existingIndex];
    if (existing && !isGeneratedToolbarLauncher(existing) && isGeneratedToolbarLauncher(entry)) {
      result[existingIndex] = entry;
    }
  }
  return result;
}

/**
 * Group the flat gallery model into titled sections, preserving the flat builder's dedupe/search/
 * present semantics. Sections with no matching entries drop out entirely (so a search shows only the
 * themes that hit).
 */
export function buildGallerySections(
  commands: readonly CommandSpec[],
  widgets: readonly GalleryWidgetDescriptor[],
  presentItemIds: ReadonlySet<string>,
  search: string
): GallerySection[] {
  const entries = buildGalleryModel(commands, widgets, presentItemIds, search);
  const bySection = new Map<string, GalleryEntry[]>();
  for (const entry of entries) {
    const section =
      entry.kind === "spacer" || entry.kind === "separator"
        ? "layout"
        : entry.kind === "widget"
          ? "widgets"
          : commandSectionId(entry.commandId ?? "");
    const bucket = bySection.get(section) ?? [];
    bucket.push({ ...entry, title: sectionDisplayTitle(section, entry) });
    bySection.set(section, bucket);
  }
  // The toolbars section can hold legacy and generated commands that open the same window. Dedupe by
  // target toolset id, never by display title: titles are editable and are not unique identities.
  const toolbars = bySection.get("toolbars");
  if (toolbars) {
    bySection.set("toolbars", dedupeToolbarLaunchers(toolbars));
  }
  return GALLERY_SECTIONS.flatMap((section) => {
    const sectionEntries = bySection.get(section.id);
    return sectionEntries && sectionEntries.length > 0
      ? [{ id: section.id, title: section.title, entries: sectionEntries }]
      : [];
  });
}
