// 1.2.3 release blocker: fresh aspirin, a '-' mark on the carboxylate O, Spin 3D. The circled minus
// was drawn beside the ester O as soon as the spin opened (before any drag), stayed wrong through the
// drag, the flatten, a transparent export and a save + reopen, while Copy As SMILES still read
// ...C(=O)[O-] and dragging the carboxylate O still pulled the mark: the binding was right, the
// stored offset was stale. Every path carried the mark by its atom's move alone, keeping its 2D
// offset, and the spin's projection rearranges the atoms around it: the charge tool places the mark
// 22.000 px from the carboxylate O and 22.001 px from the ester O, so a kept offset lands beside
// another atom (or on a bond) in many views, the opening one included. 3D clean-up did not carry
// marks at all.
//
// The shared rule (layout-engine carryElectronMarksToRedrawnMolecule): a mark keeps its 2D offset
// from its atom unless that spot lands on another atom or a bond; then it turns about its atom, at
// the same distance, to the nearest free side. Chemistry never changes. The overlay, flatten,
// release, reopen, typed rotations, Interactive 3D and 3D clean-up all use that one rule.
//
// Conformers (seeded RDKit embeds of the plain skeleton): on ca73ce95f the OPENING projection of each
// put the kept offset of the '-' beside another atom: MMFF seed 23 beside the ester O (the reported
// repro), seed 42 (the first drag repro) beside a ring carbon, seed 21 and MMFF seed 16 almost on top
// of a ring carbon, seed 28 beside the carbonyl O.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatch, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeGeometryFromAtoms, nativeElectronMarkAssignments, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import {
  carriedMarkLabelDepth, electronMarkInkRadius, moleculeLayoutLabelBoxes, planMoleculeAtomLabels, planPageSvgRender,
  transformPointForObject
} from "@chemdraft/layout-engine";
import { depictSmiles2D, ensureOclResources, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { ensureRdkit, rdkitConformerGenerator } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
// Namespace import: a build without the shared placement still runs every other test here.
import * as workflow from "./documentWorkflow";
import {
  analysisFacingStructure, applyChargeToolAtNativeAtom, applyNativeMoleculeEngineRelayout, assertSpin3dDocumentIdentity,
  attachSpin3dModelFromConformer, createNativeSavePayload, createPhase4Document, flattenSpunMolecule,
  insertNativeMolfileMolecule, normalizeCommittedDocument, openNativeDocument, rotateDocumentObject,
  spin3dModelCoordsForMolecule, validSpin3dModelFor, type NativeElectronMarkSpec
} from "./documentWorkflow";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";
import {
  applyTrackballDrag, quatFromAxisAngle, quatMultiply, quatNormalize, quatToViewMatrix, type Quaternion
} from "./interaction/rotation3d";
import { initialViewQuaternion, orientedOverlayScale, overlayScale, projectSpin, type ScreenPlacement } from "./interaction/spinOverlay";
import { Spin3dStereoReference } from "./interaction/spin3dStereo";

const aspirin = "CC(=O)Oc1ccccc1C(=O)O";

/** Every kind of mark a molecule owns, placed on the carboxylate O the way the hover keys place them. */
const markKinds: ReadonlyArray<[string, NativeElectronMarkSpec]> = [
  ["charge", { kind: "charge", charge: -1 }],
  ["radical ion", { kind: "charge", charge: -1, radical: true }],
  ["radical", { kind: "radical-dot" }],
  ["lone pair", { kind: "lone-pair" }]
];

type Conformer = { seed: number; optimize: "none" | "mmff94s" };
const dragRepro: Conformer = { seed: 42, optimize: "none" };
/** The reported repro: on ca73ce95f this embed's opening view put the '-' beside the ester O. */
const esterRepro: Conformer = { seed: 23, optimize: "mmff94s" };
const conformers: readonly Conformer[] = [
  dragRepro, esterRepro, { seed: 21, optimize: "none" }, { seed: 16, optimize: "mmff94s" }, { seed: 28, optimize: "none" }
];
const label = (conformer: Conformer) => `seed ${conformer.seed}/${conformer.optimize}`;

/** Drags of the size a user makes on the overlay (page px from the molecule's centre). */
const drags: ReadonlyArray<readonly [number, number]> = [[-60, 0], [-90, 0], [-120, 0], [90, -40], [-90, -40], [60, 60], [0, -90]];

let rdkit: Awaited<ReturnType<typeof ensureRdkit>>;
afterAll(() => {
  // Views too crowded for any free side (checked for distance and chemistry only), for the record.
  if (crowdedViews.length) console.info(`spinCarriedMarks: ${crowdedViews.length} crowded view(s): ${crowdedViews.join("; ")}`);
});
beforeAll(async () => {
  installRealRdkitModuleLoader();
  rdkit = await ensureRdkit();
  await ensureOclResources();
});

function moleculeOf(document: ChemDraftDocument): MoleculeObject {
  return document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
}

function markOf(document: ChemDraftDocument): ElectronMarkObject {
  return document.pages[0].objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
}

function centerOf(mark: Pick<ElectronMarkObject, "x" | "y" | "width" | "height">) {
  return { x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 };
}

function segmentDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

/** Aspirin as the in-page paste lays it out, with `spec` placed on the carboxylate O, and a seeded conformer. */
async function aspirinWithMark(spec: NativeElectronMarkSpec, conformer: Conformer = dragRepro) {
  const plain = insertNativeMolfileMolecule(createPhase4Document("Spin marks"), { x: 300, y: 300 },
    depictSmiles2D(aspirin).molfile, "molfile-v2000");
  const molecule = moleculeOf(plain);
  // The carboxylate O: the last atom of this SMILES, singly bonded once.
  const acidOxygen = molecule.atoms[molecule.atoms.length - 1]!;
  expect(acidOxygen.element).toBe("O");
  // Committed as the app commits it: normalization reconciles the atom's charge with the mark.
  const document = normalizeCommittedDocument(
    applyChargeToolAtNativeAtom(plain, spec, { kind: "atom", objectId: molecule.id, atomId: acidOxygen.id, distanceToPointer: 0 }));
  const mark = markOf(document);
  expect(mark, "the mark was placed").toBeDefined();
  // One seeded conformer of the plain skeleton serves every mark kind (RDKit will not embed O•−):
  // flatten reads only geometry from it, and the atoms are the same in the same order.
  const coords3d = (await rdkitConformerGenerator.generate3DConformer(
    { molfile: analysisFacingStructure(molecule).structure }, conformer
  )).mapping.coords3dByOriginalAtom.slice(0, molecule.atoms.length * 3);
  expect(coords3d).toHaveLength(molecule.atoms.length * 3);
  const charged = moleculeOf(document);
  const bondPairs = charged.bonds.map(bond => [
    charged.atoms.findIndex(atom => atom.id === bond.fromAtomId), charged.atoms.findIndex(atom => atom.id === bond.toAtomId)
  ] as [number, number]);
  // The placement Spin 3D opens a fresh embed with (MainWindow spinPlacementFor).
  const centerX = charged.atoms.reduce((sum, atom) => sum + atom.x, 0) / charged.atoms.length;
  const centerY = charged.atoms.reduce((sum, atom) => sum + atom.y, 0) / charged.atoms.length;
  const placement: ScreenPlacement = { centerX, centerY, scale: overlayScale(charged.atoms, coords3d, bondPairs) };
  const drawnAtom = charged.atoms.find(atom => atom.id === acidOxygen.id)!;
  const drawnDistance = Math.hypot(centerOf(mark).x - drawnAtom.x, centerOf(mark).y - drawnAtom.y);
  return {
    document, molecule: charged, acidOxygen: drawnAtom, mark, coords3d, placement, bondPairs, drawnDistance,
    open: initialViewQuaternion(coords3d), chemistry: chemistryOf(document)
  };
}

type Session = Awaited<ReturnType<typeof aspirinWithMark>>;

/** Canonical SMILES and formula. Sanitized topology inspection where RDKit accepts the structure; RDKit
 * refuses to sanitize a singly bonded O•− (radical anion), so that one is read unsanitized, with RDKit's
 * own per-atom charge and radical facts standing in for the formula it cannot compute. */
function identityOf(molecule: MoleculeObject) {
  const molfile = stereoPerceptionMolfile(molecule);
  const identity = inspectStructureInWorker(rdkit, molfile, undefined, "topology");
  if (identity.valid) return { canonicalSmiles: identity.canonicalSmiles, formula: identity.formula };
  const raw = rdkit.get_mol(molfile, JSON.stringify({ sanitize: false, removeHs: false }));
  if (!raw) throw new Error(identity.reason);
  try {
    if (!raw.get_json || !raw.get_smiles) throw new Error("RDKit structure reading is unavailable.");
    const atoms = (JSON.parse(raw.get_json()) as { molecules: { atoms: { z?: number; chg?: number; nRad?: number }[] }[] }).molecules[0]!.atoms;
    return { canonicalSmiles: raw.get_smiles(), formula: JSON.stringify(atoms.map(atom => [atom.z ?? 6, atom.chg ?? 0, atom.nRad ?? 0])) };
  } finally {
    raw.delete();
  }
}

/** Everything a carry must never change: the mark's anchor, owner and value, the atoms' charges and
 * radicals, and the molecule's canonical SMILES and formula (and the formula the document stores). */
function chemistryOf(document: ChemDraftDocument) {
  const molecule = moleculeOf(document);
  const mark = markOf(document);
  const identity = identityOf(molecule);
  expect(identity.canonicalSmiles).toBeTruthy();
  return {
    anchor: mark.anchor,
    owner: nativeElectronMarkAssignments(document.pages[0]).anchorByMarkId.get(mark.id),
    mark: { markKind: mark.markKind, charge: mark.charge, radical: mark.radical },
    atoms: molecule.atoms.map(atom => ({ id: atom.id, element: atom.element, formalCharge: atom.formalCharge, markRadicals: atom.markRadicals ?? 0 })),
    storedFormula: molecule.chemistry?.formula,
    canonicalSmiles: identity.canonicalSmiles,
    formula: identity.formula
  };
}

function expectChemistryKept(session: Pick<Session, "chemistry">, document: ChemDraftDocument, label: string) {
  const after = chemistryOf(document);
  expect(after.canonicalSmiles, `${label}: canonical SMILES`).toBe(session.chemistry.canonicalSmiles);
  expect(after.formula, `${label}: formula`).toBe(session.chemistry.formula);
  expect(after, `${label}: chemistry`).toEqual(session.chemistry);
}

/** Views where no side of the mark's atom, at its drawn distance, is clearly free (see `expectBeside`). */
const crowdedViews: string[] = [];

/**
 * The repro's acceptance, for any drawing of the molecule: the mark is as far from ITS atom as it was
 * drawn, nearer it than any other atom, and off every bond line. Checked independently of the rule:
 * if any side (sampled every degree) is clearly free — every other atom 5% farther, every bond line
 * 1 px beyond the mark's ink — the mark must be on a free side. A projection that piles other atoms
 * all round the atom leaves no such side; there only the distance is checked, and the view is
 * recorded in `crowdedViews` so a test can require that its views are not crowded.
 */
function expectBeside(
  atoms: readonly { id: string; x: number; y: number }[], bonds: readonly { fromAtomId: string; toAtomId: string }[],
  mark: Pick<ElectronMarkObject, "x" | "y" | "width" | "height">, atomId: string, drawnDistance: number, label: string
) {
  const center = centerOf(mark);
  const own = atoms.find(atom => atom.id === atomId)!;
  expect(Math.hypot(center.x - own.x, center.y - own.y), `${label}: distance from its atom`).toBeCloseTo(drawnDistance, 6);
  const byId = new Map(atoms.map(atom => [atom.id, atom]));
  const ink = Math.min(mark.width, mark.height) * 0.35;
  const nearestOther = (point: { x: number; y: number }) => Math.min(...atoms.filter(atom => atom.id !== atomId)
    .map(atom => Math.hypot(atom.x - point.x, atom.y - point.y)));
  const nearestBond = (point: { x: number; y: number }) => Math.min(...bonds.map(bond =>
    segmentDistance(point, byId.get(bond.fromAtomId)!, byId.get(bond.toAtomId)!)));
  const clearlyFree = Array.from({ length: 360 }, (_, degree) => ({
    x: own.x + Math.cos(degree * Math.PI / 180) * drawnDistance, y: own.y + Math.sin(degree * Math.PI / 180) * drawnDistance
  })).some(point => nearestOther(point) >= drawnDistance * 1.05 && nearestBond(point) >= ink + 2);
  if (!clearlyFree) {
    crowdedViews.push(label);
    return;
  }
  expect(nearestOther(center), `${label}: another atom is nearer the mark than its own`).toBeGreaterThanOrEqual(drawnDistance - 1e-9);
  expect(nearestBond(center), `${label}: the mark sits on a bond`).toBeGreaterThan(ink);
}

function expectMarkOnItsAtom(session: Session, document: ChemDraftDocument, label: string) {
  const molecule = moleculeOf(document);
  const mark = markOf(document);
  expect(mark.anchor, label).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: session.acidOxygen.id });
  expectBeside(molecule.atoms, molecule.bonds as never, mark, session.acidOxygen.id, session.drawnDistance, label);
}

