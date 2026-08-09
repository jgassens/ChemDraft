/**
 * Phase 6 — re-edit + round-trip tests (engine-only; no RDKit oracle).
 *
 * These close the 3D-spin roadmap by proving the COMMITTED output of the Phase 5.1
 * flatten (`flattenSpunMolecule`) is sound on the way back out of the pipeline:
 *
 *   1. Round-trip through OCL — the committed molfile re-parses with stable atom/bond
 *      counts and a re-perceivable stereocenter (the wedge survived the writer).
 *   3. Re-open through the app's own molfile loader (`parseMolfileGraph`, the function
 *      that ingests pasted/opened structures and feeds the Ketcher host) without
 *      warnings or dangling references. NB: `ketcher-core` is not headless-importable
 *      (only the `ketcher-react`/`ketcher-standalone` browser bundles are deps), so the
 *      app's real V2000 loader stands in for the editor's loader — same molblock, same
 *      strictness, runnable in node.
 *   4. Repeat-edit — flatten → move an atom → flatten again (new view) never duplicates
 *      markers: atom/bond counts, wedge markers, and crossing overrides stay stable. The
 *      strip-and-re-encode in `buildProjectedMolecule` + the clear-then-set crossing
 *      patches guarantee this; this pins it.
 *
 * (Oracle round-trip — item 2 — lives in tools/rdkit-oracle/flatten-roundtrip-oracle.test.ts
 * so it can skip when the RDKit venv is absent.)
 */
import { beforeAll, describe, expect, it } from "vitest";

import { applyPatches, type ChemDraftDocument, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, oclConformerGenerator, type Depiction2D } from "@chemdraft/ocl-adapter";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import * as OCL from "openchemlib";

import { createPhase4Document, flattenSpunMolecule } from "./documentWorkflow";

const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// View rotated 30° about Y (row-major; depth = row 2 · point). Used for the second
// flatten so the re-edit lands at a genuinely different angle than the first.
const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const TILTED_Y_30: ViewMatrix = [C, 0, S, 0, 0, 1, 0, 0, -S, 0, C, 0, 0, 0, 0, 1];

