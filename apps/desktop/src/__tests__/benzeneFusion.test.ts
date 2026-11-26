// Fusing a benzene ring onto a bond (the ring tool clicked on a bond, or the benzene hotkey on a
// hovered bond) must build an aromatic ring there and leave every other ring of the molecule as
// it was. It used to re-choose the double bonds of every six-membered carbon ring with two or more
// double bonds anywhere in the molecule, turning cyclohexadienes into benzenes, rearranging
// quinones and dienones into pentavalent carbons, and so on.
import { beforeAll, describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { moleculeSmiles } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  applyNativeTemplateToolAtTarget,
  createPhase4Document,
  insertSmilesMolecule,
  nativeMoleculeInvalidAtomStates,
  nativeRingHotkeyFuseAtBondTarget,
  planNativeTemplatePlacement,
  type NativeMoleculeDeleteTarget
} from "../documentWorkflow";

beforeAll(() => installNodeRdkitModuleLoader());

const canonical = (graph: MoleculeObject) => moleculeSmiles(graph, 0, [], computeStructureIdentifiers);

function moleculeById(document: ChemDraftDocument, id: string): MoleculeObject {
  const molecule = document.pages[0]?.objects.find((object): object is MoleculeObject =>
    object.id === id && object.type === "molecule"
  );
  if (!molecule) throw new Error(`molecule ${id} missing`);
  return molecule;
}

function fromSmiles(smiles: string): { document: ChemDraftDocument; molecule: MoleculeObject } {
  const document = insertSmilesMolecule(
    createPhase4Document(`Benzene fusion ${smiles}`),
    { x: 400, y: 400 },
    depictSmiles2D(smiles),
    smiles
  );
  const molecule = document.pages[0]?.objects.find((object): object is MoleculeObject => object.type === "molecule");
  if (!molecule) throw new Error(`no molecule for ${smiles}`);
  return { document, molecule };
}

async function canonicalOfSmiles(smiles: string): Promise<{ smiles: string; formula: string | undefined }> {
  const { molecule } = fromSmiles(smiles);
  return { smiles: await canonical(molecule), formula: molecule.chemistry?.formula };
}

