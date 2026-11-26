import type { DocumentObject, MoleculeObject, ReactionObject } from "@chemdraft/chem-core";

/**
 * Step attributes that hold atom-map edges: a flat list of CDXML node ids read in pairs
 * (reactant atom, product atom). ChemDraft keeps them as opaque source metadata in
 * `reaction.compatibility.unknown.cdxmlStepAttributes`.
 *
 * What a stored id means: it names the one atom, among the step's **own component molecules**,
 * whose `compatibility.unknown.cdxmlAtomIdsByAtomId` entry is that id. A copied molecule keeps
 * its source node ids, so the same string can also name an atom of the original; scoping the
 * lookup to the step's components is what makes a copied step's edges name the copy's atoms.
 * Export writes each resolved atom's exported node id, never the stored string as is.
 */
export const reactionStepAtomMapAttributes = ["ReactionStepAtomMap", "ReactionStepAtomMapManual", "ReactionStepAtomMapAuto"] as const;
export type ReactionStepAtomMapAttribute = typeof reactionStepAtomMapAttributes[number];

export interface ReactionStepAtomRef {
  objectId: string;
  atomId: string;
  /** The source node id stored in the step attribute. */
  sourceId: string;
}

export interface ReactionStepAtomMapEdge {
  from: ReactionStepAtomRef;
  to: ReactionStepAtomRef;
}

export interface DroppedReactionStepAtomMapEdge {
  sourceIds: string[];
  reason: string;
}

export interface ReactionStepAtomMapResolution {
  attribute: ReactionStepAtomMapAttribute;
  /** The attribute's stored text, unchanged. */
  value: string;
  edges: ReactionStepAtomMapEdge[];
  dropped: DroppedReactionStepAtomMapEdge[];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** The step attribute record a reaction preserved from its source, if any. */
export function reactionStepAttributes(reaction: ReactionObject): Record<string, string> {
  return stringRecord(reaction.compatibility?.unknown.cdxmlStepAttributes);
}

/**
 * Resolves every nonempty atom-map attribute of a reaction to atoms of its own component molecules.
 * An edge with an id that names no atom of the step, names more than one, or has no partner (an odd
 * list) is reported in `dropped`, never guessed.
 */
export function resolveReactionStepAtomMaps(
  reaction: ReactionObject,
  objects: ReadonlyMap<string, DocumentObject>
): ReactionStepAtomMapResolution[] {
  const attributes = reactionStepAttributes(reaction);
  const present = reactionStepAtomMapAttributes.filter(attribute => (attributes[attribute] ?? "").trim());
  if (!present.length) return [];
  const molecules = [...new Set(reaction.components.map(component => component.objectId))]
    .map(id => objects.get(id)).filter((object): object is MoleculeObject => object?.type === "molecule");
  const atomsBySourceId = new Map<string, Array<{ objectId: string; atomId: string }>>();
  for (const molecule of molecules) {
    const sourceIds = stringRecord(molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId);
    for (const atom of molecule.atoms) {
      const sourceId = sourceIds[atom.id];
      if (sourceId === undefined) continue;
      const list = atomsBySourceId.get(sourceId) ?? [];
      list.push({ objectId: molecule.id, atomId: atom.id });
      atomsBySourceId.set(sourceId, list);
    }
  }
  return present.map(attribute => {
    const value = attributes[attribute]!;
    const ids = value.trim().split(/\s+/);
    const edges: ReactionStepAtomMapEdge[] = [];
    const dropped: DroppedReactionStepAtomMapEdge[] = [];
    for (let index = 0; index < ids.length; index += 2) {
      const pair = ids.slice(index, index + 2);
      if (pair.length < 2) {
        dropped.push({ sourceIds: pair, reason: "it has no partner atom" });
        continue;
      }
      const resolved = pair.map(sourceId => ({ sourceId, hits: atomsBySourceId.get(sourceId) ?? [] }));
      const missing = resolved.filter(end => end.hits.length === 0).map(end => end.sourceId);
      const ambiguous = resolved.filter(end => end.hits.length > 1).map(end => end.sourceId);
      if (missing.length || ambiguous.length) {
        dropped.push({ sourceIds: pair, reason: missing.length
          ? `atom ${missing.join(" and ")} is not in the reaction`
          : `atom ${ambiguous.join(" and ")} names more than one atom of the reaction` });
        continue;
      }
      const [from, to] = resolved.map(end => ({ ...end.hits[0]!, sourceId: end.sourceId }));
      edges.push({ from: from!, to: to! });
    }
    return { attribute, value, edges, dropped };
  });
}

/** "201 304" / "201 304, 105 305" for messages. */
export function describeDroppedAtomMapEdges(dropped: readonly DroppedReactionStepAtomMapEdge[]): string {
  return dropped.map(edge => edge.sourceIds.join("→")).join(", ");
}
