// The commit normalizer and layout edits must resolve marks using exactly the same rules.
import { nativeDrawingStyleFromObjectStyle, type DocumentPage, type ElectronMarkObject,
  type MoleculeObject, type MoleculeBond } from "@chemdraft/chem-core";
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

export interface NativeElectronMarkAssignmentOptions {
  /** Per-call assignment-query override only. Persist floating drops with an explicit point anchor. */
  floatingElectronMarkIds?: ReadonlySet<string>;
}

/** The atom fields contributed by each mark kind; display-only marks contribute nothing. */
export function electronMarkAtomContribution(mark: ElectronMarkObject): { charge: number; radicals: number } {
  if (mark.markKind === "charge") {
    return { charge: nativeChargeValue(mark.charge) ?? 0, radicals: mark.radical === true ? 1 : 0 };
  }
  return { charge: 0, radicals: mark.markKind === "radical-dot" ? 1 : 0 };
}

/** Explicit point anchors stay floating; explicit atom anchors stay bound at any distance.
 * Legacy anchors are sticky within radius.
 * Other marks use the nearest atom in radius without valence-based reassignment.
 * Evaluate on the original page before any geometry changes. Point marks outside the radius float. */
export function nativeElectronMarkAssignments(
  page: DocumentPage, options: NativeElectronMarkAssignmentOptions = {}
): NativeElectronMarkAssignments {
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

  const moleculeById = new Map(molecules.map((molecule) => [molecule.id, molecule] as const));
  // The atom-targeted tool drops the mark one bond length out (the chain-growth slot), so a
  // molecule drawn or pasted with longer bonds needs its radius to scale with its own bonds.
  const associationRadiusByMoleculeId = new Map(molecules.map((molecule) => [
    molecule.id,
    Math.max(nativeChargeAssociationRadiusPx, nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx * 1.15)
  ] as const));
  const assignedChargeByAtomKey = new Map<string, number>();
  const assignedRadicalsByAtomKey = new Map<string, number>();
  const anchorByMarkId = new Map<string, { objectId: string; atomId: string } | undefined>();
  // A direct drop already made this decision with its own capture radius. Never reinterpret
  // the user's floating placement during an unrelated edit, layout operation or file open.
  for (const mark of electronMarks) {
    if (mark.atomAssociation === "explicit" && mark.anchor.kind === "point") anchorByMarkId.set(mark.id, undefined);
  }
  // Recording an unassigned result also blocks pass 2 from applying the wider legacy radius.
  for (const id of options.floatingElectronMarkIds ?? []) anchorByMarkId.set(id, undefined);

  const markCanAssociate = (
    moleculeId: string,
    atomId: string,
    center: PagePoint,
    explicit = false
  ): boolean => {
    const atom = moleculeById.get(moleculeId)?.atoms.find((candidate) => candidate.id === atomId);
    return atom !== undefined &&
      (explicit || distance(center, atom) <= (associationRadiusByMoleculeId.get(moleculeId) ?? nativeChargeAssociationRadiusPx));
  };

  const assign = (moleculeId: string, atomId: string, contribution: { charge: number; radicals: number }) => {
    const key = nativeElectronMarkAtomKey(moleculeId, atomId);
    assignedChargeByAtomKey.set(key, (assignedChargeByAtomKey.get(key) ?? 0) + contribution.charge);
    assignedRadicalsByAtomKey.set(key, (assignedRadicalsByAtomKey.get(key) ?? 0) + contribution.radicals);
  };

  // Pass 1 — sticky anchors. A mark that is already bound to an atom (by the charge tool or an
  // earlier pass) keeps that atom while it stays in radius, or at any distance if explicit, so
  // dragging a mark between two nearby atoms doesn't flicker and a crowded placement can't be
  // stolen by whichever neighbor happens to sit marginally closer.
  electronMarks.forEach((mark) => {
    if (anchorByMarkId.has(mark.id) || mark.anchor.kind !== "atom" || !mark.anchor.objectId || !mark.anchor.atomId) {
      return;
    }

    const contribution = electronMarkAtomContribution(mark);
    const center = nativeChargeMarkCenter(mark);
    if (markCanAssociate(mark.anchor.objectId, mark.anchor.atomId, center, mark.atomAssociation === "explicit")) {
      assign(mark.anchor.objectId, mark.anchor.atomId, contribution);
      anchorByMarkId.set(mark.id, { objectId: mark.anchor.objectId, atomId: mark.anchor.atomId });
    }
  });

  // Pass 2 — everything else associates with its nearest atom in radius, or floats.
  electronMarks.forEach((mark) => {
    if (anchorByMarkId.has(mark.id)) {
      return;
    }

    const contribution = electronMarkAtomContribution(mark);
    const center = nativeChargeMarkCenter(mark);
    let nearest: { objectId: string; atomId: string; distance: number } | undefined;
    molecules.forEach((molecule) => {
      const associationRadius = associationRadiusByMoleculeId.get(molecule.id) ?? nativeChargeAssociationRadiusPx;
      molecule.atoms.forEach((atom) => {
        const separation = distance(center, atom);
        if (
          separation <= associationRadius &&
          (!nearest || separation < nearest.distance) &&
          markCanAssociate(molecule.id, atom.id, center)
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
