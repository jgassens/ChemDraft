import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatch, applyPatches, createEmptyDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond,
  type MoleculeObject } from "@chemdraft/chem-core";
import { phase4Timestamp, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import {
  PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING, commitChemistryRefusals, flipChemistry, loadCommitStereoEngine, policyChemistryRefusals,
  resetCommitStereoEngineForTests, selectionTransformChemistry, type CommitChemistryPolicy, type CommitStereoEngineOption
} from "./commitChemistryGuard";
import * as workflow from "./documentWorkflow";

// Review of the stereo read-back guard (1.2.4; the guard's gap is also in shipped 1.2.2):
// P1: while the lazily loaded stereo engine was still loading after launch, or after it failed to
// load, the read-back was skipped, so a preserving commit could change R/S or E/Z unchecked. Now a
// commit that needs the read-back is refused with a specific message until the engine is there;
// a molecule with no stereo element, and a commit that cannot change stereo (a move, rotate, scale,
// or Flip), never waits for it.
// P2: every selection transform (drag, align, rotate, resize, Flip) accepted an exact whole-molecule
// mirror without a read-back. Only Flip Horizontal / Vertical may mirror (`flipChemistry`).
// Every case states the canonical isomeric SMILES OpenChemLib reads back before and after.

const M = "stereo_mol";
const atom = (id: string, element: string, x: number, y: number): MoleculeAtom => ({ id, element, x, y, formalCharge: 0 });
const bond = (id: string, fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single",
  bondStyle?: "wedge" | "hashed"): MoleculeBond =>
  ({ id, fromAtomId, toAtomId, order, ...(bondStyle ? { display: { bondStyle } } : {}) });
const molecule = (id: string, atoms: MoleculeAtom[], bonds: MoleculeBond[], structure: string): MoleculeObject =>
  ({ id, type: "molecule", x: 0, y: 0, width: 100, height: 40, rotation: 0, style: {}, atoms, bonds,
    structureFormat: "smiles", structure, superatoms: [], rGroups: [] } as MoleculeObject);

/** FC(Cl)NC=CC with a wedge from c1 to F: c1 is a stereocentre, c2=c3 is E (y down). */
const stereoMolecule = (wedge = true) => molecule(M, [atom("c1", "C", 300, 300), atom("f", "F", 300, 278), atom("cl", "Cl", 281, 311),
  atom("n", "N", 319, 311), atom("c2", "C", 338, 300), atom("c3", "C", 357, 311), atom("c4", "C", 376, 300)],
[bond("b1", "c1", "f", "single", wedge ? "wedge" : undefined), bond("b2", "c1", "cl"), bond("b3", "c1", "n"), bond("b4", "n", "c2"),
  bond("b5", "c2", "c3", "double"), bond("b6", "c3", "c4")], "FC(Cl)NC=CC");

/** Toluene (ring double bonds) and propene (a terminal double bond): no stereo element at all. */
const TOLUENE = "toluene";
const PROPENE = "propene";
const toluene = () => molecule(TOLUENE, [atom("t1", "C", 100, 100), atom("t2", "C", 119, 89), atom("t3", "C", 138, 100),
  atom("t4", "C", 138, 122), atom("t5", "C", 119, 133), atom("t6", "C", 100, 122), atom("t7", "C", 81, 89)],
[bond("r1", "t1", "t2", "double"), bond("r2", "t2", "t3"), bond("r3", "t3", "t4", "double"), bond("r4", "t4", "t5"),
  bond("r5", "t5", "t6", "double"), bond("r6", "t6", "t1"), bond("r7", "t1", "t7")], "Cc1ccccc1");
const propene = () => molecule(PROPENE, [atom("p1", "C", 100, 400), atom("p2", "C", 119, 411), atom("p3", "C", 138, 400)],
  [bond("q1", "p1", "p2", "double"), bond("q2", "p2", "p3")], "C=CC");

function document(...molecules: MoleculeObject[]): ChemDraftDocument {
  const empty = createEmptyDocument();
  return applyPatches(empty, molecules.map((object) => ({ op: "addObject" as const, pageId: empty.pages[0].id, object })),
    { now: phase4Timestamp });
}
const moleculeById = (doc: ChemDraftDocument, id: string) =>
  doc.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === id)!;
const editAtom = (doc: ChemDraftDocument, id: string, atomId: string, update: (atom: MoleculeAtom) => MoleculeAtom) =>
  applyPatch(doc, { op: "updateObject", objectId: id, changes: {
    atoms: moleculeById(doc, id).atoms.map((candidate) => candidate.id === atomId ? update(candidate) : candidate) } },
  { now: phase4Timestamp });
