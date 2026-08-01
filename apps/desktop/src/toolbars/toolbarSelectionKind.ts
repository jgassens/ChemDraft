import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { nativeArrowToolIdForGraphic, selectedDocumentObjectTypes } from "../documentWorkflow";
import type { MoleculeInspectorContext } from "../moleculeInspectorModel";

/**
 * What the Main Toolbar's style widget is looking at, distilled from the live selection. Computed
 * once in MainWindow and carried to detached palette windows inside the text-style broadcast, so
 * every field must survive JSON (sorted arrays, never Sets — the Tauri emit path serializes, and
 * `JSON.stringify(new Set(...))` is `{}` while the in-window DOM path passes by reference).
 */
export const TOOLBAR_SELECTION_KINDS = ["none", "text", "molecule", "arrow", "shape", "mixed"] as const;

/** `mixed` doubles as "no single variant claims this selection": genuinely mixed-type selections
 *  and single types without a dedicated variant (bracket, plus, group, …) both land there. */
export type ToolbarSelectionKind = (typeof TOOLBAR_SELECTION_KINDS)[number];

/** The widget layouts. Fewer variants than kinds: the mapping lives in {@link toolbarVariantForKind}. */
export type ToolbarStyleVariant = "text" | "molecule" | "arrow" | "shape";

export interface ToolbarSelectionModel {
  kind: ToolbarSelectionKind;
  /** Distinct `DocumentObject["type"]`s in the selection, sorted. */
  objectTypes: readonly string[];
  /** The molecule inspector's already-resolved context ("none" | "molecule" | "ring" | "bond" | "atom"). */
  moleculeContext: MoleculeInspectorContext;
  /** Distinct arrow-family tool ids among the selected graphics, sorted. */
  arrowToolIds: readonly string[];
  /** True while a text object is in caret-edit mode. */
  textEditing: boolean;
  selectedCount: number;
}

export interface ClassifyToolbarSelectionInput {
  document: ChemDraftDocument;
  /**
   * How many of the selected graphics can carry an arrowhead, from the memoized art inspector
   * model (`markersSupportedCount`). Passed in rather than derived here because answering it means
   * running `planNativeArtVisual` per object, which the art model has already done.
   */
  markerCapableGraphicCount?: number;
  /** From the memoized molecule inspector model (`targets.context`) — passing the resolved context
   *  instead of re-running target resolution avoids repeating ring perception per render. */
  moleculeContext: MoleculeInspectorContext;
  activeTextEditObjectId?: string;
}

export function classifyToolbarSelection({
  document,
  moleculeContext,
  activeTextEditObjectId,
  markerCapableGraphicCount
}: ClassifyToolbarSelectionInput): ToolbarSelectionModel {
  const objectTypes = [...selectedDocumentObjectTypes(document)].sort();
  const selectedIds = new Set(document.selection.objectIds);
  const arrowToolIds = new Set<string>();
  let allGraphicsAreArrows = true;
  let graphicCount = 0;
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (!selectedIds.has(object.id) || object.type !== "graphic") {
        continue;
      }
      graphicCount += 1;
      const toolId = nativeArrowToolIdForGraphic(object);
      if (toolId) {
        arrowToolIds.add(toolId);
      } else {
        allGraphicsAreArrows = false;
      }
    }
  }
  // The arrow layout is built around `supportsMarkers`, not around "is an arrow": head style, tail
  // toggle and head size all gate on it, and Set as Default Arrow Style gates separately on a
  // single ARROW. So any open stroke that can carry a head belongs there — a wavy line, a polyline,
  // a freehand stroke. Keying this on the tool id was the last thing insisting otherwise, and it
  // left those strokes on the shape layout (fill, paint type, corners) with no way to add a head at
  // all, even though the commands accept them. Every selected graphic must qualify: showing head
  // controls for a selection that includes a rectangle would lie about the rectangle.
  const everyGraphicCanCarryAHead = graphicCount > 0 && markerCapableGraphicCount === graphicCount;
  const textEditing = activeTextEditObjectId !== undefined;

  return {
    kind: classifyKind({
      objectTypes,
      moleculeContext,
      textEditing,
      selectedCount: document.selection.objectIds.length,
      allGraphicsAreArrows: allGraphicsAreArrows && arrowToolIds.size > 0,
      everyGraphicCanCarryAHead
    }),
    objectTypes,
    moleculeContext,
    arrowToolIds: [...arrowToolIds].sort(),
    textEditing,
    selectedCount: document.selection.objectIds.length
  };
}

function classifyKind({
  objectTypes,
  moleculeContext,
  textEditing,
  selectedCount,
  allGraphicsAreArrows,
  everyGraphicCanCarryAHead
}: {
  objectTypes: readonly string[];
  moleculeContext: MoleculeInspectorContext;
  textEditing: boolean;
  selectedCount: number;
  allGraphicsAreArrows: boolean;
  everyGraphicCanCarryAHead: boolean;
}): ToolbarSelectionKind {
  // A caret beats everything: typing means text styling, whatever else is selected.
  if (textEditing) {
    return "text";
  }
  // An atom/bond/ring sub-selection can coexist with an empty `selection.objectIds` (the inspector
  // adds the part's own object id when resolving targets), so "nothing selected" must consult the
  // molecule context before declaring the selection empty.
  if (selectedCount === 0 && moleculeContext === "none") {
    return "none";
  }
  const nonMoleculeTypes = objectTypes.filter((type) => type !== "molecule");
  if (moleculeContext !== "none" && nonMoleculeTypes.length === 0) {
    return "molecule";
  }
  if (objectTypes.length === 1) {
    const only = objectTypes[0];
    if (only === "text") {
      return "text";
    }
    if (only === "molecule") {
      return "molecule";
    }
    if (only === "graphic") {
      return allGraphicsAreArrows || everyGraphicCanCarryAHead ? "arrow" : "shape";
    }
    // Legacy imported arrows (CDXML round-trips) keep their dedicated object types.
    if (only === "reaction-arrow" || only === "mechanism-arrow") {
      return "arrow";
    }
    // Single types without a dedicated variant (bracket, plus, group, …) take the mixed fallback.
    return "mixed";
  }
  if (objectTypes.length > 1) {
    return "mixed";
  }
  // Selected ids that resolve to no live object (stale selection) read as empty.
  return "none";
}

/** Which layout a kind renders. `none` and `mixed` fall back to the text layout — it edits session
 *  text defaults with nothing selected (today's behavior) and its commands no-op safely on objects
 *  they don't cover. */
export function toolbarVariantForKind(kind: ToolbarSelectionKind): ToolbarStyleVariant {
  switch (kind) {
    case "molecule":
      return "molecule";
    case "arrow":
      return "arrow";
    case "shape":
      return "shape";
    case "none":
    case "text":
    case "mixed":
      return "text";
  }
}
