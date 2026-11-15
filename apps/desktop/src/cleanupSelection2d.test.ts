import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, deserializeDocument, serializeDocument, moleculeToMolfileV3000, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { cleanUpMoleculeSelection2d, cleanUpMoleculeSelections2d, cleanupSelectionAtomIds, createSmilesMolecule,
  type CleanupMoleculeSelection } from "@chemdraft/document-workflow-core";
import { assertConstrainedLayoutIdentity, depictSmiles2D, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { nativeBondOrderResolution, transformPointForObject } from "@chemdraft/layout-engine";
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { applyChargeToolAtNativeAtom, cleanUpNativeMolecules2d, normalizeCommittedDocument } from "./documentWorkflow";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";

const engines = { relayout: relayoutMolfile2D, assertIdentity: assertConstrainedLayoutIdentity };
let rdkit: Awaited<ReturnType<typeof ensureRdkit>>;
beforeAll(async () => { installDomRdkitLoader(); rdkit = await ensureRdkit(); }, 60_000);

function fixture(smiles = "c1ccccc1CCCC", bondLengthPx = 22) {
  const document = createEmptyDocument();
  const molecule = createSmilesMolecule(document, { x: 300, y: 250 }, depictSmiles2D(smiles), smiles,
    undefined, { bondLengthPx });
  document.pages[0]!.objects = [molecule];
  return { document, molecule };
}
function distorted(molecule: MoleculeObject, indices: readonly number[]) {
  return { ...molecule, atoms: molecule.atoms.map((atom, i) => indices.includes(i)
    ? { ...atom, x: atom.x + 14 * (indices.indexOf(i) + 1), y: atom.y + 11 * (indices.indexOf(i) + 1) } : atom) };
}
function selected(molecule: MoleculeObject, indices: readonly number[]): CleanupMoleculeSelection {
  return { atomIds: indices.map(i => molecule.atoms[i]!.id), bondIds: [] };
}
function identity(molecule: MoleculeObject) {
  const molfile = moleculeToMolfileV3000(molecule, { fromDocFrame: true,
    kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents;
  const parsed = rdkit.get_mol(molfile)!;
  expect(parsed).toBeTruthy();
  try {
    const tags = (parsed as typeof parsed & { get_stereo_tags(): string }).get_stereo_tags();
    return { smiles: parsed.get_smiles!(), ...compositionFromRdkitJson(JSON.parse(parsed.get_json!()) as RdkitJson),
      stereo: JSON.parse(tags), atoms: molecule.atoms.length, bonds: molecule.bonds.length };
  } finally { parsed.delete(); }
}
function expectContract(before: MoleculeObject, after: MoleculeObject, selection: CleanupMoleculeSelection, target = 22) {
  const ids = cleanupSelectionAtomIds(before, selection);
  expect(after).not.toBe(before);
  for (const [i, atom] of before.atoms.entries()) {
    if (!ids.has(atom.id)) {
      expect({ x: after.atoms[i]!.x, y: after.atoms[i]!.y }).toEqual({ x: atom.x, y: atom.y });
      expect(after.atoms[i]).toBe(atom);
    }
    const { x: _x, y: _y, ...metadata } = atom;
    const { x: _nx, y: _ny, ...nextMetadata } = after.atoms[i]!;
    expect(nextMetadata).toEqual(metadata);
  }
  expect(after.bonds).toBe(before.bonds);
  expect(after.superatoms).toBe(before.superatoms);
  expect(after.rGroups).toBe(before.rGroups);
  expect(identity(after)).toEqual(identity(before));
  const byId = new Map(after.atoms.map(atom => [atom.id, atom]));
  for (const bond of after.bonds) {
    if (!ids.has(bond.fromAtomId) && !ids.has(bond.toAtomId)) continue;
    const a = byId.get(bond.fromAtomId)!, b = byId.get(bond.toAtomId)!;
    expect(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) / target - 1)).toBeLessThan(0.01);
  }
}

describe("constrained 2D cleanup", () => {
  it.each([22, 30])("tidies a side chain on a fixed ring at %i px with standard lengths and angles", target => {
    const { molecule } = fixture("c1ccccc1CCCC", target);
    const before = distorted(molecule, [6, 7, 8, 9]);
    const selection = selected(before, [6, 7, 8, 9]);
    const after = cleanUpMoleculeSelection2d(before, selection, engines);
    expectContract(before, after, selection, target);
    for (const i of [7, 8]) {
      const a = after.atoms[i - 1]!, b = after.atoms[i]!, c = after.atoms[i + 1]!;
      const cosine = ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) /
        (Math.hypot(a.x - b.x, a.y - b.y) * Math.hypot(c.x - b.x, c.y - b.y));
      expect(cosine).toBeCloseTo(-0.5, 3);
    }
  });

  it("a bond selects both endpoints, without moving the rest of the chain", () => {
    const { molecule } = fixture();
    const before = distorted(molecule, [8, 9]);
    const bond = before.bonds.find(bond => [bond.fromAtomId, bond.toAtomId].every(id =>
      [before.atoms[8]!.id, before.atoms[9]!.id].includes(id)))!;
    const selection = { atomIds: [], bondIds: [bond.id] };
    expectContract(before, cleanUpMoleculeSelection2d(before, selection, engines), selection);
  });

  it.each([false, true])("tidies one ligand while the six-coordinate metal and other ligands stay fixed (dative: %s)", dative => {
    const { molecule } = fixture("[Zn+2](NCC)(NCC)(NCC)(NCC)(NCC)NCC");
    expect(molecule.atoms[0]!.element).toBe("Zn");
    expect(molecule.bonds.filter(bond => [bond.fromAtomId, bond.toAtomId].includes(molecule.atoms[0]!.id))).toHaveLength(6);
    if (dative) molecule.bonds = molecule.bonds.map(bond =>
      [bond.fromAtomId, bond.toAtomId].includes(molecule.atoms[0]!.id)
        ? { ...bond, display: { ...bond.display, bondStyle: "dashed" } } : bond);
    const before = distorted(molecule, [1, 2, 3]);
    const selection = selected(before, [1, 2, 3]);
    expectContract(before, cleanUpMoleculeSelection2d(before, selection, engines), selection);
  });

  it("can move a metal when it is explicitly selected along with a bonded neighbour", () => {
    const { molecule } = fixture("[Zn+2]NCC");
    const before = distorted(molecule, [0, 1, 2]), selection = selected(before, [0, 1, 2]);
    const after = cleanUpMoleculeSelection2d(before, selection, engines);
    expectContract(before, after, selection);
    expect(after.atoms[0]).not.toEqual(before.atoms[0]);
  });

  it("fits a selected ring segment onto two fixed attachments", () => {
    const { molecule } = fixture("C1CCCCC1");
    const before = distorted(molecule, [0, 1, 2]), selection = selected(before, [0, 1, 2]);
    expectContract(before, cleanUpMoleculeSelection2d(before, selection, engines), selection);
  });

  it("keeps a standard angle at the fixed middle carbon between selected pentane fragments", () => {
    const { molecule } = fixture("CCCCC");
    molecule.atoms = molecule.atoms.map((atom, i) => ({ ...atom, x: 250 + i * 22, y: 250 }));
    const before = structuredClone(molecule), selection = selected(molecule, [0, 1, 3, 4]);
    const after = cleanUpMoleculeSelection2d(molecule, selection, engines);
    expectContract(molecule, after, selection);
    const [a, centre, b] = [after.atoms[1]!, after.atoms[2]!, after.atoms[3]!];
    const angle = Math.atan2(Math.abs((a.x - centre.x) * (b.y - centre.y) -
      (a.y - centre.y) * (b.x - centre.x)),
    (a.x - centre.x) * (b.x - centre.x) + (a.y - centre.y) * (b.y - centre.y)) * 180 / Math.PI;
    expect(Math.abs(angle - 120)).toBeLessThan(1);
    expect(molecule).toEqual(before);
  });

  it.each([45, -73, 180])("keeps every unselected atom at its exact rendered position at %i degrees without marks", rotation => {
    const { molecule } = fixture();
    const before = { ...distorted(molecule, [8, 9]), rotation };
    const selection = selected(before, [8, 9]);
    const after = cleanUpMoleculeSelection2d(before, selection, engines);
    expectContract(before, after, selection);
    for (let i = 0; i < 8; i++) {
      expect(transformPointForObject(after, after.atoms[i]!)).toEqual(transformPointForObject(before, before.atoms[i]!));
    }
    expect(transformPointForObject(after, after.atoms[9]!)).not.toEqual(transformPointForObject(before, before.atoms[9]!));
  });

  it.each([22, 30].flatMap(bondLengthPx =>
    (["charge", "lone-pair", "radical-dot"] as const).map(kind => ({ bondLengthPx, kind }))
  ))("keeps the unrotated $kind offset at $bondLengthPx px through normalization and a saved-document round trip", ({ bondLengthPx, kind }) => {
    const { document, molecule } = fixture("c1ccccc1CCCO", bondLengthPx);
    document.pages[0]!.objects = [distorted(molecule, [8, 9])];
    const marked = normalizeCommittedDocument(applyChargeToolAtNativeAtom(document,
      kind === "charge" ? { kind, charge: -1 } : { kind },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id, distanceToPointer: 0 }));
    const before = marked;
    const beforeMolecule = before.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    const beforeMark = before.pages[0]!.objects.find(object => object.type === "electron-mark") as ElectronMarkObject;
    expect(beforeMark.anchor).toEqual({ kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id });
    if (kind === "charge") expect(beforeMolecule.atoms[9]!.formalCharge).toBe(-1);
    if (kind === "radical-dot") expect(beforeMolecule.atoms[9]!.markRadicals).toBe(1);

    const cleaned = cleanUpMoleculeSelections2d(before,
      [{ objectId: molecule.id, ...selected(beforeMolecule, [8, 9]) }], engines);
    const after = normalizeCommittedDocument(cleaned);
    const afterMolecule = after.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    const afterMark = after.pages[0]!.objects.find(object => object.id === beforeMark.id) as ElectronMarkObject;
    const beforeAtom = transformPointForObject(beforeMolecule, beforeMolecule.atoms[9]!);
    const afterAtom = transformPointForObject(afterMolecule, afterMolecule.atoms[9]!);
    expect(Math.hypot(afterAtom.x - beforeAtom.x, afterAtom.y - beforeAtom.y)).toBeGreaterThan(1);
    const beforeRenderedMark = transformPointForObject(beforeMark, beforeMark);
    const afterRenderedMark = transformPointForObject(afterMark, afterMark);
    expect(Math.hypot(
      (afterRenderedMark.x - afterAtom.x) - (beforeRenderedMark.x - beforeAtom.x),
      (afterRenderedMark.y - afterAtom.y) - (beforeRenderedMark.y - beforeAtom.y)
    )).toBeLessThan(1e-6);
    expect(afterMark.anchor).toEqual(beforeMark.anchor);
    expect(afterMolecule.atoms.slice(0, 8)).toEqual(beforeMolecule.atoms.slice(0, 8));
    expect(afterMolecule.atoms.map(({ x: _x, y: _y, ...metadata }) => metadata))
      .toEqual(beforeMolecule.atoms.map(({ x: _x, y: _y, ...metadata }) => metadata));
    expect(afterMolecule.bonds).toEqual(beforeMolecule.bonds);
    expect(identity(afterMolecule)).toEqual(identity(beforeMolecule));
    const reopened = normalizeCommittedDocument(deserializeDocument(serializeDocument(after)));
    const reopenedMolecule = reopened.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    expect(reopenedMolecule.atoms[9]!.formalCharge).toBe(beforeMolecule.atoms[9]!.formalCharge);
    expect(reopenedMolecule.atoms[9]!.markRadicals).toBe(beforeMolecule.atoms[9]!.markRadicals);
    expect(identity(reopenedMolecule)).toEqual(identity(beforeMolecule));
  });

  it.each([45, -73, 180].flatMap(rotation =>
    (["charge", "lone-pair", "radical-dot"] as const).map(kind => ({ rotation, kind }))
  ))("refuses moving atoms with $kind marks at $rotation degrees without changing the document", ({ rotation, kind }) => {
    const { document, molecule } = fixture("c1ccccc1CCCO");
    document.pages[0]!.objects = [distorted(molecule, [8, 9])];
    const marked = structuredClone(normalizeCommittedDocument(applyChargeToolAtNativeAtom(document,
      kind === "charge" ? { kind, charge: -1 } : { kind },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id, distanceToPointer: 0 })));
    const beforeMolecule = marked.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    beforeMolecule.rotation = rotation;
    const before = structuredClone(marked);
    expect(() => cleanUpMoleculeSelections2d(marked,
      [{ objectId: molecule.id, ...selected(beforeMolecule, [8, 9]) }], engines))
      .toThrow(/Clean Up Selection: can't move atoms with electron marks in a rotated or transformed structure/);
    expect(marked).toEqual(before);
  });

  it.each([
    { scaleX: 2, scaleY: 1, rotationDegrees: 0 },
    { scaleX: 1, scaleY: 0.75, rotationDegrees: 0 },
    { scaleX: 1, scaleY: 1, rotationDegrees: 25 },
    { scaleX: 1, scaleY: 1, rotationDegrees: 0, tiltXDegrees: 20 },
    { scaleX: 1, scaleY: 1, rotationDegrees: 0, tiltYDegrees: -20 }
  ])("refuses moving marked atoms with non-identity transform %j", transform => {
    const { document, molecule } = fixture("c1ccccc1CCCO");
    document.pages[0]!.objects = [distorted(molecule, [8, 9])];
    const marked = structuredClone(normalizeCommittedDocument(applyChargeToolAtNativeAtom(document, { kind: "charge", charge: -1 },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[9]!.id, distanceToPointer: 0 })));
    const beforeMolecule = marked.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    beforeMolecule.transform = transform;
    const before = structuredClone(marked);
    expect(() => cleanUpMoleculeSelections2d(marked,
      [{ objectId: molecule.id, ...selected(beforeMolecule, [8, 9]) }], engines)).toThrow(/Clean Up Selection: can't move atoms/);
    expect(marked).toEqual(before);
  });

  it("allows rotated cleanup when marks are only on fixed atoms", () => {
    const { document, molecule } = fixture("Oc1ccccc1CCC");
    document.pages[0]!.objects = [distorted(molecule, [8, 9])];
    const marked = structuredClone(normalizeCommittedDocument(applyChargeToolAtNativeAtom(document, { kind: "charge", charge: -1 },
      { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0]!.id, distanceToPointer: 0 })));
    const beforeMolecule = marked.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    beforeMolecule.rotation = 45;
    const after = cleanUpMoleculeSelections2d(marked,
      [{ objectId: molecule.id, ...selected(beforeMolecule, [8, 9]) }], engines);
    expect(after).not.toBe(marked);
    const afterMolecule = after.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    const expected = cleanUpMoleculeSelection2d(beforeMolecule, selected(beforeMolecule, [8, 9]), engines);
    expectContract(beforeMolecule, expected, selected(beforeMolecule, [8, 9]));
    expect(afterMolecule.atoms).toEqual(expected.atoms);
    expect(after.pages[0]!.objects.find(object => object.type === "electron-mark"))
      .toEqual(marked.pages[0]!.objects.find(object => object.type === "electron-mark"));
  });

  it("refuses incompatible fixed neighbours at a boundary carbon instead of distorting its angles", () => {
    const { molecule } = fixture("CC(CC)C");
    molecule.atoms = molecule.atoms.map((atom, i) => ({ ...atom,
      x: [278, 300, 330, 355, 322][i]!, y: [250, 250, 270, 285, 250][i]! }));
    const before = structuredClone(molecule);
    expect(() => cleanUpMoleculeSelection2d(molecule, selected(molecule, [2, 3]), engines)).toThrow(/standard bond angles/);
    expect(molecule).toEqual(before);
  });

  it("refuses impossible fixed attachments instead of moving them or stretching bonds", () => {
    const { molecule } = fixture("CCCC");
    molecule.atoms[0] = { ...molecule.atoms[0]!, x: 0, y: 0 };
    molecule.atoms[3] = { ...molecule.atoms[3]!, x: 1000, y: 0 };
    const before = structuredClone(molecule);
    expect(() => cleanUpMoleculeSelection2d(molecule, selected(molecule, [1, 2]), engines)).toThrow(/keeping the unselected atoms fixed/);
    expect(molecule).toEqual(before);
  });

  it("refuses to straighten standard chain angles merely to span fixed endpoints", () => {
    const { molecule } = fixture("CCCC");
    molecule.atoms[0] = { ...molecule.atoms[0]!, x: 0, y: 0 };
    molecule.atoms[3] = { ...molecule.atoms[3]!, x: 66, y: 0 };
    expect(() => cleanUpMoleculeSelection2d(molecule, selected(molecule, [1, 2]), engines)).toThrow(/standard bond angles/);
  });

  it("deliberately leaves a single selected atom with no selected neighbours unchanged", () => {
    const { molecule } = fixture();
    const before = distorted(molecule, [9]);
    const relayout = vi.fn(engines.relayout);
    expect(cleanUpMoleculeSelection2d(before, selected(before, [9]), { ...engines, relayout })).toBe(before);
    expect(relayout).not.toHaveBeenCalled();
  });

  it("keeps isotope, charge and radical atom metadata and canonical chemistry", () => {
    const { molecule } = fixture("c1ccccc1CC[13CH2][O-]");
    // Exercise the native isotope field directly; the low-level depiction is geometry only.
    molecule.atoms[8] = { ...molecule.atoms[8]!, isotope: 13 };
    const before = distorted(molecule, [6, 7, 8, 9]);
    // Explicit radical metadata stays on its native atom; it is never rebuilt from the engine.
    before.atoms[6] = { ...before.atoms[6]!, markRadicals: 1 };
    const selection = selected(before, [6, 7, 8, 9]);
    expect(identity(before).radicalElectronCount).toBeGreaterThan(0);
    expect(identity(before).formalCharge).toBe(-1);
    expect(before.atoms.some(atom => atom.isotope === 13)).toBe(true);
    expectContract(before, cleanUpMoleculeSelection2d(before, selection, engines), selection);
  });

  it.each(["N[C@@H](F)CCCO", "F/C=C/CCCO"])("preserves the drawn R/S or E/Z in %s", smiles => {
    const { molecule } = fixture(smiles);
    const indices = [molecule.atoms.length - 3, molecule.atoms.length - 2, molecule.atoms.length - 1];
    const before = distorted(molecule, indices), selection = selected(before, indices);
    expectContract(before, cleanUpMoleculeSelection2d(before, selection, engines), selection);
  });

  it("refuses a final geometry that inverts a stereocentre, leaving the document untouched", () => {
    const { molecule, document } = fixture("N[C@@H](F)CCCO");
    const selection = selected(molecule, [0, 1, 2, 3]);
    const before = structuredClone(document);
    // A hostile engine reflects only the selected part; wedges remain native and must fail read-back.
    const relayout = (molfile: string) => {
      const depiction = relayoutMolfile2D(molfile);
      return { ...depiction, atoms: depiction.atoms.map(atom => ({ ...atom, x: -atom.x })) };
    };
    expect(() => cleanUpMoleculeSelections2d(document, [{ ...selection, objectId: molecule.id }],
      { ...engines, relayout })).toThrow(/stereochemistry/);
    expect(document).toEqual(before);
  });

  it("refuses a layout that flips one selected alkene ligand across its fixed double-bond axis", () => {
    const { molecule } = fixture("F/C=C/CCCO");
    const before = structuredClone(molecule);
    const relayout: typeof engines.relayout = (molfile, options) => {
      const depiction = relayoutMolfile2D(molfile, options);
      const a = depiction.atoms[1]!, b = depiction.atoms[2]!, ligand = depiction.atoms[0]!;
      const ux = b.x - a.x, uy = b.y - a.y, vx = ligand.x - a.x, vy = ligand.y - a.y;
      const projection = (ux * vx + uy * vy) / (ux * ux + uy * uy);
      return { ...depiction, atoms: depiction.atoms.map((atom, i) => i === 0
        ? { ...atom, x: a.x + 2 * ux * projection - vx, y: a.y + 2 * uy * projection - vy } : atom) };
    };
    expect(() => cleanUpMoleculeSelection2d(molecule, selected(molecule, [0, 1]),
      { ...engines, relayout })).toThrow(/stereochemistry/);
    expect(molecule).toEqual(before);
  });

  it("no selection and whole-molecule selection leave the established whole cleanup path unchanged", () => {
    const { molecule, document } = fixture();
    const before = distorted(molecule, [6, 7, 8, 9]);
    document.pages[0]!.objects = [before];
    const relayout = vi.fn(engines.relayout);
    expect(cleanUpMoleculeSelection2d(before, { atomIds: [], bondIds: [] }, { ...engines, relayout })).toBe(before);
    expect(cleanUpMoleculeSelection2d(before, selected(before, before.atoms.map((_, i) => i)),
      { ...engines, relayout })).toBe(before);
    expect(relayout).not.toHaveBeenCalled();
    expect(cleanUpMoleculeSelections2d(document, [], engines)).toBe(document);
    const legacy = cleanUpNativeMolecules2d(document, [before.id]);
    expect(cleanUpMoleculeSelections2d(legacy, [{ objectId: before.id, ...selected(before, before.atoms.map((_, i) => i)) }], engines)).toBe(legacy);
    expect(identity(legacy.pages[0]!.objects[0] as MoleculeObject)).toEqual(identity(before));
  });
});
