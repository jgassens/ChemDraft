import { beforeAll, describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatch, createEmptyDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import { phase4Timestamp, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D, perceiveUnrepresentableStereo } from "@chemdraft/ocl-adapter";
import {
  PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING, commitChemistryRefusals, flipChemistry, loadCommitStereoEngine, policyChemistryRefusals,
  selectionTransformChemistry, type CommitChemistryPolicy, type CommitStereoEngine, type CommitStereoEngineOption
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";

// Bug chemistry-guard-unchecked-stereo (1.2.4, also in shipped 1.2.2): the commit guard's stereo
// read-back compared R/S per atom and E/Z per double bond only, so the axial chirality OpenChemLib
// perceives on a hindered biaryl (an atropisomer axis) was never compared: a mirror committed by a
// move, resize or Clean Up inverted it silently. And when a read failed (the perception molfile
// could not be written, or a perceiver threw) the guard passed the commit without any stereo check.
// Isomeric SMILES cannot carry axial chirality (OpenChemLib writes the same SMILES for both
// atropisomers), so the proof below is OpenChemLib's canonical idcode and the axis bond's parity,
// read from the app's own stereo-perception molfile, with the SMILES and formula unchanged.

const M = "atrop_mol";
/** 6,6'-dimethylbiphenyl-2,2'-diol: four ortho substituents, a stereogenic biaryl axis. */
const SMILES = "Cc1cccc(O)c1-c1c(C)cccc1O";

const moleculeOf = (document: ChemDraftDocument, id = M) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;

function biarylDocument(smiles = SMILES): ChemDraftDocument {
  const depiction = depictSmiles2D(smiles);
  const document = workflow.insertSmilesMolecule(workflow.createPhase4Document("atrop-fixture"), { x: 400, y: 320 }, {
    atoms: depiction.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, charge: a.charge })),
    bonds: depiction.bonds.map((b) => ({ from: b.from, to: b.to, order: b.order === "unknown" ? "single" : b.order, wedge: b.wedge }))
  }, smiles);
  const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  const empty = createEmptyDocument();
  return applyPatch(empty, { op: "addObject", pageId: empty.pages[0].id, object: { ...molecule, id: M } }, { now: phase4Timestamp });
}

const withMolecule = (document: ChemDraftDocument, changes: Partial<Pick<MoleculeObject, "atoms" | "bonds">>) =>
  applyPatch(document, { op: "updateObject", objectId: M, changes }, { now: phase4Timestamp });
const mapAtoms = (document: ChemDraftDocument, map: (atom: MoleculeAtom) => MoleculeAtom) =>
  withMolecule(document, { atoms: moleculeOf(document).atoms.map(map) });

/** OpenChemLib's reading of the app's stereo-perception molfile: canonical SMILES, formula, idcode, and the axis parities. */
function reading(document: ChemDraftDocument) {
  const molecule = Molecule.fromMolfile(stereoPerceptionMolfile(moleculeOf(document)));
  molecule.ensureHelperArrays(Molecule.cHelperCIP);
  const axes: number[] = [];
  for (let bond = 0; bond < molecule.getAllBonds(); bond++) {
    if (molecule.isBINAPChiralityBond(bond)) axes.push(molecule.getBondParity(bond));
  }
  return { smiles: molecule.toIsomericSmiles(), formula: molecule.getMolecularFormula().formula, idcode: molecule.getIDCode(), axes };
}

/** The biaryl axis bond (by OpenChemLib), and the drawing with one ortho ring bond wedged so the axis has a defined configuration. */
function definedAtropisomer() {
  const plainDocument = biarylDocument();
  const plainMolecule = moleculeOf(plainDocument);
  const axes = perceiveUnrepresentableStereo(stereoPerceptionMolfile(plainMolecule)).atropisomerBonds;
  expect(axes).toHaveLength(1);
  const axis = plainMolecule.bonds[axes[0]];
  for (const end of [axis.fromAtomId, axis.toAtomId]) {
    for (const bond of plainMolecule.bonds) {
      if (bond === axis || (bond.fromAtomId !== end && bond.toAtomId !== end)) continue;
      // Narrow end on the axis atom.
      const other = bond.fromAtomId === end ? bond.toAtomId : bond.fromAtomId;
      const wedged: MoleculeBond = { ...bond, fromAtomId: end, toAtomId: other, display: { bondStyle: "wedge" } };
      const document = withMolecule(plainDocument, { bonds: plainMolecule.bonds.map((candidate) => candidate === bond ? wedged : candidate) });
      const parity = reading(document).axes[0];
      if (parity === Molecule.cBondParityEor1 || parity === Molecule.cBondParityZor2) {
        return { plainDocument, document, axis, wedged };
      }
    }
  }
  throw new Error("no ortho ring bond defines the axis");
}

let engine: CommitStereoEngine;
beforeAll(async () => {
  engine = (await loadCommitStereoEngine())!;
  expect(engine).toBeDefined();
});

