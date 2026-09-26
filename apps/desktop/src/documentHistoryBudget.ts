import type { ChemDraftDocument } from "@chemdraft/chem-core";

/**
 * Undo history keeps whole-document snapshots. The patch engine shares unchanged objects between
 * them, so a snapshot costs what its edit changed — but an edit that rewrites everything (rotate a
 * select-all) shares nothing, and measured live on a 5,000-molecule page each such step held about
 * 18 MB: the 100-step limit alone let one large drawing's history grow toward 2 GB, enough to crash
 * the page. The history is therefore bounded by the size it actually retains as well as by count:
 * an ordinary drawing keeps all 100 steps; a huge one keeps as many as fit, oldest dropped first,
 * and never fewer than `DOCUMENT_HISTORY_MIN_STEPS`.
 */
export const DOCUMENT_HISTORY_LIMIT = 100;
export const DOCUMENT_HISTORY_MIN_STEPS = 5;
/** Size units: one per object, atom, and bond — about 900 bytes of heap each, measured live. */
export const DOCUMENT_HISTORY_WEIGHT_BUDGET = 450_000;

const weights = new WeakMap<ChemDraftDocument, number>();

type DocumentObjectOf = ChemDraftDocument["pages"][number]["objects"][number];

function objectWeight(object: DocumentObjectOf): number {
  return 1 + (object.type === "molecule" ? object.atoms.length + object.bonds.length : 0);
}

export function documentHistoryWeight(document: ChemDraftDocument): number {
  const cached = weights.get(document);
  if (cached !== undefined) {
    return cached;
  }
  let weight = 0;
  for (const page of document.pages) {
    for (const object of page.objects) {
      weight += objectWeight(object);
    }
  }
  weights.set(document, weight);
  return weight;
}

/**
 * The weight of what `older` holds that `newer` does not share. The patch engine shares unchanged
 * objects between documents, so consecutive snapshots overlap almost entirely after a small edit, and
 * charging each its full size would drop steps that cost next to nothing. Cached per pair: past
 * entries only gain a new neighbour at the newest end, so each pair is measured once.
 */
const exclusiveWeights = new WeakMap<ChemDraftDocument, { newer: ChemDraftDocument; weight: number }>();

export function exclusiveHistoryWeight(older: ChemDraftDocument, newer: ChemDraftDocument): number {
  const cached = exclusiveWeights.get(older);
  if (cached?.newer === newer) {
    return cached.weight;
  }
  const newerObjects = new Set<DocumentObjectOf>();
  for (const page of newer.pages) {
    for (const object of page.objects) {
      newerObjects.add(object);
    }
  }
  let weight = 0;
  for (const page of older.pages) {
    for (const object of page.objects) {
      if (!newerObjects.has(object)) {
        weight += objectWeight(object);
      }
    }
  }
  exclusiveWeights.set(older, { newer, weight });
  return weight;
}

/**
 * The newest entries of `past` that fit the count limit and the weight budget, counting an object
 * shared by several snapshots once. `present` is the document the history returns to after its
 * newest past entry: that entry holds only what `present` does not share, and charging it its full
 * size made any drawing heavier than the budget keep the five-step floor, however small each edit.
 */
export function boundedHistoryPast(
  past: readonly ChemDraftDocument[],
  present?: ChemDraftDocument,
  budget: number = DOCUMENT_HISTORY_WEIGHT_BUDGET
): ChemDraftDocument[] {
  const recent = past.slice(-DOCUMENT_HISTORY_LIMIT);
  let total = 0;
  let keep = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const newer = recent[index + 1] ?? present;
    total += newer ? exclusiveHistoryWeight(recent[index]!, newer) : documentHistoryWeight(recent[index]!);
    if (keep >= DOCUMENT_HISTORY_MIN_STEPS && total > budget) {
      break;
    }
    keep += 1;
  }
  return recent.slice(recent.length - keep);
}
