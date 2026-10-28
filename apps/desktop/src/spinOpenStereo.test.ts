import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deserializeDocument, serializeDocument, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { depictSmiles2D, perceiveStereoCentersFromMolfile, perceiveDoubleBondStereoFromMolfile, storedCoordinatesMatchStereo } from "@chemdraft/ocl-adapter";
import { compositionFromRdkitJson, ensureRdkit, rdkitConformerGenerator, resetRdkitForTesting, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import {
  attachSpin3dModel, attachSpin3dModelFromConformer, buildSpin3dModel, conformerGraphSignature, legacyConformerGraphSignature,
  createPhase4Document, flattenSpunMolecule, getSelectedMolecule, readSpin3dModel,
  insertNativeMolfileMolecule, specifiedDoubleBondIdsForFlatten, spin3dModelCoordsForMolecule, validSpin3dModelFor
} from "./documentWorkflow";
import { doubleBondStereoState } from "./interaction/doubleBondStereo";
import { projectSpin } from "./interaction/spinOverlay";
import { quatFromAxisAngle, quatToViewMatrix } from "./interaction/rotation3d";

const fixture = (name: string) => readFileSync(new URL(`../../../packages/fixtures/open-double-bonds/${name}.v2000.mol`, import.meta.url), "utf8");
const nativeMolfile = (mol: MoleculeObject) => moleculeToMolfileV2000(mol, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents;

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

async function identity(input: string) {
  const mol = (await ensureRdkit()).get_mol(input, JSON.stringify({ removeHs: false }))!;
  try {
    const json = JSON.parse(mol.get_json!()) as RdkitJson;
    const composition = compositionFromRdkitJson(json);
    return { canonical: mol.get_smiles!(), formula: composition.formula, charge: composition.formalCharge,
      atoms: composition.atomCount, bonds: composition.bondCount, components: composition.components.length,
      tetrahedral: perceiveStereoCentersFromMolfile(input),
      either: parseMolfileGraph(input).bonds.flatMap((bond, i) => bond.stereo === "either" ? [i] : []) };
  } finally { mol.delete(); }
}

describe("Spin open stereo intent through flatten and reopen", () => {
  it("perceives equivalent alkene ligands once and reuses the exemption across projection frames", () => {
    const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      depictSmiles2D("CC=C(C)C").molfile, "molfile-v2000");
    const mol = getSelectedMolecule(document)!;
    const double = mol.bonds.find(bond => bond.order === "double")!;
    const a = mol.atoms.find(atom => atom.id === double.fromAtomId)!;
    const b = mol.atoms.find(atom => atom.id === double.toAtomId)!;
    const ligandId = mol.bonds.flatMap(bond => bond.id !== double.id
      ? bond.fromAtomId === a.id ? [bond.toAtomId] : bond.toAtomId === a.id ? [bond.fromAtomId] : []
      : []).sort()[0];
    // Reflect one ligand across the double-bond axis, changing the conservative drawn-side bit.
    const reflected = { ...mol, atoms: mol.atoms.map(atom => {
      if (atom.id !== ligandId) return atom;
      const dx = b.x - a.x, dy = b.y - a.y;
      const projection = ((atom.x - a.x) * dx + (atom.y - a.y) * dy) / (dx * dx + dy * dy);
      return { ...atom, x: 2 * (a.x + projection * dx) - atom.x, y: 2 * (a.y + projection * dy) - atom.y };
    }) };
    expect(doubleBondStereoState(reflected).get(double.id)).not.toBe(doubleBondStereoState(mol).get(double.id));
    const coords = reflected.atoms.flatMap(atom => [atom.x, -atom.y, 0]);
    const view = quatToViewMatrix(quatFromAxisAngle([1, 0, 0], 0));
    expect(flattenSpunMolecule(document, mol.id, coords, view).status).toBe("refused");
    expect(flattenSpunMolecule(document, mol.id, coords, view,
      { perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile }).status).toBe("committed");
    const reader = vi.fn(perceiveDoubleBondStereoFromMolfile);
    const specifiedDoubleBondIds = specifiedDoubleBondIdsForFlatten(mol, reader);
    expect(specifiedDoubleBondIds?.size).toBe(0);
    for (const angle of [0, 0.1, 0.2]) {
      const result = flattenSpunMolecule(document, mol.id, coords,
        quatToViewMatrix(quatFromAxisAngle([1, 0, 0], angle)), { specifiedDoubleBondIds });
      expect(result.status, result.refusalReasons.join("; ")).toBe("committed");
    }
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it.each(["CC=C(C)C", "CC(C)=CCCC(C)=CCO", "CC(=C1CCCCC1)C", "C1CCC(=C2CCCCC2)CC1"])(
    "never guards equivalent double-bond ligands across conformer seeds: %s", async smiles => {
      const source = depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: true }).molfile;
      const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 }, source, "molfile-v2000");
      const original = getSelectedMolecule(document)!;
      const expected = await identity(nativeMolfile(original));
      const input = (await ensureRdkit()).get_mol(smiles)!;
      try { expect(expected.canonical).toBe(input.get_smiles!()); }
      finally { input.delete(); }
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const coords = (await rdkitConformerGenerator.generate3DConformer(
          { molfile: nativeMolfile(original) }, { optimize: "none", seed }
        )).mapping.coords3dByOriginalAtom;
        for (const angle of [0, 0.3, 0.7, 1.3, 2.0, 2.6]) {
          const result = flattenSpunMolecule(document, original.id, coords,
            quatToViewMatrix(quatFromAxisAngle([1, 2, 3], angle)), {
              perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile, perceiveStereo: perceiveStereoCentersFromMolfile
            });
          expect(result.status, `seed ${seed}, angle ${angle}: ${result.refusalReasons.join("; ")}`).toBe("committed");
          const flattened = getSelectedMolecule(result.document)!;
          // Cache keys record drawing geometry even for equivalent ligands; chemical identity stays unchanged.
          expect(conformerGraphSignature({ ...flattened, atoms: flattened.atoms.map(atom =>
            ({ ...atom, x: atom.x + 100, y: atom.y - 100 })) })).toBe(conformerGraphSignature(flattened));
          expect(await identity(nativeMolfile(flattened))).toEqual(expected);
          expect(await identity(flattened.structure)).toEqual(expected);
        }
      }
    }, 60_000);

  it.each(["C[C@H](O)/C=C/C", "C[C@H](O)[C@H](F)Cl", "[H][C@](F)(Cl)Br"])(
    "validates legacy coordinates against every drawn wedge and upgrades on write: %s", async smiles => {
      const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
        depictSmiles2D(smiles).molfile, "molfile-v2000");
      const original = getSelectedMolecule(document)!;
      const markers = original.bonds.filter(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? ""));
      expect(markers.length).toBeGreaterThan(0);
      const legacyKey = original.atoms.map(atom => `${atom.id}:${atom.element}:${atom.formalCharge}`).join(",") + "|" +
        original.bonds.map(bond => `${bond.fromAtomId}>${bond.toAtomId}:${bond.order}`).join(",");
      expect(legacyConformerGraphSignature(original)).toBe(legacyKey);
      expect(conformerGraphSignature(original)).not.toBe(legacyKey);
      const coords3d = (await rdkitConformerGenerator.generate3DConformer(
        { molfile: nativeMolfile(original) }, { optimize: "none" }
      )).mapping.coords3dByOriginalAtom;
      const orientation = { x: 0, y: 0, z: 0, w: 1 };
      const current = buildSpin3dModel({ molecule: original, coords3d, orientation });
      const legacy = { ...current, graphSignature: legacyKey };
      const saved = deserializeDocument(serializeDocument(attachSpin3dModel(document, original.id, legacy)));
      const persisted = getSelectedMolecule(saved)!;
      const beforeRead = serializeDocument(saved);
      expect(validSpin3dModelFor(persisted)).toBeUndefined();
      expect(validSpin3dModelFor(persisted, storedCoordinatesMatchStereo)).toEqual(legacy);
      expect(serializeDocument(saved)).toBe(beforeRead); // Reading never migrates the document.
      const rotated = { ...legacy, coords3d: original.atoms.flatMap((_, i) =>
        [coords3d[i * 3 + 2], coords3d[i * 3], coords3d[i * 3 + 1]]) };
      expect(validSpin3dModelFor(getSelectedMolecule(attachSpin3dModel(document, original.id, rotated))!, storedCoordinatesMatchStereo)).toEqual(rotated);
      const reordered = { ...legacy, atomIds: [...legacy.atomIds].reverse(),
        coords3d: original.atoms.flatMap((_, i) => legacy.coords3d.slice((original.atoms.length - 1 - i) * 3,
          (original.atoms.length - i) * 3)) };
      expect(validSpin3dModelFor(getSelectedMolecule(attachSpin3dModel(document, original.id, reordered))!, storedCoordinatesMatchStereo)).toEqual(reordered);
      const rewritten = getSelectedMolecule(attachSpin3dModelFromConformer(saved, persisted.id, legacy))!;
      expect(readSpin3dModel(rewritten)?.graphSignature).toBe(conformerGraphSignature(persisted));
      expect(validSpin3dModelFor(rewritten, storedCoordinatesMatchStereo)).toBeDefined();
      const withCurrent = getSelectedMolecule(attachSpin3dModel(document, original.id, current))!;
      const mirrored = { ...withCurrent, atoms: withCurrent.atoms.map(atom => ({ ...atom, x: -atom.x })) };
      expect(conformerGraphSignature(mirrored)).not.toBe(current.graphSignature);
      expect(validSpin3dModelFor(mirrored, storedCoordinatesMatchStereo)).toBeUndefined();
      for (const marker of markers) {
        const flip = (mol: MoleculeObject): MoleculeObject => ({ ...mol, bonds: mol.bonds.map(bond => bond.id === marker.id
          ? { ...bond, display: { ...bond.display, bondStyle: marker.display!.bondStyle === "wedge" ? "hashed" : "wedge" } }
          : bond) });
        expect(validSpin3dModelFor(flip(persisted), storedCoordinatesMatchStereo), `legacy: ${marker.id}`).toBeUndefined();
        expect(validSpin3dModelFor(flip(withCurrent), storedCoordinatesMatchStereo), `current: ${marker.id}`).toBeUndefined();
      }
      // Coplanar coordinates cannot prove a specified tetrahedral configuration.
      const planar = { ...legacy, coords3d: original.atoms.flatMap(atom => [atom.x, -atom.y, 0]) };
      expect(validSpin3dModelFor(getSelectedMolecule(attachSpin3dModel(document, original.id, planar))!, storedCoordinatesMatchStereo)).toBeUndefined();
    });

  it("accepts legacy E-2-butene coordinates only while the drawing specifies E", async () => {
    const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 }, fixture("e"), "molfile-v2000");
    const original = getSelectedMolecule(document)!;
    const coords3d = (await rdkitConformerGenerator.generate3DConformer(
      { molfile: nativeMolfile(original) }, { optimize: "none" }
    )).mapping.coords3dByOriginalAtom;
    const legacy = { ...buildSpin3dModel({ molecule: original, coords3d, orientation: { x: 0, y: 0, z: 0, w: 1 } }),
      graphSignature: legacyConformerGraphSignature(original) };
    const persisted = getSelectedMolecule(attachSpin3dModel(document, original.id, legacy))!;
    expect(validSpin3dModelFor(persisted)).toBeUndefined();
    expect(validSpin3dModelFor(persisted, storedCoordinatesMatchStereo)).toEqual(legacy);
    const double = original.bonds.find(bond => bond.order === "double")!;
    const a = original.atoms.find(atom => atom.id === double.fromAtomId)!;
    const b = original.atoms.find(atom => atom.id === double.toAtomId)!;
    const ligand = original.bonds.find(bond => bond.order === "single" &&
      (bond.fromAtomId === b.id || bond.toAtomId === b.id))!;
    const ligandId = ligand.fromAtomId === b.id ? ligand.toAtomId : ligand.fromAtomId;
    const z: MoleculeObject = { ...persisted, atoms: persisted.atoms.map(atom => {
      if (atom.id !== ligandId) return atom;
      const dx = b.x - a.x, dy = b.y - a.y;
      const projection = ((atom.x - b.x) * dx + (atom.y - b.y) * dy) / (dx * dx + dy * dy);
      return { ...atom, x: 2 * (b.x + projection * dx) - atom.x, y: 2 * (b.y + projection * dy) - atom.y };
    }) };
    expect(legacyConformerGraphSignature(z)).toBe(legacy.graphSignature);
    expect(conformerGraphSignature(z)).not.toBe(conformerGraphSignature(persisted));
    expect(validSpin3dModelFor(z, storedCoordinatesMatchStereo)).toBeUndefined();
  });

  it.each(["open", "e", "z", "mixed-diene", "conjugated-diene", "neighboring-centers"])(
    "preserves full chemistry, stereo and ScreenPlacement: %s", async name => {
      const source = fixture(name);
      const expected = await identity(source);
      const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 }, source, "molfile-v2000");
      const original = getSelectedMolecule(document)!;
      const coords = (await rdkitConformerGenerator.generate3DConformer({ molfile: nativeMolfile(original) }, { optimize: "none" }))
        .mapping.coords3dByOriginalAtom;
      const placement = { centerX: 350, centerY: 350, scale: 25 };
      const pairs = original.bonds.map(bond => [original.atoms.findIndex(a => a.id === bond.fromAtomId),
        original.atoms.findIndex(a => a.id === bond.toAtomId)] as const);
      const centres = new Set(original.atoms.flatMap((atom, i) => expected.tetrahedral[i]?.isStereoCenter ? [atom.id] : []));
      let committed = 0;
      for (const angle of [0, 0.3, 0.7, 1.3, 2.0, 2.6]) {
        const orientation = quatFromAxisAngle([1, 2, 3], angle);
        const matrix = quatToViewMatrix(orientation);
        const result = flattenSpunMolecule(document, original.id, coords, matrix, {
          placement, stereoCenterAtomIds: centres, perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile, perceiveStereo: perceiveStereoCentersFromMolfile
        });
        if (result.status !== "committed") continue;
        committed++;
        const reopened = deserializeDocument(serializeDocument(attachSpin3dModelFromConformer(result.document,
          original.id, { coords3d: coords, orientation })));
        const flat = getSelectedMolecule(reopened)!;
        expect(await identity(flat.structure)).toEqual(expected);
        expect(await identity(nativeMolfile(flat))).toEqual(expected);
        expect(flat.bonds.flatMap((bond, i) => bond.stereo === "either" ? [i] : [])).toEqual(expected.either);
        for (const marker of flat.bonds.filter(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? ""))) {
          expect(expected.tetrahedral[original.atoms.findIndex(atom => atom.id === marker.fromAtomId)]?.descriptor).not.toBe("unspecified");
        }
        const model = validSpin3dModelFor(flat, storedCoordinatesMatchStereo)!;
        const reopenedCoords = spin3dModelCoordsForMolecule(model, flat)!;
        expect(Array.from(reopenedCoords)).toEqual(Array.from(coords));
        const overlay = projectSpin(reopenedCoords, pairs, model.orientation, placement);
        flat.atoms.forEach((atom, i) => {
          expect(atom.x).toBeCloseTo(overlay.atoms[i].sx, 8);
          expect(atom.y).toBeCloseTo(overlay.atoms[i].sy, 8);
        });
        // Releasing the reopened overlay in the same view keeps exactly the same chemistry.
        const again = flattenSpunMolecule(reopened, flat.id, reopenedCoords, matrix, {
          placement, stereoCenterAtomIds: centres, perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile, perceiveStereo: perceiveStereoCentersFromMolfile
        });
        expect(again.status, again.refusalReasons.join("; ")).toBe("committed");
        expect(await identity(getSelectedMolecule(again.document)!.structure)).toEqual(expected);
      }
      expect(committed).toBeGreaterThanOrEqual(2);
    }, 60_000);

  it.each([false, true])("refuses changed specified E/Z and preserves open intent (reader: %s)", withReader => {
    const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 }, fixture("e"), "molfile-v2000");
    const mol = getSelectedMolecule(document)!;
    // xy reads E. Looking obliquely along X brings the last ligand across the axis.
    const coords = [-1, 1, 0, 0, 0, 0, 1, 0, 0, 2, -1, 2];
    const view = quatToViewMatrix(quatFromAxisAngle([1, 0, 0], -Math.PI / 3));
    const options = withReader ? { perceiveDoubleBondStereo: perceiveDoubleBondStereoFromMolfile } : {};
    const result = flattenSpunMolecule(document, mol.id, coords, view, options);
    expect(result.status).toBe("refused");
    expect(result.refusalReasons.join("; ")).toContain("specified E/Z");
    expect(result.document).toBe(document);
    const open = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 }, fixture("open"), "molfile-v2000");
    const flattenedOpen = flattenSpunMolecule(open, getSelectedMolecule(open)!.id, coords, view, options);
    expect(flattenedOpen.status).toBe("committed");
    expect(getSelectedMolecule(flattenedOpen.document)!.bonds.filter(bond => bond.order === "double"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ stereo: "either" })]));
  });
});
