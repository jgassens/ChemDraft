import { bracketChemistryWarnings, bracketPairs, resolveRepeatUnitAtomMembership, type DocumentObject, type ChemDraftDocument, type MoleculeObject, type MolfileWriteOptions } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import type { ExportWarning } from "./results";

type RepeatUnit = {
  objectId: string;
  label: string;
  usage: "sru" | "multiple" | "unknown";
  unresolved: boolean;
  members: { molecule: MoleculeObject; atomIds: string[] }[];
  connectivity?: "eu" | "ht" | "hh";
  context: string[];
  reason?: string;
};

/** Scope follows exported molecules, even when the user selected no bracket glyphs. */
export function repeatUnits(document: ChemDraftDocument, molecules?: readonly MoleculeObject[]): RepeatUnit[] {
  const exported = molecules && new Set(molecules.map(molecule => molecule.id));
  return document.pages.flatMap(page => [...bracketPairs(page.objects).values()].flatMap(pair => {
    const usage = pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage ??
      (pair.some(object => object.repeatUnit || object.bracketKind === "polymer") ? "sru" : "generic");
    if (usage === "generic") return [];
    const close = pair.find(object => object.side === "close")!;
    const explicit = new Set(pair.flatMap(object => object.containedObjectIds));
    const membership = resolveRepeatUnitAtomMembership(pair, page.objects, { atomPosition: transformPointForObject });
    const allMembers = page.objects.flatMap(object => {
      if (object.type !== "molecule") return [];
      const atomIds = membership.members.find(member => member.molecule.id === object.id)?.atomIds ?? [];
      const context = bracketChemistryWarnings(document, object, { atomPosition: transformPointForObject }).filter(warning => warning.pairId === pair[0].pairId);
      return (membership.imported ? atomIds.length : atomIds.length || explicit.has(object.id) || context.length)
        ? [{ molecule: object, atomIds, context }] : [];
    });
    const members = allMembers.filter(member => !exported || exported.has(member.molecule.id));
    // Keep unresolved native and imported units as diagnostics even with no known atoms.
    // An unreferenced native unit cannot prove a same-page selection is unrelated; warn
    // without assigning it any molecules. Known references still exclude unrelated subsets.
    const exportsPage = !exported || page.objects.every(object => object.type !== "molecule" || exported.has(object.id));
    const touchesSelection = page.objects.some(object => object.type === "molecule" &&
      (!exported || exported.has(object.id)) && (membership.referencedObjectIds.has(object.id) ||
        !membership.imported && membership.referencedObjectIds.size === 0));
    if (!members.length && !(membership.unresolved && (exportsPage || touchesSelection))) return [];
    const missing = [...explicit].some(id => !page.objects.some(object => object.id === id && object.type === "molecule"));
    const excluded = allMembers.some(member => exported && !exported.has(member.molecule.id));
    const reason = usage !== "sru" ? `its ${usage === "multiple" ? "multiple-group" : "unknown group"} semantics cannot be represented as an SRU`
      : membership.imported && membership.reason ? membership.reason
      : missing ? "its membership includes missing or non-molecular objects"
      : excluded ? "part of its atom membership is outside the export selection"
      : members.some(member => member.atomIds.some(id => !(molecules ?? [member.molecule]).some(molecule =>
        molecule.id === member.molecule.id && molecule.atoms.some(atom => atom.id === id))))
        ? "part of its atom membership is outside the export scope"
      : members.some(member => member.atomIds.length === 0) ? "its atom membership is empty"
      : membership.reason;
    return [{ objectId: close.id, label: close.label ?? "n", usage, unresolved: membership.unresolved, members,
      connectivity: membership.connectivity, context: members.flatMap(member => member.context.map(warning => warning.message)), reason }];
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
    if (unit.unresolved) return warning(unit,
      `${format} cannot hold ${description} (bracket ${unit.objectId}): its atom membership cannot be resolved: ${unit.reason}; only the bare structure is written.`);
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
