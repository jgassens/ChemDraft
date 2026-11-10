import { bracketChemistryWarnings, bracketPairs, type BracketObject, type DocumentObject, type ChemDraftDocument, type MoleculeObject, type MolfileWriteOptions } from "@chemdraft/chem-core";
import { projectedPlaneSvgTransformForObject, transformPointForObject } from "@chemdraft/layout-engine";
import type { ExportWarning } from "./results";

type RepeatUnit = {
  objectId: string;
  label: string;
  usage: "sru" | "multiple" | "unknown";
  members: { molecule: MoleculeObject; atomIds: string[] }[];
  connectivity?: "eu" | "ht" | "hh";
  context: string[];
  reason?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Source ids are opaque: only the importer's scoped native references can resolve them. */
function importedMembership(pair: BracketObject[], objects: readonly DocumentObject[]) {
  const source = pair.find(object => {
    const group = object.compatibility?.unknown.bracketedGroup;
    return record(group) && record(group.attributes);
  });
  if (!source) return undefined;
  const group = source.compatibility!.unknown.bracketedGroup as { attributes: Record<string, unknown> };
  const value = group.attributes.BracketedObjectIDs;
  const sourceIds = typeof value === "string" ? [...new Set(value.trim().split(/\s+/).filter(Boolean))] : [];
  const pattern = group.attributes.PolymerRepeatPattern;
  // CDX/CDXML defaults to HeadToTail; native brackets still use the MOL writer's default.
  const connectivity: RepeatUnit["connectivity"] = pattern === undefined || pattern === "HeadToTail" ? "ht"
    : pattern === "HeadToHead" ? "hh" : pattern === "EitherUnknown" ? "eu" : undefined;
  const connectivityReason = pattern !== undefined && connectivity === undefined
    ? `its imported PolymerRepeatPattern "${String(pattern)}" has no supported MOL SRU connectivity` : undefined;
  const members = new Map<string, Set<string>>();
  const referencedObjectIds = new Set(pair.flatMap(object => {
    const atomMemberObjects = object.compatibility?.unknown.cdxmlBracketMemberObjectIds;
    return [...object.containedObjectIds, ...(object.crossingBondIds ?? []).map(ref => ref.objectId),
      ...(Array.isArray(atomMemberObjects) ? atomMemberObjects.filter((id): id is string => typeof id === "string") : [])];
  }));
  const memberRecords = pair.flatMap(object => {
    const entries = object.compatibility?.unknown.cdxmlBracketMembers;
    return Array.isArray(entries) ? entries.filter(record) : [];
  });
  memberRecords.forEach(entry => { if (typeof entry.objectId === "string") referencedObjectIds.add(entry.objectId); });
  const membershipUnchanged = pair.every(object =>
    object.compatibility?.unknown.cdxmlBracketMembership === JSON.stringify(object.containedObjectIds));
  if (!membershipUnchanged) {
    // A native edit replaces whole-molecule imports. Never revive the old membership or
    // supplement the edit with geometry; atom-scoped imports cannot be replaced unambiguously.
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
    return { members, reason: reason ?? connectivityReason, referencedObjectIds, connectivity };
  }
  let reason = sourceIds.length ? undefined : "its imported BracketedObjectIDs membership is empty or invalid";
  for (const sourceId of sourceIds) {
    const records = memberRecords.filter(entry => entry.sourceId === sourceId);
    const unique = [...new Map(records.map(entry => [JSON.stringify(entry), entry])).values()];
    const member = unique.length === 1 && record(unique[0]) ? unique[0] : undefined;
    const molecule = member && objects.find(object => object.id === member.objectId);
    const atoms = molecule?.type === "molecule" ? molecule.atoms.filter(atom => member!.atomId === undefined || atom.id === member!.atomId) : [];
    if (!atoms.length) {
      reason ??= `its imported BracketedObjectIDs member "${sourceId}" does not resolve unambiguously to atoms in the export scope`;
      continue;
    }
    const ids = members.get(molecule!.id) ?? new Set<string>();
    atoms.forEach(atom => ids.add(atom.id));
    members.set(molecule!.id, ids);
  }
  reason ??= importedBoundaryReason(pair, members, objects);
  return { members, reason: reason ?? connectivityReason, referencedObjectIds, connectivity };
}

/** Import snapshots distinguish later additions from intentionally excluded source atoms. */
function importedBoundaryReason(pair: BracketObject[], members: Map<string, Set<string>>, objects: readonly DocumentObject[]): string | undefined {
  const left = Math.min(...pair.map(object => object.x));
  const top = Math.min(...pair.map(object => object.y));
  const right = Math.max(...pair.map(object => object.x + object.width));
  const bottom = Math.max(...pair.map(object => object.y + object.height));
  for (const [objectId, atomIds] of members) {
    const molecule = objects.find(object => object.id === objectId);
    if (molecule?.type !== "molecule") continue;
    const importedBonds = molecule.compatibility?.unknown.cdxmlBondIdsByBondId;
    const importedAtoms = molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId;
    for (const bond of molecule.bonds) {
      if (atomIds.has(bond.fromAtomId) === atomIds.has(bond.toAtomId)) continue;
      if (!record(importedBonds) || typeof importedBonds[bond.id] !== "string") {
        return `its imported atom-level membership has a new boundary bond "${bond.id}" between member and non-member atoms`;
      }
      const outsideId = atomIds.has(bond.fromAtomId) ? bond.toAtomId : bond.fromAtomId;
      const outside = molecule.atoms.find(atom => atom.id === outsideId);
      if (outside && (!record(importedAtoms) || typeof importedAtoms[outsideId] !== "string")) {
        const point = transformPointForObject(molecule, outside);
        if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
          return `its imported atom-level membership omits new atom "${outsideId}" inside the bracket adjacent to a member atom`;
        }
      }
    }
  }
  return undefined;
}

