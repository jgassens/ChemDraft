import type { ChemDraftDocument } from "@chemdraft/chem-core";

/**
 * Undo history keeps whole-document snapshots (every edit produces a fresh deep copy), so its memory
 * is steps × document size. Measured live on a 5,000-molecule page: about 18 MB per step, so the
 * 100-step limit alone let the history of one large drawing grow toward 2 GB — enough to crash the
 * page. The history is therefore bounded by an estimated size as well as by count: an ordinary
 * drawing keeps all 100 steps; a huge one keeps as many as fit, oldest dropped first, and never
 * fewer than `DOCUMENT_HISTORY_MIN_STEPS`.
 */
export const DOCUMENT_HISTORY_LIMIT = 100;
export const DOCUMENT_HISTORY_MIN_STEPS = 5;
/** Size units: one per object, atom, and bond — about 900 bytes of heap each, measured live. */
export const DOCUMENT_HISTORY_WEIGHT_BUDGET = 450_000;

const weights = new WeakMap<ChemDraftDocument, number>();

export function documentHistoryWeight(document: ChemDraftDocument): number {
  const cached = weights.get(document);
  if (cached !== undefined) {
    return cached;
  }
  let weight = 0;
  for (const page of document.pages) {
    for (const object of page.objects) {
      weight += 1;
      if (object.type === "molecule") {
        weight += object.atoms.length + object.bonds.length;
      }
    }
  }
  weights.set(document, weight);
  return weight;
}

/** The newest entries of `past` that fit the count limit and the weight budget. */
export function boundedHistoryPast(
  past: readonly ChemDraftDocument[],
  budget: number = DOCUMENT_HISTORY_WEIGHT_BUDGET
): ChemDraftDocument[] {
  const recent = past.slice(-DOCUMENT_HISTORY_LIMIT);
  let total = 0;
  let keep = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    total += documentHistoryWeight(recent[index]!);
    if (keep >= DOCUMENT_HISTORY_MIN_STEPS && total > budget) {
      break;
    }
    keep += 1;
  }
  return recent.slice(recent.length - keep);
}
