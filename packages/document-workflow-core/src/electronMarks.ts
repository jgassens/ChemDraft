// The commit normalizer and layout edits must resolve marks using exactly the same rules.
import { nativeDrawingStyleFromObjectStyle, type DocumentPage, type ElectronMarkObject,
  type MoleculeObject, type MoleculeBond } from "@chemdraft/chem-core";
import { atomBondOrderUsageMap } from "@chemdraft/layout-engine";
import { nativeElementFromAtomLabel, nativeAtomChargeSupportsValence } from "./atoms";
import { distance, type PagePoint } from "./shared";
import { nativeBondLengthPx } from "./molecule";

export const nativeChargeAssociationRadiusPx = nativeBondLengthPx * 1.15;
/** Stacking the charge tool tops out here — beyond ±9 is a typo, not chemistry. */
export const nativeChargeMarkMaxMagnitude = 9;
export const nativeElectronMarkAtomKey = (moleculeId: string, atomId: string) => `${moleculeId}\n${atomId}`;

export interface NativeElectronMarkAssignments {
  anchorByMarkId: Map<string, { objectId: string; atomId: string } | undefined>;
  assignedChargeByAtomKey: Map<string, number>;
  assignedRadicalsByAtomKey: Map<string, number>;
}

/** Sticky atom anchors first, then nearest supportable atoms within each molecule's radius.
 * Evaluate on the original page before any geometry changes. Point marks outside the radius float. */
export function nativeElectronMarkAssignments(page: DocumentPage): NativeElectronMarkAssignments {
  const electronMarks = page.objects.filter((object): object is ElectronMarkObject =>
    object.type === "electron-mark" &&
    (object.markKind === "lone-pair" ||
      object.markKind === "radical-dot" ||
      (object.markKind === "charge" && nativeChargeValue(object.charge) !== undefined))
  );
  const molecules = page.objects.filter((object): object is MoleculeObject =>
    object.type === "molecule" && isEditableNativeMoleculeGraph(object)
  );
  const hasMarkContributions = molecules.some((molecule) =>
    molecule.atoms.some((atom) => (atom.markCharge ?? 0) !== 0 || (atom.markRadicals ?? 0) !== 0)
  );
  if (electronMarks.length === 0 && !hasMarkContributions) {
    return { anchorByMarkId: new Map(), assignedChargeByAtomKey: new Map(), assignedRadicalsByAtomKey: new Map() };
  }

  // What a mark contributes to its atom. Lone pairs contribute nothing — they anchor for
  // positioning only, since implied lone pairs are already part of the octet arithmetic.
  const markContribution = (mark: ElectronMarkObject): { charge: number; radicals: number } => {
    if (mark.markKind === "charge") {
      return { charge: nativeChargeValue(mark.charge) ?? 0, radicals: mark.radical === true ? 1 : 0 };
    }
    return { charge: 0, radicals: mark.markKind === "radical-dot" ? 1 : 0 };
  };

  const moleculeById = new Map(molecules.map((molecule) => [molecule.id, molecule] as const));
  const usageByMoleculeId = new Map(molecules.map((molecule) =>
    [molecule.id, atomBondOrderUsageMap(molecule.atoms, molecule.bonds)] as const
  ));
  // The atom-targeted tool drops the mark one bond length out (the chain-growth slot), so a
  // molecule drawn or pasted with longer bonds needs its radius to scale with its own bonds.
  const associationRadiusByMoleculeId = new Map(molecules.map((molecule) => [
    molecule.id,
    Math.max(nativeChargeAssociationRadiusPx, nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx * 1.15)
  ] as const));
  const assignedChargeByAtomKey = new Map<string, number>();
  const assignedRadicalsByAtomKey = new Map<string, number>();
  const anchorByMarkId = new Map<string, { objectId: string; atomId: string } | undefined>();

  const markCanAssociate = (
    moleculeId: string,
    atomId: string,
    center: PagePoint,
    contribution: { charge: number; radicals: number }
  ): boolean => {
    const molecule = moleculeById.get(moleculeId);
    const atom = molecule?.atoms.find((candidate) => candidate.id === atomId);
    if (!molecule || !atom ||
      distance(center, atom) > (associationRadiusByMoleculeId.get(moleculeId) ?? nativeChargeAssociationRadiusPx)) {
      return false;
    }

    const element = nativeElementFromAtomLabel(atom.element);
    if (!element) {
      // Nicknames and condensed labels are superatoms outside the element valence tables. They
      // still own nearby charge/radical marks; only the distance can be judged without inventing
      // valence rules for labels such as Me, N3, or Ph.
      return true;
    }

    if (contribution.charge === 0 && contribution.radicals === 0) {
      return true;
    }

    const key = nativeElectronMarkAtomKey(moleculeId, atomId);
    const intrinsicCharge = atom.formalCharge - (atom.markCharge ?? 0);
    const candidateCharge = intrinsicCharge + (assignedChargeByAtomKey.get(key) ?? 0) + contribution.charge;
    // Each unpaired electron occupies a bonding slot, so it counts as used valence.
    const candidateUsage = (usageByMoleculeId.get(moleculeId)?.get(atomId) ?? 0) +
      (assignedRadicalsByAtomKey.get(key) ?? 0) + contribution.radicals;
    return nativeAtomChargeSupportsValence(element, candidateUsage, candidateCharge);
  };

  const assign = (moleculeId: string, atomId: string, contribution: { charge: number; radicals: number }) => {
    const key = nativeElectronMarkAtomKey(moleculeId, atomId);
    assignedChargeByAtomKey.set(key, (assignedChargeByAtomKey.get(key) ?? 0) + contribution.charge);
    assignedRadicalsByAtomKey.set(key, (assignedRadicalsByAtomKey.get(key) ?? 0) + contribution.radicals);
  };

  // Pass 1 — sticky anchors. A mark that is already bound to an atom (by the charge tool or an
  // earlier pass) keeps that atom while it stays in radius and the chemistry stays legal, so
  // dragging a mark between two nearby atoms doesn't flicker and a crowded placement can't be
  // stolen by whichever neighbor happens to sit marginally closer.
  electronMarks.forEach((mark) => {
    if (mark.anchor.kind !== "atom" || !mark.anchor.objectId || !mark.anchor.atomId) {
      return;
    }

    const contribution = markContribution(mark);
    const center = nativeChargeMarkCenter(mark);
    if (markCanAssociate(mark.anchor.objectId, mark.anchor.atomId, center, contribution)) {
      assign(mark.anchor.objectId, mark.anchor.atomId, contribution);
      anchorByMarkId.set(mark.id, { objectId: mark.anchor.objectId, atomId: mark.anchor.atomId });
    }
  });

  // Pass 2 — everything else associates with its nearest supportable atom in radius, or floats.
  electronMarks.forEach((mark) => {
    if (anchorByMarkId.has(mark.id)) {
      return;
    }

    const contribution = markContribution(mark);
    const center = nativeChargeMarkCenter(mark);
    let nearest: { objectId: string; atomId: string; distance: number } | undefined;
    molecules.forEach((molecule) => {
      const associationRadius = associationRadiusByMoleculeId.get(molecule.id) ?? nativeChargeAssociationRadiusPx;
      molecule.atoms.forEach((atom) => {
        const separation = distance(center, atom);
        if (
          separation <= associationRadius &&
          (!nearest || separation < nearest.distance) &&
          markCanAssociate(molecule.id, atom.id, center, contribution)
        ) {
          nearest = { objectId: molecule.id, atomId: atom.id, distance: separation };
        }
      });
    });

    if (nearest) {
      assign(nearest.objectId, nearest.atomId, contribution);
      anchorByMarkId.set(mark.id, { objectId: nearest.objectId, atomId: nearest.atomId });
    } else {
      anchorByMarkId.set(mark.id, undefined);
    }
  });

  return { anchorByMarkId, assignedChargeByAtomKey, assignedRadicalsByAtomKey };
}