const editBonds = (doc: ChemDraftDocument, update: (bond: MoleculeBond) => MoleculeBond) =>
  applyPatch(doc, { op: "updateObject", objectId: M, changes: { bonds: moleculeById(doc, M).bonds.map(update) } },
    { now: phase4Timestamp });

const canonical = (doc: ChemDraftDocument, id = M) =>
  Molecule.fromMolfile(stereoPerceptionMolfile(moleculeById(doc, id))).toIsomericSmiles();

/** The commit funnel's check, as MainWindow runs it; `stereoEngine` absent: the module's own engine state. */
const funnel = (before: ChemDraftDocument, after: ChemDraftDocument, policy: CommitChemistryPolicy = PRESERVE_CHEMISTRY,
  stereoEngine?: CommitStereoEngineOption) =>
  policyChemistryRefusals(policy, {
    before, next: after, after: workflow.committedNormalForm(after), normalize: workflow.committedNormalForm,
    markAtoms: workflow.committedElectronMarkAtoms, ...(stereoEngine === undefined ? {} : { stereoEngine })
  });
const exact = (before: ChemDraftDocument, after: ChemDraftDocument, stereoEngine?: CommitStereoEngineOption) =>
  commitChemistryRefusals({ before, next: after, after, normalize: (doc) => doc, markAtoms: workflow.committedElectronMarkAtoms,
    operation: "move", ...(stereoEngine === undefined ? {} : { stereoEngine }) });

const STARTING = `Cannot move yet: checking the stereochemistry of molecule "${M}" is still starting; try again in a moment.`;
const failed = (reason: string, operation = "move") =>
  `Cannot ${operation}: the stereochemistry of molecule "${M}" cannot be checked because the stereo engine failed to load ` +
  `(${reason}); try again, and restart ChemDraft if it keeps failing.`;

afterEach(() => resetCommitStereoEngineForTests());

describe("while the stereo engine is still loading", () => {
  it("refuses a commit that needs the read-back with a temporary message, never skipping it", () => {
    const before = document(stereoMolecule());
    // The wedge moved to another bond of c1: the read-back would accept it, but cannot run yet.
    const moved = editBonds(before, (b) => b.id === "b1" ? { ...b, display: undefined } : b.id === "b2" ? { ...b, display: { bondStyle: "wedge" } } : b);
    expect(canonical(moved)).toBe(canonical(before));
    // The wedge turned to a hash: c1 inverts.
    const inverted = editBonds(before, (b) => b.id === "b1" ? { ...b, display: { bondStyle: "hashed" } } : b);
    expect(canonical(before)).toBe("C/C=C/N[C@H](F)Cl");
    expect(canonical(inverted)).toBe("C/C=C/N[C@@H](F)Cl");
    for (const after of [moved, inverted]) {
      expect(exact(before, after, STEREO_ENGINE_LOADING)).toEqual([STARTING]);
      expect(funnel(before, after, PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING)).toHaveLength(1);
    }
  });

  it("refuses a re-layout of a molecule whose only stereo element is an E/Z double bond", () => {
    const before = document(stereoMolecule(false));
    // c4 swung to the same side of c2=c3 as n: E becomes Z.
    const swung = editAtom(before, M, "c4", (a) => ({ ...a, x: 357, y: 333 }));
    expect(canonical(before)).toBe("C/C=C/NC(F)Cl");
    expect(canonical(swung)).toBe("C/C=C\\NC(F)Cl");
    expect(exact(before, swung, STEREO_ENGINE_LOADING)).toEqual([STARTING]);
  });

  it("never blocks a molecule without any stereo element, and still reports every other invariant", () => {
    const before = document(toluene(), propene());
    const relaid = editAtom(editAtom(before, TOLUENE, "t7", (a) => ({ ...a, x: 70, y: 100 })), PROPENE, "p3", (a) => ({ ...a, x: 140, y: 420 }));
    expect(canonical(relaid, TOLUENE)).toBe(canonical(before, TOLUENE));
    expect(canonical(relaid, PROPENE)).toBe(canonical(before, PROPENE));
    expect(exact(before, relaid, STEREO_ENGINE_LOADING)).toEqual([]);
    expect(funnel(before, relaid, PRESERVE_CHEMISTRY, STEREO_ENGINE_LOADING)).toEqual([]);
    const element = editAtom(before, TOLUENE, "t7", (a) => ({ ...a, element: "N" }));
    expect(exact(before, element, STEREO_ENGINE_LOADING)).toEqual([
      `Cannot move without changing the chemistry of molecule "${TOLUENE}": its atom "t7" would be N instead of C.`]);
  });

  it("never blocks a move, rotate, scale or Flip of a stereo molecule (they cannot change its stereo)", () => {
    const before = document(stereoMolecule());
    const reference = canonical(before);
    const cases: [string, ChemDraftDocument, CommitChemistryPolicy][] = [
      ["move", workflow.moveDocumentObjects(before, [M], 37.5, -12.25), selectionTransformChemistry("move")],
      ["rotate", workflow.rotateDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, 73), selectionTransformChemistry("rotate")],
      ["scale", workflow.scaleDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, 1.7, 0.6), selectionTransformChemistry("resize")]
    ];
    for (const [name, after] of cases) expect(canonical(after), name).toBe(reference);
    cases.push(["flip", workflow.flipDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, "horizontal"), flipChemistry()]);
    for (const [name, after, policy] of cases) {
      expect(funnel(before, after, policy, STEREO_ENGINE_LOADING), name).toEqual([]);
    }
  });
});

