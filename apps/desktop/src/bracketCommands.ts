import { applyPatches, bracketPairs, type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";
import { transformPointForObject } from "@chemdraft/layout-engine";

export function selectedBracketPair(document: ChemDraftDocument): BracketObject[] {
  const page = document.pages.find(page => page.id === document.selection.pageId) ?? document.pages[0];
  const objects = page.objects;
  const selected = objects.filter(object => document.selection.objectIds.includes(object.id));
  if (!selected.length || selected.some(object => object.type !== "bracket")) return [];
  const first = selected[0] as BracketObject;
  if (!first.pairId || selected.some(object => object.type !== "bracket" || object.pairId !== first.pairId)) return [];
  return bracketPairs(objects).get(first.pairId) ?? [];
}

export function createBracketCommands(document: ChemDraftDocument): CommandSpec[] {
  const pair = selectedBracketPair(document);
  const repeat = pair.some(object => object.repeatUnit || object.bracketKind === "polymer");
  return [
    { id: "bracket.repeatUnit.toggle", title: repeat ? "Remove Repeat Unit" : "Mark as Repeat Unit", category: "annotation",
      icon: "bracket", enabled: pair.length === 2, disabledReason: pair.length ? undefined : "Select a bracket pair first" },
    { id: "bracket.label.edit", title: "Edit Repeat Label", category: "annotation", icon: "text", enabled: repeat,
      disabledReason: repeat ? undefined : "Mark a bracket pair as a repeat unit first" }
  ];
}

export function toggleBracketRepeatUnit(document: ChemDraftDocument): ChemDraftDocument {
  const pair = selectedBracketPair(document);
  if (!pair.length) return document;
  const repeatUnit = !pair.some(object => object.repeatUnit || object.bracketKind === "polymer");
  return applyPatches(document, [
    ...pair.map(object => ({ op: "updateObject" as const, objectId: object.id, changes: {
      repeatUnit, bracketKind: object.bracketKind === "polymer" ? "square" as const : object.bracketKind,
      ...(repeatUnit && object.side === "close" ? { label: object.label || "n" } : {})
    } })),
    { op: "setSelection", pageId: document.selection.pageId, objectIds: pair.map(object => object.id) }
  ]);
}

/** Describe the result using the same explicit-or-enclosed atom membership as graph exports. */
export function bracketRepeatUnitStatus(document: ChemDraftDocument): string {
  const pair = selectedBracketPair(document);
  const close = pair.find(object => object.side === "close");
  if (!close) return "No bracket pair selected";
  const label = close.label ?? "n";
  if (!pair.some(object => object.repeatUnit || object.bracketKind === "polymer")) return `Removed repeat unit "${label}"`;
  const page = document.pages.find(page => page.objects.some(object => object.id === close.id))!;
  const explicit = new Set(pair.flatMap(object => object.containedObjectIds));
  const left = Math.min(...pair.map(object => object.x));
  const top = Math.min(...pair.map(object => object.y));
  const right = Math.max(...pair.map(object => object.x + object.width));
  const bottom = Math.max(...pair.map(object => object.y + object.height));
  const count = page.objects.reduce((count, object) => count + (object.type !== "molecule" ? 0 :
    object.atoms.filter(atom => {
      if (explicit.has(object.id)) return true;
      const point = transformPointForObject(object, atom);
      return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    }).length), 0);
  return `Marked ${count} ${count === 1 ? "atom" : "atoms"} as repeat unit "${label}"`;
}

export function setBracketRepeatLabel(document: ChemDraftDocument, objectId: string, label: string): ChemDraftDocument {
  const object = document.pages.flatMap(page => page.objects).find(object => object.id === objectId);
  const page = document.pages.find(page => page.objects.some(item => item.id === objectId));
  const pair = object?.type === "bracket" && object.pairId && page ? bracketPairs(page.objects).get(object.pairId) : undefined;
  if (object?.type !== "bracket" || !pair || object.side !== "close" || !(object.repeatUnit || object.bracketKind === "polymer")) return document;
  const value = label.trim() || "n";
  if (value === (object.label ?? "n")) return document;
  return applyPatches(document, [
    { op: "updateObject", objectId, changes: { label: value } },
    { op: "setSelection", pageId: document.selection.pageId, objectIds: pair.map(item => item.id) }
  ]);
}
