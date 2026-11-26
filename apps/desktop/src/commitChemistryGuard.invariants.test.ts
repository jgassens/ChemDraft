import { beforeAll, describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatch, applyPatches, createEmptyDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond,
  type MoleculeObject } from "@chemdraft/chem-core";
import { phase4Timestamp, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import {
  CHEMISTRY_EDIT, PRESERVE_CHEMISTRY, chemistryEditOf, commitChemistryRefusals, loadCommitStereoEngine, policyChemistryRefusals,
  STEREO_ENGINE_LOADING, flipChemistry, preserveChemistry, selectionTransformChemistry, structureEditChemistry,
  type CommitChemistryPolicy, type CommitStereoEngine, type CommitStereoEngineOption
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";

// Bug chemistry-guard-too-narrow (1.2.4; also in 1.2.2): a preserving commit compared only charge,
// mark charge, radical marks and removed atoms, so an element, isotope, stated hydrogen count, bond
// order, wedge or a mirrored layout changed chemistry silently. Each case proves the change with the
// canonical isomeric SMILES OpenChemLib reads back from the app's own stereo-perception molfile.

const M = "stereo_mol";
const OTHER = "other_mol";

/**
 * (E)-FC(Cl)NC=CC with a wedge from c1 to F: c1 is a stereocentre (F, Cl, N, H), c2=c3 is E.
 * Coordinates are page coordinates (y down), drawn on a 22 px grid.
 */
function stereoMolecule(): MoleculeObject {
  const atom = (id: string, element: string, x: number, y: number): MoleculeAtom => ({ id, element, x, y, formalCharge: 0 });
  const bond = (id: string, fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single",
    bondStyle?: "wedge" | "hashed"): MoleculeBond =>
    ({ id, fromAtomId, toAtomId, order, ...(bondStyle ? { display: { bondStyle } } : {}) });
  const atoms = [atom("c1", "C", 300, 300), atom("f", "F", 300, 278), atom("cl", "Cl", 281, 311), atom("n", "N", 319, 311),
    atom("c2", "C", 338, 300), atom("c3", "C", 357, 311), atom("c4", "C", 376, 300)];
  const bonds = [bond("b1", "c1", "f", "single", "wedge"), bond("b2", "c1", "cl"), bond("b3", "c1", "n"), bond("b4", "n", "c2"),
    bond("b5", "c2", "c3", "double"), bond("b6", "c3", "c4")];
  return { id: M, type: "molecule", x: 281, y: 278, width: 95, height: 33, rotation: 0, style: {}, atoms, bonds,
    structureFormat: "smiles", structure: "FC(Cl)NC=CC", superatoms: [], rGroups: [] } as MoleculeObject;
}

/** An ethane far from M, for scoped edits and align. */
function otherMolecule(): MoleculeObject {
  return { id: OTHER, type: "molecule", x: 100, y: 500, width: 22, height: 0, rotation: 0, style: {},
    atoms: [{ id: "o1", element: "C", x: 100, y: 500, formalCharge: 0 }, { id: "o2", element: "C", x: 122, y: 500, formalCharge: 0 }],
    bonds: [{ id: "ob", fromAtomId: "o1", toAtomId: "o2", order: "single" }],
    structureFormat: "smiles", structure: "CC", superatoms: [], rGroups: [] } as MoleculeObject;
}

function fixture(): ChemDraftDocument {
  const empty = createEmptyDocument();
  return applyPatches(empty, [
    { op: "addObject", pageId: empty.pages[0].id, object: stereoMolecule() },
    { op: "addObject", pageId: empty.pages[0].id, object: otherMolecule() }
  ], { now: phase4Timestamp });
}

const moleculeById = (document: ChemDraftDocument, id: string) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;

function editMolecule(document: ChemDraftDocument, id: string,
  edit: (molecule: MoleculeObject) => Partial<Pick<MoleculeObject, "atoms" | "bonds">>): ChemDraftDocument {
  return applyPatch(document, { op: "updateObject", objectId: id, changes: edit(moleculeById(document, id)) }, { now: phase4Timestamp });
}
const editAtom = (document: ChemDraftDocument, atomId: string, update: (atom: MoleculeAtom) => MoleculeAtom, id = M) =>
  editMolecule(document, id, (molecule) => ({ atoms: molecule.atoms.map((atom) => atom.id === atomId ? update(atom) : atom) }));
const editBond = (document: ChemDraftDocument, bondId: string, update: (bond: MoleculeBond) => MoleculeBond) =>
  editMolecule(document, M, (molecule) => ({ bonds: molecule.bonds.map((bond) => bond.id === bondId ? update(bond) : bond) }));

/** The canonical isomeric SMILES OpenChemLib reads back from the app's stereo-perception molfile. */
const canonical = (document: ChemDraftDocument, id = M) =>
  Molecule.fromMolfile(stereoPerceptionMolfile(moleculeById(document, id))).toIsomericSmiles();

let engine: CommitStereoEngine;
beforeAll(async () => {
  engine = (await loadCommitStereoEngine())!;
  expect(engine).toBeDefined();
});

const identity = (document: ChemDraftDocument) => document;

/** The commit funnel's check under `policy`, with commit normalization (as MainWindow runs it). */
function funnel(before: ChemDraftDocument, next: ChemDraftDocument, policy: CommitChemistryPolicy = PRESERVE_CHEMISTRY,
  stereoEngine: CommitStereoEngineOption = engine): string[] {
  return policyChemistryRefusals(policy, {
    before, next, after: workflow.committedNormalForm(next), normalize: workflow.committedNormalForm,
    markAtoms: workflow.committedElectronMarkAtoms, stereoEngine
  });
}

/** The same check without normalization: exactly the edit, nothing settled around it. */
const exact = (before: ChemDraftDocument, after: ChemDraftDocument, stereoEngine: CommitStereoEngineOption = engine) =>
  commitChemistryRefusals({ before, next: after, after, normalize: identity, markAtoms: workflow.committedElectronMarkAtoms,
    operation: "move", stereoEngine });

const prefix = `Cannot move without changing the chemistry of molecule "${M}": `;
const STARTING = `Cannot move yet: checking the stereochemistry of molecule "${M}" is still starting; try again in a moment.`;

describe("a preserving commit refuses every AGENTS.md section 7 invariant change", () => {
  it("the fixture reads back as one stereocentre and an E double bond", () => {
    const document = fixture();
    expect(canonical(document)).toMatch(/@/);
    expect(canonical(document)).toMatch(/\/|\\/);
    expect(exact(document, document)).toEqual([]);
  });

  it("refuses an element change (N to O)", () => {
    const before = fixture();
    const after = editAtom(before, "n", (atom) => ({ ...atom, element: "O" }));
    expect(canonical(after)).not.toBe(canonical(before));
    expect(exact(before, after)).toEqual([`${prefix}its atom "n" would be O instead of N.`]);
    expect(funnel(before, after)).not.toEqual([]);
  });

  it("refuses an isotope", () => {
    const before = fixture();
    const after = editAtom(before, "c4", (atom) => ({ ...atom, isotope: 13 }));
    expect(canonical(after)).not.toBe(canonical(before));
    expect(exact(before, after)).toEqual([`${prefix}its atom "c4" would have isotope 13 instead of none.`]);
    expect(funnel(before, after)).not.toEqual([]);
  });

  it("refuses a stated hydrogen count", () => {
    const before = fixture();
    const after = editAtom(before, "n", (atom) => ({ ...atom, hydrogenCount: 0 }));
    expect(exact(before, after)).toEqual([`${prefix}its atom "n" would have a stated hydrogen count of 0 instead of no stated hydrogen count.`]);
    expect(funnel(before, after)).not.toEqual([]);
  });

  it("refuses the literal-label flag", () => {
    const before = fixture();
    const after = editAtom(before, "c4", (atom) => ({ ...atom, labelLiteral: true }));
    expect(exact(before, after)).toEqual([`${prefix}its atom "c4" would become a literal label (no implicit hydrogens).`]);
  });

  it("refuses a radical", () => {
    const before = fixture();
    const after = editAtom(before, "c4", (atom) => ({ ...atom, markRadicals: 1 }));
    expect(exact(before, after)).toHaveLength(1);
    expect(exact(before, after)[0]).toContain(`its atom "c4" would have charge 0 and 1 radical marks instead of 0 and 0`);
  });

  it("refuses a bond-order change (C=C to C-C)", () => {
    const before = fixture();
    const after = editBond(before, "b5", (bond) => ({ ...bond, order: "single" }));
    expect(canonical(after)).not.toBe(canonical(before));
    expect(exact(before, after)).toEqual([`${prefix}its bond "b5" would be single instead of double.`]);
    expect(funnel(before, after)).not.toEqual([]);
  });

  it("refuses an \"either\" double bond", () => {
    const before = fixture();
    const after = editBond(before, "b5", (bond) => ({ ...bond, stereo: "either" }));
    expect(canonical(after)).not.toBe(canonical(before));
    expect(exact(before, after)).toEqual([`${prefix}its bond "b5" would have unspecified (either) E/Z instead of the drawn geometry.`]);
  });

  it("refuses wedge to hash, and a wedge turned around, by the stereo they read back as", () => {
    // Stereo is judged by what it means (commitChemistryGuard.stereoMeaning.test.ts), so each
    // refusal names the centre's read-back, not the bond's style.
    const before = fixture();
    const hashed = editBond(before, "b1", (bond) => ({ ...bond, display: { bondStyle: "hashed" } }));
    expect(canonical(hashed)).not.toBe(canonical(before));
    expect(exact(before, hashed)).toEqual([`${prefix}its atom "c1" would read as stereocentre S instead of stereocentre R.`]);
    expect(funnel(before, hashed)).not.toEqual([]);
    const plain = editBond(before, "b1", ({ display: _display, ...bond }) => bond);
    expect(exact(before, plain)).toEqual([`${prefix}its atom "c1" would read as an unspecified stereocentre instead of stereocentre R.`]);
    const reversed = editBond(before, "b1", (bond) => ({ ...bond, fromAtomId: "f", toAtomId: "c1" }));
    expect(exact(before, reversed)).toEqual([`${prefix}its atom "c1" would read as an unspecified stereocentre instead of stereocentre R.`]);
  });

  it("refuses an added atom, an added bond and a removed bond", () => {
    const before = fixture();
    const addedAtom = editMolecule(before, M, (molecule) => ({
      atoms: [...molecule.atoms, { id: "c5", element: "C", x: 395, y: 311, formalCharge: 0 }],
      bonds: [...molecule.bonds, { id: "b7", fromAtomId: "c4", toAtomId: "c5", order: "single" }]
    }));
    expect(canonical(addedAtom)).not.toBe(canonical(before));
    expect(exact(before, addedAtom)).toEqual([`${prefix}it would gain atom "c5" (C).`,
      `${prefix}it would gain bond "b7" between atoms "c4" and "c5".`]);
    const removedBond = editMolecule(before, M, (molecule) => ({ bonds: molecule.bonds.filter((bond) => bond.id !== "b6") }));
    expect(exact(before, removedBond)).toEqual([`${prefix}its bond "b6" between atoms "c3" and "c4" would be removed.`]);
    const rejoined = editBond(before, "b6", (bond) => ({ ...bond, toAtomId: "c1" }));
    expect(exact(before, rejoined)[0]).toBe(`${prefix}its bond "b6" would join atoms "c3" and "c1" instead of "c3" and "c4".`);
  });

  it("refuses a mirrored layout that inverts the stereocentre, read back with the engine", () => {
    const before = fixture();
    // Mirror every atom of M about x = 330; the wedge stays a wedge.
    const mirrored = editMolecule(before, M, (molecule) => ({ atoms: molecule.atoms.map((atom) => ({ ...atom, x: 660 - atom.x })) }));
    expect(canonical(mirrored)).not.toBe(canonical(before));
    expect(exact(before, mirrored)).toEqual([expect.stringMatching(
      new RegExp(`^${prefix.replace(/[()"]/g, "\\$&")}its atom "c1" would read as stereocentre [RS] instead of stereocentre [RS]\\.$`))]);
    // The app's own Flip Horizontal is the same mirror, but mirroring is what Flip means: through
    // the Flip policy it commits, as it did before the guard was widened. Under any other
    // selection transform (a drag, align, rotate, resize) the mirror is refused.
    const flipped = workflow.flipDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, "horizontal");
    expect(canonical(flipped)).not.toBe(canonical(before));
    expect(funnel(before, flipped, flipChemistry())).toEqual([]);
    expect(funnel(before, flipped, selectionTransformChemistry())).toHaveLength(1);
    expect(funnel(before, flipped)).toHaveLength(1);
  });

  it("without the engine, refuses until it can read the stereo back (no skip, no guess from wedges)", () => {
    const before = fixture();
    const mirrored = editMolecule(before, M, (molecule) => ({ atoms: molecule.atoms.map((atom) => ({ ...atom, x: 660 - atom.x })) }));
    expect(exact(before, mirrored, STEREO_ENGINE_LOADING)).toEqual([STARTING]);
  });

  it("refuses moving one atom across its double bond (E to Z), read back with the engine", () => {
    const before = fixture();
    // c4 from (376, 300) to (357, 333): the same side of c2=c3 as n, so E becomes Z.
    const swung = editAtom(before, "c4", (atom) => ({ ...atom, x: 357, y: 333 }));
    expect(canonical(swung)).not.toBe(canonical(before));
    expect(exact(before, swung)).toEqual([`${prefix}its double bond between atoms "c2" and "c3" would read Z instead of E.`]);
    // Without the engine the commit waits for it (no skip, no guess from the drawing).
    expect(exact(before, swung, STEREO_ENGINE_LOADING)).toEqual([STARTING]);
  });

  it("names a changed molecule and counts the rest on the status line", () => {
    const before = fixture();
    const after = editAtom(editAtom(before, "n", (atom) => ({ ...atom, element: "O" })), "c4", (atom) => ({ ...atom, isotope: 13 }));
    expect(exact(before, after)).toHaveLength(2);
  });
});

describe("layout and transform commands that keep chemistry still commit", () => {
  it("move, rotate, scale and align of a stereo molecule commit, and read back the same canonical SMILES", () => {
    const before = fixture();
    const reference = canonical(before);
    const moved = workflow.moveDocumentObjects(before, [M], 37.5, -12.25);
    const rotated = workflow.rotateDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, 73);
    const scaled = workflow.scaleDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, 1.7, 0.6);
    const selected = { ...before, selection: { ...before.selection, pageId: before.pages[0].id, objectIds: [M, OTHER] } };
    const aligned = workflow.alignSelectedDocumentObjects(selected, "left");
    for (const [name, after] of [["move", moved], ["rotate", rotated], ["scale", scaled], ["align", aligned]] as const) {
      expect(moleculeById(after, M).atoms, name).not.toEqual(moleculeById(before, M).atoms);
      expect(canonical(after), name).toBe(reference);
      expect(funnel(before, after, selectionTransformChemistry(name)), name).toEqual([]);
      // These never need the read-back, so they never wait for the engine.
      expect(funnel(before, after, PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING), name).toEqual([]);
    }
  });

  it("a flip of an achiral molecule commits", () => {
    const before = fixture();
    const flipped = workflow.flipDocumentObjectsAroundPoint(before, [OTHER], { x: 111, y: 500 }, "vertical");
    expect(funnel(before, flipped, selectionTransformChemistry())).toEqual([]);
  });

  it("a partial move that keeps the configuration commits (read back, not refused by geometry alone)", () => {
    const before = fixture();
    // c4 moves along its own side of c2=c3: not an affine map of the molecule, still E.
    const nudged = editAtom(before, "c4", (atom) => ({ ...atom, x: atom.x + 4, y: atom.y - 3 }));
    expect(canonical(nudged)).toBe(canonical(before));
    expect(exact(before, nudged)).toEqual([]);
    // Only the read-back can tell, so without the engine it waits for it.
    expect(exact(before, nudged, STEREO_ENGINE_LOADING)).toEqual([STARTING]);
  });
});