/** The orientation a drag of (dx, dy) page px from the opening view gives (the overlay's trackball). */
function dragged(session: Session, dx: number, dy: number): Quaternion {
  const { centerX: x, centerY: y } = session.placement;
  return applyTrackballDrag(session.open, { x, y }, { x: x + dx, y: y + dy }, { center: { x, y }, radius: 240 });
}

/** Click outside: flatten, attach the model and normalize, exactly as commitSpinFlatten commits. */
function flattenAt(session: Session, quat: Quaternion, coords3d: ArrayLike<number> = session.coords3d, source = session.document,
  placement = session.placement) {
  const outcome = flattenSpunMolecule(source, session.molecule.id, coords3d, quatToViewMatrix(quat), { placement });
  expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
  return normalizeCommittedDocument(attachSpin3dModelFromConformer(outcome.document, session.molecule.id, {
    coords3d: outcome.depictionCoords3d ?? coords3d, orientation: quat
  }));
}

/** What SpinOverlay paints each frame: the projected atoms, and the placement of the mark for them that
 * MainWindow's overlay asks for (`spinOverlayCarriedMarkPlacements`, the frame flatten commits in). */
function liveOverlay(session: Pick<Session, "document" | "molecule" | "mark" | "bondPairs" | "placement" | "coords3d">,
  quat: Quaternion, coords3d: ArrayLike<number> = session.coords3d) {
  const projection = projectSpin(coords3d, session.bondPairs, quat, session.placement);
  const atoms = session.molecule.atoms.map((atom, index) => ({ ...atom, x: projection.atoms[index]!.sx, y: projection.atoms[index]!.sy }));
  expect(typeof workflow.spinOverlayCarriedMarkPlacements, "the overlay's shared mark placement").toBe("function");
  const placed = workflow.spinOverlayCarriedMarkPlacements(session.document.pages[0], session.molecule, atoms).get(session.mark.id)!;
  expect(placed, "the overlay carries the mark").toBeDefined();
  return { atoms, placement: { ...placed, width: session.mark.width, height: session.mark.height } };
}