const funnel = (before: ChemDraftDocument, after: ChemDraftDocument, policy: CommitChemistryPolicy = PRESERVE_CHEMISTRY,
  stereoEngine: CommitStereoEngineOption = engine) =>
  policyChemistryRefusals(policy, {
    before, next: after, after: workflow.committedNormalForm(after), normalize: workflow.committedNormalForm,
    markAtoms: workflow.committedElectronMarkAtoms, stereoEngine
  });

const exact = (before: ChemDraftDocument, after: ChemDraftDocument, stereoEngine: CommitStereoEngineOption = engine) =>
  commitChemistryRefusals({ before, next: after, after, normalize: (document) => document,
    markAtoms: workflow.committedElectronMarkAtoms, operation: "move", stereoEngine });

const centre = (document: ChemDraftDocument) => {
  const atoms = moleculeOf(document).atoms;
  return { x: atoms.reduce((sum, atom) => sum + atom.x, 0) / atoms.length, y: atoms.reduce((sum, atom) => sum + atom.y, 0) / atoms.length };
};

describe("an atropisomer axis is stereo: its configuration is read back and compared", () => {
  it("refuses a mirror of a defined atropisomer under any commit but Flip", () => {
    const { document: before, axis } = definedAtropisomer();
    const { x } = centre(before);
    const mirrored = mapAtoms(before, (atom) => ({ ...atom, x: 2 * x - atom.x }));
    const was = reading(before);
    const now = reading(mirrored);
    // SMILES and formula cannot tell the two atropisomers apart; the axis parity and idcode can.
    expect(now.smiles).toBe(was.smiles);
    expect(was.smiles).toBe("Cc(cccc1O)c1-c(c(C)ccc1)c1O");
    expect(now.formula).toBe(was.formula);
    expect(was.formula).toBe("C14H14O2");
    expect(now.idcode).not.toBe(was.idcode);
    expect(new Set([was.axes[0], now.axes[0]])).toEqual(new Set([Molecule.cBondParityEor1, Molecule.cBondParityZor2]));
    const detail = `its axial stereochemistry would read differently (the atropisomer axis between atoms "${axis.fromAtomId}" ` +
      `and "${axis.toAtomId}")`;
    for (const operation of ["move", "resize", "rotate"]) {
      expect(funnel(before, mirrored, selectionTransformChemistry(operation)), operation).toEqual([
        `Cannot ${operation} without changing the chemistry of molecule "${M}": ${detail}.`]);
    }
    expect(funnel(before, mirrored)).toEqual([`Cannot complete this edit without changing the chemistry of molecule "${M}": ${detail}.`]);
    // Without the engine it waits rather than skipping.
    expect(exact(before, mirrored, STEREO_ENGINE_LOADING)).toEqual([
      `Cannot move yet: checking the stereochemistry of molecule "${M}" is still starting; try again in a moment.`]);
  });

  it("commits a move, rotation and scaling of a defined atropisomer, and a re-layout that keeps its axis", () => {
    const { document: before } = definedAtropisomer();
    const { x, y } = centre(before);
    const angle = 0.7;
    const moved = mapAtoms(before, (atom) => ({ ...atom, x: atom.x + 37, y: atom.y - 11 }));
    const rotated = mapAtoms(before, (atom) => ({ ...atom,
      x: x + (atom.x - x) * Math.cos(angle) - (atom.y - y) * Math.sin(angle),
      y: y + (atom.x - x) * Math.sin(angle) + (atom.y - y) * Math.cos(angle) }));
    const scaled = mapAtoms(before, (atom) => ({ ...atom, x: x + (atom.x - x) * 1.6, y: y + (atom.y - y) * 1.6 }));
    for (const [operation, after] of [["move", moved], ["rotate", rotated], ["resize", scaled]] as const) {
      expect(reading(after).idcode, operation).toBe(reading(before).idcode);
      expect(funnel(before, after, selectionTransformChemistry(operation)), operation).toEqual([]);
    }
    // Not an affine image (one methyl nudged): the read-back runs, and the axis reads the same.
    const methyl = moleculeOf(before).atoms[0];
    const nudged = mapAtoms(before, (atom) => atom.id === methyl.id ? { ...atom, x: atom.x + 2, y: atom.y + 1 } : atom);
    expect(reading(nudged).idcode).toBe(reading(before).idcode);
    expect(funnel(before, nudged, selectionTransformChemistry("move"))).toEqual([]);
  });

  it("commits Flip Horizontal / Vertical of a defined atropisomer (mirroring is what the command means)", () => {
    const { document: before } = definedAtropisomer();
    const point = centre(before);
    for (const axis of ["horizontal", "vertical"] as const) {
      const flipped = workflow.flipDocumentObjectsAroundPoint(before, [M], point, axis);
      expect(reading(flipped).idcode, axis).not.toBe(reading(before).idcode);
      expect(funnel(before, flipped, flipChemistry()), axis).toEqual([]);
    }
  });

  it("counts a hindered biaryl as possible stereo even with no wedge: it waits for the engine; an unhindered one does not", () => {
    const { plainDocument } = definedAtropisomer();
    const nudge = (document: ChemDraftDocument) => {
      const first = moleculeOf(document).atoms[0];
      return mapAtoms(document, (atom) => atom.id === first.id ? { ...atom, x: atom.x + 2 } : atom);
    };
    expect(exact(plainDocument, nudge(plainDocument), STEREO_ENGINE_LOADING)).toEqual([
      `Cannot move yet: checking the stereochemistry of molecule "${M}" is still starting; try again in a moment.`]);
    // With the engine the same re-layout reads back unchanged (no wedge, so no defined axis).
    expect(exact(plainDocument, nudge(plainDocument))).toEqual([]);
    // Biphenyl: no ortho substituent, no axis, nothing to wait for.
    const biphenyl = biarylDocument("c1ccccc1-c1ccccc1");
    expect(exact(biphenyl, nudge(biphenyl), STEREO_ENGINE_LOADING)).toEqual([]);
  });
});

