import { applyPatches, type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";

export function selectedBracketPair(document: ChemDraftDocument): BracketObject[] {
  const objects = document.pages.flatMap(page => page.objects);
  const selected = objects.filter(object => document.selection.objectIds.includes(object.id));
  if (!selected.length || selected.some(object => object.type !== "bracket")) return [];
  const first = selected[0] as BracketObject;
  if (!first.pairId || selected.some(object => object.type !== "bracket" || object.pairId !== first.pairId)) return [];
  const pair = objects.filter((object): object is BracketObject => object.type === "bracket" && object.pairId === first.pairId);
  return pair.length === 2 && pair.some(object => object.side === "open") && pair.some(object => object.side === "close") ? pair : [];
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

export function setBracketRepeatLabel(document: ChemDraftDocument, objectId: string, label: string): ChemDraftDocument {
  const object = document.pages.flatMap(page => page.objects).find(object => object.id === objectId);
  if (object?.type !== "bracket" || object.side !== "close" || !(object.repeatUnit || object.bracketKind === "polymer")) return document;
  const value = label.trim() || "n";
  if (value === (object.label ?? "n")) return document;
  const pair = document.pages.flatMap(page => page.objects).filter(item => item.type === "bracket" && item.pairId === object.pairId);
  return applyPatches(document, [
    { op: "updateObject", objectId, changes: { label: value } },
    { op: "setSelection", pageId: document.selection.pageId, objectIds: pair.map(item => item.id) }
  ]);
}
