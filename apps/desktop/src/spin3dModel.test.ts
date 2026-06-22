import { describe, expect, it } from "vitest";

import {
  applyPatches,
  deserializeDocument,
  serializeDocument,
  type ChemDraftDocument,
  type MoleculeObject,
  type ViewMatrix
} from "@chemdraft/chem-core";

import {
  SPIN3D_MODEL_KEY,
  attachSpin3dModel,
  attachSpin3dModelFromConformer,
  buildSpin3dModel,
  conformerGraphSignature,
  createPhase4Document,
  flattenSpunMolecule,
  rotateDocumentObject,
  readSpin3dModel,
  spin3dModelCoordsForMolecule,
  validSpin3dModelFor,
  type Spin3dDocumentModelV1
} from "./documentWorkflow";
import { quatFromAxisAngle, quatMultiply, quatNormalize, quatToViewMatrix, type Quaternion } from "./interaction/rotation3d";
import { medianBondLength2d, orientedOverlayScale, overlayScale, type ScreenPlacement } from "./interaction/spinOverlay";

// Butane-ish chain (achiral → flatten never refuses) with a genuinely non-planar conformer
// so projecting it from different orientations produces different depth cues.
const CHAIN_ATOMS: MoleculeObject["atoms"] = [
  { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
  { id: "a1", element: "C", x: 130, y: 100, formalCharge: 0 },
  { id: "a2", element: "C", x: 160, y: 100, formalCharge: 0 },
  { id: "a3", element: "C", x: 190, y: 100, formalCharge: 0 }
];
const CHAIN_BONDS: MoleculeObject["bonds"] = [
  { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" },
  { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
  { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
];
// Zig-zag spread along x (with vertical spread so projections stay non-degenerate in
// every view) and alternating z; rotating about Y converts the wide x-spread into depth.
const CHAIN_COORDS3D = [0, 0, 0, 1, 0.8, 0.3, 2, 0, -0.3, 3, 0.8, 0.3];

function molecule(atoms = CHAIN_ATOMS, bonds = CHAIN_BONDS): MoleculeObject {
  return {
    id: "mol",
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  };
}

function documentWith(mol: MoleculeObject): ChemDraftDocument {
  const base = createPhase4Document("Spin 3D model fixture");
  return applyPatches(base, [
    { op: "addObject", pageId: base.pages[0].id, object: mol },
    { op: "setSelection", pageId: base.pages[0].id, objectIds: [mol.id] }
  ]);
}

function moleculeOf(document: ChemDraftDocument, id = "mol"): MoleculeObject {
  const found = document.pages[0].objects.find((object) => object.id === id);
  if (!found || found.type !== "molecule") throw new Error("molecule missing");
  return found;
}

function bondPairsFor(mol: MoleculeObject): [number, number][] {
  const atomIndex = new Map(mol.atoms.map((atom, index) => [atom.id, index] as const));
  return mol.bonds
    .map((bond) => [atomIndex.get(bond.fromAtomId), atomIndex.get(bond.toAtomId)] as const)
    .filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);
}

function moleculeAtomBounds(mol: MoleculeObject): { width: number; height: number } {
  const xs = mol.atoms.map((atom) => atom.x);
  const ys = mol.atoms.map((atom) => atom.y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

function placementFor(mol: MoleculeObject, coords3d: ArrayLike<number>, orientation?: Quaternion): ScreenPlacement {
  const points = mol.atoms.map((atom) => ({ x: atom.x, y: atom.y }));
  const bondPairs = bondPairsFor(mol);
  return {
    centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    scale: orientation
      ? orientedOverlayScale(points, coords3d, bondPairs, quatToViewMatrix(orientation))
      : overlayScale(points, coords3d, bondPairs)
  };
}

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 } as const;

function modelFor(mol: MoleculeObject): Spin3dDocumentModelV1 {
  return buildSpin3dModel({
    molecule: mol,
    coords3d: CHAIN_COORDS3D,
    orientation: IDENTITY_QUAT,
    engine: { name: "rdkit-wasm", version: "test", forceField: "MMFF94" }
  });
}

describe("spin3d model — attach / read / validate", () => {
  it("round-trips through compatibility.unknown without clobbering other metadata", () => {
    const mol: MoleculeObject = {
      ...molecule(),
      compatibility: { sourceFormat: "smiles", warnings: [], unknown: { keep: "me" } }
    };
    const document = documentWith(mol);
    const attached = attachSpin3dModel(document, "mol", modelFor(mol));
    const next = moleculeOf(attached);

    // Other compatibility fields survive the merge.
    expect(next.compatibility?.sourceFormat).toBe("smiles");
    expect(next.compatibility?.unknown?.keep).toBe("me");

    const read = readSpin3dModel(next);
    expect(read?.kind).toBe(SPIN3D_MODEL_KEY);
    expect(read?.atomIds).toEqual(["a0", "a1", "a2", "a3"]);
    expect(read?.coords3d).toEqual(CHAIN_COORDS3D);
    expect(read?.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(read?.engine).toEqual({ name: "rdkit-wasm", version: "test", forceField: "MMFF94" });
  });

  it("survives document serialize → deserialize (strict schema)", () => {
    const mol = molecule();
    const attached = attachSpin3dModel(documentWith(mol), "mol", modelFor(mol));
    const reloaded = deserializeDocument(serializeDocument(attached));
    expect(readSpin3dModel(moleculeOf(reloaded))?.coords3d).toEqual(CHAIN_COORDS3D);
  });

  it("validSpin3dModelFor honors the graph-signature gate", () => {
    const mol = molecule();
    const attached = attachSpin3dModel(documentWith(mol), "mol", modelFor(mol));
    expect(validSpin3dModelFor(moleculeOf(attached))?.kind).toBe(SPIN3D_MODEL_KEY);

    // Edit the graph (add an atom) → the stored model is still readable but now stale.
    const edited = applyPatches(attached, [
      {
        op: "updateObject",
        objectId: "mol",
        changes: { atoms: [...CHAIN_ATOMS, { id: "a4", element: "C", x: 220, y: 100, formalCharge: 0 }] }
      }
    ]);
    const editedMol = moleculeOf(edited);
    expect(readSpin3dModel(editedMol)?.kind).toBe(SPIN3D_MODEL_KEY); // still present
    expect(validSpin3dModelFor(editedMol)).toBeUndefined(); // but rejected by the gate
  });

  it("readSpin3dModel rejects malformed models", () => {
    const base = molecule();
    const bad = (model: unknown): MoleculeObject => ({
      ...base,
      compatibility: { warnings: [], unknown: { [SPIN3D_MODEL_KEY]: model } }
    });
    expect(readSpin3dModel(bad({ kind: "other" }))).toBeUndefined();
    expect(readSpin3dModel(bad({ kind: SPIN3D_MODEL_KEY, graphSignature: "x", atomIds: ["a0"], coords3d: [0, 0], orientation: IDENTITY_QUAT, updatedAt: "now" }))).toBeUndefined(); // coords len mismatch
    expect(readSpin3dModel(bad({ kind: SPIN3D_MODEL_KEY, graphSignature: "x", atomIds: ["a0"], coords3d: [0, 0, 0], updatedAt: "now" }))).toBeUndefined(); // missing orientation
  });

  it("spin3dModelCoordsForMolecule reorders coords into the molecule's atom order", () => {
    const mol = molecule();
    const model = modelFor(mol);
    // Same atoms, reversed order.
    const reversed = molecule([...CHAIN_ATOMS].reverse(), CHAIN_BONDS);
    const coords = spin3dModelCoordsForMolecule(model, reversed);
    expect(coords).toBeDefined();
    // a3 is now first; its coords (index 3 in the model) should lead.
    expect(Array.from(coords!).slice(0, 3)).toEqual([3, 0.8, 0.3]);

    // An atom id the model doesn't know about → cannot map.
    const renamed = molecule(
      CHAIN_ATOMS.map((atom, index) => (index === 0 ? { ...atom, id: "zzz" } : atom)),
      CHAIN_BONDS
    );
    expect(spin3dModelCoordsForMolecule(model, renamed)).toBeUndefined();
  });

  it("buildSpin3dModel signs the current graph", () => {
    const mol = molecule();
    expect(buildSpin3dModel({ molecule: mol, coords3d: CHAIN_COORDS3D, orientation: IDENTITY_QUAT }).graphSignature)
      .toBe(conformerGraphSignature(mol));
  });
});

describe("spin3d model — depth-cue invariant", () => {
  it("re-projecting the conformer at different orientations moves the bond depth cues", () => {
    const document = documentWith(molecule());

    const flatA = flattenSpunMolecule(document, "mol", CHAIN_COORDS3D, quatToViewMatrix(IDENTITY_QUAT));
    // ~60° about Y turns the chain's x-spread into depth.
    const flatB = flattenSpunMolecule(
      document,
      "mol",
      CHAIN_COORDS3D,
      quatToViewMatrix(quatFromAxisAngle([0, 1, 0], Math.PI / 3))
    );

    expect(flatA.status).toBe("committed");
    expect(flatB.status).toBe("committed");

    const weights = (outcome: typeof flatA): (number | null)[] =>
      moleculeOf(outcome.document).bonds.map((bond) => bond.display?.depthWeight ?? null);
    const weightsA = weights(flatA);
    const weightsB = weights(flatB);

    // The tilted view has real, non-uniform depth cues that differ from the flat view.
    expect(weightsB.some((value) => typeof value === "number")).toBe(true);
    expect(new Set(weightsB.filter((value): value is number => typeof value === "number")).size).toBeGreaterThan(1);
    expect(JSON.stringify(weightsA)).not.toEqual(JSON.stringify(weightsB));
  });

  it("keeps modeled X/Y rotations bounded with placement and does not write legacy tilt", () => {
    const base = documentWith(molecule());
    const first = flattenSpunMolecule(base, "mol", CHAIN_COORDS3D, quatToViewMatrix(IDENTITY_QUAT), {
      placement: placementFor(molecule(), CHAIN_COORDS3D)
    });
    expect(first.status).toBe("committed");

    let current = attachSpin3dModel(first.document, "mol", modelFor(moleculeOf(first.document)));
    let currentOrientation: Quaternion = IDENTITY_QUAT;
    const firstMol = moleculeOf(current);
    const firstBounds = moleculeAtomBounds(firstMol);
    const firstMedian = medianBondLength2d(firstMol.atoms, bondPairsFor(firstMol));

    for (const delta of [Math.PI / 3, -Math.PI / 4, Math.PI / 2, -Math.PI / 5]) {
      const startMol = moleculeOf(current);
      const placement = placementFor(startMol, CHAIN_COORDS3D, currentOrientation);
      currentOrientation = quatNormalize(quatMultiply(quatFromAxisAngle([0, 1, 0], delta), currentOrientation));
      const outcome = flattenSpunMolecule(current, "mol", CHAIN_COORDS3D, quatToViewMatrix(currentOrientation), {
        placement
      });
      expect(outcome.status).toBe("committed");
      current = attachSpin3dModelFromConformer(outcome.document, "mol", {
        coords3d: CHAIN_COORDS3D,
        orientation: currentOrientation
      });
      const nextMol = moleculeOf(current);
      const bounds = moleculeAtomBounds(nextMol);
      expect(bounds.width).toBeLessThan(firstBounds.width * 1.25);
      expect(bounds.height).toBeLessThan(firstBounds.width * 1.25);
      expect(medianBondLength2d(nextMol.atoms, bondPairsFor(nextMol))).toBeLessThan(firstMedian * 1.25);
      expect(nextMol.transform?.tiltXDegrees).toBeUndefined();
      expect(nextMol.transform?.tiltYDegrees).toBeUndefined();
    }
  });
});

describe("spin3d model — Z-rotate keeps the stored orientation in lock-step with the drawing", () => {
  // A screen-Z rotate is shown via the cheap 2D rotateDocumentObject path, but the stored
  // orientation gets a Z quaternion folded in. flattenSpunMolecule flips Y on output (math
  // y-up → document y-down), so a +θ screen rotation is a −θ rotation about the math-frame +Z.
  // The commit therefore folds quatFromAxisAngle(Z, −θ); reopening must reproduce the same
  // drawing the 2D rotate produced, or the next reopen/X-Y tilt jumps. This pins that sign.
  const bondAngle = (document: ChemDraftDocument, fromId: string, toId: string): number => {
    const atoms = moleculeOf(document).atoms;
    const from = atoms.find((atom) => atom.id === fromId)!;
    const to = atoms.find((atom) => atom.id === toId)!;
    return Math.atan2(to.y - from.y, to.x - from.x);
  };
  const angularGap = (a: number, b: number): number => {
    const diff = Math.abs(a - b) % (2 * Math.PI);
    return Math.min(diff, 2 * Math.PI - diff);
  };

  it("re-projecting at the folded (−θ) orientation matches the 2D-rotated drawing", () => {
    const THETA_DEG = 40;
    const theta = (THETA_DEG * Math.PI) / 180;
    const base = documentWith(molecule());

    // The committed Spin 3D drawing at identity, then the user's screen-Z 2D rotate of it.
    const committed = flattenSpunMolecule(base, "mol", CHAIN_COORDS3D, quatToViewMatrix(IDENTITY_QUAT));
    expect(committed.status).toBe("committed");
    const rotated = rotateDocumentObject(committed.document, "mol", THETA_DEG);

    // Reopen = re-project the conformer through the orientation the commit stores: the code
    // folds quatFromAxisAngle(Z, −θ) onto the (here identity) start orientation.
    const reopened = flattenSpunMolecule(base, "mol", CHAIN_COORDS3D, quatToViewMatrix(quatFromAxisAngle([0, 0, 1], -theta)));
    expect(reopened.status).toBe("committed");
    expect(angularGap(bondAngle(rotated, "a0", "a3"), bondAngle(reopened.document, "a0", "a3"))).toBeLessThan(0.02);

    // Teeth: the un-negated sign rotates the opposite way (~2θ off), proving the test bites.
    const wrongSign = flattenSpunMolecule(base, "mol", CHAIN_COORDS3D, quatToViewMatrix(quatFromAxisAngle([0, 0, 1], theta)));
    expect(angularGap(bondAngle(rotated, "a0", "a3"), bondAngle(wrongSign.document, "a0", "a3"))).toBeGreaterThan(0.1);
  });
});
