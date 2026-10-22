import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";
import { moveDocumentObjects } from "./documentWorkflow";

const directions = [
  { name: "left", key: "ArrowLeft", x: -1, y: 0 },
  { name: "right", key: "ArrowRight", x: 1, y: 0 },
  { name: "up", key: "ArrowUp", x: 0, y: -1 },
  { name: "down", key: "ArrowDown", x: 0, y: 1 }
] as const;

/** Page-space pixels: independent of zoom, like the existing pointer-move primitive. */
export const selectionNudges = directions.flatMap((direction) => [1, 10].map((step) => ({
  id: `layout.nudge.${direction.name}.${step}`,
  title: `Move selection ${direction.name}${step === 10 ? " (large step)" : ""}`,
  shortcut: `${step === 10 ? "Shift+" : ""}${direction.key}`,
  dx: direction.x * step,
  dy: direction.y * step
})));

export function createSelectionNudgeActions(hasSelection: boolean): CommandSpec[] {
  return selectionNudges.map(({ id, title, shortcut }) => ({
    id, title, shortcut, icon: "select", source: "core", category: "layout",
    enabled: hasSelection,
    disabledReason: hasSelection ? undefined : "Select a structure or object to move"
  }));
}

/** A part selection moves its containing molecule rigidly, never distorting chemical geometry. */
export function nudgeDocumentSelection(
  document: ChemDraftDocument,
  commandId: string,
  selectedMoleculeIds: readonly string[] = []
): ChemDraftDocument {
  const nudge = selectionNudges.find((candidate) => candidate.id === commandId);
  if (!nudge) return document;
  return moveDocumentObjects(document, [...new Set([
    ...document.selection.objectIds, ...selectedMoleculeIds
  ])], nudge.dx, nudge.dy, document.selection.pageId);
}

/** Focused widgets and open menus keep their arrow-key navigation. */
export function selectionNudgeOwnsTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return true;
  return !target.closest(
    "button, input, textarea, select, [contenteditable], [role='menu'], [role='menubar'], " +
    "[role='menuitem'], [role='slider'], [role='spinbutton'], [role='tablist'], [role='listbox']"
  );
}
