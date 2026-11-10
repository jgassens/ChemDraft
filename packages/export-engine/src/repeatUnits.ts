import { bracketPairs, type ChemDraftDocument, type DocumentObject, type MoleculeObject, type MolfileWriteOptions } from "@chemdraft/chem-core";
import { projectedPlaneSvgTransformForObject, transformPointForObject } from "@chemdraft/layout-engine";
import type { ExportWarning } from "./results";

type RepeatUnit = {
  objectId: string;
  label: string;
  members: { molecule: MoleculeObject; atomIds: string[] }[];
  reason?: string;
};

/** Scope follows exported molecules, even when the user selected no bracket glyphs. */
function repeatUnits(document: ChemDraftDocument, molecules?: readonly MoleculeObject[]): RepeatUnit[] {
  const exported = molecules && new Set(molecules.map(molecule => molecule.id));
  return document.pages.flatMap(page => [...bracketPairs(page.objects).values()].flatMap(pair => {
    if (!pair.some(object => object.repeatUnit || object.bracketKind === "polymer")) return [];
    const close = pair.find(object => object.side === "close")!;
    const explicit = new Set(pair.flatMap(object => object.containedObjectIds));
    const left = Math.min(...pair.map(object => object.x));
    const top = Math.min(...pair.map(object => object.y));
    const right = Math.max(...pair.map(object => object.x + object.width));
    const bottom = Math.max(...pair.map(object => object.y + object.height));
    const allMembers = page.objects.flatMap(object => {
      if (object.type !== "molecule") return [];
      const atomIds = object.atoms.filter(atom => {
        if (explicit.has(object.id)) return true;
        const point = transformPointForObject(object, atom);
        return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
      }).map(atom => atom.id);
      return atomIds.length || explicit.has(object.id) ? [{ molecule: object, atomIds }] : [];
    });
    const members = allMembers.filter(member => !exported || exported.has(member.molecule.id));
    if (!members.length) return [];
    const missing = [...explicit].some(id => !page.objects.some(object => object.id === id && object.type === "molecule"));
    const excluded = allMembers.some(member => exported && !exported.has(member.molecule.id));
    const reason = missing ? "its membership includes missing or non-molecular objects"
      : excluded ? "part of its atom membership is outside the export selection"
      : pair.some(object => projectedPlaneSvgTransformForObject(object) !== undefined)
        ? "rotated or projected brackets have no unambiguous atom membership"
      : members.some(member => member.atomIds.length === 0) ? "its atom membership is empty"
      : undefined;
    return [{ objectId: pair[0].id, label: close.label ?? "n", members, reason }];
  }));
}

function warning(unit: RepeatUnit, message: string): ExportWarning {
  return { code: "export.repeat_unit_not_represented", severity: "warning", objectId: unit.objectId, message };
}

/** SMILES has no SRU encoding. Other graph-only formats use the same explicit loss channel. */
export function repeatUnitExportWarnings(document: ChemDraftDocument, format: string, scope?: {
  objects: readonly DocumentObject[];
  molecules: readonly MoleculeObject[];
}): ExportWarning[] {
  return repeatUnits(document, scope?.molecules).map(unit => warning(unit,
    `${format} cannot hold the repeat unit ${unit.label} around ${unit.members.reduce((count, member) => count + member.atomIds.length, 0)} atoms (bracket ${unit.objectId}); only the bare structure is written.`));
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
    return [{ objectId: unit.objectId, label: unit.label, atomIds: [...atomIds] }];
  });
}