function degree(molecule: MoleculeObject, atomId: string): number {
  return molecule.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function neighbours(molecule: MoleculeObject, atomId: string): string[] {
  return molecule.bonds.flatMap((bond) =>
    bond.fromAtomId === atomId ? [bond.toAtomId] : bond.toAtomId === atomId ? [bond.fromAtomId] : []
  );
}

function bondTarget(molecule: MoleculeObject, bond: MoleculeBond): NativeMoleculeDeleteTarget {
  return {
    objectId: molecule.id,
    kind: "bond",
    bondId: bond.id,
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    distanceToPointer: 0
  } as NativeMoleculeDeleteTarget;
}

/** The end bond of the molecule's only n-butyl chain: CH3–CH2. */
function butylEndBond(molecule: MoleculeObject): MoleculeBond {
  const bonds = molecule.bonds.filter((bond) => {
    const ends = [bond.fromAtomId, bond.toAtomId];
    return ends.some((id) => degree(molecule, id) === 1) && ends.some((id) => degree(molecule, id) === 2);
  });
  expect(bonds).toHaveLength(1);
  return bonds[0]!;
}

/** An isopropyl CH–CH3 bond: a methyl whose neighbour carries a second methyl. */
function isopropylMethylBond(molecule: MoleculeObject): MoleculeBond {
  const bond = molecule.bonds.find((candidate) => {
    const methyl = [candidate.fromAtomId, candidate.toAtomId].find((id) => degree(molecule, id) === 1);
    const other = methyl === candidate.fromAtomId ? candidate.toAtomId : candidate.fromAtomId;
    return methyl !== undefined &&
      neighbours(molecule, other).filter((id) => id !== methyl && degree(molecule, id) === 1).length === 1;
  });
  if (!bond) throw new Error("no isopropyl bond");
  return bond;
}

/** A page point on the side of the bond facing away from the molecule, as a user would click. */
function outsidePoint(molecule: MoleculeObject, bond: MoleculeBond) {
  const from = molecule.atoms.find((atom) => atom.id === bond.fromAtomId)!;
  const to = molecule.atoms.find((atom) => atom.id === bond.toAtomId)!;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const centre = molecule.atoms.reduce(
    (sum, atom) => ({ x: sum.x + atom.x / molecule.atoms.length, y: sum.y + atom.y / molecule.atoms.length }),
    { x: 0, y: 0 }
  );
  let away = { x: mid.x - centre.x, y: mid.y - centre.y };
  if (Math.hypot(away.x, away.y) < 1e-3) away = { x: -(to.y - from.y), y: to.x - from.x };
  const length = Math.hypot(away.x, away.y);
  return { x: mid.x + (away.x / length) * 6, y: mid.y + (away.y / length) * 6 };
}

type Route = "tool" | "hotkey";
type Fusion = { fused?: MoleculeObject; refused: boolean; document: ChemDraftDocument };

function fuse(route: Route, document: ChemDraftDocument, molecule: MoleculeObject, bond: MoleculeBond): Fusion {
  const target = bondTarget(molecule, bond);
  if (route === "hotkey") {
    const result = nativeRingHotkeyFuseAtBondTarget(document, target, "benzene");
    return result.refusal
      ? { refused: true, document: result.document }
      : { refused: false, document: result.document, fused: moleculeById(result.document, molecule.id) };
  }
  const point = outsidePoint(molecule, bond);
  const plan = planNativeTemplatePlacement(document, { point, target }, "benzene");
  const next = applyNativeTemplateToolAtTarget(document, target, point, "benzene");
  if (plan?.kind !== "fuse-bond" && plan?.kind !== "fused-closure") {
    return { refused: true, document: next };
  }
  return { refused: false, document: next, fused: moleculeById(next, molecule.id) };
}

/**
 * Every bond that existed before keeps its order, and the new ring is a Kekulé benzene: each of
 * its atoms carries one double bond (at least one where `overfilled`, for a fusion atom that
 * already had its own and is flagged instead). Where `overfilled`, an existing single bond
 * between two atoms of the new ring may become one of its double bonds.
 */
function expectOnlyNewRingAdded(
  before: MoleculeObject,
  after: MoleculeObject,
  target: MoleculeBond,
  aromaticBondIds = new Set<string>(),
  overfilled = false
) {
  const newAtomIds = new Set(after.atoms.filter((atom) => !before.atoms.some((old) => old.id === atom.id)).map((atom) => atom.id));
  // Four new atoms, or three when the ring closed onto an existing atom.
  expect([3, 4]).toContain(newAtomIds.size);
  // Every atom of the new ring (the new atoms and the existing atoms they bond to) carries
  // exactly one double bond.
  const fusionAtomIds = new Set([
    target.fromAtomId,
    target.toAtomId,
    ...after.bonds
      .filter((bond) => newAtomIds.has(bond.fromAtomId) !== newAtomIds.has(bond.toAtomId))
      .flatMap((bond) => [bond.fromAtomId, bond.toAtomId])
      .filter((id) => !newAtomIds.has(id))
  ]);
  expect(fusionAtomIds.size).toBe(6 - newAtomIds.size);
  before.bonds.forEach((bond) => {
    if (aromaticBondIds.has(bond.id)) return;
    const order = after.bonds.find((candidate) => candidate.id === bond.id)?.order;
    if (overfilled && bond.order === "single" && order === "double" &&
      fusionAtomIds.has(bond.fromAtomId) && fusionAtomIds.has(bond.toAtomId)) return;
    expect(order, `bond ${bond.id}`).toBe(bond.order);
  });
  [...newAtomIds, ...fusionAtomIds].forEach((atomId) => {
    const doubles = after.bonds.filter((bond) =>
      bond.order === "double" && (bond.fromAtomId === atomId || bond.toAtomId === atomId)
    );
    if (overfilled && fusionAtomIds.has(atomId)) {
      expect(doubles.length, `atom ${atomId} double bonds`).toBeGreaterThanOrEqual(1);
    } else {
      expect(doubles, `atom ${atomId} double bonds`).toHaveLength(1);
    }
  });
  if (!overfilled) {
    expect(nativeMoleculeInvalidAtomStates(after)).toEqual([]);
  }
}

const routes: Route[] = ["tool", "hotkey"];

describe.each(routes)("benzene fused onto a bond (%s route)", (route) => {
  const sideChainRows = [
    { name: "1,3-cyclohexadiene with a butyl chain", smiles: "CCCCC1C=CC=CC1", product: "c1ccc(CCC2C=CC=CC2)cc1", formula: "C14H16" },
    { name: "1,4-cyclohexadiene with a butyl chain", smiles: "CCCCC1C=CCC=C1", product: "c1ccc(CCC2C=CCC=C2)cc1", formula: "C14H16" },
    { name: "a partly saturated tricycle", smiles: "CCCCC1CCC2=CC=C3CCCCC3C2C1", product: "c1ccc(CCC2CCC3=CC=C4CCCCC4C3C2)cc1" },
    { name: "a quinone", smiles: "CCCCC1=CC(=O)C=CC1=O", product: "c1ccc(CCC2=CC(=O)C=CC2=O)cc1" },
    { name: "a dienone", smiles: "CCCCC1CC2C=CC(=O)C=C2CC1", product: "c1ccc(CCC2CC3C=CC(=O)C=C3CC2)cc1" }
  ];

  it("leaves cyclohexa-2,4-dien-1-one untouched when benzene is fused onto its ethyl arm", async () => {
    // The old re-pairing gave the dienone ring a third double bond and a pentavalent C=O carbon.
    const { document, molecule } = fromSmiles("CCC1C=CC=CC1=O");
    const target = butylEndBond(molecule);
    const result = fuse(route, document, molecule, target);

    expect(result.refused).toBe(false);
    const fused = result.fused!;
    const expected = await canonicalOfSmiles("O=C1C=CC=CC1c1ccccc1");
    expect(await canonical(fused)).toBe(expected.smiles);
    expect(fused.chemistry?.formula).toBe("C12H10O");
    expectOnlyNewRingAdded(molecule, fused, target);
  });

  it.each(sideChainRows)("leaves $name untouched when benzene is fused onto the chain end", async (row) => {
    const { document, molecule } = fromSmiles(row.smiles);
    const beforeSmiles = await canonical(molecule);
    const target = butylEndBond(molecule);
    const result = fuse(route, document, molecule, target);

    expect(result.refused).toBe(false);
    const fused = result.fused!;
    const expected = await canonicalOfSmiles(row.product);
    expect(await canonical(fused)).toBe(expected.smiles);
    expect(fused.chemistry?.formula).toBe(expected.formula);
    if (row.formula) expect(fused.chemistry?.formula).toBe(row.formula);
    expectOnlyNewRingAdded(molecule, fused, target);
    // The original molecule's canonical SMILES did not change shape either (sanity: the input is
    // what the row says).
    expect(beforeSmiles).toBe((await canonicalOfSmiles(row.smiles)).smiles);
  });

  it("fuses benzene across gamma-terpinene's isopropyl CH–CH3 and leaves the diene ring alone", async () => {
    // The hexagon on the isopropyl CH–CH3 bond closes onto the isopropyl's other methyl, so the
    // isopropyl group becomes the new benzene's ipso carbon and two ortho carbons: a phenyl on
    // the intact cyclohexa-1,4-diene. The old code also turned the diene into a toluene ring
    // (4-methylbiphenyl).
    const { document, molecule } = fromSmiles("CC1=CCC(=CC1)C(C)C");
    const target = isopropylMethylBond(molecule);
    const result = fuse(route, document, molecule, target);

    expect(result.refused).toBe(false);
    const fused = result.fused!;
    const expected = await canonicalOfSmiles("CC1=CCC(c2ccccc2)=CC1");
    expect(await canonical(fused)).toBe(expected.smiles);
    expect(fused.chemistry?.formula).toBe("C13H14");
    // The closure reused the CH–CH3 bond to the other methyl; it becomes one of the new ring's
    // double bonds. Every other existing bond keeps its order.
    expectOnlyNewRingAdded(molecule, fused, target, new Set(), true);
    expect(nativeMoleculeInvalidAtomStates(fused)).toEqual([]);
  });

  it("fuses benzene onto each 1,3-cyclohexadiene ring bond without rewriting the diene", async () => {
    const { document, molecule } = fromSmiles("C1=CC=CCC1");
    const dihydronaphthalene = await canonicalOfSmiles("C1Cc2ccccc2C=C1");
    const naphthalene = await canonicalOfSmiles("c1ccc2ccccc2c1");
    const hasDouble = (atomId: string) => molecule.bonds.some((bond) =>
      bond.order === "double" && (bond.fromAtomId === atomId || bond.toAtomId === atomId)
    );

    for (const bond of molecule.bonds) {
      const result = fuse(route, document, molecule, bond);
      const sp2Ends = [bond.fromAtomId, bond.toAtomId].filter(hasDouble).length;
      if (bond.order === "double") {
        // On a ring C=C the double bond is shared: 1,2-dihydronaphthalene, diene kept.
        expect(result.refused, `bond ${bond.id}`).toBe(false);
        expect(await canonical(result.fused!)).toBe(dihydronaphthalene.smiles);
        expect(result.fused!.chemistry?.formula).toBe("C10H10");
        expectOnlyNewRingAdded(molecule, result.fused!, bond);
      } else if (sp2Ends === 0) {
        // Onto the CH2–CH2 bond: both CH2 become aromatic ring carbons and the old ring's two
        // C=C bonds, untouched, complete a naphthalene Kekulé structure.
        expect(result.refused, `bond ${bond.id}`).toBe(false);
        expect(await canonical(result.fused!)).toBe(naphthalene.smiles);
        expect(result.fused!.chemistry?.formula).toBe("C10H8");
        expectOnlyNewRingAdded(molecule, result.fused!, bond);
      } else {
        // A fusion atom already carries a ring C=C outside the new ring that is not part of an
        // aromatic ring: the new ring cannot be aromatic without moving the diene's double
        // bonds. The diene keeps its bonds; the new ring stays aromatic and the overfilled
        // fusion atom is flagged, as for any overfilled ring placement.
        expect(result.refused, `bond ${bond.id}`).toBe(false);
        expectOnlyNewRingAdded(molecule, result.fused!, bond, new Set(), true);
        expect(nativeMoleculeInvalidAtomStates(result.fused!).length, `bond ${bond.id}`).toBeGreaterThan(0);
        expect(await canonical(result.fused!)).not.toBe(naphthalene.smiles);
      }
    }
  });

  it("still fuses benzene onto benzene as naphthalene", async () => {
    for (const bondIndex of [0, 1]) {
      const { document, molecule } = fromSmiles("c1ccccc1");
      const bond = molecule.bonds[bondIndex]!;
      const result = fuse(route, document, molecule, bond);
      expect(result.refused).toBe(false);
      expect(await canonical(result.fused!)).toBe((await canonicalOfSmiles("c1ccc2ccccc2c1")).smiles);
      expect(result.fused!.chemistry?.formula).toBe("C10H8");
      // Kekulé positions inside the original benzene may be re-chosen; every carbon of the
      // naphthalene still carries exactly one double bond.
      expectOnlyNewRingAdded(molecule, result.fused!, bond, new Set(molecule.bonds.map((candidate) => candidate.id)));
      result.fused!.atoms.forEach((atom) => {
        expect(result.fused!.bonds.filter((candidate) =>
          candidate.order === "double" && (candidate.fromAtomId === atom.id || candidate.toAtomId === atom.id)
        )).toHaveLength(1);
      });
    }
  });

  it("leaves benzene and cyclohexene elsewhere in the molecule unchanged", async () => {
    for (const [smiles, product] of [
      ["CCCCc1ccccc1", "c1ccc(CCc2ccccc2)cc1"],
      ["CCCCC1CC=CCC1", "c1ccc(CCC2CC=CCC2)cc1"]
    ] as const) {
      const { document, molecule } = fromSmiles(smiles);
      const target = butylEndBond(molecule);
      const result = fuse(route, document, molecule, target);
      expect(result.refused).toBe(false);
      expect(await canonical(result.fused!)).toBe((await canonicalOfSmiles(product)).smiles);
      expectOnlyNewRingAdded(molecule, result.fused!, target);
    }
  });
});