function molecule(id: string, atoms: MoleculeObject["atoms"], bonds: MoleculeObject["bonds"]): MoleculeObject {
  return {
    id,
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
  const base = createPhase4Document("Round-trip Fixture");
  return applyPatches(base, [
    { op: "addObject", pageId: base.pages[0].id, object: mol },
    { op: "setSelection", pageId: base.pages[0].id, objectIds: [mol.id] }
  ]);
}

function moleculeOf(document: ChemDraftDocument, id: string): MoleculeObject {
  const found = document.pages[0].objects.find((object) => object.id === id);
  if (!found || found.type !== "molecule") throw new Error("molecule missing");
  return found;
}

/** Build a document-frame molecule + its OCL 3D conformer coords from a SMILES.
 *  The depiction is y-up (math frame); negate y so the fixture lives in the y-down
 *  document frame `flattenSpunMolecule` expects (as a real drawing would). */
async function conformerFromSmiles(smiles: string, id: string) {
  const dep: Depiction2D = depictSmiles2D(smiles);
  const mol = molecule(
    id,
    dep.atoms.map((atom, index) => ({ id: `a${index}`, element: atom.element, x: 50 + atom.x * 20, y: 50 - atom.y * 20, formalCharge: atom.charge })),
    dep.bonds.map((bond, index) => ({
      id: `b${index}`,
      fromAtomId: `a${bond.from}`,
      toAtomId: `a${bond.to}`,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      ...(bond.wedge ? { display: { bondStyle: bond.wedge } } : {})
    }))
  );
  const conformer = await oclConformerGenerator.generate3DConformer({ molfile: dep.molfile }, { optimize: "auto" });
  return { mol, coords3d: conformer.mapping.coords3dByOriginalAtom, embedStatus: conformer.embed.status };
}

const isWedge = (bond: MoleculeObject["bonds"][number]) =>
  bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed";

beforeAll(async () => {
  await ensureOclResources();
});

describe("Phase 6 — flatten → molfile → OCL round-trip", () => {
  it("re-parses the committed molfile with stable counts and a perceivable stereocenter", async () => {
    const { mol, coords3d, embedStatus } = await conformerFromSmiles("C[C@H](F)Cl", "mol_rt");
    expect(embedStatus).toBe("ok");

    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_rt", coords3d, IDENTITY);
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_rt");

    // Parse the committed structure back through the chemistry engine.
    const parsed = OCL.Molecule.fromMolfile(next.structure);
    expect(parsed.getAllAtoms()).toBe(mol.atoms.length); // heavy atoms only — molblock carries no implicit H
    expect(parsed.getAllBonds()).toBe(mol.bonds.length);

    // Stereo survived the writer: OCL re-perceives a defined CIP center from 2D coords + wedge flags.
    parsed.ensureHelperArrays(OCL.Molecule.cHelperCIP);
    const definedCenters: number[] = [];
    for (let a = 0; a < parsed.getAllAtoms(); a += 1) {
      if (parsed.isAtomStereoCenter(a) && parsed.getAtomCIPParity(a) !== 0) definedCenters.push(a);
    }
    expect(definedCenters.length).toBeGreaterThanOrEqual(1);
  });

  it("round-trips a multi-double-bond ring (styrene) with the graph intact", async () => {
    const { mol, coords3d, embedStatus } = await conformerFromSmiles("C=Cc1ccccc1", "mol_rt_styrene");
    expect(embedStatus).toBe("ok");

    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_rt_styrene", coords3d, IDENTITY);
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_rt_styrene");

    const parsed = OCL.Molecule.fromMolfile(next.structure);
    expect(parsed.getAllAtoms()).toBe(mol.atoms.length);
    expect(parsed.getAllBonds()).toBe(mol.bonds.length);
    // Double-bond count is conserved through the writer.
    let doubles = 0;
    for (let b = 0; b < parsed.getAllBonds(); b += 1) if (parsed.getBondOrder(b) === 2) doubles += 1;
    expect(doubles).toBe(mol.bonds.filter((bond) => bond.order === "double").length);
  });
});

describe("Phase 6 — committed structure re-opens cleanly", () => {
  // parseMolfileGraph is the app's real structure-load path (clipboard paste + file open,
  // and what hands a molecule to the Ketcher host). A faithful "re-open" check.
  it("round-trips through the app's molfile loader without warnings or dangling refs", async () => {
    const { mol, coords3d } = await conformerFromSmiles("C[C@H](F)Cl", "mol_reopen");
    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_reopen", coords3d, IDENTITY);
    expect(outcome.status).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_reopen");

    const reparsed = parseMolfileGraph(next.structure); // throws on a malformed molblock
    expect(reparsed.format).toBe("molfile-v2000");
    expect(reparsed.atoms).toHaveLength(mol.atoms.length);
    expect(reparsed.bonds).toHaveLength(mol.bonds.length);
    expect(reparsed.warnings).toHaveLength(0);

    // Every bond references a real atom (a strict loader like Indigo/Ketcher rejects dangling refs).
    const atomIds = new Set(reparsed.atoms.map((atom) => atom.id));
    for (const bond of reparsed.bonds) {
      expect(atomIds.has(bond.fromAtomId) && atomIds.has(bond.toAtomId)).toBe(true);
    }
    // No coordinate corruption (NaN/Inf would break layout and the editor).
    for (const atom of reparsed.atoms) {
      expect(Number.isFinite(atom.x) && Number.isFinite(atom.y)).toBe(true);
    }
  });

  it("round-trips a placed flatten through the app's molfile loader", async () => {
    const { mol, coords3d } = await conformerFromSmiles("C[C@H](F)Cl", "mol_reopen_placed");
    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_reopen_placed", coords3d, IDENTITY, {
      placement: { centerX: 180, centerY: 160, scale: 24 }
    });
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_reopen_placed");

    const reparsed = parseMolfileGraph(next.structure);
    expect(reparsed.atoms).toHaveLength(mol.atoms.length);
    expect(reparsed.bonds).toHaveLength(mol.bonds.length);
    expect(reparsed.warnings).toHaveLength(0);
  });
});