/** The overlay painted the mark where flatten committed it, relative to its atom (flatten may clamp into the page). */
function expectOverlayMatchesCommit(session: Session, live: ReturnType<typeof liveOverlay>, committed: ChemDraftDocument, label: string) {
  const mark = markOf(committed);
  const atom = moleculeOf(committed).atoms.find(candidate => candidate.id === session.acidOxygen.id)!;
  const liveAtom = live.atoms.find(candidate => candidate.id === session.acidOxygen.id)!;
  expect(mark.x - atom.x, `${label}: x offset`).toBeCloseTo(live.placement.x - liveAtom.x, 6);
  expect(mark.y - atom.y, `${label}: y offset`).toBeCloseTo(live.placement.y - liveAtom.y, 6);
  expect(mark.rotation, `${label}: rotation`).toBeCloseTo(live.placement.rotation, 6);
}

describe("Spin 3D opens with each mark beside its own atom (before any drag)", () => {
  it.each(markKinds)("a %s: the opening projection's overlay and an immediate click-outside", async (_kind, spec) => {
    const crowdedBefore = crowdedViews.length;
    for (const conformer of conformers) {
      const session = await aspirinWithMark(spec, conformer);
      const flattened = flattenAt(session, session.open);
      expectMarkOnItsAtom(session, flattened, `${label(conformer)} flattened at the opening view`);
      expectChemistryKept(session, flattened, label(conformer));
      const live = liveOverlay(session, session.open);
      expectBeside(live.atoms, session.molecule.bonds, live.placement, session.acidOxygen.id, session.drawnDistance,
        `${label(conformer)} overlay at the opening view`);
      expectOverlayMatchesCommit(session, live, flattened, label(conformer));
    }
    // Every opening view here has a free side, so each check above was the full one.
    expect(crowdedViews.slice(crowdedBefore)).toEqual([]);
  });
});

