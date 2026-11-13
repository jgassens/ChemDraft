import { nativeDrawingStyleFromObjectStyle, type DocumentObject, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkPlacementPointForAtom, findNearestAtomAtPoint, planBondExtension, transformPointForObject, type LayoutPoint } from "./index";

export const nativeChargeMarkSizePx = 18;
export const nativeAtomHitRadiusPx = 8;

/** The atom tool and import use the same open bond-growth slot and label-placement policy.
 * Keep this module independent of container decoders so importers can reuse it directly. */
export function nativeChargePlacementPointForAtom(
  molecule: MoleculeObject,
  atomId: string,
  objects: readonly DocumentObject[],
  pageWidth: number,
  pageHeight: number,
  mark?: ElectronMarkObject
): LayoutPoint | undefined {
  const atom = molecule.atoms.find(candidate => candidate.id === atomId);
  if (!atom) return undefined;
  const hitRadius = nativeAtomHitRadiusPx;
  const hit = findNearestAtomAtPoint({ atoms: molecule.atoms, point: atom, hitRadius });
  const style = nativeDrawingStyleFromObjectStyle(molecule.style);
  const growth = hit && planBondExtension({
    atoms: molecule.atoms, bonds: molecule.bonds, clickPoint: atom,
    bondLength: style.bondLengthPx, hitRadius,
    targetBondAngleDegrees: style.chainAngleDegrees, preferredAtomId: hit.atomId,
    pageBounds: { x: 0, y: 0, width: pageWidth, height: pageHeight },
    objectBounds: { x: molecule.x, y: molecule.y, width: molecule.width, height: molecule.height }
  });
  // Direct drops clear their whole frame from labels; new tool marks retain the original slot.
  const localPoint = electronMarkPlacementPointForAtom(molecule, atomId, objects, pageWidth, pageHeight, {
    growthPoint: growth && growth.sourceAtomId === atomId && !growth.targetAtomId ? growth.newAtomPoint : undefined,
    mark,
    avoidLabelOverlap: mark !== undefined
  });
  return localPoint && transformPointForObject(molecule, localPoint);
}
