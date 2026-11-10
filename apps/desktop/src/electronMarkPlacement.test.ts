import { describe, expect, it } from "vitest";
import { ChemDraftSyntheticStylePreset, type DocumentObject, type ElectronMarkObject, type MoleculeAtom,
  type MoleculeObject } from "@chemdraft/chem-core";
import { clamp, distance, type LayoutPoint } from "@chemdraft/layout-engine";
import { nativeChargeMarkCenter, nativeChargeMarkSizePx, nativeChargePlacementPointForAtom,
  previewNativeMoleculeBondGrowth } from "./documentWorkflow";

const nativeBondLength = ChemDraftSyntheticStylePreset.drawing.bondLengthPx;

// Frozen oracle from ee50d782's nativeChargePlacementPointForAtom, largestOpenAngle,
// angularDistance and normalizeAngle. Keep the arithmetic and tie-breaking unchanged.
function legacyPlacementPoint(
  molecule: MoleculeObject, atomId: string, objects: readonly DocumentObject[], pageWidth: number, pageHeight: number
): LayoutPoint | undefined {
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) return undefined;
  const growth = previewNativeMoleculeBondGrowth(molecule, atom, pageWidth, pageHeight);
  if (growth && growth.atomId === atomId && !growth.targetAtomId) return growth.newAtomPoint;

  const placementRadius = Math.max(nativeChargeMarkSizePx * 1.35, nativeBondLength * 0.55);
  const neighborAngles = molecule.bonds
    .filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId)
    .map((bond) => molecule.atoms.find((candidate) =>
      candidate.id === (bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId)))
    .filter((candidate): candidate is MoleculeAtom => candidate !== undefined)
    .map((neighbor) => Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x));
  const preferredOpenAngle = largestOpenAngle(neighborAngles) ?? -Math.PI / 4;
  const otherAtoms = molecule.atoms.filter((candidate) => candidate.id !== atomId);
  const chargeCenters = objects
    .filter((object): object is ElectronMarkObject => object.type === "electron-mark" && object.markKind === "charge")
    .map(nativeChargeMarkCenter);
  const halfSize = nativeChargeMarkSizePx / 2;
  const candidates = Array.from({ length: 16 }, (_, index) => {
    const angle = -Math.PI + index * Math.PI / 8;
    const point = { x: atom.x + Math.cos(angle) * placementRadius, y: atom.y + Math.sin(angle) * placementRadius };
    const clampedPoint = {
      x: clamp(point.x, halfSize, Math.max(halfSize, pageWidth - halfSize)),
      y: clamp(point.y, halfSize, Math.max(halfSize, pageHeight - halfSize))
    };
    const boundaryPenalty = distance(point, clampedPoint);
    const bondSeparation = neighborAngles.length === 0 ? Math.PI
      : Math.min(...neighborAngles.map((neighborAngle) => angularDistance(angle, neighborAngle)));
    const atomDistanceScore = otherAtoms.reduce((sum, otherAtom) =>
      sum + Math.min(1, distance(clampedPoint, otherAtom) / (nativeBondLength * 1.5)), 0);
    const chargeDistanceScore = chargeCenters.reduce((sum, center) =>
      sum + Math.min(1, distance(clampedPoint, center) / (nativeBondLength * 1.5)), 0);
    const preferredScore = 1 - angularDistance(angle, preferredOpenAngle) / Math.PI;
    return { point: clampedPoint,
      score: bondSeparation * 1000 + atomDistanceScore * 20 + chargeDistanceScore * 10 + preferredScore - boundaryPenalty * 10 };
  });
  return candidates.sort((left, right) => right.score - left.score || left.point.y - right.point.y || left.point.x - right.point.x)[0]?.point;
}

function largestOpenAngle(angles: readonly number[]): number | undefined {
  if (angles.length === 0) return undefined;
  const normalizedAngles = angles.map(normalizeAngle).sort((left, right) => left - right);
  const gaps = normalizedAngles.map((angle, index) => {
    const nextAngle = normalizedAngles[(index + 1) % normalizedAngles.length] ?? angle;
    const wrappedNext = index === normalizedAngles.length - 1 ? nextAngle + Math.PI * 2 : nextAngle;
    const gap = wrappedNext - angle;
    return { gap, midpoint: normalizeAngle(angle + gap / 2) };
  });
  return gaps.sort((left, right) => right.gap - left.gap || left.midpoint - right.midpoint)[0]?.midpoint;
}

function angularDistance(left: number, right: number): number {
  const delta = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(delta, Math.PI * 2 - delta);
}

function normalizeAngle(angle: number): number {
  let normalized = angle % (Math.PI * 2);
  if (normalized < 0) normalized += Math.PI * 2;
  return normalized;
}

