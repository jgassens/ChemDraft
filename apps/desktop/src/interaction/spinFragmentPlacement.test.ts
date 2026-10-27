import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatches, deserializeDocument, serializeDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, generate3DConformerProgressive as oclGenerate } from "@chemdraft/ocl-adapter";
import { ensureRdkit, generate3DConformerProgressive as rdkitGenerate, resetRdkitForTesting } from "../../../../packages/rdkit-adapter/src/conformer";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import * as OCL from "openchemlib";
import {
  attachSpin3dModelFromConformer, createPhase4Document, flattenNativeMolecule3d, flattenSpunMolecule,
  spin3dModelCoordsForMolecule, validSpin3dModelFor
} from "../documentWorkflow";
import { applySpinFragmentArrangement, computeSpinFragmentArrangement, placeSpinFragments, spinFragmentIndices } from "./spinFragmentPlacement";
import {
  conformerCentroid, initialViewQuaternion, orientedOverlayScale, overlayScale, projectSpin
} from "./spinOverlay";
import { quatFromAxisAngle, quatIdentity, quatMultiply, quatToViewMatrix, rotateVectorByQuat } from "./rotation3d";

type BondPair = readonly [number, number];

function sphere(coords: ArrayLike<number>, indices: number[]) {
  const center = conformerCentroid(indices.flatMap((index) => [coords[index * 3], coords[index * 3 + 1], coords[index * 3 + 2]]));
  const radius = Math.max(...indices.map((index) => Math.hypot(
    coords[index * 3] - center[0], coords[index * 3 + 1] - center[1], coords[index * 3 + 2] - center[2]
  )));
  return { center, radius };
}

function expectSeparated(coords: ArrayLike<number>, fragments: number[][]) {
  const spheres = fragments.map((indices) => sphere(coords, indices));
  for (let i = 0; i < spheres.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = spheres[i];
      const b = spheres[j];
      expect(Math.hypot(...a.center.map((value, axis) => value - b.center[axis]))).toBeGreaterThan(a.radius + b.radius);
    }
  }
}

