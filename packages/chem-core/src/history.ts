import type { ChemDraftDocument } from "./schemas";
import { applyPatch, type ApplyPatchOptions, type DocumentPatch } from "./patches";

export interface DocumentHistory {
  past: ChemDraftDocument[];
  present: ChemDraftDocument;
  future: ChemDraftDocument[];
}

export function createDocumentHistory(document: ChemDraftDocument): DocumentHistory {
  return {
    past: [],
    present: document,
    future: []
  };
}

export function applyPatchWithHistory(
  history: DocumentHistory,
  patch: DocumentPatch,
  options: ApplyPatchOptions = {}
): DocumentHistory {
  return {
    past: [...history.past, history.present],
    present: applyPatch(history.present, patch, options),
    future: []
  };
}

export function undo(history: DocumentHistory): DocumentHistory {
  const previous = history.past.at(-1);
  if (!previous) {
    return history;
  }

  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future]
  };
}

export function redo(history: DocumentHistory): DocumentHistory {
  const next = history.future[0];
  if (!next) {
    return history;
  }

  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1)
  };
}