function placementFixture(shape: "isolated" | "terminal" | "ring" | "saturated" | "growth-limit", element: string,
  origin: LayoutPoint, rotation: number, fontSize: number): MoleculeObject {
  const points = shape === "isolated" ? [[0, 0]] : shape === "terminal" ? [[0, 0], [-22, 0]]
    : shape === "saturated" ? [[0, 0], [22, 0], [0, 22], [-22, 0], [0, -22]]
    : shape === "growth-limit" ? [[0, 0], ...Array.from({ length: 8 }, (_, index) =>
      [22 * Math.cos(index * Math.PI / 4), 22 * Math.sin(index * Math.PI / 4)])]
    : Array.from({ length: 6 }, (_, index) => [22 * (Math.cos(index * Math.PI / 3) - 1), 22 * Math.sin(index * Math.PI / 3)]);
  const atoms = points.map(([x, y], index) => ({ id: `atom_${index}`, element: index === 0 ? element : "C", formalCharge: 0,
    x: origin.x + x * Math.cos(rotation) - y * Math.sin(rotation),
    y: origin.y + x * Math.sin(rotation) + y * Math.cos(rotation) }));
  const bonds: MoleculeObject["bonds"] = atoms.slice(1).map((atom, index) => ({ id: `bond_${index}`,
    fromAtomId: shape === "ring" ? atoms[index].id : atoms[0].id, toAtomId: atom.id, order: "single" }));
  if (shape === "ring") bonds.push({ id: "closure", fromAtomId: atoms[5].id, toAtomId: atoms[0].id, order: "single" });
  const xs = atoms.map(atom => atom.x), ys = atoms.map(atom => atom.y);
  return { id: "molecule", type: "molecule", x: Math.min(...xs), y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), rotation: 0,
    style: { atomLabelFontSizePx: fontSize }, structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: [] };
}

function chargeMark(molecule: MoleculeObject, point: LayoutPoint): ElectronMarkObject {
  return { id: "existing_charge", type: "electron-mark", markKind: "charge", charge: 1, chargeStyle: "circled",
    x: point.x - 9, y: point.y - 9, width: 18, height: 18, rotation: 0, style: {},
    anchor: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0].id } };
}

describe("charge-tool placement equivalence with ee50d782", () => {
  it.each(["isolated", "terminal", "ring", "saturated", "growth-limit"] as const)("preserves exact %s placement with labels, charges and page edges", shape => {
    const origins = [
      { x: 300, y: 300 }, { x: 4, y: 300 }, { x: 788, y: 300 }, { x: 300, y: 4 }, { x: 300, y: 608 },
      { x: 4, y: 4 }, { x: 788, y: 4 }, { x: 4, y: 608 }, { x: 788, y: 608 }
    ];
    for (const element of ["C", "N", "O", "Zn"]) for (const fontSize of [15, 36])
      for (const rotation of [0, Math.PI / 7, Math.PI - 0.00001]) for (const origin of origins) {
        const molecule = placementFixture(shape, element, origin, rotation, fontSize);
        for (const mark of [undefined, chargeMark(molecule, { x: origin.x + 22, y: origin.y }),
          chargeMark(molecule, { x: origin.x - 17, y: origin.y - 17 })]) {
          const objects = mark ? [molecule, mark] : [molecule];
          expect(nativeChargePlacementPointForAtom(molecule, "atom_0", objects, 792, 612),
            JSON.stringify({ shape, element, fontSize, rotation, origin, mark: mark?.x }))
            .toEqual(legacyPlacementPoint(molecule, "atom_0", objects, 792, 612));
        }
      }
  });

  it("still accounts for existing charge centres when there is no growth slot", () => {
    // Growth admits up to eight bonds, even on a four-bond carbon; use the actual editor limit.
    const molecule = placementFixture("growth-limit", "Zn", { x: 300, y: 300 }, 0, 15);
    expect(previewNativeMoleculeBondGrowth(molecule, molecule.atoms[0], 792, 612)).toBeUndefined();
    const original = nativeChargePlacementPointForAtom(molecule, "atom_0", [molecule], 792, 612)!;
    const objects = [molecule, chargeMark(molecule, original)];
    const point = nativeChargePlacementPointForAtom(molecule, "atom_0", objects, 792, 612);
    expect(point).not.toEqual(original);
    expect(point).toEqual(legacyPlacementPoint(molecule, "atom_0", objects, 792, 612));
  });

  it("returns no point for a missing atom", () => {
    const molecule = placementFixture("terminal", "N", { x: 300, y: 300 }, 0, 15);
    expect(nativeChargePlacementPointForAtom(molecule, "missing", [molecule], 792, 612)).toBeUndefined();
  });
});
