import type { BracketObject, ChemDraftDocument, DocumentObject } from "./schemas";

/** Pair identities are page-local and require exactly one opening and one closing glyph. */
export function bracketPairs(objects: readonly DocumentObject[]): Map<string, BracketObject[]> {
  const pairs = new Map<string, BracketObject[]>();
  for (const object of objects) {
    if (object.type !== "bracket" || !object.pairId) continue;
    const pair = pairs.get(object.pairId) ?? [];
    pair.push(object);
    pairs.set(object.pairId, pair);
  }
  for (const [id, pair] of pairs) {
    if (pair.length !== 2 || !pair.some(object => object.side === "open") || !pair.some(object => object.side === "close")) {
      pairs.delete(id);
    }
  }
  return pairs;
}

export function withoutBracketPairMetadata(object: BracketObject): BracketObject {
  const { pairId: _pairId, repeatUnit: _repeatUnit, label: _label, ...plain } = object;
  return { ...plain, containedObjectIds: [], bracketKind: object.bracketKind === "polymer" ? "square" : object.bracketKind };
}

/** Only call on an owned, parsed document; never mutate an undo snapshot. */
export function normalizeBracketPairs(document: ChemDraftDocument): ChemDraftDocument {
  for (const page of document.pages) {
    const pairs = bracketPairs(page.objects);
    page.objects = page.objects.map(object => {
      if (object.type !== "bracket" || (object.pairId && pairs.has(object.pairId)) ||
        (object.pairId === undefined && object.repeatUnit === undefined && object.label === undefined)) return object;
      document.compatibility.warnings.push({ code: "document.bracket_partner_missing", objectId: object.id,
        message: `Bracket ${object.id} had no partner; repeat-unit mark removed.` });
      return withoutBracketPairMetadata(object);
    });
  }
  return document;
}