/** The MOL writer derives boundary bonds; decline any imported references it cannot preserve. */
function crossingReason(pair: BracketObject[], members: RepeatUnit["members"], molecules: readonly MoleculeObject[]): string | undefined {
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
      atoms.has(bond.fromAtomId) !== atoms.has(bond.toAtomId) ? [{ objectId: member.molecule.id, bondId: bond.id }] : []) ?? [];
  });
  if (refs.some(ref => !boundary.some(bond => bond.objectId === ref.objectId && bond.bondId === ref.bondId)) ||
    refs.length > 0 && boundary.some(bond => !refs.some(ref => bond.objectId === ref.objectId && bond.bondId === ref.bondId))) {
    return "its crossing-bond references do not match the boundary of its atom membership in the export scope";
  }
  return undefined;
}

/** Scope follows exported molecules, even when the user selected no bracket glyphs. */
export function repeatUnits(document: ChemDraftDocument, molecules?: readonly MoleculeObject[]): RepeatUnit[] {
  const exported = molecules && new Set(molecules.map(molecule => molecule.id));
  return document.pages.flatMap(page => [...bracketPairs(page.objects).values()].flatMap(pair => {
    const usage = pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage ??
      (pair.some(object => object.repeatUnit || object.bracketKind === "polymer") ? "sru" : "generic");
    if (usage === "generic") return [];
    const close = pair.find(object => object.side === "close")!;
    const explicit = new Set(pair.flatMap(object => object.containedObjectIds));
    const imported = importedMembership(pair, page.objects);
    const left = Math.min(...pair.map(object => object.x));
    const top = Math.min(...pair.map(object => object.y));
    const right = Math.max(...pair.map(object => object.x + object.width));
    const bottom = Math.max(...pair.map(object => object.y + object.height));
    const allMembers = page.objects.flatMap(object => {
      if (object.type !== "molecule") return [];
      const atomIds = object.atoms.filter(atom => {
        if (imported) return imported.members.get(object.id)?.has(atom.id) ?? false;
        if (explicit.has(object.id)) return true;
        const point = transformPointForObject(object, atom);
        return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
      }).map(atom => atom.id);
      const context = bracketChemistryWarnings(document, object).filter(warning => warning.pairId === pair[0].pairId);
      return (imported ? atomIds.length : atomIds.length || explicit.has(object.id) || context.length)
        ? [{ molecule: object, atomIds, context }] : [];
    });
    const members = allMembers.filter(member => !exported || exported.has(member.molecule.id));
    if (!members.length && !(imported?.reason && page.objects.some(object => object.type === "molecule" &&
      imported.referencedObjectIds.has(object.id) && (!exported || exported.has(object.id))))) return [];
    const missing = [...explicit].some(id => !page.objects.some(object => object.id === id && object.type === "molecule"));
    const excluded = allMembers.some(member => exported && !exported.has(member.molecule.id));
    const reason = usage !== "sru" ? `its ${usage === "multiple" ? "multiple-group" : "unknown group"} semantics cannot be represented as an SRU`
      : imported?.reason ? imported.reason
      : missing ? "its membership includes missing or non-molecular objects"
      : excluded ? "part of its atom membership is outside the export selection"
      : members.some(member => member.atomIds.some(id => !(molecules ?? [member.molecule]).some(molecule =>
        molecule.id === member.molecule.id && molecule.atoms.some(atom => atom.id === id))))
        ? "part of its atom membership is outside the export scope"
      : !imported && pair.some(object => projectedPlaneSvgTransformForObject(object) !== undefined)
        ? "rotated or projected brackets have no unambiguous atom membership"
      : members.some(member => member.atomIds.length === 0) ? "its atom membership is empty"
      : crossingReason(pair, members, molecules ?? members.map(member => member.molecule));
    return [{ objectId: close.id, label: close.label ?? "n", usage, members,
      connectivity: imported?.connectivity, context: members.flatMap(member => member.context.map(warning => warning.message)), reason }];
  }));
}