describe("Spin 3D keeps a molecule's marks on their atoms through a drag (aspirin, mark on the carboxylate O)", () => {
  it("repro: the '-' stays beside the carboxylate O after a drag-sized turn and click-outside flatten", async () => {
    const crowdedBefore = crowdedViews.length;
    for (const conformer of conformers) {
      const session = await aspirinWithMark({ kind: "charge", charge: -1 }, conformer);
      for (const [dx, dy] of drags) {
        const flattened = flattenAt(session, dragged(session, dx, dy));
        expectMarkOnItsAtom(session, flattened, `${label(conformer)} drag ${dx},${dy}`);
        expectChemistryKept(session, flattened, `${label(conformer)} drag ${dx},${dy}`);
      }
    }
    expect(crowdedViews.slice(crowdedBefore)).toEqual([]);
  });

  it.each(markKinds)("a %s on the carboxylate O follows it through every drag, chemistry unchanged", async (_kind, spec) => {
    for (const conformer of [dragRepro, esterRepro]) {
      const session = await aspirinWithMark(spec, conformer);
      for (const [dx, dy] of drags) {
        const flattened = flattenAt(session, dragged(session, dx, dy));
        expectMarkOnItsAtom(session, flattened, `${label(conformer)} drag ${dx},${dy}`);
        expectChemistryKept(session, flattened, `${label(conformer)} drag ${dx},${dy}`);
      }
    }
  });

  it.each(markKinds)("the live overlay paints a %s beside its atom, where flatten commits it, every frame", async (_kind, spec) => {
    for (const conformer of [dragRepro, esterRepro]) {
      const session = await aspirinWithMark(spec, conformer);
      for (const [dx, dy] of drags) {
        const quat = dragged(session, dx, dy);
        const live = liveOverlay(session, quat);
        expectBeside(live.atoms, session.molecule.bonds, live.placement, session.acidOxygen.id, session.drawnDistance,
          `${label(conformer)} overlay drag ${dx},${dy}`);
        expectOverlayMatchesCommit(session, live, flattenAt(session, quat), `${label(conformer)} drag ${dx},${dy}`);
      }
    }
  });
});

describe("a flattened mark stays beside its atom once saved and reopened", () => {
  it.each(markKinds)("a %s: save the flattened drawing, open the file, and it is where flatten put it", async (_kind, spec) => {
    for (const conformer of [esterRepro, dragRepro]) {
      const session = await aspirinWithMark(spec, conformer);
      for (const quat of [session.open, dragged(session, -90, -40)]) {
        const flattened = flattenAt(session, quat);
        const opened = openNativeDocument(createNativeSavePayload(flattened).contents);
        expect(opened.document, opened.warnings.map(warning => warning.message).join("; ")).toBeDefined();
        const reopened = normalizeCommittedDocument(opened.document!);
        expectMarkOnItsAtom(session, reopened, `${label(conformer)} reopened`);
        expectChemistryKept(session, reopened, `${label(conformer)} reopened`);
        const before = markOf(flattened), after = markOf(reopened);
        expect([after.x, after.y, after.rotation]).toEqual([before.x, before.y, before.rotation]);
      }
    }
  });

  it.each(markKinds)("reopening the stored model of a spun %s and flattening it again leaves it where it was", async (_kind, spec) => {
    const session = await aspirinWithMark(spec, esterRepro);
    const spun = flattenAt(session, dragged(session, -90, -40));
    // Reopen: the stored model at its committed orientation, placed as MainWindow spinPlacementFor does.
    const reopened = moleculeOf(spun);
    const model = validSpin3dModelFor(reopened)!;
    const coords3d = spin3dModelCoordsForMolecule(model, reopened)!;
    const points = reopened.atoms.map(atom => ({ x: atom.x, y: atom.y }));
    const placement: ScreenPlacement = {
      centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      scale: orientedOverlayScale(points, coords3d, session.bondPairs, quatToViewMatrix(model.orientation))
    };
    const again = flattenAt({ ...session, molecule: reopened }, model.orientation, coords3d, spun, placement);
    const before = markOf(spun), after = markOf(again);
    const atomBefore = reopened.atoms.find(atom => atom.id === session.acidOxygen.id)!;
    const atomAfter = moleculeOf(again).atoms.find(atom => atom.id === session.acidOxygen.id)!;
    expect(after.x - atomAfter.x).toBeCloseTo(before.x - atomBefore.x, 6);
    expect(after.y - atomAfter.y).toBeCloseTo(before.y - atomBefore.y, 6);
    expect(after.rotation).toBeCloseTo(before.rotation, 6);
    expectChemistryKept(session, again, "re-flattened");
  });
});

/** MainWindow rotateSpin3dXY: X/Y rotation of a stored model, composed onto its orientation. */
function rotateXY(orientation: Quaternion, xDegrees: number, yDegrees: number): Quaternion {
  const toRad = Math.PI / 180;
  return quatNormalize(quatMultiply(
    quatMultiply(quatFromAxisAngle([0, 1, 0], yDegrees * toRad), quatFromAxisAngle([1, 0, 0], xDegrees * toRad)), orientation));
}