describe("Spin fragment placement", () => {
  it("reuses crowded opening centres for different extents, correcting only overlapping pairs", () => {
    const points = [{ x: -20, y: 0 }, { x: 20, y: 0 }, { x: -19, y: 0 }, { x: 21, y: 0 }, { x: -18, y: 0 }, { x: 22, y: 0 }];
    const pairs: BondPair[] = [[0, 1], [2, 3], [4, 5]];
    const embedded = new Float64Array([-2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0]);
    const arrangement = computeSpinFragmentArrangement(points, embedded, pairs, quatIdentity())!;
    const fragments = spinFragmentIndices(points.length, pairs);
    const openingScale = overlayScale(points, embedded, pairs);
    const opening = applySpinFragmentArrangement(embedded, arrangement, openingScale);
    const smallerRaw = new Float64Array([-1, 0, 0, 1, 0, 0, -1.5, 0, 0, 1.5, 0, 0, -1, 0, 0, 1, 0, 0]);
    const smallerScale = overlayScale(points, smallerRaw, pairs);
    const smaller = applySpinFragmentArrangement(smallerRaw, arrangement, smallerScale);
    expectSeparated(opening, fragments);
    expectSeparated(smaller, fragments);
    fragments.forEach((indices) => sphere(smaller, indices).center.forEach((value, axis) =>
      expect(value * smallerScale).toBeCloseTo(sphere(opening, indices).center[axis] * openingScale, 12)));

    // Only the final sphere grows enough to overlap its neighbour. It moves outward by
    // precisely the overlap plus the documented floating-point clearance.
    const larger = applySpinFragmentArrangement(new Float64Array([-2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0, -8, 0, 0, 8, 0, 0]), arrangement, openingScale);
    expectSeparated(larger, fragments);
    const before = fragments.map((indices) => sphere(opening, indices).center);
    const after = fragments.map((indices) => sphere(larger, indices).center);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2][0] - before[2][0]).toBeCloseTo(2, 9);
    expect(after[2][1]).toBeCloseTo(before[2][1], 12);
  });

  it("escapes alternating overlap corrections with a bounded non-overlapping fallback", () => {
    // The last sphere cannot fit between the first two: pairwise correction alternates
    // forever between x = -1 and x = +1 on 02d521a7. A timeout cannot interrupt a
    // synchronous UI loop, so the fallback must return and put it beyond both spheres.
    const raw = new Float64Array([0, -1, 0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -3, 0, 0, 3, 0]);
    const fragments = [[0, 1], [2, 3], [4, 5]];
    const placed = applySpinFragmentArrangement(raw, {
      fragments: fragments.map((indices, i) => ({ indices, targetPage: [[-3, 0, 0], [3, 0, 0], [0, 0, 0]][i] as [number, number, number] }))
    }, 1);
    expectSeparated(placed, fragments);
    expect(sphere(placed, fragments[0]).center).toEqual([-3, 0, 0]);
    expect(sphere(placed, fragments[1]).center).toEqual([3, 0, 0]);
    expect(sphere(placed, fragments[2]).center[0]).toBeCloseTo(7, 9);
    expect(sphere(placed, fragments[2]).center.slice(1)).toEqual([0, 0]);
    fragments.forEach((indices) => expect(sphere(placed, indices).radius).toBe(sphere(raw, indices).radius));
    expect(raw).toEqual(new Float64Array([0, -1, 0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -3, 0, 0, 3, 0]));
  });
  it("leaves a connected conformer byte-identical, including its opening orientation", () => {
    const coords = new Float64Array([-0, 1.123456789, -2, 3, 4, 5, -6, 7, 8]);
    const bytes = new Uint8Array(coords.buffer).slice();
    const orientation = initialViewQuaternion(coords);
    expect(computeSpinFragmentArrangement([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }], coords, [[0, 1], [1, 2]], orientation)).toBeUndefined();
    expect(placeSpinFragments([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }], coords, [[0, 1], [1, 2]], orientation)).toBe(coords);
    expect(new Uint8Array(coords.buffer)).toEqual(bytes);
    expect(initialViewQuaternion(coords)).toEqual(orientation);
  });

  it("expands crowded centres uniformly, preserving left/right and vertical arrangement", () => {
    const coords = new Float64Array([-2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0]);
    const points = [{ x: -20, y: 0 }, { x: 20, y: 0 }, { x: -19, y: 1 }, { x: 21, y: 1 }, { x: -18, y: -1 }, { x: 22, y: -1 }];
    const pairs: BondPair[] = [[0, 1], [2, 3], [4, 5]];
    const placed = placeSpinFragments(points, coords, pairs, quatIdentity());
    const fragments = spinFragmentIndices(points.length, pairs);
    expectSeparated(placed, fragments);
    const centers = fragments.map((indices) => sphere(placed, indices).center);
    expect(centers[0][0]).toBeLessThan(centers[1][0]);
    expect(centers[1][0]).toBeLessThan(centers[2][0]);
    expect(centers[1][1]).toBeLessThan(centers[0][1]);
    expect(centers[2][1]).toBeGreaterThan(centers[0][1]);
    expect(coords).toEqual(new Float64Array([-2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0, -2, 0, 0, 2, 0, 0]));
  });

  it("keeps well-separated fragment centroids exactly at their drawn positions in the opening view", () => {
    const points = [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 210, y: 80 }, { x: 230, y: 80 }];
    const coords = new Float64Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0]);
    const pairs: BondPair[] = [[0, 1], [2, 3]];
    const opening = quatFromAxisAngle([1, 2, 3], 0.7);
    const placed = placeSpinFragments(points, coords, pairs, opening);
    const projection = projectSpin(placed, pairs, opening, { centerX: 120, centerY: 50, scale: 20 });
    expect((projection.atoms[0].sx + projection.atoms[1].sx) / 2).toBeCloseTo(20, 10);
    expect((projection.atoms[0].sy + projection.atoms[1].sy) / 2).toBeCloseTo(20, 10);
    expect((projection.atoms[2].sx + projection.atoms[3].sx) / 2).toBeCloseTo(220, 10);
    expect((projection.atoms[2].sy + projection.atoms[3].sy) / 2).toBeCloseTo(80, 10);
  });

  it("separates isolated atoms even when drawn centroids coincide", () => {
    const placed = placeSpinFragments(Array.from({ length: 3 }, () => ({ x: 10, y: 10 })), new Float64Array(9), [], quatIdentity());
    expectSeparated(placed, [[0], [1], [2]]);
    expect(Array.from(placed).every(Number.isFinite)).toBe(true);
  });
});