export function isEditableNativeMoleculeGraph(molecule: MoleculeObject): boolean {
  const atomIds = new Set(molecule.atoms.map((atom) => atom.id));
  const supportedBondOrders = new Set<MoleculeBond["order"]>(["single", "double", "triple", "aromatic", "unknown"]);

  return (
    molecule.atoms.length >= 1 &&
    molecule.atoms.every((atom) =>
      atom.id.trim().length > 0 &&
      atom.element.trim().length > 0 &&
      Number.isFinite(atom.x) &&
      Number.isFinite(atom.y)
    ) &&
    molecule.bonds.every((bond) =>
      bond.id.trim().length > 0 &&
      bond.fromAtomId !== bond.toAtomId &&
      atomIds.has(bond.fromAtomId) &&
      atomIds.has(bond.toAtomId) &&
      supportedBondOrders.has(bond.order)
    )
  );
}

export function nativeChargeMarkCenter(mark: ElectronMarkObject): PagePoint {
  return {
    x: mark.x + mark.width / 2,
    y: mark.y + mark.height / 2
  };
}

/** A drawable mark charge: any nonzero integer up to |9| — 2+ zincs, 3- phosphates. */
export function nativeChargeValue(charge: number | undefined): number | undefined {
  return typeof charge === "number" && Number.isInteger(charge) && charge !== 0 && Math.abs(charge) <= nativeChargeMarkMaxMagnitude
    ? charge
    : undefined;
}