describe("typed X/Y/Z rotation of a stored 3D model carries the marks", () => {
  const typed: ReadonlyArray<readonly [number, number]> = [[60, 0], [120, 0], [180, 0], [0, 60], [0, 120], [0, 180], [45, 45], [-60, 30]];

  it.each(markKinds)("a %s stays beside its atom for every typed X/Y angle", async (_kind, spec) => {
    for (const conformer of [dragRepro, esterRepro]) {
      const session = await aspirinWithMark(spec, conformer);
      // A molecule spun once and released at its opening view: its stored model reopens there.
      const modeled = flattenAt(session, session.open);
      const molecule = moleculeOf(modeled);
      const model = validSpin3dModelFor(molecule)!;
      const coords3d = spin3dModelCoordsForMolecule(model, molecule)!;
      const points = molecule.atoms.map(atom => ({ x: atom.x, y: atom.y }));
      // The numeric X/Y entry (MainWindow): spinPlacementFor at the stored orientation, then flatten.
      const placement: ScreenPlacement = {
        centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
        scale: orientedOverlayScale(points, coords3d, session.bondPairs, quatToViewMatrix(model.orientation))
      };
      // The app's guard. RDKit cannot sanitize a singly bonded O•−, so the app refuses to rotate that
      // one ("couldn't verify"); its carry is still checked here, without the guard.
      let stereo: Spin3dStereoReference | undefined;
      try {
        stereo = new Spin3dStereoReference(rdkit, molecule);
      } catch (error) {
        expect(spec, String(error)).toMatchObject({ kind: "charge", radical: true });
      }
      for (const [x, y] of typed) {
        const turned = rotateXY(model.orientation, x, y);
        const outcome = flattenSpunMolecule(modeled, molecule.id, coords3d, quatToViewMatrix(turned), { placement, stereoReference: stereo });
        expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
        const rotated = normalizeCommittedDocument(attachSpin3dModelFromConformer(outcome.document, molecule.id, {
          coords3d: outcome.depictionCoords3d ?? coords3d, orientation: turned
        }));
        if (stereo) expect(() => assertSpin3dDocumentIdentity(modeled, rotated, stereo)).not.toThrow();
        expectMarkOnItsAtom(session, rotated, `${label(conformer)} X${x} Y${y}`);
        expectChemistryKept(session, rotated, `${label(conformer)} X${x} Y${y}`);
      }
    }
  });

  it.each(markKinds)("a typed Z rotation turns a %s rigidly with its molecule", async (_kind, spec) => {
    const session = await aspirinWithMark(spec, esterRepro);
    const modeled = flattenAt(session, session.open);
    const atomBefore = moleculeOf(modeled).atoms.find(atom => atom.id === session.acidOxygen.id)!;
    const markBefore = markOf(modeled);
    for (const degrees of [30, 90, 180, -135]) {
      const rotated = normalizeCommittedDocument(rotateDocumentObject(modeled, session.molecule.id, degrees));
      const atom = moleculeOf(rotated).atoms.find(candidate => candidate.id === session.acidOxygen.id)!;
      const mark = markOf(rotated);
      const turn = degrees * Math.PI / 180;
      const offset = { x: centerOf(markBefore).x - atomBefore.x, y: centerOf(markBefore).y - atomBefore.y };
      expect(centerOf(mark).x - atom.x, `Z${degrees}`).toBeCloseTo(offset.x * Math.cos(turn) - offset.y * Math.sin(turn), 6);
      expect(centerOf(mark).y - atom.y, `Z${degrees}`).toBeCloseTo(offset.x * Math.sin(turn) + offset.y * Math.cos(turn), 6);
      expect(mark.anchor).toEqual(markBefore.anchor);
      expectChemistryKept(session, rotated, `Z${degrees}`);
    }
  });
});

describe("Interactive 3D carries the marks", () => {
  it.each(markKinds)("a tug, the live overlay and the flatten keep a %s beside its atom", async (_kind, spec) => {
    for (const conformer of [dragRepro, esterRepro]) {
      const session = await aspirinWithMark(spec, conformer);
      // A tug moves one atom of the conformer (here the carboxylate O itself, toward the ester).
      const pulled = Float64Array.from(session.coords3d);
      const index = session.molecule.atoms.findIndex(atom => atom.id === session.acidOxygen.id);
      pulled[index * 3] += 0.3;
      pulled[index * 3 + 1] += 0.2;
      for (const quat of [session.open, dragged(session, -90, 0)]) {
        // The overlay paints the tugged preview coordinates; release flattens the same coordinates.
        const live = liveOverlay(session, quat, pulled);
        expectBeside(live.atoms, session.molecule.bonds, live.placement, session.acidOxygen.id, session.drawnDistance, `${label(conformer)} tug overlay`);
        const flattened = flattenAt(session, quat, pulled);
        expectMarkOnItsAtom(session, flattened, `${label(conformer)} tug flatten`);
        expectOverlayMatchesCommit(session, live, flattened, `${label(conformer)} tug`);
        expectChemistryKept(session, flattened, `${label(conformer)} tug`);
      }
    }
  });
});

describe("the identity check holds the commit to the shared placement", () => {
  it("accepts the free-side placement and refuses a mark left behind", async () => {
    const session = await aspirinWithMark({ kind: "charge", charge: -1 }, esterRepro);
    const stereo = new Spin3dStereoReference(rdkit, session.molecule);
    const flattened = flattenAt(session, session.open);
    expect(() => assertSpin3dDocumentIdentity(session.document, flattened, stereo)).not.toThrow();
    const leftBehind = normalizeCommittedDocument(applyPatch(flattened, {
      op: "updateObject", objectId: session.mark.id, changes: { x: session.mark.x, y: session.mark.y }
    }));
    expect(() => assertSpin3dDocumentIdentity(session.document, leftBehind, stereo)).toThrow(/charge mark .* would move away/);
  });
});

