import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChemDraftSyntheticStylePreset, type ChemDraftDocument, type DocumentObject, type ElectronMarkObject, type MoleculeAtom,
  type MoleculeObject } from "@chemdraft/chem-core";
import { clamp, distance, lonePairPlacementPlanForAtom, type LayoutPoint } from "@chemdraft/layout-engine";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { ensureRdkit, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";
import { applyChargeToolAtNativeAtom, createPhase4Document, nativeChargeMarkCenter, nativeChargeMarkSizePx,
  nativeChargePlacementPointForAtom, normalizeCommittedDocument, previewNativeMoleculeBondGrowth } from "./documentWorkflow";

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

function placementFixture(shape: "isolated" | "terminal" | "ring" | "saturated" | "growth-limit" | "blocked", element: string,
  origin: LayoutPoint, rotation: number, fontSize: number): MoleculeObject {
  const points = shape === "isolated" ? [[0, 0]] : shape === "terminal" ? [[0, 0], [-22, 0]]
    : shape === "saturated" ? [[0, 0], [22, 0], [0, 22], [-22, 0], [0, -22]]
    : shape === "growth-limit" || shape === "blocked" ? [[0, 0], ...Array.from({ length: shape === "blocked" ? 16 : 8 }, (_, index) => {
      const angle = index * Math.PI / (shape === "blocked" ? 8 : 4);
      const radius = shape === "blocked" ? nativeBondLength : 22;
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    })]
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
    // Growth has no valence/degree cap. Sixteen bonded neighbours block every endpoint
    // geometrically (within 0.25 bond lengths), and cannot be offered as new ring closures.
    const molecule = placementFixture("blocked", "Zn", { x: 300, y: 300 }, 0, 15);
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

function ketoneFixture() {
  const molecule: MoleculeObject = {
    id: "ketone", type: "molecule", x: 178, y: 178, width: 44, height: 44, rotation: 0, style: {},
    structureFormat: "smiles", structure: "",
    atoms: [
      { id: "carbonyl", element: "C", formalCharge: 0, x: 200, y: 200 },
      { id: "oxygen", element: "O", formalCharge: 0, x: 222, y: 200 },
      { id: "methyl-1", element: "C", formalCharge: 0, x: 189, y: 181 },
      { id: "methyl-2", element: "C", formalCharge: 0, x: 189, y: 219 }
    ],
    bonds: [
      { id: "carbonyl-bond", fromAtomId: "carbonyl", toAtomId: "oxygen", order: "double" },
      { id: "methyl-bond-1", fromAtomId: "carbonyl", toAtomId: "methyl-1", order: "single" },
      { id: "methyl-bond-2", fromAtomId: "carbonyl", toAtomId: "methyl-2", order: "single" }
    ], superatoms: [], rGroups: []
  };
  molecule.structure = nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds);
  molecule.chemistry = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
  const empty = createPhase4Document("Ketone lone pairs");
  const document = normalizeCommittedDocument({ ...empty, pages: [{ ...empty.pages[0], objects: [molecule] }] });
  const target = { kind: "atom" as const, objectId: molecule.id, atomId: "oxygen", distanceToPointer: 0 };
  return { document, molecule, target };
}

const pairsIn = (document: ChemDraftDocument) => document.pages[0].objects.filter(
  (object): object is ElectronMarkObject => object.type === "electron-mark" && object.markKind === "lone-pair");

describe("lone-pair tool placement", () => {
  beforeAll(() => installRealRdkitModuleLoader());
  afterAll(() => resetRdkitForTesting());

  it("intentionally replaces the frozen growth-slot placement with opposite-bond and tangent geometry", () => {
    const { document, molecule, target } = ketoneFixture();
    const first = normalizeCommittedDocument(applyChargeToolAtNativeAtom(document, { kind: "lone-pair" }, target));
    const [pair] = pairsIn(first);
    const center = nativeChargeMarkCenter(pair);
    // Lone pairs deliberately leave the legacy charge growth slot to clear label ink on the largest-gap ray.
    expect(center).not.toEqual(legacyPlacementPoint(molecule, "oxygen", [molecule], 792, 612));
    expect(center.x).toBeGreaterThan(222);
    expect(center.y).toBeCloseTo(200, 10);
    expect(pair.rotation).toBeCloseTo(90, 10);
    expect(pair.anchor).toEqual({ kind: "atom", objectId: molecule.id, atomId: "oxygen" });
    expect(first.selection.objectIds).toEqual([pair.id]);

    const second = normalizeCommittedDocument(applyChargeToolAtNativeAtom(first, { kind: "lone-pair" }, target));
    const next = pairsIn(second)[1];
    expect(nativeChargeMarkCenter(next).x).toBeCloseTo(222, 10);
    expect(nativeChargeMarkCenter(next).y).toBeGreaterThan(200);
    expect(next.rotation).toBeCloseTo(180, 10);
    expect(pairsIn(second)[0]).toEqual(pair);
  });

  it("passes an explicit direction through the workflow, retaining clearance and tangent rotation", () => {
    const { document, molecule, target } = ketoneFixture();
    const enlarged = { ...molecule, style: { ...molecule.style, atomLabelFontSizePx: 48 } };
    const withLargeLabel = { ...document, pages: [{ ...document.pages[0], objects: [enlarged] }] };
    const direction = -Math.PI / 4;
    const expected = lonePairPlacementPlanForAtom(enlarged, "oxygen", [enlarged], document.pages[0].width,
      document.pages[0].height, direction)!;
    const updated = normalizeCommittedDocument(applyChargeToolAtNativeAtom(withLargeLabel, { kind: "lone-pair" }, target, direction));
    const [pair] = pairsIn(updated);
    expect(nativeChargeMarkCenter(pair)).toEqual(expected.center);
    expect(pair.rotation).toBeCloseTo(45, 10);
    expect(pair.rotation).toBe(expected.rotation);
    expect(pair).toMatchObject({ atomAssociation: "explicit", anchor: { kind: "atom", atomId: "oxygen" } });
    expect(distance(nativeChargeMarkCenter(pair), enlarged.atoms[1])).toBeGreaterThan(22 * 1.15);
    expect(normalizeCommittedDocument(updated)).toBe(updated);
    const next = normalizeCommittedDocument(applyChargeToolAtNativeAtom(updated, { kind: "lone-pair" }, target));
    expect(pairsIn(next)[1].rotation).toBeCloseTo(157.5, 10);
    expect(pairsIn(next)[1].anchor).toEqual(pair.anchor);
  });

  it("leaves legacy radical placement and its zero rotation unchanged", () => {
    const { document, molecule, target } = ketoneFixture();
    const updated = applyChargeToolAtNativeAtom(document, { kind: "radical-dot" }, target);
    const mark = updated.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    expect(nativeChargeMarkCenter(mark)).toEqual(legacyPlacementPoint(molecule, "oxygen", [molecule], 792, 612));
    expect(mark.rotation).toBe(0);
  });

  it("preserves RDKit canonical SMILES, formula, charge, atom/bond counts and the entire native graph after two pairs", async () => {
    const { document, target } = ketoneFixture();
    const module = await ensureRdkit();
    const moleculeIn = (doc: ChemDraftDocument) => doc.pages[0].objects.find(
      (object): object is MoleculeObject => object.type === "molecule")!;
    const before = moleculeIn(document);
    const identity = inspectStructureInWorker(module, stereoPerceptionMolfile(before));
    expect(identity).toMatchObject({ valid: true, formula: "C3H6O", heavyAtoms: 4 });
    if (!identity.valid) throw new Error(identity.reason);
    expect(identity.canonicalSmiles).toBe("CC(C)=O");
    let updated = document;
    for (let index = 0; index < 2; index++) {
      updated = normalizeCommittedDocument(applyChargeToolAtNativeAtom(updated, { kind: "lone-pair" }, target));
      const after = moleculeIn(updated);
      expect(inspectStructureInWorker(module, stereoPerceptionMolfile(after))).toEqual(identity);
      expect(after.atoms).toHaveLength(before.atoms.length);
      expect(after.bonds).toHaveLength(before.bonds.length);
      expect(after.atoms.map(atom => atom.formalCharge)).toEqual(before.atoms.map(atom => atom.formalCharge));
      expect(after.chemistry).toMatchObject({ formula: "C3H6O", totalCharge: 0 });
      expect(after).toEqual(before);
    }
    expect(pairsIn(updated)).toHaveLength(2);
  });
});
