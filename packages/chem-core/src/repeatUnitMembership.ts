import { CdxmlBracketAtomSnapshotSchema, type BracketObject, type DocumentObject, type MoleculeObject, type MoleculeAtom, type MoleculeBond, type Point } from "./schemas";
import { bracketPairUsage } from "./bracketSemantics";
import { rotatePointAboutCenter } from "./pointRotation";

export type RepeatUnitMembershipOptions = {
  /** Rendering transforms stay in layout-engine. Unrotated native atoms already use page coordinates. */
  atomPosition?: (molecule: MoleculeObject, atom: MoleculeAtom) => Point;
  /** Cached chemistry warnings are compared by the authored-write scope checks. */
  useLegacyDiagnostics?: boolean;
};

export type RepeatUnitAtomMembership = {
  members: { molecule: MoleculeObject; atomIds: string[] }[];
  /** Explicit object members with a stored structure but no native atoms to export. */
  structureOnlyMembers: MoleculeObject[];
  /** References may touch a graph even when imported member ids cannot resolve (#379). */
  crossingAtomIds: Map<string, Set<string>>;
  referencedObjectIds: Set<string>;
  imported: boolean;
  /** Some imported source ids could not be resolved to explicit objects or native atoms. */
  unresolvedMemberReferences: boolean;
  /** True for every invalid membership; reason supplies the shared diagnostic for all consumers. */
  unresolved: boolean;
  connectivity?: "eu" | "ht" | "hh";
  reason?: string;
};

/** The crossing bonds of a drawn SRU have one member atom and one nonmember atom. */
export function isRepeatUnitBoundaryBond(bond: MoleculeBond, atomIds: ReadonlySet<string>): boolean {
  return atomIds.has(bond.fromAtomId) !== atomIds.has(bond.toAtomId);
}

/** Resolve atoms once for UI counts, interchange, analysis and search. Imported source ids are
 * authoritative and scoped through native records: never replace unresolved imports with geometry.
 * Native whole-object membership includes every atom; otherwise use individual enclosed atoms or
 * the component on a crossing's recorded inner side. No multiplier ever expands the graph. */