beforeAll(async () => {
  installNodeRdkitModuleLoader();
  await ensureOclResources();
});
afterAll(() => resetRdkitForTesting());

function fixture(smiles: string) {
  const depiction = depictSmiles2D(smiles);
  const mol: MoleculeObject = {
    id: "multi", type: "molecule", x: 0, y: 0, width: 400, height: 100, rotation: 0, style: {},
    structureFormat: "molfile-v2000", structure: depiction.molfile, superatoms: [], rGroups: [],
    atoms: depiction.atoms.map((atom, i) => ({ id: `a${i}`, element: atom.element, formalCharge: atom.charge, x: 100 + atom.x * 20, y: 200 - atom.y * 20 })),
    bonds: depiction.bonds.map((bond, i) => ({ id: `b${i}`, fromAtomId: `a${bond.from}`, toAtomId: `a${bond.to}`, order: bond.order }))
  };
  return { mol, pairs: depiction.bonds.map((bond) => [bond.from, bond.to] as const), molfile: depiction.molfile };
}

async function canonicalSmiles(molfile: string) {
  const rdkit = await ensureRdkit();
  const molecule = rdkit.get_mol(molfile);
  if (!molecule?.get_smiles) throw new Error("RDKit cannot read fixture chemistry");
  try { return molecule.get_smiles(); }
  finally { molecule.delete(); }
}

