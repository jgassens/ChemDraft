import { beforeAll, describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatch, applyPatches, createEmptyDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond,
  type MoleculeObject } from "@chemdraft/chem-core";
import { phase4Timestamp, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D, ensureOclResources, oclConformerGenerator, perceiveDoubleBondStereoFromMolfile,
  perceiveStereoCentersFromMolfile, type Depiction2D } from "@chemdraft/ocl-adapter";
import {
  PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING, commitChemistryRefusals, flipChemistry, loadCommitStereoEngine, policyChemistryRefusals,
  selectionTransformChemistry, type CommitChemistryPolicy, type CommitStereoEngine, type CommitStereoEngineOption
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";
import { quatFromAxisAngle, quatToViewMatrix } from "./interaction/rotation3d";

// Bug chemistry-guard-stereo-by-bond (1.2.4): the widened commit guard compared wedge, hash and
// wavy style and the narrow end bond by bond, so Spin 3D flatten (PRESERVE_CHEMISTRY), which
// re-places wedges on other bonds while keeping every stereocentre, was refused. Stereo is judged
// by what it means: R/S per atom and E/Z per double bond as the app's perceivers read it back.
// Every case states the canonical isomeric SMILES OpenChemLib reads back before and after.

const M = "stereo_mol";

/** FC(Cl)NC=CC with a wedge from c1 to F: c1 is a stereocentre (F, Cl, N, implicit H), c2=c3 is E. Page coordinates (y down). */
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

function fixture(): ChemDraftDocument {
  const empty = createEmptyDocument();
  return applyPatches(empty, [{ op: "addObject", pageId: empty.pages[0].id, object: stereoMolecule() }], { now: phase4Timestamp });
}

const moleculeById = (document: ChemDraftDocument, id: string) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;
const editBonds = (document: ChemDraftDocument, update: (bond: MoleculeBond) => MoleculeBond, id = M) =>
  applyPatch(document, { op: "updateObject", objectId: id, changes: { bonds: moleculeById(document, id).bonds.map(update) } },
    { now: phase4Timestamp });
const plain = ({ display: _display, ...bond }: MoleculeBond): MoleculeBond => bond;
const styled = (bond: MoleculeBond, bondStyle: "wedge" | "hashed" | "wavy"): MoleculeBond => ({ ...bond, display: { bondStyle } });

/** The canonical isomeric SMILES OpenChemLib reads back from the app's own stereo-perception molfile. */
const canonical = (document: ChemDraftDocument, id = M) =>
  Molecule.fromMolfile(stereoPerceptionMolfile(moleculeById(document, id))).toIsomericSmiles();

let engine: CommitStereoEngine;
beforeAll(async () => {
  engine = (await loadCommitStereoEngine())!;
  expect(engine).toBeDefined();
});

/** The commit funnel's check under `policy`, with commit normalization, as MainWindow runs it. */
const funnel = (before: ChemDraftDocument, after: ChemDraftDocument, policy: CommitChemistryPolicy = PRESERVE_CHEMISTRY,
  stereoEngine: CommitStereoEngineOption = engine) =>
  policyChemistryRefusals(policy, {
    before, next: after, after: workflow.committedNormalForm(after), normalize: workflow.committedNormalForm,
    markAtoms: workflow.committedElectronMarkAtoms, stereoEngine
  });

/** Exactly the edit, nothing settled around it. */
const exact = (before: ChemDraftDocument, after: ChemDraftDocument, stereoEngine: CommitStereoEngineOption = engine) =>
  commitChemistryRefusals({ before, next: after, after, normalize: (document) => document,
    markAtoms: workflow.committedElectronMarkAtoms, operation: "move", stereoEngine });

const prefix = `Cannot move without changing the chemistry of molecule "${M}": `;

describe("stereo is judged by what it means, not by which bond carries the wedge", () => {
  it("accepts a wedge moved to another bond of the same centre that keeps its configuration", () => {
    const before = fixture();
    // c1 has three drawn neighbours and an implicit H: a wedge on any one of them puts the H behind.
    const moved = editBonds(before, (bond) => bond.id === "b1" ? plain(bond) : bond.id === "b2" ? styled(bond, "wedge") : bond);
    expect(canonical(before)).toBe("C/C=C/N[C@H](F)Cl");
    expect(canonical(moved)).toBe(canonical(before));
    expect(exact(before, moved)).toEqual([]);
    expect(funnel(before, moved)).toEqual([]);
  });

  it("refuses an inverted centre, also when the mark moves to another bond", () => {
    const before = fixture();
    const hashed = editBonds(before, (bond) => bond.id === "b1" ? styled(bond, "hashed") : bond);
    const elsewhere = editBonds(before, (bond) => bond.id === "b1" ? plain(bond) : bond.id === "b2" ? styled(bond, "hashed") : bond);
    for (const after of [hashed, elsewhere]) {
      expect(canonical(after)).toBe("C/C=C/N[C@@H](F)Cl");
      expect(exact(before, after)).toEqual([`${prefix}its atom "c1" would read as stereocentre S instead of stereocentre R.`]);
      expect(funnel(before, after)).toHaveLength(1);
    }
  });

  it("refuses a centre lost (wedge removed, or turned around) and a centre gained", () => {
    const before = fixture();
    const lost = editBonds(before, (bond) => bond.id === "b1" ? plain(bond) : bond);
    const turned = editBonds(before, (bond) => bond.id === "b1" ? { ...bond, fromAtomId: "f", toAtomId: "c1" } : bond);
    for (const after of [lost, turned]) {
      expect(canonical(after)).toBe("C/C=C/NC(F)Cl");
      expect(exact(before, after)).toEqual([`${prefix}its atom "c1" would read as an unspecified stereocentre instead of stereocentre R.`]);
    }
    expect(exact(lost, before)).toEqual([`${prefix}its atom "c1" would read as stereocentre R instead of an unspecified stereocentre.`]);
  });

  it("treats a wavy bond as meaning: a defined centre made undefined, or the reverse, is refused", () => {
    const before = fixture();
    const wavy = editBonds(before, (bond) => bond.id === "b1" ? styled(bond, "wavy") : bond);
    expect(canonical(wavy)).toBe("C/C=C/NC(F)Cl");
    expect(exact(before, wavy)).toEqual([`${prefix}its atom "c1" would read as an unspecified stereocentre instead of stereocentre R.`]);
    expect(exact(wavy, before)).toEqual([`${prefix}its atom "c1" would read as stereocentre R instead of an unspecified stereocentre.`]);
    // Undefined either way (no mark, or a wave) is the same meaning.
    const lost = editBonds(before, (bond) => bond.id === "b1" ? plain(bond) : bond);
    expect(exact(wavy, lost)).toEqual([]);
  });

  it("refuses E to Z read back after a re-layout", () => {
    const before = fixture();
    // c4 from (376, 300) to (357, 333): the same side of c2=c3 as n.
    const swung = applyPatch(before, { op: "updateObject", objectId: M, changes: {
      atoms: moleculeById(before, M).atoms.map((atom) => atom.id === "c4" ? { ...atom, x: 357, y: 333 } : atom)
    } }, { now: phase4Timestamp });
    expect(canonical(swung)).toBe("C/C=C\\N[C@H](F)Cl");
    expect(exact(before, swung)).toEqual([`${prefix}its double bond between atoms "c2" and "c3" would read Z instead of E.`]);
  });

  it("still refuses the E/Z \"either\" flag without the engine", () => {
    const before = fixture();
    const either = editBonds(before, (bond) => bond.id === "b5" ? { ...bond, stereo: "either" } : bond);
    expect(canonical(either)).toBe("CC=CN[C@H](F)Cl");
    expect(exact(before, either, STEREO_ENGINE_LOADING)).toEqual([`${prefix}its bond "b5" would have unspecified (either) E/Z instead of the drawn geometry.`]);
  });
});

describe("without the stereo engine (still loading, or a drawing it cannot read)", () => {
  it("refuses a commit that needs the read-back (never skips it, never guesses from wedges), and keeps every other invariant", () => {
    const starting = `Cannot move yet: checking the stereochemistry of molecule "${M}" is still starting; try again in a moment.`;
    const before = fixture();
    const moved = editBonds(before, (bond) => bond.id === "b1" ? plain(bond) : bond.id === "b2" ? styled(bond, "wedge") : bond);
    expect(exact(before, moved, STEREO_ENGINE_LOADING)).toEqual([starting]);
    const mirrored = applyPatch(before, { op: "updateObject", objectId: M, changes: {
      atoms: moleculeById(before, M).atoms.map((atom) => ({ ...atom, x: 660 - atom.x }))
    } }, { now: phase4Timestamp });
    expect(exact(before, mirrored, STEREO_ENGINE_LOADING)).toEqual([starting]);
    const element = applyPatch(before, { op: "updateObject", objectId: M, changes: {
      atoms: moleculeById(before, M).atoms.map((atom) => atom.id === "n" ? { ...atom, element: "O" } : atom),
      bonds: moleculeById(before, M).bonds.map((bond) => bond.id === "b1" ? plain(bond) : bond)
    } }, { now: phase4Timestamp });
    expect(exact(before, element, STEREO_ENGINE_LOADING)).toEqual([`${prefix}its atom "n" would be O instead of N.`]);
  });

  it("refuses the commit, naming the failure, when the engine cannot read the drawing (never skips the comparison)", () => {
    // Bug chemistry-guard-unchecked-stereo (1.2.4): this used to commit, so the inverted centre
    // below (R to S) went through with its stereo unchecked.
    const before = fixture();
    const hashed = editBonds(before, (bond) => bond.id === "b1" ? styled(bond, "hashed") : bond);
    expect(canonical(before)).toBe("C/C=C/N[C@H](F)Cl");
    expect(canonical(hashed)).toBe("C/C=C/N[C@@H](F)Cl");
    const failing: CommitStereoEngine = {
      perceiveStereoCentersFromMolfile: () => { throw new Error("unreadable"); },
      perceiveDoubleBondStereoFromMolfile: () => { throw new Error("unreadable"); }
    };
    expect(exact(before, hashed, failing)).toEqual([`Cannot move: the stereochemistry of molecule "${M}" cannot be checked because ` +
      "the stereocentre perceiver failed on the drawing before the edit (unreadable)."]);
  });
});

describe("Flip Horizontal / Vertical", () => {
  it("commits a flip of a chiral molecule (mirroring is what the command means)", () => {
    const before = fixture();
    for (const axis of ["horizontal", "vertical"] as const) {
      const flipped = workflow.flipDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, axis);
      // The mirror image: the stereocentre inverts, E stays E.
      expect(canonical(flipped), axis).toBe("C/C=C/N[C@@H](F)Cl");
      expect(funnel(before, flipped, flipChemistry(undefined, new Set())), axis).toEqual([]);
      expect(funnel(before, flipped, flipChemistry()), axis).toEqual([]);
      // The same mirror under any other selection transform (a drag, align, rotate, resize) is read back.
      expect(funnel(before, flipped, selectionTransformChemistry("move", new Set())), axis).toEqual([
        `Cannot move without changing the chemistry of molecule "${M}": its atom "c1" would read as stereocentre S instead of stereocentre R.`]);
    }
  });

  it("a mirror under any other preserving commit (Spin 3D flatten, Clean Up) is still read back and refused", () => {
    const before = fixture();
    const flipped = workflow.flipDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, "horizontal");
    expect(funnel(before, flipped)).toEqual([
      `Cannot complete this edit without changing the chemistry of molecule "${M}": its atom "c1" would read as stereocentre S ` +
      "instead of stereocentre R."]);
  });
});