export function resolveRepeatUnitAtomMembership(
  pair: readonly BracketObject[], objects: readonly DocumentObject[], options: RepeatUnitMembershipOptions = {}
): RepeatUnitAtomMembership {
  const explicit = new Set(pair.flatMap(object => object.containedObjectIds));
  const crossingAtomIds = new Map<string, Set<string>>();
  const refs = pair.flatMap(object => object.crossingBondIds ?? []);
  const crossings = pair.flatMap(object => {
    const entries = object.compatibility?.unknown.cdxmlBracketCrossings;
    return Array.isArray(entries) ? entries.filter(record) : [];
  });
  const referencedObjectIds = new Set(explicit);
  for (const bracket of pair) {
    const ids = bracket.compatibility?.unknown.cdxmlBracketMemberObjectIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") referencedObjectIds.add(id);
  }
  for (const ref of [...refs, ...crossings.flatMap(entry => record(entry.ref) ? [entry.ref] : [])]) {
    if (typeof ref.objectId !== "string") continue;
    referencedObjectIds.add(ref.objectId);
    const molecule = objects.find(object => object.id === ref.objectId && object.type === "molecule");
    if (molecule?.type !== "molecule") continue;
    const atoms = crossingAtomIds.get(molecule.id) ?? new Set<string>();
    const bond = molecule.bonds.find(bond => bond.id === ref.bondId);
    if (bond) { atoms.add(bond.fromAtomId); atoms.add(bond.toAtomId); }
    for (const entry of crossings) if (record(entry.ref) && entry.ref.objectId === molecule.id &&
      typeof entry.innerAtomId === "string" && molecule.atoms.some(atom => atom.id === entry.innerAtomId)) atoms.add(entry.innerAtomId);
    crossingAtomIds.set(molecule.id, atoms);
  }
  const imported = importedMembership(pair, objects, options);
  imported?.referencedObjectIds.forEach(id => referencedObjectIds.add(id));
  const left = Math.min(...pair.map(object => object.x));
  const top = Math.min(...pair.map(object => object.y));
  const right = Math.max(...pair.map(object => object.x + object.width));
  const bottom = Math.max(...pair.map(object => object.y + object.height));
  const enclosure = bracketPairEnclosure(pair);
  let reason = imported ? imported.reason : enclosure.reason;
  const structureOnlyMembers: MoleculeObject[] = [];
  const members = objects.flatMap(molecule => {
    if (molecule.type !== "molecule") return [];
    if (!molecule.atoms.length && molecule.structure.trim() && explicit.has(molecule.id)) structureOnlyMembers.push(molecule);
    const atomIds = new Set(imported?.members.get(molecule.id));
    if (!imported) {
      for (const atom of molecule.atoms) {
        const point = options.atomPosition ? options.atomPosition(molecule, atom) : molecule.rotation === 0 ? atom : undefined;
        if (explicit.has(molecule.id) || point && enclosure.contains?.(point)) atomIds.add(atom.id);
      }
      // Crossing bonds alone do not identify which side is inside. A recorded inner atom does.
      if (!atomIds.size) {
        const seeds = crossings.flatMap(entry => record(entry.ref) && entry.ref.objectId === molecule.id &&
          typeof entry.innerAtomId === "string" && molecule.atoms.some(atom => atom.id === entry.innerAtomId) ? [entry.innerAtomId] : []);
        const boundary = new Set(refs.filter(ref => ref.objectId === molecule.id).map(ref => ref.bondId));
        const pending = [...seeds];
        while (pending.length) {
          const id = pending.pop()!;
          if (atomIds.has(id)) continue;
          atomIds.add(id);
          for (const bond of molecule.bonds) if (!boundary.has(bond.id)) {
            if (bond.fromAtomId === id && !atomIds.has(bond.toAtomId)) pending.push(bond.toAtomId);
            if (bond.toAtomId === id && !atomIds.has(bond.fromAtomId)) pending.push(bond.fromAtomId);
          }
        }
      }
      if (!atomIds.size && !options.atomPosition && molecule.rotation !== 0 && molecule.x <= right && molecule.x + molecule.width >= left &&
        molecule.y <= bottom && molecule.y + molecule.height >= top) {
        referencedObjectIds.add(molecule.id);
        reason ??= "its rotated molecule needs page-space atom positions to resolve membership";
      }
    }
    if (atomIds.size) referencedObjectIds.add(molecule.id);
    return atomIds.size ? [{ molecule, atomIds: molecule.atoms.filter(atom => atomIds.has(atom.id)).map(atom => atom.id) }] : [];
  });
  if (!imported) {
    if ([...explicit].some(id => !objects.some(object => object.id === id && object.type === "molecule"))) {
      reason ??= "its membership includes missing or non-molecular objects";
    }
  }
  if (!options.useLegacyDiagnostics && structureOnlyMembers.length && members.length) {
    reason ??= "its explicitly contained structure has no native atoms";
  }
  reason ??= !members.length ? "its atom membership is empty" :
    crossingReason(pair, members, objects.filter((object): object is MoleculeObject => object.type === "molecule"),
      !imported && bracketPairUsage(pair) === "multiple" ? explicit : new Set<string>());
  return { members, structureOnlyMembers, crossingAtomIds, referencedObjectIds, imported: imported !== undefined,
    unresolvedMemberReferences: imported?.unresolvedMemberReferences ?? false,
    unresolved: reason !== undefined, connectivity: imported?.connectivity, reason };
}

/** Undo the glyphs' common rotation, keeping each renderer pivot at its stored frame center.
 * In that frame each glyph is axis aligned, so the union of their frames bounds the enclosure. */