for (const [engine, generate] of [["RDKit", rdkitGenerate], ["OCL fallback", oclGenerate]] as const) {
  describe(`${engine} disconnected conformer → overlay → flatten → reopen`, () => {
    it.each(["c1ccccc1", "CC(C)(C)C", "OCCO"])("keeps the single-fragment %s result byte-identical", async (smiles) => {
      const { mol, pairs, molfile } = fixture(smiles);
      const { embedded } = await generate({ molfile, originalAtomCount: mol.atoms.length }, { optimize: "none" });
      expect(embedded.embed.status).toBe("ok");
      const raw = embedded.mapping.coords3dByOriginalAtom;
      const orientation = initialViewQuaternion(raw);
      const placed = placeSpinFragments(mol.atoms, raw, pairs, orientation);
      expect(placed).toBe(raw);
      expect(new Uint8Array(placed.buffer)).toEqual(new Uint8Array(raw.buffer));
      expect(initialViewQuaternion(placed)).toEqual(orientation);
      const original = flattenNativeMolecule3d(mol, raw, quatToViewMatrix(orientation));
      expect(original.status).toBe("committed");
      expect(flattenNativeMolecule3d(mol, placed, quatToViewMatrix(orientation))).toEqual(original);
    });

    it("keeps benzene, neopentane and glycol apart without changing chemistry", async () => {
      const { mol, pairs, molfile } = fixture("c1ccccc1.CC(C)(C)C.OCCO");
      const fragments = spinFragmentIndices(mol.atoms.length, pairs);
      expect(fragments.map((indices) => indices.length).sort()).toEqual([4, 5, 6]);
      const result = await generate({ molfile, originalAtomCount: mol.atoms.length }, { optimize: "auto", maxMinimiseIterations: 40 });
      expect(result.embedded.embed.status).toBe("ok");
      const opening = initialViewQuaternion(result.embedded.mapping.coords3dByOriginalAtom);
      const arrangement = computeSpinFragmentArrangement(mol.atoms, result.embedded.mapping.coords3dByOriginalAtom, pairs, opening)!;
      const refined = result.refineFromEmbedded?.(40);
      expect(refined).toBeDefined();
      for (const stage of [result.embedded, refined!]) {
        const raw = stage.mapping.coords3dByOriginalAtom;
        const placed = applySpinFragmentArrangement(raw, arrangement, overlayScale(mol.atoms, raw, pairs));
        expectSeparated(placed, fragments);
        for (const axis of [[1, 0, 0], [0, 1, 0], [1, 2, 3]] as const) {
          const rotation = quatFromAxisAngle(axis, 1.2);
          const rotatedCoords = Array.from({ length: mol.atoms.length }, (_, i) =>
            rotateVectorByQuat(rotation, [placed[i * 3], placed[i * 3 + 1], placed[i * 3 + 2]])).flat();
          expectSeparated(rotatedCoords, fragments);
        }
        // Translation preserves every intrafragment distance (and therefore shape/handedness).
        for (const indices of fragments) {
          for (const a of indices) for (const b of indices) {
            const distance = (coords: Float64Array) => Math.hypot(...[0, 1, 2].map((axis) => coords[a * 3 + axis] - coords[b * 3 + axis]));
            expect(distance(placed)).toBeCloseTo(distance(raw), 12);
          }
          expect(rotateVectorByQuat(opening, sphere(placed, indices).center)[2]).toBeCloseTo(0, 12);
        }
        const placement = {
          centerX: mol.atoms.reduce((sum, atom) => sum + atom.x, 0) / mol.atoms.length,
          centerY: mol.atoms.reduce((sum, atom) => sum + atom.y, 0) / mol.atoms.length,
          scale: overlayScale(mol.atoms, raw, pairs)
        };
        const projection = projectSpin(placed, pairs, opening, placement);
        expectSeparated(projection.atoms.flatMap((atom) => [atom.sx, atom.sy, 0]), fragments);
        // Every pair retains both axes of the drawn centroid arrangement.
        for (let i = 0; i < fragments.length; i++) for (let j = 0; j < i; j++) {
          for (const axis of ["x", "y"] as const) {
            const drawnCenter = (indices: number[]) => indices.reduce((sum, index) => sum + mol.atoms[index][axis], 0) / indices.length;
            const projectedCenter = (indices: number[]) => indices.reduce((sum, index) => sum + projection.atoms[index][axis === "x" ? "sx" : "sy"], 0) / indices.length;
            const delta = drawnCenter(fragments[i]) - drawnCenter(fragments[j]);
            if (Math.abs(delta) > 1e-8) expect(Math.sign(projectedCenter(fragments[i]) - projectedCenter(fragments[j]))).toBe(Math.sign(delta));
          }
        }
        const base = createPhase4Document("Multi-fragment spin");
        const document = applyPatches(base, [{ op: "addObject", pageId: base.pages[0].id, object: mol }]);
        // A real drag changes the view, while separated 3D bounding spheres stay apart.
        const rotated = quatMultiply(quatFromAxisAngle([0, 0, 1], 0.2), opening);
        const outcome = flattenSpunMolecule(document, mol.id, placed, quatToViewMatrix(rotated), { placement });
        expect(outcome.status).toBe("committed");
        const attached = attachSpin3dModelFromConformer(outcome.document, mol.id, { coords3d: placed, orientation: rotated });
        const saved = deserializeDocument(serializeDocument(attached));
        const next = saved.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
        expect(next.atoms.map(({ x: _x, y: _y, ...atom }) => atom)).toEqual(mol.atoms.map(({ x: _x, y: _y, ...atom }) => atom));
        expect(next.bonds.map(({ display: _display, ...bond }) => bond)).toEqual(mol.bonds);
        expect(OCL.Molecule.fromMolfile(next.structure).getIDCode()).toBe(OCL.Molecule.fromMolfile(molfile).getIDCode());
        expect(await canonicalSmiles(next.structure)).toBe(await canonicalSmiles(molfile));
        expectSeparated(next.atoms.flatMap((atom) => [atom.x, atom.y, 0]), fragments);
        const model = validSpin3dModelFor(next)!;
        const reopened = spin3dModelCoordsForMolecule(model, next)!;
        expect(reopened).toEqual(placed);
        expectSeparated(reopened, fragments);
        const reopenedProjection = projectSpin(reopened, pairs, model.orientation, {
          centerX: next.atoms.reduce((sum, atom) => sum + atom.x, 0) / next.atoms.length,
          centerY: next.atoms.reduce((sum, atom) => sum + atom.y, 0) / next.atoms.length,
          scale: orientedOverlayScale(next.atoms, reopened, pairs, quatToViewMatrix(model.orientation))
        });
        next.atoms.forEach((atom, i) => {
          expect(reopenedProjection.atoms[i].sx).toBeCloseTo(atom.x, 8);
          expect(reopenedProjection.atoms[i].sy).toBeCloseTo(atom.y, 8);
        });
      }
    }, 30000);
  });
}