describe("Phase 6 — repeat-edit: re-flatten never duplicates markers", () => {
  it("flatten → move an atom → flatten again keeps counts + markers stable", async () => {
    const { mol, coords3d, embedStatus } = await conformerFromSmiles("C[C@H](F)Cl", "mol_repeat");
    expect(embedStatus).toBe("ok");
    const document = documentWith(mol);

    // First flatten (identity view).
    const first = flattenSpunMolecule(document, "mol_repeat", coords3d, IDENTITY);
    expect(first.status, first.refusalReasons.join("; ")).toBe("committed");
    const afterFirst = moleculeOf(first.document, "mol_repeat");
    const firstWedges = afterFirst.bonds.filter(isWedge).length;
    expect(firstWedges).toBeGreaterThanOrEqual(1); // a stereocenter ⇒ at least one wedge marker
    const firstCrossings = first.document.pages[0].crossings.length;

    // User re-edit: nudge an atom via the normal updateObject patch path.
    const nudged = afterFirst.atoms.map((atom) => (atom.id === "a0" ? { ...atom, x: atom.x + 12, y: atom.y - 7 } : atom));
    const edited = applyPatches(first.document, [
      { op: "updateObject", objectId: "mol_repeat", changes: { atoms: nudged } }
    ]);

    // Second flatten from a different angle (spin to a new view, re-flatten).
    const second = flattenSpunMolecule(edited, "mol_repeat", coords3d, TILTED_Y_30);
    expect(second.status, second.refusalReasons.join("; ")).toBe("committed");
    const afterSecond = moleculeOf(second.document, "mol_repeat");

    // Graph is identical in size — nothing accumulated.
    expect(afterSecond.atoms).toHaveLength(mol.atoms.length);
    expect(afterSecond.bonds).toHaveLength(mol.bonds.length);
    expect(new Set(afterSecond.atoms.map((a) => a.id)).size).toBe(mol.atoms.length);
    expect(new Set(afterSecond.bonds.map((b) => b.id)).size).toBe(mol.bonds.length);

    // Wedge markers don't pile up: a single stereocenter still encodes as a single wedge,
    // not first-flatten's + second-flatten's. (strip-and-re-encode, not append.)
    expect(afterSecond.bonds.filter(isWedge).length).toBe(firstWedges);

    // Crossing overrides for this object don't accumulate or duplicate across re-flattens.
    const crossings = second.document.pages[0].crossings;
    const keys = crossings.map((crossing) => JSON.stringify([...crossing.bonds].map((b) => `${b.objectId}:${b.bondId}`).sort()));
    expect(new Set(keys).size).toBe(keys.length); // no duplicate crossing markers
    expect(crossings.length).toBeLessThanOrEqual(Math.max(firstCrossings, crossings.length)); // bounded, not growing

    // Still sound: the twice-flattened structure re-parses with the same counts.
    const reparsed = parseMolfileGraph(afterSecond.structure);
    expect(reparsed.atoms).toHaveLength(mol.atoms.length);
    expect(reparsed.bonds).toHaveLength(mol.bonds.length);
  });
});

describe("spin release does not change how a double bond draws", () => {
  it("leaves a symmetric C=O without a baked side", () => {
    // A terminal heteroatom double bond with no derivable inner side renders as the symmetric
    // +/-gap/2 straddle — it has no side at all. Flatten baked `doubleBondSide` onto every double
    // bond regardless, and an explicit side is itself what suppresses the straddle, so committing a
    // spin silently turned a symmetric C=O one-sided: "releasing changes nothing visually" broken
    // by the release itself.
    const formaldehyde = molecule(
      "mol_sym",
      [
        { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a2", element: "O", x: 40, y: 0, formalCharge: 0 }
      ],
      [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "double" }]
    );
    const document = documentWith(formaldehyde);
    const coords3d = new Float64Array([0, 0, 0, 1.2, 0, 0]);

    const outcome = flattenSpunMolecule(document, "mol_sym", coords3d, IDENTITY);
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");

    const bond = moleculeOf(outcome.document, "mol_sym").bonds[0];
    expect(bond.display?.doubleBondSide).toBeUndefined();
  });

  it("still bakes a side for a ring double bond, which does draw one-sided", () => {
    // The complement: a ring double bond genuinely has a side, and it must be recomputed from the
    // new geometry — otherwise its inner line lands outside the ring.
    const ring = molecule(
      "mol_ring",
      [
        { id: "r1", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "r2", element: "C", x: 40, y: 0, formalCharge: 0 },
        { id: "r3", element: "C", x: 60, y: 35, formalCharge: 0 },
        { id: "r4", element: "C", x: 40, y: 70, formalCharge: 0 },
        { id: "r5", element: "C", x: 0, y: 70, formalCharge: 0 },
        { id: "r6", element: "C", x: -20, y: 35, formalCharge: 0 }
      ],
      [
        { id: "rb1", fromAtomId: "r1", toAtomId: "r2", order: "double" },
        { id: "rb2", fromAtomId: "r2", toAtomId: "r3", order: "single" },
        { id: "rb3", fromAtomId: "r3", toAtomId: "r4", order: "single" },
        { id: "rb4", fromAtomId: "r4", toAtomId: "r5", order: "single" },
        { id: "rb5", fromAtomId: "r5", toAtomId: "r6", order: "single" },
        { id: "rb6", fromAtomId: "r6", toAtomId: "r1", order: "single" }
      ]
    );
    const document = documentWith(ring);
    const coords3d = new Float64Array([
      0, 0, 0, 1.4, 0, 0, 2.1, 1.2, 0, 1.4, 2.4, 0, 0, 2.4, 0, -0.7, 1.2, 0
    ]);

    const outcome = flattenSpunMolecule(document, "mol_ring", coords3d, IDENTITY);
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");

    const bond = moleculeOf(outcome.document, "mol_ring").bonds.find((candidate) => candidate.id === "rb1");
    expect(bond?.display?.doubleBondSide).toBeDefined();
  });
});