/** The drawn geometry of every element a mark paints, read from SVG markup or from the canvas plan. */
const geometryAttributes = ["cx", "cy", "r", "x1", "y1", "x2", "y2", "transform", "d", "x", "y"] as const;
function svgMarkGeometry(svg: string, markId: string): string[] {
  return [...svg.matchAll(/<(\w+)\s([^>]*)>/g)].filter(([, , attrs]) => attrs!.includes(`data-object-id="${markId}"`)).map(([, tag, attrs]) =>
    `${tag} ` + geometryAttributes.flatMap(name => {
      const value = attrs!.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
      return value === undefined ? [] : [`${name}=${value}`];
    }).join(" "));
}
function canvasMarkGeometry(document: ChemDraftDocument, markId: string): string[] {
  const round = (value: unknown) => typeof value === "number" ? Number(value.toFixed(3)).toString() : String(value);
  return planPageSvgRender(document.pages[0]).fragments.filter(fragment => fragment.attrs["data-object-id"] === markId)
    .map(fragment => `${fragment.kind === "element" ? fragment.tag : fragment.kind} ` + geometryAttributes.flatMap(name =>
      fragment.attrs[name] === undefined ? [] : [`${name}=${round(fragment.attrs[name])}`]).join(" "));
}

describe("exports draw the marks where the canvas does", () => {
  it.each(markKinds)("SVG export of a flattened %s matches the canvas, beside its atom", async (_kind, spec) => {
    for (const conformer of [esterRepro, dragRepro]) {
      const session = await aspirinWithMark(spec, conformer);
      for (const quat of [session.open, dragged(session, -120, 0)]) {
        const flattened = flattenAt(session, quat);
        const mark = markOf(flattened);
        const canvas = canvasMarkGeometry(flattened, mark.id);
        expect(canvas.length, "the canvas draws the mark").toBeGreaterThan(0);
        // A transparent TIFF/PNG export rasterizes this same SVG.
        expect(svgMarkGeometry(exportDocumentToSvg(flattened).contents, mark.id)).toEqual(canvas);
        expectMarkOnItsAtom(session, flattened, `${label(conformer)} exported`);
      }
    }
  });
});

describe("3D clean-up carries a molecule's marks with its atoms", () => {
  it.each(markKinds)("a %s on the carboxylate O moves with it in the same patch set", async (_kind, spec) => {
    const session = await aspirinWithMark(spec);
    // Bend the drawing so the clean-up has something to fix (the mark is placed on the bent drawing).
    const bentPlain = applyPatch(insertNativeMolfileMolecule(createPhase4Document("Bent"), { x: 300, y: 300 },
      depictSmiles2D(aspirin).molfile, "molfile-v2000"), {
      op: "updateObject", objectId: session.molecule.id, changes: {
        atoms: session.molecule.atoms.map((atom, index) => ({ ...atom, formalCharge: 0, x: atom.x + (index % 3) * 7, y: atom.y - (index % 2) * 9 }))
      }
    });
    const bent = normalizeCommittedDocument(applyChargeToolAtNativeAtom(normalizeCommittedDocument(bentPlain), spec,
      { kind: "atom", objectId: session.molecule.id, atomId: session.acidOxygen.id, distanceToPointer: 0 }));
    const drawnMark = markOf(bent);
    const drawnAtom = moleculeOf(bent).atoms.find(atom => atom.id === session.acidOxygen.id)!;
    const cleaned = normalizeCommittedDocument(applyNativeMoleculeEngineRelayout(bent, session.molecule.id, relayoutMolfile2D, { warnings: [] }));
    const atom = moleculeOf(cleaned).atoms.find(candidate => candidate.id === session.acidOxygen.id)!;
    expect(Math.hypot(atom.x - drawnAtom.x, atom.y - drawnAtom.y), "the clean-up moved the O").toBeGreaterThan(1);
    const drawnDistance = Math.hypot(centerOf(drawnMark).x - drawnAtom.x, centerOf(drawnMark).y - drawnAtom.y);
    expectMarkOnItsAtom({ ...session, mark: drawnMark, acidOxygen: drawnAtom, drawnDistance }, cleaned, "clean-up");
    expectChemistryKept({ chemistry: chemistryOf(bent) }, cleaned, "clean-up");
  });
});

describe("a drawing saved with a stale offset", () => {
  it("is not moved on open, and an explicit re-spin and release puts the mark back beside its atom", async () => {
    const session = await aspirinWithMark({ kind: "charge", charge: -1 }, esterRepro);
    const flattened = flattenAt(session, session.open);
    // What 1.2.3 stored: the drawn offset carried unchanged by the atom's move.
    const atom = moleculeOf(flattened).atoms.find(candidate => candidate.id === session.acidOxygen.id)!;
    const stale = normalizeCommittedDocument(applyPatch(flattened, { op: "updateObject", objectId: session.mark.id, changes: {
      x: session.mark.x + atom.x - session.acidOxygen.x, y: session.mark.y + atom.y - session.acidOxygen.y
    } }));
    // The reported picture: the '-' reads as the ester O's (atom 3 of this SMILES).
    const staleCenter = centerOf(markOf(stale));
    const nearest = [...moleculeOf(stale).atoms].sort((left, right) => Math.hypot(left.x - staleCenter.x, left.y - staleCenter.y) -
      Math.hypot(right.x - staleCenter.x, right.y - staleCenter.y))[0]!;
    expect(nearest.id).toBe(session.molecule.atoms[3]!.id);
    expect(session.molecule.atoms[3]!.element).toBe("O");
    const reopened = normalizeCommittedDocument(openNativeDocument(createNativeSavePayload(stale).contents).document!);
    // Opening never repositions a mark: a stale offset cannot be told from a deliberate placement.
    expect([markOf(reopened).x, markOf(reopened).y]).toEqual([markOf(stale).x, markOf(stale).y]);
    expectChemistryKept(session, reopened, "stale reopened");
    // The user's own Spin 3D on it, released where it opens, applies the shared rule.
    const molecule = moleculeOf(reopened);
    const model = validSpin3dModelFor(molecule)!;
    const coords3d = spin3dModelCoordsForMolecule(model, molecule)!;
    const points = molecule.atoms.map(point => ({ x: point.x, y: point.y }));
    const placement: ScreenPlacement = {
      centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      scale: orientedOverlayScale(points, coords3d, session.bondPairs, quatToViewMatrix(model.orientation))
    };
    const respun = flattenAt({ ...session, molecule }, model.orientation, coords3d, reopened, placement);
    expectMarkOnItsAtom(session, respun, "re-spun");
    expectChemistryKept(session, respun, "re-spun");
  });
});