describe("Spin 3D flatten re-places wedges and keeps every stereocentre", () => {
  beforeAll(async () => {
    await ensureOclResources();
  }, 120_000);

  const molOf = (document: ChemDraftDocument, id: string) =>
    document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;
  const marks = (molecule: MoleculeObject) => JSON.stringify(molecule.bonds.flatMap((bond) =>
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed" || bond.display?.bondStyle === "wavy"
      ? [[bond.id, bond.display.bondStyle, bond.fromAtomId]] : []));

  it("commits every flattened view of menthol; without the engine it waits for it rather than skipping the check", async () => {
    const smiles = "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O";
    const depiction: Depiction2D = depictSmiles2D(smiles);
    const document = workflow.insertSmilesMolecule(workflow.createPhase4Document("stereo-fixture"), { x: 400, y: 320 }, {
      atoms: depiction.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, charge: a.charge })),
      bonds: depiction.bonds.map((b) => ({ from: b.from, to: b.to, order: b.order === "unknown" ? "single" : b.order, wedge: b.wedge }))
    }, smiles);
    const molId = document.pages[0].objects.find((object) => object.type === "molecule")!.id;
    const start = molOf(document, molId);
    const startCanonical = canonical(document, molId);
    const intent = perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(start));
    const centres = new Set(start.atoms.filter((_, i) => intent[i]?.isStereoCenter).map((atom) => atom.id));
    expect(centres.size).toBe(3);
    const coords = (await oclConformerGenerator.generate3DConformer({ molfile: stereoPerceptionMolfile(start) }, { optimize: "auto" }))
      .mapping.coords3dByOriginalAtom;
    let committed = 0;
    let replaced = 0;
    for (let attempt = 0; attempt < 30 && committed < 6; attempt++) {
      const outcome = workflow.flattenSpunMolecule(document, molId, coords, quatToViewMatrix(quatFromAxisAngle([1, 2, 3], 0.3 + attempt * 0.4)), {
        stereoCenterAtomIds: centres,
        perceiveStereo: perceiveStereoCentersFromMolfile, perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile
      });
      if (outcome.status !== "committed") continue;
      committed++;
      const flat = molOf(outcome.document, molId);
      if (marks(flat) !== marks(start)) replaced++;
      expect(canonical(outcome.document, molId), `view ${attempt}`).toBe(startCanonical);
      expect(funnel(document, outcome.document), `view ${attempt}`).toEqual([]);
      expect(funnel(document, outcome.document, PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING), `view ${attempt}`).toEqual([
        `Cannot complete this edit yet: checking the stereochemistry of molecule "${molId}" is still starting; try again in a moment.`]);
    }
    expect(committed).toBe(6);
    // The bug path: wedges on other bonds than before.
    expect(replaced).toBeGreaterThan(0);
  }, 120_000);
});