function bracketPairEnclosure(pair: readonly BracketObject[]): { contains?: (point: Point) => boolean; reason?: string } {
  const rotation = ((pair[0]?.rotation ?? NaN) % 360 + 360) % 360;
  if (pair.length !== 2 || pair.some(object => ![object.x, object.y, object.width, object.height, object.rotation].every(Number.isFinite) ||
    (object.rotation % 360 + 360) % 360 !== rotation || object.style.tiltXDegrees || object.style.tiltYDegrees)) {
    return { reason: "its brackets do not share a known planar rotation frame" };
  }
  const centers = pair.map(object => ({ x: object.x + object.width / 2, y: object.y + object.height / 2 }));
  const center = { x: (centers[0].x + centers[1].x) / 2, y: (centers[0].y + centers[1].y) / 2 };
  const radians = -rotation * Math.PI / 180;
  const localCenters = centers.map(point => rotatePointAboutCenter(point, center, radians));
  const left = Math.min(...pair.map((object, index) => localCenters[index].x - object.width / 2));
  const right = Math.max(...pair.map((object, index) => localCenters[index].x + object.width / 2));
  const top = Math.min(...pair.map((object, index) => localCenters[index].y - object.height / 2));
  const bottom = Math.max(...pair.map((object, index) => localCenters[index].y + object.height / 2));
  return { contains: point => {
    const local = rotatePointAboutCenter(point, center, radians);
    const tolerance = 1e-8;
    return local.x >= left - tolerance && local.x <= right + tolerance && local.y >= top - tolerance && local.y <= bottom + tolerance;
  } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retarget imported atom-level records by the merge's graph mapping. Preserve unprovable
 * records and the source attributes so the normal membership diagnostic can explain the loss. */
export function remapImportedRepeatUnitAfterMoleculeMerge(bracket: BracketObject, absorbedObjectId: string,
  hostObjectId: string, atomIds: ReadonlyMap<string, string>, bondIds: ReadonlyMap<string, string>): BracketObject["compatibility"] {
  const compatibility = bracket.compatibility;
  if (!compatibility) return undefined;
  const unknown = { ...compatibility.unknown };
  const members = unknown.cdxmlBracketMembers;
  const absorbedMembers = Array.isArray(members) ? members.filter(entry => record(entry) && entry.objectId === absorbedObjectId) : [];
  const remappedSources = new Set<string>();
  if (absorbedMembers.length && Array.isArray(members)) {
    unknown.cdxmlBracketMembers = members.map(entry => {
      if (!record(entry) || entry.objectId !== absorbedObjectId ||
        typeof entry.atomId !== "string" || typeof entry.sourceId !== "string") return entry;
      const atomId = atomIds.get(entry.atomId);
      if (!atomId) return entry;
      remappedSources.add(entry.sourceId);
      return { ...entry, objectId: hostObjectId, atomId };
    });
    if (unknown.cdxmlBracketAtomSnapshots) {
      unknown.cdxmlBracketAtomSnapshots = unknown.cdxmlBracketAtomSnapshots.map(snapshot => {
        if (!remappedSources.has(snapshot.sourceId)) return snapshot;
        const atomId = atomIds.get(snapshot.atomId);
        if (!atomId) return snapshot;
        // Keep proof of absent bonds for export diagnostics, independent of the surviving atom's identity.
        const incidentBonds = snapshot.incidentBonds.map(bond => {
          const id = bondIds.get(bond.id), fromAtomId = atomIds.get(bond.fromAtomId), toAtomId = atomIds.get(bond.toAtomId);
          return id && fromAtomId && toAtomId ? { ...bond, id, fromAtomId, toAtomId } : bond;
        });
        return { ...snapshot, atomId, incidentBonds };
      });
    }
  }
  const memberObjects = unknown.cdxmlBracketMemberObjectIds;
  if (absorbedMembers.length || (Array.isArray(memberObjects) && memberObjects.includes(absorbedObjectId))) {
    const originalIds = Array.isArray(memberObjects) ? memberObjects : [];
    const fullyMapped = absorbedMembers.length > 0 && absorbedMembers.every(entry =>
      typeof entry.atomId === "string" && atomIds.has(entry.atomId));
    unknown.cdxmlBracketMemberObjectIds = [...new Set([
      ...originalIds.filter(id => !fullyMapped || id !== absorbedObjectId), hostObjectId
    ])];
  }
  const crossings = unknown.cdxmlBracketCrossings;
  if (Array.isArray(crossings)) {
    unknown.cdxmlBracketCrossings = crossings.map(entry => {
      if (!record(entry) || !record(entry.ref) || entry.ref.objectId !== absorbedObjectId || typeof entry.ref.bondId !== "string") return entry;
      const bondId = bondIds.get(entry.ref.bondId);
      const innerAtomId = typeof entry.innerAtomId === "string" ? atomIds.get(entry.innerAtomId) : undefined;
      if (!bondId || (entry.innerAtomId !== undefined && !innerAtomId)) return entry;
      let bondIdentity = entry.bondIdentity;
      if (typeof bondIdentity === "string") {
        try {
          const endpoints: unknown = JSON.parse(bondIdentity);
          if (Array.isArray(endpoints) && endpoints.length === 2 &&
            endpoints.every(id => typeof id === "string" && atomIds.has(id))) {
            bondIdentity = JSON.stringify(endpoints.map(id => atomIds.get(id)));
          }
        } catch { /* Keep the malformed source identity for the diagnostic. */ }
      }
      return { ...entry, ref: { objectId: hostObjectId, bondId },
        ...(bondIdentity !== undefined && { bondIdentity }), ...(innerAtomId && { innerAtomId }) };
    });
  }
  return absorbedMembers.length || (Array.isArray(memberObjects) && memberObjects.includes(absorbedObjectId)) ||
    (Array.isArray(crossings) && crossings.some((entry, i) => entry !== (unknown.cdxmlBracketCrossings as unknown[])[i]))
    ? { ...compatibility, unknown } : compatibility;
}

function importedBracketAttributes(pair: readonly BracketObject[]): Record<string, unknown> | undefined {
  for (const bracket of pair) {
    const group = bracket.compatibility?.unknown.bracketedGroup;
    if (record(group) && record(group.attributes)) return group.attributes;
  }
}

function importedSourceIds(attributes: Record<string, unknown>): string[] {
  const ids = attributes.BracketedObjectIDs;
  return typeof ids === "string" ? [...new Set(ids.trim().split(/\s+/).filter(Boolean))] : [];
}

function importedMemberRecords(pair: readonly BracketObject[]): Record<string, unknown>[] {
  return pair.flatMap(object => {
    const entries = object.compatibility?.unknown.cdxmlBracketMembers;
    return Array.isArray(entries) ? entries.filter(record) : [];
  });
}

function importedMemberRecord(records: Record<string, unknown>[], sourceId: string): Record<string, unknown> | undefined {
  const unique = new Map(records.filter(entry => entry.sourceId === sourceId).map(entry => [JSON.stringify(entry), entry]));
  if (unique.size === 1) return unique.values().next().value;
}

type DeletedImportedAtom = [sourceId: string, atomId: string];

function recordedImportedDeletions(pair: readonly BracketObject[]): DeletedImportedAtom[] | undefined {
  const previous = pair.map(bracket => bracket.compatibility?.unknown.cdxmlBracketDeletedAtoms ?? []);
  return JSON.stringify(previous[0]) === JSON.stringify(previous[1]) ? previous[0] : undefined;
}

/** Deletion needs atom provenance, independent of whether the remaining graph can be exported
 * as an SRU. For example, a prior member deletion also removes a surviving member's bond. */
export function planImportedRepeatUnitDeletion(pair: readonly BracketObject[], objects: readonly DocumentObject[],
  after: ReadonlyMap<string, readonly DocumentObject[]>, wholeMoleculesOnly: boolean) {
  const attributes = importedBracketAttributes(pair);
  const records = importedMemberRecords(pair);
  const retained = { orphaned: false, deletedMoleculeIds: new Set<string>(), deletedAtoms: [] };
  if (!attributes) {
    const hasRecords = records.length || pair.some(bracket => {
      const ids = bracket.compatibility?.unknown.cdxmlBracketMemberObjectIds;
      return Array.isArray(ids) && ids.length > 0;
    });
    return hasRecords ? retained : undefined;
  }
  const sourceIds = importedSourceIds(attributes);
  const previous = recordedImportedDeletions(pair);
  if (!sourceIds.length || !previous) return retained;
  let unresolved = false;
  const knownDeleted = new Set(previous.map(entry => JSON.stringify(entry)));
  const deletedAtoms: DeletedImportedAtom[] = [];
  const deletedMoleculeIds = new Set<string>();
  const previouslyDeletedObjects = new Set<string>();
  let survives = false;
  for (const sourceId of sourceIds) {
    const member = importedMemberRecord(records, sourceId);
    const snapshots = pair.map(bracket => bracket.compatibility?.unknown.cdxmlBracketAtomSnapshots
      ?.filter(snapshot => snapshot.sourceId === sourceId));
    const originals = snapshots[0];
    if (!member || typeof member.objectId !== "string" || !originals?.length ||
      JSON.stringify(originals) !== JSON.stringify(snapshots[1]) ||
      (member.atomId !== undefined && (originals.length !== 1 || originals[0].atomId !== member.atomId))) {
      unresolved = true;
      continue;
    }
    const candidates = objects.filter(object => object.id === member.objectId);
    const molecule = candidates.length === 1 && candidates[0].type === "molecule" ? candidates[0] : undefined;
    if (candidates.length && !molecule) {
      unresolved = true;
      continue;
    }
    if (molecule && new Set(molecule.atoms.map(atom => atom.id)).size !== molecule.atoms.length) {
      unresolved = true;
      continue;
    }
    const remaining = (after.get(member.objectId) ?? []).filter((object): object is MoleculeObject => object.type === "molecule");
    const sourceAtoms = molecule?.compatibility?.unknown.cdxmlAtomIdsByAtomId;
    const atoms = new Map(molecule?.atoms.map(atom => [atom.id, atom]));
    const deletedBefore = originals.every(({ atomId }) => knownDeleted.has(JSON.stringify([sourceId, atomId])));
    if (member.atomId === undefined && !molecule && deletedBefore) previouslyDeletedObjects.add(member.objectId);
    for (const { atomId, element } of originals) {
      const atom = atoms.get(atomId);
      const sourceAtomId = member.atomId !== undefined ? sourceId : record(sourceAtoms) ? sourceAtoms[atomId] : undefined;
      if (!atom) {
        if (!knownDeleted.has(JSON.stringify([sourceId, atomId]))) unresolved = true;
      } else if (typeof sourceAtomId !== "string" || atom.cdxmlSourceId !== sourceAtomId || atom.element !== element) {
        unresolved = true;
      } else if (remaining.some(object => wholeMoleculesOnly ||
        object.atoms.some(atom => atom.id === atomId || atom.cdxmlSourceId === sourceAtomId))) {
        survives = true;
      } else {
        deletedAtoms.push([sourceId, atomId]);
        if (!remaining.length) deletedMoleculeIds.add(member.objectId);
      }
    }
  }
  // A native membership edit is not evidence that the import's members were deleted.
  for (const bracket of pair) {
    const snapshot = bracket.compatibility?.unknown.cdxmlBracketMembership;
    if (snapshot === JSON.stringify(bracket.containedObjectIds)) continue;
    try {
      const ids: unknown = typeof snapshot === "string" ? JSON.parse(snapshot) : undefined;
      if (Array.isArray(ids) &&
        JSON.stringify(ids.filter(id => !previouslyDeletedObjects.has(id))) === JSON.stringify(bracket.containedObjectIds)) continue;
    } catch { /* An invalid import snapshot cannot prove membership. */ }
    return retained;
  }
  return { orphaned: !unresolved && !survives && deletedAtoms.length > 0, deletedMoleculeIds,
    deletedAtoms: deletedAtoms.length ? [...previous, ...deletedAtoms] : [] };
}

/** Source ids are opaque: only the importer's scoped native references can resolve them. */
function importedMembership(pair: readonly BracketObject[], objects: readonly DocumentObject[],
  { atomPosition, useLegacyDiagnostics }: RepeatUnitMembershipOptions) {
  const attributes = importedBracketAttributes(pair);
  const memberRecords = importedMemberRecords(pair);
  if (!attributes) {
    const ids = pair.flatMap(object => {
      const value = object.compatibility?.unknown.cdxmlBracketMemberObjectIds;
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    });
    if (!ids.length && !memberRecords.length) return undefined;
    return { members: new Map<string, Set<string>>(), referencedObjectIds: new Set([
      ...ids, ...memberRecords.flatMap(entry => typeof entry.objectId === "string" ? [entry.objectId] : [])
    ]), connectivity: undefined, unresolvedMemberReferences: true,
      reason: "its preserved CDXML atom membership has no source BracketedObjectIDs group to resolve" };
  }
  const sourceIds = importedSourceIds(attributes);
  const pattern = attributes.PolymerRepeatPattern;
  // CDX/CDXML defaults to HeadToTail; native brackets still use the MOL writer's default.
  const connectivity: RepeatUnitAtomMembership["connectivity"] = pattern === undefined || pattern === "HeadToTail" ? "ht"
    : pattern === "HeadToHead" ? "hh" : pattern === "EitherUnknown" ? "eu" : undefined;
  const connectivityReason = pattern !== undefined && connectivity === undefined
    ? `its imported PolymerRepeatPattern "${String(pattern)}" has no supported MOL SRU connectivity` : undefined;
  const members = new Map<string, Set<string>>();
  const referencedObjectIds = new Set(pair.flatMap(object => {
    const atomMemberObjects = object.compatibility?.unknown.cdxmlBracketMemberObjectIds;
    return [...object.containedObjectIds, ...(object.crossingBondIds ?? []).map(ref => ref.objectId),
      ...(Array.isArray(atomMemberObjects) ? atomMemberObjects.filter((id): id is string => typeof id === "string") : [])];
  }));
  memberRecords.forEach(entry => { if (typeof entry.objectId === "string") referencedObjectIds.add(entry.objectId); });
  const membershipUnchanged = pair.every(object =>
    object.compatibility?.unknown.cdxmlBracketMembership === JSON.stringify(object.containedObjectIds));
  if (!membershipUnchanged) {
    // Merge/delete remaps live object references, not the imported graph. A replacement
    // cannot prove the original membership; never silently absorb the surviving molecule.
    const requested = [...new Set(pair.flatMap(object => object.containedObjectIds))];
    let reason = pair.some(object => typeof object.compatibility?.unknown.cdxmlBracketMembership !== "string")
      ? "its edited native membership cannot be compared with a missing import-time membership snapshot"
      : pair.some(object => requested.some(id => !object.containedObjectIds.includes(id)))
        ? "its edited native membership differs between the paired brackets"
      : memberRecords.some(entry => entry.atomId !== undefined)
        ? "its edited native membership conflicts with imported atom-level BracketedObjectIDs membership"
      : !requested.length ? "its edited native membership is empty" : undefined;
    for (const id of requested) {
      const molecule = objects.find(object => object.id === id);
      if (molecule?.type !== "molecule") {
        reason ??= `its edited native membership includes missing or non-molecular object "${id}"`;
      } else {
        members.set(id, new Set(molecule.atoms.map(atom => atom.id)));
        if (!molecule.atoms.length) reason ??= `its edited native member "${id}" has no atoms`;
      }
    }
    reason ??= "its imported whole-molecule membership changed after an edit and no longer resolves to the original member molecules";
    return { members, reason, referencedObjectIds, connectivity, unresolvedMemberReferences: true };
  }
  let unresolvedMemberReferences = !sourceIds.length;
  let reason = sourceIds.length ? undefined : "its imported BracketedObjectIDs membership is empty or invalid";
  let deletedReason: string | undefined;
  const recordedDeletions = useLegacyDiagnostics ? undefined : recordedImportedDeletions(pair);
  for (const sourceId of sourceIds) {
    const member = importedMemberRecord(memberRecords, sourceId);
    const molecule = member && objects.find(object => object.id === member.objectId);
    const atoms = molecule?.type === "molecule" ? molecule.atoms.filter(atom => member!.atomId === undefined || atom.id === member!.atomId) : [];
    if (!atoms.length) {
      if (molecule?.type !== "molecule" || molecule.atoms.length || !molecule.structure.trim() ||
        member?.atomId !== undefined || !pair.some(bracket => bracket.containedObjectIds.includes(molecule.id))) {
        unresolvedMemberReferences = true;
      }
      const missing = `its imported BracketedObjectIDs member "${sourceId}" does not resolve unambiguously to atoms in the export scope`;
      if (recordedDeletions?.some(([id, atomId]) => id === sourceId && atomId === member?.atomId)) deletedReason ??= missing;
      else reason ??= missing;
      continue;
    }
    const ids = members.get(molecule!.id) ?? new Set<string>();
    atoms.forEach(atom => ids.add(atom.id));
    members.set(molecule!.id, ids);
  }
  reason ??= deletedReason;
  reason ??= importedBoundaryReason(pair, members, objects, atomPosition);
  if (!reason) {
    reason = importedIdentityReason(pair, memberRecords, members, objects);
    unresolvedMemberReferences ||= reason !== undefined;
  }
  return { members, reason: reason ?? connectivityReason, referencedObjectIds, connectivity, unresolvedMemberReferences };
}

/** Keep the specific diagnostics for plainly new ids; map presence alone proves no identity. */
function importedBoundaryReason(pair: readonly BracketObject[], members: Map<string, Set<string>>, objects: readonly DocumentObject[], atomPosition: RepeatUnitMembershipOptions["atomPosition"]): string | undefined {
  const enclosure = bracketPairEnclosure(pair);
  for (const [objectId, atomIds] of members) {
    const molecule = objects.find(object => object.id === objectId);
    if (molecule?.type !== "molecule") continue;
    const importedBonds = molecule.compatibility?.unknown.cdxmlBondIdsByBondId;
    const importedAtoms = molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId;
    for (const bond of molecule.bonds) {
      if (!isRepeatUnitBoundaryBond(bond, atomIds)) continue;
      if (!record(importedBonds) || typeof importedBonds[bond.id] !== "string") {
        return `its imported atom-level membership has a new boundary bond "${bond.id}" between member and non-member atoms`;
      }
      const outsideId = atomIds.has(bond.fromAtomId) ? bond.toAtomId : bond.fromAtomId;
      const outside = molecule.atoms.find(atom => atom.id === outsideId);
      if (outside && (!record(importedAtoms) || typeof importedAtoms[outsideId] !== "string")) {
        const point = atomPosition ? atomPosition(molecule, outside) : molecule.rotation === 0 ? outside : undefined;
        if (point && enclosure.contains?.(point)) {
          return `its imported atom-level membership omits new atom "${outsideId}" inside the bracket adjacent to a member atom`;
        }
      }
    }
  }
  return undefined;
}

/** Native ids can be recycled. Check source provenance, elements and the complete incident graph. */
function importedIdentityReason(pair: readonly BracketObject[], records: Record<string, unknown>[], members: Map<string, Set<string>>,
  objects: readonly DocumentObject[]): string | undefined {
  for (const member of new Map(records.map(entry => [JSON.stringify(entry), entry])).values()) {
    if (typeof member.objectId !== "string") continue;
    const wholeMolecule = member.atomId === undefined;
    const description = `its imported ${wholeMolecule ? "whole-molecule" : "atom-level"} membership`;
    const memberId = wholeMolecule ? member.objectId : member.atomId;
    const molecule = objects.find(object => object.id === member.objectId);
    if (molecule?.type !== "molecule") continue;
    const snapshots = pair.map(object => object.compatibility?.unknown.cdxmlBracketAtomSnapshots
      ?.filter(snapshot => snapshot.sourceId === member.sourceId));
    // Legacy whole-molecule records have no snapshots (or an empty array). Source maps
    // alone cannot distinguish deleted/redrawn ids, so they cannot certify membership.
    if (snapshots.some(entries => !entries?.length || !wholeMolecule && entries.length !== 1)) {
      return `${description} cannot rule out edits to member "${memberId}" without an import-time atom and incident-bond snapshot`;
    }
    const parsed = CdxmlBracketAtomSnapshotSchema.array().safeParse(snapshots[0]);
    if (!parsed.success || !wholeMolecule && parsed.data[0].atomId !== member.atomId ||
      snapshots.some(entries => JSON.stringify(entries) !== JSON.stringify(snapshots[0])) ||
      new Set(parsed.data.map(snapshot => snapshot.atomId)).size !== parsed.data.length) {
      return `${description} has an invalid or inconsistent identity snapshot for member "${memberId}"`;
    }
    const originals = parsed.data;
    if (wholeMolecule) {
      const originalIds = new Set(originals.map(snapshot => snapshot.atomId));
      const added = molecule.atoms.find(atom => !originalIds.has(atom.id));
      if (added) return `${description} has new atom "${added.id}" after an edit to member "${memberId}"`;
      const missing = originals.find(snapshot => !molecule.atoms.some(atom => atom.id === snapshot.atomId));
      if (missing) return `${description} no longer resolves imported atom "${missing.atomId}" after an edit to member "${memberId}"`;
    }
    const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
    const sourceAtoms = molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId;
    const sourceBonds = molecule.compatibility?.unknown.cdxmlBondIdsByBondId;
    for (const snapshot of originals) {
      const atomId = snapshot.atomId;
      if (atoms.get(atomId)?.element !== snapshot.element) {
        return `${description} has edited atom "${atomId}" with a different element`;
      }
      const sourceId = wholeMolecule ? (record(sourceAtoms) ? sourceAtoms[atomId] : undefined) : member.sourceId;
      if (typeof sourceId !== "string" || atoms.get(atomId)?.cdxmlSourceId !== sourceId) {
        return `${description} cannot prove atom "${atomId}" is the imported original after an edit`;
      }
      const incident = molecule.bonds.filter(bond => bond.fromAtomId === atomId || bond.toAtomId === atomId);
      for (const bond of incident) {
        const original = snapshot.incidentBonds.find(entry => entry.id === bond.id);
        if (!original) {
          const atomIds = members.get(member.objectId)!;
          return isRepeatUnitBoundaryBond(bond, atomIds)
            ? `${description} has a new boundary bond "${bond.id}" between member and non-member atoms`
            : `${description} has a new bond "${bond.id}" touching a member atom`;
        }
        // Reversing a bond does not change its membership. The crossing-bond check below still
        // enforces the source's directional InnerAtomID association where one was supplied.
        if (!(bond.fromAtomId === original.fromAtomId && bond.toAtomId === original.toAtomId ||
          bond.fromAtomId === original.toAtomId && bond.toAtomId === original.fromAtomId)) {
          return `${description} has edited bond "${bond.id}" with different endpoints`;
        }
        for (const [id, element] of [[original.fromAtomId, original.fromElement], [original.toAtomId, original.toElement]]) {
          if (atoms.get(id)?.element !== element) {
            return `${description} has edited atom "${id}" with a different element`;
          }
          if (!record(sourceAtoms) || typeof sourceAtoms[id] !== "string" || atoms.get(id)?.cdxmlSourceId !== sourceAtoms[id]) {
            return `${description} cannot prove atom "${id}" is the imported original after an edit`;
          }
        }
        if (!record(sourceBonds) || typeof sourceBonds[bond.id] !== "string" || bond.cdxmlSourceId !== sourceBonds[bond.id]) {
          return `${description} cannot prove bond "${bond.id}" is the imported original after an edit`;
        }
      }
      const missing = snapshot.incidentBonds.find(original => !incident.some(bond => bond.id === original.id));
      if (missing) return `${description} no longer has incident bond "${missing.id}" on member "${atomId}"`;
    }
  }
  return undefined;
}

/** Partial units must match the atom boundary. Native multiple groups may also retain bond
 * references on explicitly contained whole molecules; those references do not narrow membership. */
function crossingReason(pair: readonly BracketObject[], members: RepeatUnitAtomMembership["members"], molecules: readonly MoleculeObject[],
  nativeMultipleObjectIds: ReadonlySet<string>): string | undefined {
  const refs = pair.flatMap(object => object.crossingBondIds ?? []);
  for (const object of pair) {
    const entries = object.compatibility?.unknown.cdxmlBracketCrossings;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!record(entry)) return "its imported crossing-bond membership is invalid";
      const attributes = record(entry.attributes) ? entry.attributes : {};
      const ref = record(entry.ref) ? entry.ref : undefined;
      if (!ref || !refs.some(candidate => candidate.objectId === ref.objectId && candidate.bondId === ref.bondId)) {
        return `its imported crossing bond "${attributes.BondID ?? "(unknown)"}" does not resolve to a crossing bond in the export scope`;
      }
      const molecule = molecules.find(molecule => molecule.id === ref.objectId);
      const bond = molecule?.bonds.find(bond => bond.id === ref.bondId);
      if (entry.bondIdentity !== undefined && entry.bondIdentity !== JSON.stringify(bond && [bond.fromAtomId, bond.toAtomId])) {
        return `its imported crossing bond "${attributes.BondID ?? ref.bondId}" no longer has its original endpoints`;
      }
      if (attributes.InnerAtomID !== undefined && (!bond ||
        ![bond.fromAtomId, bond.toAtomId].includes(String(entry.innerAtomId)) ||
        !members.some(member => member.molecule.id === ref.objectId && member.atomIds.includes(String(entry.innerAtomId))))) {
        return `its imported crossing InnerAtomID "${attributes.InnerAtomID}" does not resolve to a member atom on its bond`;
      }
    }
  }
  const boundary = members.flatMap(member => {
    const atoms = new Set(member.atomIds);
    return molecules.find(molecule => molecule.id === member.molecule.id)?.bonds.flatMap(bond =>
      isRepeatUnitBoundaryBond(bond, atoms) ? [{ objectId: member.molecule.id, bondId: bond.id }] : []) ?? [];
  });
  const wholeMultipleCrossing = (ref: { objectId: string; bondId: string }) => {
    if (!nativeMultipleObjectIds.has(ref.objectId)) return false;
    const member = members.find(member => member.molecule.id === ref.objectId);
    const bond = member?.molecule.bonds.find(bond => bond.id === ref.bondId);
    return bond !== undefined && member!.atomIds.includes(bond.fromAtomId) && member!.atomIds.includes(bond.toAtomId);
  };
  if (refs.some(ref => !boundary.some(bond => bond.objectId === ref.objectId && bond.bondId === ref.bondId) && !wholeMultipleCrossing(ref)) ||
    refs.length > 0 && boundary.some(bond => !refs.some(ref => bond.objectId === ref.objectId && bond.bondId === ref.bondId))) {
    return "its crossing-bond references do not match the boundary of its atom membership in the export scope";
  }
  return undefined;
}