/**
 * `session` with its molecule turned `degrees` on the page (its object rotation, a supported state: a
 * drawing imported or grouped with a turn), the mark turned with it so it sits beside its atom where
 * the page draws it. Atoms, bonds and chemistry are unchanged. The mark's binding to its atom is made
 * explicit (as any spin, rotation or direct drop leaves it): a legacy distance association is read
 * against the molecule's unturned atoms (document-workflow-core nativeElectronMarkAssignments), which
 * at 90° would hand this '-' to the carboxyl C.
 */
function turnedOnPage(session: Session, degrees: number): Session {
  const turned = { ...session.molecule, rotation: degrees };
  const center = transformPointForObject(turned, centerOf(session.mark));
  let document = applyPatch(session.document, { op: "updateObject", objectId: turned.id, changes: { rotation: degrees } });
  document = normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: session.mark.id, changes: {
    x: center.x - session.mark.width / 2, y: center.y - session.mark.height / 2, atomAssociation: "explicit",
    anchor: { kind: "atom", objectId: turned.id, atomId: session.acidOxygen.id },
    ...(session.mark.markKind === "lone-pair" ? { rotation: ((session.mark.rotation + degrees) % 360 + 360) % 360 } : {})
  } }));
  const molecule = moleculeOf(document);
  const atom = transformPointForObject(molecule, molecule.atoms.find(candidate => candidate.id === session.acidOxygen.id)!);
  const mark = markOf(document);
  expect(Math.hypot(centerOf(mark).x - atom.x, centerOf(mark).y - atom.y), "the turned mark is as far from its atom").toBeCloseTo(session.drawnDistance, 6);
  const chemistry = chemistryOf(document);
  expect(chemistry.owner, "still the carboxylate O's").toEqual(session.chemistry.owner);
  return { ...session, document, molecule, mark, chemistry };
}

/** The committed molecule's atoms where the page draws them (its rotation applied). */
function pageAtoms(molecule: MoleculeObject) {
  return molecule.atoms.map(atom => ({ ...atom, ...transformPointForObject(molecule, atom) }));
}

describe("a molecule turned on the page: the overlay paints each mark exactly where release stores it", () => {
  it.each(markKinds)("a %s on a molecule turned 37° and 90°: same page position in the overlay and after flatten", async (_kind, spec) => {
    const crowdedBefore = crowdedViews.length;
    for (const conformer of [esterRepro, dragRepro]) {
      for (const degrees of [37, 90]) {
        const session = turnedOnPage(await aspirinWithMark(spec, conformer), degrees);
        for (const [view, quat] of [["opening", session.open], ["drag -90,-40", dragged(session, -90, -40)]] as const) {
          const name = `${label(conformer)} turned ${degrees}° ${view}`;
          const live = liveOverlay(session, quat);
          const committed = flattenAt(session, quat);
          const mark = markOf(committed);
          // Absolute page coordinates, not just the offset from the atom.
          expect(mark.x, `${name}: x`).toBeCloseTo(live.placement.x, 6);
          expect(mark.y, `${name}: y`).toBeCloseTo(live.placement.y, 6);
          expect(mark.rotation, `${name}: rotation`).toBeCloseTo(live.placement.rotation, 6);
          // The commit keeps the molecule's turn, and the mark beside its atom where the page draws it.
          const molecule = moleculeOf(committed);
          expect(molecule.rotation).toBe(degrees);
          expect(mark.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: session.acidOxygen.id });
          expectBeside(pageAtoms(molecule), molecule.bonds, mark, session.acidOxygen.id, session.drawnDistance, name);
          expectChemistryKept(session, committed, name);
        }
      }
    }
    expect(crowdedViews.slice(crowdedBefore)).toEqual([]);
  });
});

/** `document` with `smiles` added as a second molecule whose atoms are moved so its atom `index` sits at `at`. */
function withSecondMolecule(document: ChemDraftDocument, smiles: string, index: number, at: { x: number; y: number }) {
  const added = insertNativeMolfileMolecule(document, { x: 80, y: 80 }, depictSmiles2D(smiles).molfile, "molfile-v2000");
  const second = added.pages[0].objects.find((object): object is MoleculeObject =>
    object.type === "molecule" && !document.pages[0].objects.some(existing => existing.id === object.id))!;
  const anchor = second.atoms[index]!;
  const atoms = second.atoms.map(atom => ({ ...atom, x: atom.x + at.x - anchor.x, y: atom.y + at.y - anchor.y }));
  const placed = normalizeCommittedDocument(applyPatch(added, {
    op: "updateObject", objectId: second.id, changes: { atoms, ...moleculeGeometryFromAtoms(atoms) }
  }));
  return { document: placed, second: placed.pages[0].objects.find((object): object is MoleculeObject => object.id === second.id)! };
}