describe("commands that legitimately change chemistry are unaffected", () => {
  const changed = (before: ChemDraftDocument) => editBond(editAtom(before, "n", (atom) => ({ ...atom, element: "O" })), "b1",
    (bond) => ({ ...bond, display: { bondStyle: "hashed" } }));

  it("CHEMISTRY_EDIT is not checked", () => {
    const before = fixture();
    expect(funnel(before, changed(before), CHEMISTRY_EDIT)).toEqual([]);
  });

  it("a scoped chemistry edit may change the molecule it names, never another", () => {
    const before = fixture();
    expect(funnel(before, changed(before), chemistryEditOf([M]))).toEqual([]);
    const otherToo = editAtom(changed(before), "o1", (atom) => ({ ...atom, element: "N" }), OTHER);
    expect(funnel(before, otherToo, chemistryEditOf([M]))).toEqual([
      `Cannot complete this edit without changing the chemistry of molecule "${OTHER}": its atom "o1" would be N instead of C.`]);
  });

  it("a structure edit may change the molecule it structurally edits, never another", () => {
    const before = fixture();
    const reordered = editBond(before, "b5", (bond) => ({ ...bond, order: "single" }));
    expect(funnel(before, reordered, structureEditChemistry("add a bond"))).toEqual([]);
    // An element or isotope change is structural (`structurallyEditedMoleculeKeys`), so it would
    // put OTHER in the edit's scope; a stated hydrogen count is not.
    const hydrogensOnOther = editAtom(reordered, "o2", (atom) => ({ ...atom, hydrogenCount: 2 }), OTHER);
    expect(funnel(before, hydrogensOnOther, structureEditChemistry("add a bond"))).toEqual([
      `Cannot add a bond without changing the chemistry of molecule "${OTHER}": its atom "o2" would have a stated hydrogen count ` +
      "of 2 instead of no stated hydrogen count."]);
    expect(funnel(before, hydrogensOnOther, preserveChemistry("paste"))).toHaveLength(2);
  });
});
