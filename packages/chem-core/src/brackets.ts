import type { BracketObject, ChemDraftDocument, DocumentObject, MoleculeObject } from "./schemas";
import { resolveRepeatUnitAtomMembership, type RepeatUnitMembershipOptions } from "./repeatUnitMembership";

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
  const { pairId: _pairId, repeatUnit: _repeatUnit, label: _label,
    bracketUsage: _usage, repeatCount: _count, crossingBondIds: _crossing, ...plain } = object;
  return { ...plain, containedObjectIds: [], bracketKind: object.bracketKind === "polymer" ? "square" : object.bracketKind };
}

/** Only call on an owned, parsed document; never mutate an undo snapshot. */
export function normalizeBracketPairs(document: ChemDraftDocument): ChemDraftDocument {
  for (const page of document.pages) {
    const pairs = bracketPairs(page.objects);
    page.objects = page.objects.map(object => {
      if (object.type !== "bracket" || (object.pairId && pairs.has(object.pairId)) ||
        (object.pairId === undefined && object.repeatUnit === undefined && object.label === undefined &&
          object.bracketUsage === undefined && object.repeatCount === undefined && object.crossingBondIds === undefined)) return object;
      if (!document.compatibility.warnings.some(warning => warning.code === "document.bracket_partner_missing" && warning.objectId === object.id)) {
        document.compatibility.warnings.push({ code: "document.bracket_partner_missing", objectId: object.id,
          message: `Bracket ${object.id} had no partner; repeat-unit mark removed.` });
      }
      return withoutBracketPairMetadata(object);
    });
  }
  return withBracketChemistryWarnings(document);
}

/** The graph is one drawn copy. Never interpret a bracket multiplier as additional atoms. */
export function bracketChemistryWarnings(document: ChemDraftDocument, molecule: MoleculeObject, options: RepeatUnitMembershipOptions = {}): { pairId: string; objectId: string; message: string }[] {
  const page = document.pages.find(page => page.objects.some(object => object.id === molecule.id));
  if (!page) return [];
  return chemistryWarningsForPairs(bracketPairs(page.objects), molecule, page.objects, options);
}

function chemistryWarningsForPairs(pairs: ReadonlyMap<string, BracketObject[]>, molecule: MoleculeObject,
  objects: readonly DocumentObject[], options: RepeatUnitMembershipOptions = {}) {
  return [...pairs].flatMap(([pairId, pair]) => {
    const usage = pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage ??
      (pair.some(object => object.repeatUnit || object.bracketKind === "polymer") ? "sru" : "generic");
    if (usage === "generic") return [];
    const membership = resolveRepeatUnitAtomMembership(pair, objects, options);
    if (!membership.referencedObjectIds.has(molecule.id)) return [];
    const closing = pair.find(object => object.side === "close")!;
    const count = pair.find(object => object.repeatCount !== undefined)?.repeatCount;
    const label = closing.label === undefined ? "n" : closing.label || "(unassociated label)";
    const description = usage === "multiple" ? `a multiple group x${count ?? "?"}` : usage === "sru" ?
      `a repeat unit ${label}; polymer formula not computed` : "a bracket group with unknown usage";
    return [{ pairId, objectId: closing.id, message: membership.reason
      ? `Repeat unit membership for bracket ${closing.id} cannot be resolved: ${membership.reason}. Molecule ${molecule.id} cannot be analyzed as a finite graph.`
      : `Molecule ${molecule.id} is inside ${description}; values and molecular graph exports are for one drawn copy only.` }];
  });
}

/** Annotate cached formula/mass data without deriving chemistry or changing a molecular graph. */
export function withBracketChemistryWarnings(document: ChemDraftDocument): ChemDraftDocument {
  let changed = false;
  const pages = document.pages.map(page => {
    const pairs = bracketPairs(page.objects);
    let pageChanged = false;
    const objects = page.objects.map(object => {
      if (object.type !== "molecule" || !object.chemistry) return object;
      const previous = object.chemistry.warnings;
      if (!pairs.size && !previous.some(warning => warning.code === "chemistry.bracket_multiplier")) return object;
      const warnings = [...previous.filter(warning => warning.code !== "chemistry.bracket_multiplier"),
        ...chemistryWarningsForPairs(pairs, object, page.objects).map(warning => ({ code: "chemistry.bracket_multiplier", objectId: object.id, message: warning.message }))];
      if (JSON.stringify(previous) === JSON.stringify(warnings)) return object;
      changed = pageChanged = true;
      return { ...object, chemistry: { ...object.chemistry, warnings } };
    });
    return pageChanged ? { ...page, objects } : page;
  });
  return changed ? { ...document, pages } : document;
}

/** Document-aware callers use live pair context; graph-only callers retain cached context warnings. */
export function moleculeBracketWarningMessages(molecule: MoleculeObject, document?: ChemDraftDocument, options: RepeatUnitMembershipOptions = {}): string[] {
  return document ? bracketChemistryWarnings(document, molecule, options).map(warning => warning.message) :
    (molecule.chemistry?.warnings.filter(warning => warning.code === "chemistry.bracket_multiplier").map(warning => warning.message) ?? []);
}
