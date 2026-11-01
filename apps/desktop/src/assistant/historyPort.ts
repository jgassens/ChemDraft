import type { AssistantRect } from "./AssistantToolContext";
import type { ChemDraftDocument } from "@chemdraft/chem-core";

/** Selection patches rebuild page arrays too; array identity alone is not a document edit. */
export function assistantDocumentContentUnchanged(before: ChemDraftDocument, after: ChemDraftDocument): boolean {
  const { selection: _beforeSelection, updatedAt: _beforeTime, pages: beforePages, ...beforeShell } = before;
  const { selection: _afterSelection, updatedAt: _afterTime, pages: afterPages, ...afterShell } = after;
  if (JSON.stringify(beforeShell) !== JSON.stringify(afterShell) || beforePages.length !== afterPages.length) return false;
  return beforePages.every((page, index) => {
    const { objects, ...shell } = page;
    const { objects: nextObjects, ...nextShell } = afterPages[index]!;
    return JSON.stringify(shell) === JSON.stringify(nextShell) && objects.length === nextObjects.length &&
      objects.every((object, objectIndex) => object === nextObjects[objectIndex] ||
        JSON.stringify(object) === JSON.stringify(nextObjects[objectIndex]));
  });
}

/** The assistant owns no editor state. Every operation addresses the tab captured at Send. */
export interface AssistantHistoryPort {
  /** Desktop gesture gate and page-coordinate viewport, bound to the requested tab. */
  runWrite?<T>(apply: () => T): Promise<T>;
  getViewportRect?(tabId: string): AssistantRect | undefined;
  read(tabId: string): ChemDraftDocument | undefined;
  push(tabId: string, before: ChemDraftDocument, after: ChemDraftDocument, label: string): void;
  amend(tabId: string, after: ChemDraftDocument, label: string): void;
  select(tabId: string, objectIds: readonly string[], label: string): void;
  onUserEdit(listener: (tabId: string) => void): () => void;
  undo(tabId: string, expected: ChemDraftDocument): boolean;
}

let mountedPort: AssistantHistoryPort | undefined;

/** MainWindow binds this once; this is a host interface, never a window/DOM API. */
export function registerAssistantHistoryPort(port: AssistantHistoryPort): () => void {
  mountedPort = port;
  return () => { if (mountedPort === port) mountedPort = undefined; };
}

export function getAssistantHistoryPort(): AssistantHistoryPort {
  if (!mountedPort) throw new Error("The document window is closed; assistant writes were refused.");
  return mountedPort;
}
