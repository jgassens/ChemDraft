// Groups an atom label names — an abbreviation from the template library ("OMe"), or an element
// carrying abbreviations ("NMe2") — and their expansion into real atoms for export and analysis.
//
// The label is the only stored form of a group: nothing here writes the expansion back into a
// document. `atoms.ts` decides which labels are groups and whether each is valid; this file only
// builds the atoms. Kept free of `atoms.ts` imports so that file can call it for the formula.

import { ChemDraftSyntheticStylePreset, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";
import type { AbbreviationDefinition } from "@chemdraft/template-library";

/** What a label spells when it names a group. */
export type NativeLabelGroup =
  | {
      kind: "abbreviation";
      label: string;
      definition: AbbreviationDefinition;
    }
  | {
      /** One element carrying stated hydrogens and abbreviations, all bonded to it: "NMe2", "CH2Ph". */
      kind: "composite";
      label: string;
      head: string;
      hydrogens: number;
      /** One entry per substituent, repeated for a count: "NMe2" lists Me twice. */
      substituents: readonly AbbreviationDefinition[];
    };

/** The atom a group's label bonds connect to, as the group itself defines it. */
export interface NativeLabelGroupAttachment {
  element: string;
  /** Valence the attachment atom already uses inside the group: its bonds there plus its hydrogens. */
  internalValence: number;
  /** Formal charge the attachment atom carries inside the group (nitro's N⁺). */
  charge: number;
  /** The free valence the table states; a composite's follows from its head instead. */
  declaredAttachmentCount?: number;
}

export function nativeLabelGroupAttachment(group: NativeLabelGroup): NativeLabelGroupAttachment {
  if (group.kind === "composite") {
    return { element: group.head, internalValence: group.hydrogens + group.substituents.length, charge: 0 };
  }
  const { definition } = group;
  const attachment = definition.atoms[0]!;
  const bondValence = definition.bonds
    .filter(([from, to]) => from === 0 || to === 0)
    .reduce((sum, [, , order]) => sum + order, 0);
  return {
    element: attachment.element,
    internalValence: bondValence + attachment.hydrogens,
    charge: attachment.charge ?? 0,
    declaredAttachmentCount: definition.attachmentCount
  };
}

/** One group written out as atoms. */
export interface NativeLabelGroupExpansion {
  /** The labelled atom. It stays, at its index and position, as the group's attachment atom. */
  atomId: string;
  label: string;
  /** Every atom of the group in the expanded graph, the attachment atom first. */
  atomIds: string[];
}

export interface NativeLabelGroupExpansionResult {
  /** The drawn atoms in their order, then each group's added atoms. Drawn indices never move. */
  atoms: MoleculeAtom[];
  bonds: MoleculeBond[];
  expansions: NativeLabelGroupExpansion[];
}

const bondOrderName = { 1: "single", 2: "double", 3: "triple" } as const;

/**
 * Write each listed atom's group out as real atoms. The labelled atom becomes the attachment atom
 * (same id, same place, the group's element and charge plus its own), and the rest of the group is
 * appended after every drawn atom, so an index into the drawn atoms means the same atom before and
 * after — the contract engine read-backs rely on. Added atoms are ordinary implicit-hydrogen atoms:
 * a group is only expanded when its bonds fill its free valence exactly (the caller checks), and
 * then the valence model gives every table atom the hydrogens the table states. The one place it can
 * fall short is a head in a hypervalent state ("SHMe" or "PH3Me" on a bond); `atoms.ts` writes those
 * stated hydrogens as explicit H atoms after this runs.
 *
 * Layout: an abbreviation is turned to point away from the atom it is bonded to, at the
 * molecule's own bond length; a composite's substituents spread into the open space around its
 * head. The geometry matters only to a file reader's depiction; no group here has stereochemistry.
 */
export function expandNativeLabelGroupsInGraph(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  groups: ReadonlyMap<string, NativeLabelGroup>
): NativeLabelGroupExpansionResult {
  if (groups.size === 0) {
    return { atoms: [...atoms], bonds: [...bonds], expansions: [] };
  }
  const usedAtomIds = new Set(atoms.map((atom) => atom.id));
  const usedBondIds = new Set(bonds.map((bond) => bond.id));
  const fresh = (used: Set<string>, base: string): string => {
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}_${suffix}`;
    used.add(id);
    return id;
  };
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const bondLength = labelGroupBondLength(atoms, bonds);
  const expandedAtoms = [...atoms];
  const addedAtoms: MoleculeAtom[] = [];
  const addedBonds: MoleculeBond[] = [];
  const expansions: NativeLabelGroupExpansion[] = [];

  atoms.forEach((atom, index) => {
    const group = groups.get(atom.id);
    if (!group) return;
    const attachment = nativeLabelGroupAttachment(group);
    expandedAtoms[index] = groupAttachmentAtom(atom, attachment);
    const atomIds = [atom.id];
    const neighborAngles = bonds
      .filter((bond) => bond.fromAtomId === atom.id || bond.toAtomId === atom.id)
      .map((bond) => atomById.get(bond.fromAtomId === atom.id ? bond.toAtomId : bond.fromAtomId))
      .filter((neighbor): neighbor is MoleculeAtom => neighbor !== undefined)
      .map((neighbor) => Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x));
    let groupIndex = 0;
    // Places one abbreviation's atoms around its attachment atom (`originId`, already in place at
    // `origin`), its frame turned so the atom it bonds to lies at angle `inward` from it.
    const place = (definition: AbbreviationDefinition, originId: string, origin: { x: number; y: number }, inward: number): void => {
      const outward = inward + Math.PI;
      const cos = Math.cos(outward);
      const sin = Math.sin(outward);
      const ids = definition.atoms.map((_, atomIndex) => {
        if (atomIndex === 0) return originId;
        groupIndex += 1;
        return fresh(usedAtomIds, `${atom.id}_g${groupIndex}`);
      });
      definition.atoms.forEach((groupAtom, atomIndex) => {
        if (atomIndex === 0) return;
        addedAtoms.push({
          id: ids[atomIndex]!,
          element: groupAtom.element,
          x: origin.x + bondLength * (groupAtom.x * cos - groupAtom.y * sin),
          y: origin.y + bondLength * (groupAtom.x * sin + groupAtom.y * cos),
          formalCharge: groupAtom.charge ?? 0
        });
        atomIds.push(ids[atomIndex]!);
      });
      definition.bonds.forEach(([from, to, order]) => {
        addedBonds.push({
          id: fresh(usedBondIds, `${atom.id}_gb${addedBonds.length + 1}`),
          fromAtomId: ids[from]!,
          toAtomId: ids[to]!,
          order: bondOrderName[order]
        });
      });
    };

    if (group.kind === "abbreviation") {
      // The group grows away from the first atom it is bonded to; a charge-closed group with no
      // bond ("OMe" carrying −1, methoxide) keeps the table's own orientation.
      place(group.definition, atom.id, atom, neighborAngles[0] ?? Math.PI);
    } else {
      labelGroupOpenDirections(neighborAngles, group.substituents.length).forEach((direction, substituentIndex) => {
        const definition = group.substituents[substituentIndex]!;
        groupIndex += 1;
        const substituentId = fresh(usedAtomIds, `${atom.id}_g${groupIndex}`);
        const origin = {
          x: atom.x + bondLength * Math.cos(direction),
          y: atom.y + bondLength * Math.sin(direction)
        };
        const substituentAttachment = definition.atoms[0]!;
        addedAtoms.push({
          id: substituentId,
          element: substituentAttachment.element,
          x: origin.x,
          y: origin.y,
          formalCharge: substituentAttachment.charge ?? 0
        });
        atomIds.push(substituentId);
        addedBonds.push({
          id: fresh(usedBondIds, `${atom.id}_gb${addedBonds.length + 1}`),
          fromAtomId: atom.id,
          toAtomId: substituentId,
          order: "single"
        });
        place(definition, substituentId, origin, direction + Math.PI);
      });
    }
    expansions.push({ atomId: atom.id, label: group.label, atomIds });
  });

  return { atoms: [...expandedAtoms, ...addedAtoms], bonds: [...bonds, ...addedBonds], expansions };
}

/**
 * The labelled atom as the group's attachment atom: the group's element, the group's charge on top
 * of the label's own, and none of the label-only fields — it is no longer a literal label, so a
 * writer gives it the valence model's hydrogens, which equal the table's for a valid group.
 */
function groupAttachmentAtom(atom: MoleculeAtom, attachment: NativeLabelGroupAttachment): MoleculeAtom {
  const {
    labelLiteral: _labelLiteral,
    labelVisible: _labelVisible,
    hydrogenCount: _hydrogenCount,
    warningSuppressed: _warningSuppressed,
    ...rest
  } = atom;
  return { ...rest, element: attachment.element, formalCharge: atom.formalCharge + attachment.charge };
}

/** The median drawn bond length, or the default style's when nothing is drawn. */
export function labelGroupBondLength(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]): number {
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const lengths = bonds
    .map((bond) => {
      const from = atomById.get(bond.fromAtomId);
      const to = atomById.get(bond.toAtomId);
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
    })
    .filter((length) => length > 1e-6)
    .sort((left, right) => left - right);
  return lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)]! : ChemDraftSyntheticStylePreset.drawing.bondLengthPx;
}

/**
 * Directions for `count` substituents around an atom whose bonds point at `taken` (radians). One
 * bond: the substituents share the rest of the circle evenly (NMe2 at 120°). Otherwise each goes
 * into the middle of the widest gap left, so a ring "NMe" points out of the ring.
 */
export function labelGroupOpenDirections(taken: readonly number[], count: number): number[] {
  if (taken.length === 0) {
    return Array.from({ length: count }, (_, index) => (2 * Math.PI * index) / count);
  }
  if (taken.length === 1) {
    return Array.from({ length: count }, (_, index) => taken[0]! + (2 * Math.PI * (index + 1)) / (count + 1));
  }
  const directions: number[] = [];
  const occupied = [...taken];
  for (let index = 0; index < count; index += 1) {
    const sorted = occupied.map(normalizeAngle).sort((left, right) => left - right);
    let bestStart = sorted[sorted.length - 1]!;
    let bestGap = sorted[0]! + 2 * Math.PI - bestStart;
    for (let gapIndex = 1; gapIndex < sorted.length; gapIndex += 1) {
      const gap = sorted[gapIndex]! - sorted[gapIndex - 1]!;
      if (gap > bestGap) {
        bestGap = gap;
        bestStart = sorted[gapIndex - 1]!;
      }
    }
    const direction = bestStart + bestGap / 2;
    directions.push(direction);
    occupied.push(direction);
  }
  return directions;
}

function normalizeAngle(angle: number): number {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}