function warning(unit: RepeatUnit, message: string): ExportWarning {
  return { code: "export.repeat_unit_not_represented", severity: "warning", objectId: unit.objectId, message };
}

/** SMILES has no SRU encoding. Other graph-only formats use the same explicit loss channel. */
export function repeatUnitExportWarnings(document: ChemDraftDocument, format: string, scope?: {
  objects?: readonly DocumentObject[];
  molecules: readonly MoleculeObject[];
}): ExportWarning[] {
  return repeatUnits(document, scope?.molecules).map(unit => {
    const description = unit.usage === "sru" ? `the repeat unit ${unit.label}` :
      unit.usage === "multiple" ? "the multiple group" : "the bracket group with unknown usage";
    return warning(unit,
      `${format} cannot hold ${description} around ${unit.members.reduce((count, member) => count + member.atomIds.length, 0)} atoms (bracket ${unit.objectId}); only the bare structure is written. ${unit.context.join(" ")}`.trim());
  });
}

/** Resolve annotations before merging/expanding atoms; never guess incomplete membership. */
export function repeatUnitMolfileGroups(
  document: ChemDraftDocument,
  molecules: readonly MoleculeObject[],
  warnings: ExportWarning[],
  options: { merged?: boolean; expansions?: readonly { atomId: string; atomIds: readonly string[] }[] } = {}
): NonNullable<MolfileWriteOptions["repeatUnitGroups"]> {
  return repeatUnits(document, molecules).flatMap(unit => {
    if (unit.reason) {
      warnings.push(warning(unit, `MOL cannot represent repeat unit ${unit.label} (bracket ${unit.objectId}): ${unit.reason}; only the bare structure is written.`));
      return [];
    }
    const atomIds = new Set(unit.members.flatMap(member => member.atomIds.map(id =>
      options.merged && molecules.length > 1 ? `m${molecules.findIndex(molecule => molecule.id === member.molecule.id)}_${id}` : id)));
    for (const expansion of options.expansions ?? []) {
      if (atomIds.has(expansion.atomId)) expansion.atomIds.forEach(id => atomIds.add(id));
    }
    return [{ objectId: unit.objectId, label: unit.label, atomIds: [...atomIds],
      ...(unit.connectivity ? { connectivity: unit.connectivity } : {}) }];
  });
}