describe("another molecule on the page is an obstacle: a mark is never carried onto its atom, bond or label", () => {
  it.each([["ethane's carbon", "CC", 0], ["methylamine's NH2 label", "CN", 1]] as const)(
    "the '-' whose kept spot lands on %s turns to a free side, in the overlay and on release", async (_what, smiles, index) => {
      const crowdedBefore = crowdedViews.length;
      for (const conformer of [esterRepro, dragRepro]) {
        const session = await aspirinWithMark({ kind: "charge", charge: -1 }, conformer);
        for (const quat of [session.open, dragged(session, -90, -40)]) {
          // Where release puts the '-' with nothing else on the page.
          const spot = centerOf(markOf(flattenAt(session, quat)));
          const { document, second } = withSecondMolecule(session.document, smiles, index, spot);
          const crowded: Session = { ...session, document };
          // Adding the molecule changes nothing about the aspirin or its mark.
          expect(chemistryOf(document), "the mark still belongs to the carboxylate O").toEqual(session.chemistry);
          const name = `${label(conformer)} ${smiles} at the kept spot`;
          const live = liveOverlay(crowded, quat);
          const committed = flattenAt(crowded, quat);
          const mark = markOf(committed);
          expect(mark.x, `${name}: x`).toBeCloseTo(live.placement.x, 6);
          expect(mark.y, `${name}: y`).toBeCloseTo(live.placement.y, 6);
          const center = centerOf(mark);
          expect(Math.hypot(center.x - spot.x, center.y - spot.y), `${name}: the mark left the spot`).toBeGreaterThan(5);
          // Beside its own atom: nearer it than any atom of either molecule, off every bond of both.
          const prefixed = second.atoms.map(atom => ({ ...atom, id: `second:${atom.id}` }));
          const bonds = [...moleculeOf(committed).bonds, ...second.bonds.map(bond => ({
            fromAtomId: `second:${bond.fromAtomId}`, toAtomId: `second:${bond.toAtomId}`
          }))];
          expectBeside([...moleculeOf(committed).atoms, ...prefixed], bonds, mark, session.acidOxygen.id, session.drawnDistance, name);
          // Off the other molecule's label letters by the mark's drawn ink.
          const ink = electronMarkInkRadius(mark);
          for (const box of moleculeLayoutLabelBoxes(second)) {
            expect(carriedMarkLabelDepth(center, ink, box), `${name}: on the label`).toBeLessThanOrEqual(1e-6);
          }
          // Neither molecule's chemistry changed; the other molecule did not move.
          expectChemistryKept(session, committed, name);
          expect(committed.pages[0].objects.find(object => object.id === second.id)).toEqual(second);
        }
      }
      expect(crowdedViews.slice(crowdedBefore)).toEqual([]);
    });
});

describe("a mark keeps off the letters of the label its molecule is committed with", () => {
  it("methylammonium spun end over end: H3N is committed as NH3, and the '+' turns off the H3 it would land on", async () => {
    const plain = insertNativeMolfileMolecule(createPhase4Document("Ammonium"), { x: 300, y: 300 }, depictSmiles2D("CN").molfile, "molfile-v2000");
    const drawn = moleculeOf(plain);
    const nitrogen = drawn.atoms.find(atom => atom.element === "N")!;
    const charged = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "charge", charge: 1 },
      { kind: "atom", objectId: drawn.id, atomId: nitrogen.id, distanceToPointer: 0 }));
    // The '+' to the lower right of N: clear of "H3N" (its hydrogens are drawn on the left, away from the C).
    const molecule = moleculeOf(charged);
    expect(planMoleculeAtomLabels(molecule).map(plan => plan.label)).toEqual(["H3N"]);
    const placedMark = markOf(charged);
    const document = normalizeCommittedDocument(applyPatch(charged, { op: "updateObject", objectId: placedMark.id, changes: {
      x: nitrogen.x + 14 - placedMark.width / 2, y: nitrogen.y + 9 - placedMark.height / 2
    } }));
    const mark = markOf(document);
    const chemistry = chemistryOf(document);
    const drawnLabel = moleculeLayoutLabelBoxes(molecule)[0]!;
    expect(carriedMarkLabelDepth(centerOf(mark), electronMarkInkRadius(mark), drawnLabel), "drawn clear of H3N").toBeLessThan(0);
    // A 2D conformer turned half a turn about the vertical: the C goes over to N's other side.
    const coords3d = Float64Array.from(molecule.atoms.flatMap(atom => [atom.x, -atom.y, 0]));
    const bondPairs: [number, number][] = [[0, 1]];
    const placement: ScreenPlacement = {
      centerX: (molecule.atoms[0]!.x + molecule.atoms[1]!.x) / 2, centerY: (molecule.atoms[0]!.y + molecule.atoms[1]!.y) / 2, scale: 1
    };
    const quat = quatFromAxisAngle([0, 1, 0], Math.PI);
    const live = liveOverlay({ document, molecule, mark, bondPairs, placement, coords3d }, quat);
    const outcome = flattenSpunMolecule(document, molecule.id, coords3d, quatToViewMatrix(quat), { placement });
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
    const committed = normalizeCommittedDocument(outcome.document);
    const committedMolecule = moleculeOf(committed);
    expect(planMoleculeAtomLabels(committedMolecule).map(plan => plan.label), "the label is committed the other way round").toEqual(["NH3"]);
    const committedLabel = moleculeLayoutLabelBoxes(committedMolecule)[0]!;
    const committedN = committedMolecule.atoms.find(atom => atom.id === nitrogen.id)!;
    const ink = electronMarkInkRadius(mark);
    // Kept at its offset, the '+' would sit on the H3 of NH3.
    const kept = { x: committedN.x + centerOf(mark).x - nitrogen.x, y: committedN.y + centerOf(mark).y - nitrogen.y };
    expect(carriedMarkLabelDepth(kept, ink, committedLabel), "the kept spot is on the letters").toBeGreaterThan(3);
    // It turns off them, at the same distance from its N, and the overlay paints it there.
    const committedMark = markOf(committed);
    const center = centerOf(committedMark);
    expect(carriedMarkLabelDepth(center, ink, committedLabel)).toBeLessThanOrEqual(1e-6);
    expect(Math.hypot(center.x - committedN.x, center.y - committedN.y)).toBeCloseTo(Math.hypot(14, 9), 6);
    expect(committedMark.x).toBeCloseTo(live.placement.x, 6);
    expect(committedMark.y).toBeCloseTo(live.placement.y, 6);
    expect(chemistryOf(committed)).toEqual(chemistry);
  });
});
