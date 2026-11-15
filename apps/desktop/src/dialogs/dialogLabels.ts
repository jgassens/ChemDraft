import { isDocumentWindowId } from "../documentIdentity";
import type { DialogKind } from "./dialogProtocol";

const kinds: readonly string[] = ["pageSize", "arrangementSpacing", "reactionConditions", "export", "engineInstall", "toolInstall", "customColor", "insertTable", "structureTemplates", "atomProblem", "vibeCodeGuide"];

export function isDialogOwnerId(owner: unknown): owner is string {
  return isDocumentWindowId(owner) && owner.length <= 128 && !/[^A-Za-z0-9_-]/.test(owner);
}

/** Syntax only. Rust verifies registry membership and the actual calling native window. */
export function parseDialogLabel(label: unknown): { ownerWindowId: string; kind: DialogKind; slot: string } | undefined {
  if (typeof label !== "string") return undefined;
  // Split from the right: document ids contain hyphens (including UUID separators).
  const match = /^dialog-(.+)-([A-Za-z]+)-([0-9]{1,20})$/.exec(label);
  if (!match || match[0] !== label || !isDialogOwnerId(match[1]) || !kinds.includes(match[2]!)) return undefined;
  return { ownerWindowId: match[1]!, kind: match[2] as DialogKind, slot: match[3]! };
}

export function formatDialogLabel(ownerWindowId: string, kind: DialogKind, slot: string): string {
  const label = `dialog-${ownerWindowId}-${kind}-${slot}`;
  if (!parseDialogLabel(label)) throw new Error("Invalid dialog label");
  return label;
}