describe("a stereo read-back that cannot run refuses the commit, naming why", () => {
  const unchecked = (reason: string) => `Cannot move: the stereochemistry of molecule "${M}" cannot be checked because ${reason}.`;

  it("refuses when a perceiver throws", () => {
    const { document: before } = definedAtropisomer();
    const { x } = centre(before);
    const mirrored = mapAtoms(before, (atom) => ({ ...atom, x: 2 * x - atom.x }));
    const throwing: CommitStereoEngine = { ...engine, perceiveStereoCentersFromMolfile: () => { throw new Error("unreadable"); } };
    expect(exact(before, mirrored, throwing)).toEqual([
      unchecked("the stereocentre perceiver failed on the drawing before the edit (unreadable)")]);
    const axialThrowing: CommitStereoEngine = { ...engine, perceiveUnrepresentableStereo: () => { throw new Error("axis unreadable"); } };
    expect(exact(before, mirrored, axialThrowing)).toEqual([
      unchecked("the atropisomer perceiver failed on the drawing before the edit (axis unreadable)")]);
    const short: CommitStereoEngine = { ...engine, perceiveStereoCentersFromMolfile: () => [] };
    expect(exact(before, mirrored, short)).toEqual([
      unchecked(`the stereocentre perceiver read 0 of the ${moleculeOf(before).atoms.length} atoms of the drawing before the edit`)]);
  });

  it("refuses a molecule that may carry an axis when the engine cannot read axes", () => {
    const { document: before } = definedAtropisomer();
    const { x } = centre(before);
    const mirrored = mapAtoms(before, (atom) => ({ ...atom, x: 2 * x - atom.x }));
    const noAxes: CommitStereoEngine = {
      perceiveStereoCentersFromMolfile: engine.perceiveStereoCentersFromMolfile,
      perceiveDoubleBondStereoFromMolfile: engine.perceiveDoubleBondStereoFromMolfile
    };
    expect(exact(before, mirrored, noAxes)).toEqual([unchecked("the stereo engine cannot read atropisomer axes")]);
  });

  it("refuses when the perception molfile cannot be written (an unknown-order bond)", () => {
    const { document: defined } = definedAtropisomer();
    const molecule = moleculeOf(defined);
    const last = molecule.atoms[molecule.atoms.length - 1];
    const before = withMolecule(defined, {
      atoms: [...molecule.atoms, { id: "q", element: "C", x: last.x + 20, y: last.y, formalCharge: 0 }],
      bonds: [...molecule.bonds, { id: "bq", fromAtomId: last.id, toAtomId: "q", order: "unknown" }]
    });
    const { x } = centre(before);
    const mirrored = mapAtoms(before, (atom) => ({ ...atom, x: 2 * x - atom.x }));
    expect(exact(before, mirrored)).toEqual([
      unchecked("the stereo perception molfile could not be written for the drawing before the edit (Bond bq has an unknown bond order.)")]);
  });

  it("never refuses a molecule with no stereo element, whatever the engine does", () => {
    // Cyclohexene: its only double bond is in a six-membered ring (no E/Z), no wedge, no axis.
    const before = biarylDocument("C1CCC=CC1");
    const first = moleculeOf(before).atoms[0];
    const nudged = mapAtoms(before, (atom) => atom.id === first.id ? { ...atom, x: atom.x + 3 } : atom);
    const throwing: CommitStereoEngine = {
      perceiveStereoCentersFromMolfile: () => { throw new Error("unreadable"); },
      perceiveDoubleBondStereoFromMolfile: () => { throw new Error("unreadable"); }
    };
    expect(exact(before, nudged, throwing)).toEqual([]);
  });
});