describe("after the stereo engine failed to load", () => {
  it("refuses a commit that needs the read-back, naming the failure", () => {
    const before = document(stereoMolecule());
    const inverted = editBonds(before, (b) => b.id === "b1" ? { ...b, display: { bondStyle: "hashed" } } : b);
    expect(exact(before, inverted, { unavailable: "failed", reason: "network error" })).toEqual([failed("network error")]);
    // A molecule without stereo is never blocked.
    const plain = document(toluene());
    const relaid = editAtom(plain, TOLUENE, "t7", (a) => ({ ...a, x: 70, y: 100 }));
    expect(exact(plain, relaid, { unavailable: "failed", reason: "network error" })).toEqual([]);
  });
});

describe("the guard's own engine state (what MainWindow's commit funnel uses)", () => {
  const inverted = () => {
    const before = document(stereoMolecule());
    return [before, editBonds(before, (b) => b.id === "b1" ? { ...b, display: { bondStyle: "hashed" } } : b)] as const;
  };

  it("before any load: refuses as still starting and starts the load; once loaded, reads back", async () => {
    const [before, after] = inverted();
    expect(exact(before, after)).toEqual([STARTING]);
    await loadCommitStereoEngine();
    expect(exact(before, after)).toEqual([
      `Cannot move without changing the chemistry of molecule "${M}": its atom "c1" would read as stereocentre S instead of stereocentre R.`]);
  });

  it("a failed load is named until a retry succeeds; every later commit is still checked, never skipped", async () => {
    const [before, after] = inverted();
    expect(await loadCommitStereoEngine(() => Promise.reject(new Error("chunk ocl-adapter failed to fetch")))).toBeUndefined();
    expect(exact(before, after)).toEqual([failed("chunk ocl-adapter failed to fetch")]);
    expect(exact(before, after)).toEqual([failed("chunk ocl-adapter failed to fetch")]);
    expect(await loadCommitStereoEngine(() => Promise.resolve(ocl))).toBeDefined();
    expect(exact(before, after)).toHaveLength(1);
    expect(exact(before, after)[0]).toMatch(/would read as stereocentre S instead of stereocentre R\.$/);
  });
});

describe("only Flip Horizontal / Vertical may mirror a molecule without the read-back", () => {
  beforeAll(async () => {
    await loadCommitStereoEngine();
  });

  it("refuses a mirror committed by resize, move or rotate, and commits the same mirror under Flip", () => {
    const before = document(stereoMolecule());
    // An exact whole-molecule mirror as any other selection transform could produce it (the app's
    // resize clamps negative scales today; the guard must not depend on that).
    const mirroredByResize = applyPatch(before, { op: "updateObject", objectId: M, changes: {
      atoms: moleculeById(before, M).atoms.map((a) => ({ ...a, x: 660 - a.x })) } }, { now: phase4Timestamp });
    const flipped = workflow.flipDocumentObjectsAroundPoint(before, [M], { x: 330, y: 300 }, "horizontal");
    expect(canonical(before)).toBe("C/C=C/N[C@H](F)Cl");
    expect(canonical(mirroredByResize)).toBe("C/C=C/N[C@@H](F)Cl");
    expect(canonical(flipped)).toBe("C/C=C/N[C@@H](F)Cl");
    const refusal = (operation: string) => [`Cannot ${operation} without changing the chemistry of molecule "${M}": ` +
      'its atom "c1" would read as stereocentre S instead of stereocentre R.'];
    for (const operation of ["resize", "move", "rotate"]) {
      expect(funnel(before, mirroredByResize, selectionTransformChemistry(operation)), operation).toEqual(refusal(operation));
      expect(funnel(before, mirroredByResize, selectionTransformChemistry(operation, new Set())), operation).toEqual(refusal(operation));
    }
    expect(funnel(before, mirroredByResize, selectionTransformChemistry())).toEqual(refusal("complete this edit"));
    expect(funnel(before, flipped, flipChemistry())).toEqual([]);
    expect(funnel(before, flipped, flipChemistry(undefined, new Set()))).toEqual([]);
  });
});
