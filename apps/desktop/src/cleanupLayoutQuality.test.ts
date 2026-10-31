/** P8: real paste kernel -> native document -> identity/stereo-checked cleanup candidates. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as OCL from "openchemlib";
import { insertStructureTemplate } from "./structureTemplateInsertion";
import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, undo, redo, type MoleculeObject } from "@chemdraft/chem-core";
import { ensureOclResources, relayoutMolfile2D, perceiveStereoCentersFromMolfile, perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";
import { inspectHydrogenNormalizedIdentity, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import * as layoutEngine from "@chemdraft/layout-engine";
import { evaluateLayoutQuality, moleculeLayoutLabelBoxes, conventionalLayoutOrientations, type LayoutQuality, type LayoutRepair, type LayoutPoint } from "@chemdraft/layout-engine";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { createRdkit2DRelayouts } from "../../../packages/rdkit-adapter/src/relayout2d";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { depictInWorker } from "./depiction2d/depict";
import { replanRepairLabels } from "../../../packages/layout-engine/src/layoutRepair";
import { prepareLayoutLabelEvaluator } from "../../../packages/layout-engine/src/layoutQuality";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";
import { verifySmilesPaste } from "./smilesPasteIdentity";
import {
  insertSmilesMolecule, SMILES_PASTE_OPTIONS, moleculeHasFusedRingSystem,
  applyNativeMoleculeEngineRelayout, prepareNativeMoleculeEngineRelayout, type PastedStructureDepiction
} from "./documentWorkflow";

const fixtures = [
  ["TMR", "CN(C)C1=CC2=C(C=C1)C(=C3C=CC(=[N+](C)C)C=C3O2)C4=C(C=C(C=C4)C(=O)[O-])C(=O)O", false],
  ["fluorescein lactone", "O=C1OC2(c3ccccc31)c1ccc(O)cc1Oc1cc(O)ccc12", false],
  ["fluorescein open quinoid", "Oc1ccc2c(c1)oc1cc(=O)ccc-1c2-c1ccccc1C(=O)O", false],
  ["acridine", "c1ccc2nc3ccccc3cc2c1", true],
  ["cholesterol", "CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C", true],
  ["xanthene", "c1ccc2c(c1)Cc1ccccc1O2", true],
  ["TMR without benzoate", "CN(C)c1ccc2cc3ccc(=[N+](C)C)cc3oc2c1", true]
] as const;

function quality(m: MoleculeObject, reference?: number) {
  const ids = new Map(m.atoms.map((atom, i) => [atom.id, i]));
  return evaluateLayoutQuality(m.atoms, m.bonds.map(b => ({ from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)! })),
    reference, undefined, undefined, moleculeLayoutLabelBoxes(m));
}

/** Fit only a proper rotation and positive scale; reflections cannot match. */
function fitLayout(source: readonly LayoutPoint[], target: readonly LayoutPoint[], indices = source.map((_, i) => i)) {
  const center = (points: readonly LayoutPoint[]) => indices.reduce((p, i) => ({
    x: p.x + points[i].x / indices.length, y: p.y + points[i].y / indices.length }), { x: 0, y: 0 });
  const a = center(source), b = center(target);
  let dot = 0, cross = 0, length2 = 0;
  for (const i of indices) {
    const x = source[i].x - a.x, y = source[i].y - a.y;
    dot += x * (target[i].x - b.x) + y * (target[i].y - b.y);
    cross += x * (target[i].y - b.y) - y * (target[i].x - b.x);
    length2 += x * x + y * y;
  }
  const angle = Math.atan2(cross, dot), scale = Math.hypot(dot, cross) / length2;
  return { angleDegrees: angle * 180 / Math.PI, error: Math.max(...indices.map(i => Math.hypot(
    b.x + scale * ((source[i].x - a.x) * Math.cos(angle) - (source[i].y - a.y) * Math.sin(angle)) - target[i].x,
    b.y + scale * ((source[i].x - a.x) * Math.sin(angle) + (source[i].y - a.y) * Math.cos(angle)) - target[i].y))) };
}

const engineFrame = (m: MoleculeObject) => m.atoms.map(a => ({ x: a.x, y: -a.y }));

function depictionQuality(m: MoleculeObject, depiction: PastedStructureDepiction, target: number) {
  const meanBond = depiction.bonds.reduce((sum, b) => sum + Math.hypot(
    depiction.atoms[b.from].x - depiction.atoms[b.to].x, depiction.atoms[b.from].y - depiction.atoms[b.to].y), 0) / depiction.bonds.length;
  const scale = target / meanBond;
  return quality({ ...m, atoms: m.atoms.map((atom, i) => ({ ...atom,
    x: depiction.atoms[i].x * scale, y: -depiction.atoms[i].y * scale })) }, target);
}

function expectConventional(m: MoleculeObject) {
  const ids = new Map(m.atoms.map((a, i) => [a.id, i]));
  const bonds = m.bonds.map(b => ({ from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)! }));
  // The preferred orientation is already horizontal with the pendant below in document y-down.
  expect(conventionalLayoutOrientations(m.atoms, bonds)[0].angleDegrees).toBeCloseTo(0, 2);
}
function metrics(q: LayoutQuality) {
  return { min: q.minBondLength, max: q.maxBondLength, std: q.bondLengthStdDev,
    nearest: q.nearestAtomPairDistance, nearestNonBonded: q.nearestNonBondedAtomPairDistance,
    overlaps: q.overlappingAtoms.length, crossings: q.crossings.length,
    atomsOnBonds: q.atomBondOverlaps.length, collinearBonds: q.collinearBondOverlaps.length,
    labelBonds: q.labelBondOverlaps.length, labelLabels: q.labelLabelOverlaps.length,
    labelClearance: q.smallestLabelBondClearance,
    maxRingAngleError: Math.max(0, ...q.rings.map(r => r.maxAngleError ?? 0)),
    maxBridgeLength: q.maxBridgeLength, hardDefects: q.hardDefects, softScore: q.softScore,
    fusedSideDefects: q.fusedSideDefects.length, strict: q.passes, relaxed: q.passesRelaxed };
}

/** Fixed-seed radial jitter, bounded by 0.2 style bond lengths for every atom. */
function perturb(molecule: MoleculeObject, target: number): MoleculeObject {
  let seed = 0x5eed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  return { ...molecule, atoms: molecule.atoms.map(atom => {
    const angle = random() * 2 * Math.PI;
    const radius = random() * 0.2 * target;
    return { ...atom, x: atom.x + radius * Math.cos(angle), y: atom.y + radius * Math.sin(angle) };
  }) };
}

const cases = fixtures.flatMap(([name, smiles, oclPasses]) => [
  { name, smiles, oclPasses, variant: "pasted" },
  ...(!oclPasses ? [{ name, smiles, oclPasses, variant: "perturbed" }] : [])
]);
beforeAll(async () => { installRealRdkitModuleLoader(); await ensureOclResources(); });
afterAll(() => resetRdkitForTesting());

describe("Clean Up Structure 2D layout quality (real engines)", () => {
  it("still rejects a real E/Z-changing repair without a stereogenicity reader", () => {
    const h = Math.sin(Math.PI / 9), w = Math.cos(Math.PI / 9);
    const chain = (points: [number, number][]): PastedStructureDepiction => ({
      atoms: points.map(([x, y]) => ({ x, y, element: "C", charge: 0 })),
      bonds: Array.from({ length: 3 }, (_, i) => ({ from: i, to: i + 1,
        order: i === 1 ? "double" : "single", wedge: null }))
    });
    const trans = chain([[-w, -h], [0, 0], [1, 0], [1 + w, h]]);
    const cis = chain([[-w, -h], [0, 0], [1, 0], [1 + w, -h]]);
    const colliding = chain([[-w, -h], [0, 0], [1, 0], [-0.7, -0.4]]);
    const document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, trans, "C/C=C/C");
    const before = document.pages[0].objects[0] as MoleculeObject;
    const search = vi.spyOn(layoutEngine, "repairLayoutOverlaps").mockReturnValue([{
      atoms: [...cis.atoms], quality: evaluateLayoutQuality(cis.atoms, cis.bonds),
      kind: "substituent swing", pivot: 2, movedAtoms: [3], angleDegrees: -40
    }]);
    try {
      const warnings: string[] = [];
      expect(applyNativeMoleculeEngineRelayout(document, before.id, () => colliding, {
        targetBondLengthPx: 22, warnings
      })).toBe(document);
      expect(search).toHaveBeenCalledOnce();
      expect(warnings).toEqual(["Clean Up kept the drawn layout of this structure: the generated layouts put atoms on top of each other."]);
    } finally { search.mockRestore(); }
  });
  it.each(["synchronous", "prepared"])("%s cleanup refuses Astra's shallow trans-butene to cis repair despite empty perception", async path => {
    const radius = 1 / (2 * Math.sin(Math.PI / 8));
    const ring = Array.from({ length: 8 }, (_, i) => ({
      x: radius * Math.cos(i * Math.PI / 4), y: radius * Math.sin(i * Math.PI / 4), element: "C", charge: 0
    }));
    const pivots = [0, 2, 4, 6];
    const oh = pivots.map(i => ({ x: ring[i].x * (radius - 1) / radius,
      y: ring[i].y * (radius - 1) / radius, element: "O", charge: 0 }));
    const depiction = (angle: number, sign: number): PastedStructureDepiction => {
      const w = Math.cos(angle * Math.PI / 180), h = Math.sin(angle * Math.PI / 180);
      return {
        atoms: [...ring, ...oh, ...[[-w, -h], [0, 0], [1, 0], [1 + w, sign * h]]
          .map(([x, y]) => ({ x: x + 10, y, element: "C", charge: 0 }))],
        bonds: [...Array.from({ length: 8 }, (_, from) => ({ from, to: (from + 1) % 8, order: "single" as const, wedge: null })),
          ...pivots.map((from, i) => ({ from, to: i + 8, order: "single" as const, wedge: null })),
          ...Array.from({ length: 3 }, (_, i) => ({ from: 12 + i, to: 13 + i,
            order: i === 1 ? "double" as const : "single" as const, wedge: null }))]
      };
    };
    const document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 },
      depiction(2.5, 1), "C/C=C/C.OC1CC(O)CC(O)CC(O)C1");
    const before = document.pages[0].objects[0] as MoleculeObject;
    expect(perceiveDoubleBondStereoFromMolfile(stereoPerceptionMolfile(before))).toEqual([]);
    const module = await ensureRdkit();
    const smiles = (molecule: MoleculeObject) => {
      const mol = module.get_mol(stereoPerceptionMolfile(molecule));
      try { return mol.get_smiles(); } finally { mol.delete(); }
    };
    const originalSmiles = smiles(before);
    expect(originalSmiles).toContain("C/C=C/C");
    const search = vi.spyOn(layoutEngine, "repairLayoutOverlaps");
    const warnings: string[] = [];
    const options = { targetBondLengthPx: 30, warnings, perceiveStereo: perceiveStereoCentersFromMolfile };
    try {
      const source = () => depiction(20, -1);
      const cleaned = path === "prepared"
        ? await prepareNativeMoleculeEngineRelayout(document, before.id, source, async () => [], options)
        : applyNativeMoleculeEngineRelayout(document, before.id, source, options);
      // The real repair clears the OH labels; rejection must come from the E/Z guard.
      expect(search).toHaveBeenCalledOnce();
      expect((search.mock.results[0].value as LayoutRepair[]).some(r => r.quality.hardDefects === 0)).toBe(true);
      expect(cleaned).toBe(document);
      expect(smiles(cleaned.pages[0].objects[0] as MoleculeObject)).toBe(originalSmiles);
      expect(warnings).toContainEqual(expect.stringMatching(/^Clean Up kept the drawn layout/));
    } finally { search.mockRestore(); }
  });
  it.each(["calix-4-arene", "calix-6-arene", "p-tert-butylcalix-5-arene", "p-tert-butylcalix-6-arene"])(
    "%s clears inward OH labels without atom-level defects", async id => {
      const document = insertStructureTemplate(createEmptyDocument(), id, { x: 390, y: 300 }).document;
      const before = document.pages[0].objects[0] as MoleculeObject;
      const target = nativeDrawingStyleFromObjectStyle(before.style).bondLengthPx;
      const snapshot = structuredClone(document);
      const generated: { engine: string; depiction: PastedStructureDepiction }[] = [];
      const engines = [relayoutMolfile2D, ...await createRdkit2DRelayouts()].map((engine, i) => (molfile: string) => {
        const depiction = engine(molfile);
        generated.push({ engine: ["OCL", "CoordGen", "default"][i], depiction });
        return depiction;
      });
      const repairSearch = vi.spyOn(layoutEngine, "repairLayoutOverlaps");
      const warnings: string[] = [];
      let cleaned: ReturnType<typeof applyNativeMoleculeEngineRelayout>;
      try {
        cleaned = await prepareNativeMoleculeEngineRelayout(document, before.id, engines[0], async () => engines.slice(1), {
          targetBondLengthPx: target, warnings,
          perceiveStereo: perceiveStereoCentersFromMolfile
        });
        const report = (q: LayoutQuality) => ({ atoms: q.overlappingAtoms, onBonds: q.atomBondOverlaps,
          collinear: q.collinearBondOverlaps, labelBonds: q.labelBondOverlaps, labelLabels: q.labelLabelOverlaps,
          crossings: q.crossings, soft: q.softScore, strict: q.passes, relaxed: q.passesRelaxed,
          bridged: q.hasBridgedRings, min: q.minBondLength, max: q.maxBondLength });
        console.log("CALIX_DIAG " + JSON.stringify({ id, original: report(quality(before)), candidates: generated.map(({ engine, depiction }, i) => {
          const args = repairSearch.mock.calls[i];
          const source = args?.[0] ?? depiction.atoms;
          const bonds = args?.[1] ?? depiction.bonds;
          const labels = args?.[2]?.labelBoxes;
          const q = (points: readonly LayoutPoint[]) => labels
            ? evaluateLayoutQuality(points, bonds, undefined, undefined, undefined, labels(points))
            : depictionQuality(before, { ...depiction, atoms: depiction.atoms.map((a, i) => ({ ...a, ...points[i] })) }, target);
          return { engine, bonds: bonds.map(b => [b.from, b.to]), raw: report(q(depiction.atoms)), selected: report(q(source)),
            rotations: conventionalLayoutOrientations(source, bonds, -1).map(o => ({ angle: o.angleDegrees, ...report(q(o.atoms)) })),
            repairs: (repairSearch.mock.results[i]?.value as LayoutRepair[] | undefined)?.map(r => ({ kind: r.kind,
              pivot: r.pivot, moved: r.movedAtoms, angle: r.angleDegrees, rotation: r.rotationDegrees, swings: r.swings, ...report(r.quality) })) };
        }), committed: report(quality(cleaned.pages[0].objects[0] as MoleculeObject)), warnings }));
      } finally { repairSearch.mockRestore(); }
      expect(cleaned).not.toBe(document);
      const after = cleaned.pages[0].objects[0] as MoleculeObject;
      const committed = quality(after, target);
      expect(committed.overlappingAtoms).toEqual([]);
      expect(committed.atomBondOverlaps).toEqual([]);
      expect(committed.collinearBondOverlaps).toEqual([]);
      expect(committed.hardDefects).toBe(0);
      expect(warnings).toEqual([]);
      expect(cleaned.selection).toEqual(document.selection);
      expect(after.atoms.map(({ x: _x, y: _y, ...atom }) => atom))
        .toEqual(before.atoms.map(({ x: _x, y: _y, ...atom }) => atom));
      const bondIdentity = (m: MoleculeObject) => m.bonds.map(b => [b.id, b.fromAtomId, b.toAtomId, b.order]);
      expect(bondIdentity(after)).toEqual(bondIdentity(before));
      expect(document).toEqual(snapshot);
      expect(applyNativeMoleculeEngineRelayout(document, before.id, relayoutMolfile2D, {
        targetBondLengthPx: target, alternateRelayouts: await createRdkit2DRelayouts(),
        perceiveStereo: perceiveStereoCentersFromMolfile
      })).toEqual(cleaned);
      const module = await ensureRdkit();
      expect(inspectStructureInWorker(module, stereoPerceptionMolfile(after)))
        .toEqual(inspectStructureInWorker(module, stereoPerceptionMolfile(before)));
    }, 60_000);
  it.each(fixtures)("%s random rigid trials match a fresh renderer label plan", async (_name, smiles) => {
    const parsed = await depictInWorker(smiles, generateSmiles2DMolfile, () => {});
    const document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, parsed.depiction, smiles, SMILES_PASTE_OPTIONS);
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    const ids = new Map(molecule.atoms.map((a, i) => [a.id, i]));
    const bonds = molecule.bonds.map(b => ({ from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)! }));
    const labels = (points: readonly LayoutPoint[]) => moleculeLayoutLabelBoxes({ ...molecule,
      atoms: molecule.atoms.map((a, i) => ({ ...a, ...points[i] })) });
    let seed = 0x5eed;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const rotate = (p: LayoutPoint, pivot: LayoutPoint, angle: number) => ({
      x: pivot.x + (p.x - pivot.x) * Math.cos(angle) - (p.y - pivot.y) * Math.sin(angle),
      y: pivot.y + (p.x - pivot.x) * Math.sin(angle) + (p.y - pivot.y) * Math.cos(angle)
    });
    for (let trial = 0; trial < 20; trial++) {
      const angle = random() * 2 * Math.PI;
      const base = molecule.atoms.map(a => rotate(a, { x: 0, y: 0 }, angle));
      const pivot = Math.floor(random() * base.length), swing = (random() - 0.5) * Math.PI;
      const moving = new Set(base.flatMap((_, i) => i !== pivot && random() < 0.35 ? [i] : []));
      const changing = new Set(moving);
      bonds.forEach(b => {
        if (moving.has(b.from)) changing.add(b.to);
        if (moving.has(b.to)) changing.add(b.from);
      });
      const points = base.map((a, i) => moving.has(i) ? rotate(a, base[pivot], swing) : a);
      const original = labels(base), fresh = labels(points);
      const planned = replanRepairLabels(base, original, points, changing, labels);
      expect(planned).toHaveLength(fresh.length);
      planned.forEach((box, i) => {
        expect(box.atom).toBe(fresh[i].atom);
        for (const key of ["x", "y", "width", "height"] as const) expect(box[key]).toBeCloseTo(fresh[i][key], 10);
      });
      const reference = nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx;
      const geometry = prepareLayoutLabelEvaluator(base, bonds, original, reference, moving, undefined, [], changing)(points, planned);
      const full = prepareLayoutLabelEvaluator(points, bonds, fresh, reference)();
      expect(geometry.labelLabelOverlaps).toEqual(full.labelLabelOverlaps);
      expect(geometry.labelBondOverlaps).toEqual(full.labelBondOverlaps);
      expect(geometry.smallestLabelBondClearance).toBeCloseTo(full.smallestLabelBondClearance, 10);
    }
  });
  it("keeps the clean primary when coordinated sulfur is S in the full graph, without loading alternates", async () => {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = {
      id: "sulfur-zinc", type: "molecule", x: -30, y: 0, width: 51, height: 50, rotation: 0,
      structure: "", structureFormat: "smiles", superatoms: [], rGroups: [],
      style: { bondLengthPx: 30, atomLabelFontSizePx: 15 },
      // Metal deliberately precedes the water: ligand indices must be remapped.
      atoms: [{ id: "c", element: "C", x: -30, y: 0, formalCharge: 0 }, { id: "s", element: "S", x: 0, y: 0, formalCharge: 0 },
        { id: "zn", element: "Zn", x: 0, y: 50, formalCharge: 0 }, { id: "o", element: "O", x: 21, y: 0, formalCharge: 0 }],
      bonds: [{ id: "cs", fromAtomId: "c", toAtomId: "s", order: "single" },
        { id: "szn", fromAtomId: "s", toAtomId: "zn", order: "single", display: { bondStyle: "dashed" } }]
    };
    document.pages[0].objects.push(molecule);
    const snapshot = structuredClone(document);
    expect(layoutEngine.planMoleculeAtomLabels(molecule).find(p => p.atom.id === "s")!.label).toBe("S");
    expect(evaluateLayoutQuality(molecule.atoms, [{ from: 0, to: 1 }], 30, undefined, undefined,
      moleculeLayoutLabelBoxes(molecule)).hardDefects).toBe(0);
    const primary = vi.fn((): PastedStructureDepiction => ({
      atoms: molecule.atoms.filter(a => a.element !== "Zn").map(a => ({ ...a, y: -a.y, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }));
    const loader = vi.fn(async () => [primary]);
    const warnings: string[] = [];
    const cleaned = await prepareNativeMoleculeEngineRelayout(document, molecule.id, primary, loader,
      { targetBondLengthPx: 30, warnings });
    expect(loader).not.toHaveBeenCalled();
    expect(primary).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
    // The normal metal-placement pass still runs. Keep that primary result exactly;
    // there must be no alternate engine, conventional rotation or fragment repair.
    const ungatedPrimary = applyNativeMoleculeEngineRelayout(document, molecule.id, primary);
    expect(cleaned).toEqual(ungatedPrimary);
    const after = cleaned.pages[0].objects[0] as MoleculeObject;
    expect(evaluateLayoutQuality(after.atoms, [{ from: 0, to: 1 }], 30, undefined, undefined,
      moleculeLayoutLabelBoxes(after)).hardDefects).toBe(0);
    expect(after.atoms.map(({ x: _x, y: _y, ...a }) => a))
      .toEqual(molecule.atoms.map(({ x: _x, y: _y, ...a }) => a));
    expect(after.bonds).toEqual(molecule.bonds);
    expect(document).toEqual(snapshot);
  });
  it("rejects overlaps introduced by placing concentric disconnected naphthalenes", async () => {
    const parsed = await depictInWorker("c1ccc2ccccc2c1", generateSmiles2DMolfile, () => {});
    const first = parsed.depiction;
    const center = { x: first.atoms.reduce((s, a) => s + a.x, 0) / 10,
      y: first.atoms.reduce((s, a) => s + a.y, 0) / 10 };
    const concentric: PastedStructureDepiction = {
      atoms: [...first.atoms, ...first.atoms.map(a => ({ ...a,
        x: center.x + (a.x - center.x) * 10, y: center.y + (a.y - center.y) * 10 }))],
      bonds: [...first.bonds, ...first.bonds.map(b => ({ ...b, from: b.from + 10, to: b.to + 10 }))]
    };
    const document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, concentric,
      "c1ccc2ccccc2c1.c1ccc2ccccc2c1", SMILES_PASTE_OPTIONS);
    const before = document.pages[0].objects[0] as MoleculeObject;
    const warnings: string[] = [];
    let raw: PastedStructureDepiction | undefined;
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, molfile => {
      raw = relayoutMolfile2D(molfile);
      return raw;
    }, { targetBondLengthPx: 22, warnings });
    expect(evaluateLayoutQuality(raw!.atoms, raw!.bonds).passes).toBe(true);
    expect(cleaned).toBe(document);
    expect(warnings).toContainEqual(expect.stringMatching(/put atoms on top of each other/));
  });

  it.each([
    // Bridged blocks now use hard defects only, so OCL's conventional norbornane passes.
    ["norbornane", "C1CC2CCC1C2", "OCL"],
    ["adamantane", "C1C2CC3CC1CC(C2)C3", "RDKit CoordGen"],
    ["cubane", "C12C3C4C1C5C2C3C45", "OCL"]
  ])("%s cleanup commits no overlapping atoms and records candidate metrics", async (name, smiles, expectedWinner) => {
    const parsed = await depictInWorker(smiles, generateSmiles2DMolfile, () => {});
    const document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, parsed.depiction, smiles, SMILES_PASTE_OPTIONS);
    const before = document.pages[0].objects[0] as MoleculeObject;
    const target = nativeDrawingStyleFromObjectStyle(before.style).bondLengthPx;
    const engines = [relayoutMolfile2D, ...await createRdkit2DRelayouts()];
    const labels = ["OCL", "RDKit CoordGen", "RDKit default"];
    const depictions = engines.map(engine => {
      let depiction: PastedStructureDepiction | undefined;
      applyNativeMoleculeEngineRelayout(document, before.id, molfile => { depiction = engine(molfile); return depiction; });
      return depiction!;
    });
    const warnings: string[] = [];
    const options = { targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile };
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, () => depictions[0], {
      ...options, warnings, alternateRelayouts: depictions.slice(1).map(d => () => d)
    });
    const after = cleaned.pages[0].objects[0] as MoleculeObject;
    // Alternates now rotate; match geometry by a proper rigid fit instead of byte equality.
    const winnerIndex = depictions.findIndex(d => fitLayout(d.atoms, engineFrame(after)).error < 0.002);
    const winner = cleaned === document ? "kept original" : labels[winnerIndex];
    const rotationDegrees = fitLayout(depictions[winnerIndex].atoms, engineFrame(after)).angleDegrees;
    console.log("P8_CAGE " + JSON.stringify({ name, winner,
      rotationDegrees,
      candidates: Object.fromEntries(depictions.map((d, i) => [labels[i], metrics(depictionQuality(before, d, target))])),
      committed: metrics(quality(after)), warnings }));
    expect(cleaned).not.toBe(document);
    expect(winner).toBe(expectedWinner);
    expect(quality(after).overlappingAtoms).toEqual([]);
    if (winner === "OCL") expect(after).toEqual(applyNativeMoleculeEngineRelayout(document, before.id, () => depictions[0], options).pages[0].objects[0]);
    if (name === "norbornane") expect(quality(after).passes).toBe(true);
    const module = await ensureRdkit();
    expect(inspectStructureInWorker(module, stereoPerceptionMolfile(after)))
      .toEqual(inspectStructureInWorker(module, stereoPerceptionMolfile(before)));
  });

  it.each(cases)("$name ($variant) commits a clean layout with unchanged chemistry", async ({ name, smiles, oclPasses, variant }) => {
    const module = await ensureRdkit();
    const parsed = await depictInWorker(smiles, generateSmiles2DMolfile, () => {});
    await verifySmilesPaste(parsed.depiction, smiles, async (_format, value, reference) =>
      inspectHydrogenNormalizedIdentity(module, value, reference));
    let document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, parsed.depiction, smiles, SMILES_PASTE_OPTIONS);
    const pasted = document.pages[0].objects[0] as MoleculeObject;
    const target = nativeDrawingStyleFromObjectStyle(pasted.style).bondLengthPx;
    if (variant === "perturbed") {
      document = { ...document, pages: document.pages.map(page => ({ ...page,
        objects: page.objects.map(object => object.id === pasted.id ? perturb(pasted, target) : object)
      })) };
    }
    const before = document.pages[0].objects[0] as MoleculeObject;
    expect(moleculeHasFusedRingSystem(before)).toBe(true);
    // Pasted text may collide before cleanup; this precondition checks only the input skeleton.
    const inputIds = new Map(before.atoms.map((a, i) => [a.id, i]));
    expect.soft(evaluateLayoutQuality(before.atoms, before.bonds.map(b => ({ from: inputIds.get(b.fromAtomId)!, to: inputIds.get(b.toAtomId)! })), target).hardDefects,
      "input skeleton must have no overlaps/crossings").toBe(0);
    const warnings: string[] = [];
    const attempted: string[] = [];
    const generated = new Map<string, PastedStructureDepiction>();
    const track = (label: string, engine: (molfile: string) => PastedStructureDepiction) => (molfile: string) => {
      attempted.push(label);
      const result = engine(molfile);
      generated.set(label, result);
      return result;
    };
    const primary = track("OCL", relayoutMolfile2D);
    const alternates = (await createRdkit2DRelayouts()).map((engine, i) => track(i === 0 ? "RDKit CoordGen" : "RDKit default", engine));
    const options = { targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile, warnings, alternateRelayouts: alternates };
    const repairSearch = vi.spyOn(layoutEngine, "repairLayoutOverlaps");
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, primary, options);
    const repairTrials = repairSearch.mock.calls.map((args, i) => ({ source: args[0], repairs: repairSearch.mock.results[i].value as LayoutRepair[] }));
    repairSearch.mockRestore();
    const after = cleaned.pages[0].objects[0] as MoleculeObject;
    const identity = (value: string) => {
      const result = inspectStructureInWorker(module, value);
      if (!result.valid) throw new Error(result.reason);
      const mol = OCL.Molecule.fromMolfile(value);
      return { canonical: result.canonicalSmiles, formula: result.formula,
        charges: Array.from({ length: mol.getAllAtoms() }, (_, i) => mol.getAtomCharge(i)).sort((a, b) => a - b) };
    };
    expect(identity(stereoPerceptionMolfile(after))).toEqual(identity(stereoPerceptionMolfile(before)));
    expect(after.atoms.map(a => ({ id: a.id, element: a.element, charge: a.formalCharge, isotope: a.isotope })))
      .toEqual(before.atoms.map(a => ({ id: a.id, element: a.element, charge: a.formalCharge, isotope: a.isotope })));
    expect(identity(stereoPerceptionMolfile(before))).toEqual(identity(stereoPerceptionMolfile(pasted)));
    const bondIdentity = (m: MoleculeObject) => m.bonds.map(b => ({ id: b.id, from: b.fromAtomId, to: b.toAtomId, order: b.order }));
    expect(bondIdentity(after)).toEqual(bondIdentity(before));
    expect(cleaned.selection).toEqual(document.selection);
    const committed = quality(after, target);
    const kept = cleaned === document;
    const oclQuality = depictionQuality(before, generated.get("OCL")!, target);
    expect(oclQuality.passes).toBe(oclPasses);
    if (oclPasses) expect(attempted).toEqual(["OCL"]);
    let winner = kept ? "kept original" : "unknown";
    let winningRepair: LayoutRepair | undefined;
    let rotationDegrees = 0;
    if (!kept) {
      for (const [label, depiction] of generated) {
        const fit = fitLayout(depiction.atoms, engineFrame(after));
        if (fit.error < 0.002) {
          winner = label;
          rotationDegrees = fit.angleDegrees;
          break;
        }
        for (const trial of repairTrials.filter(t => fitLayout(depiction.atoms, t.source).error < 1e-8)) {
          winningRepair = trial.repairs.find(r => fitLayout(r.atoms, engineFrame(after)).error < 0.002);
          if (!winningRepair) continue;
          winner = label + ` + ${winningRepair.kind}`;
          rotationDegrees = fitLayout(depiction.atoms, engineFrame(after), depiction.atoms.flatMap((_, i) =>
            winningRepair!.movedAtoms.includes(i) ? [] : [i])).angleDegrees;
          break;
        }
        if (winner !== "unknown") break;
      }
    }
    // Exercise the command's preparation path too: it must give the identical result and must
    // never ask for RDKit when the primary is already good.
    const firstAttempts = [...attempted];
    const loader = vi.fn(async () => alternates);
    const preparedWarnings: string[] = [];
    const prepared = await prepareNativeMoleculeEngineRelayout(document, before.id, relayoutMolfile2D, loader, {
      targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile, warnings: preparedWarnings
    });
    expect(prepared).toEqual(cleaned);
    expect(preparedWarnings).toEqual(warnings);
    expect(loader).toHaveBeenCalledTimes(oclPasses ? 0 : 1);
    // Capture every engine independently for the handoff, even if strict selection stopped early.
    // Capture raw metrics too; the host also checks hard defects after placement and folding.
    const allGenerated = new Map(generated);
    for (const [i, engine] of [relayoutMolfile2D, ...await createRdkit2DRelayouts()].entries()) {
      const label = ["OCL", "RDKit CoordGen", "RDKit default"][i];
      if (!allGenerated.has(label)) {
        applyNativeMoleculeEngineRelayout(document, before.id, molfile => {
          const depiction = engine(molfile);
          allGenerated.set(label, depiction);
          return depiction;
        }, { targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile });
      }
    }
    console.log("P8_RESULT " + JSON.stringify({ name, variant, winner, attempted: firstAttempts,
      rotationDegrees,
      original: metrics(quality(before)),
      candidates: Object.fromEntries([...allGenerated].map(([label, depiction]) =>
        [label, metrics(depictionQuality(before, depiction, target))])),
      committed: metrics(committed), repair: winningRepair ? {
        kind: winningRepair.kind, pivot: winningRepair.pivot, angleDegrees: winningRepair.angleDegrees,
        movedAtoms: winningRepair.movedAtoms, metrics: metrics(winningRepair.quality)
      } : undefined, warnings }));
    expect(winner).not.toBe("unknown");
    if (oclPasses) expect(winner).toBe("OCL");
    if (oclPasses) {
      expect(after).toEqual(applyNativeMoleculeEngineRelayout(document, before.id, () => generated.get("OCL")!, {
        targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile
      }).pages[0].objects[0]);
      expect(rotationDegrees).toBeCloseTo(0, 2);
    } else expectConventional(after);
    if (name === "TMR" || name === "fluorescein open quinoid") expect(winner).toBe("RDKit CoordGen");
    if (name === "fluorescein lactone") {
      // CoordGen's repaired rings have a lower soft distortion score than OCL's.
      expect(winner).toBe("RDKit CoordGen + spiro rotation");
      expect(Math.max(0, ...committed.rings.map(r => r.maxAngleError ?? 0))).toBeLessThan(1);
    }
    // Keep lactone under these same assertions even if no engine passes: that is a visible
    // incomplete fixture, never a reason to relax ring geometry or accept an overlap.
    expect(kept, "Clean Up must commit, including a passing layout close to the pasted drawing").toBe(false);
    expect(committed.overlappingAtoms).toEqual([]);
    expect(committed.crossings).toEqual([]);
    expect(committed.hardDefects).toBe(0);
    expect(committed.labelBondOverlaps).toEqual([]);
    expect(committed.labelLabelOverlaps).toEqual([]);
    expect(committed.passes || committed.passesRelaxed, "committed layout must pass strict or bridge-only relaxed limits").toBe(true);
    expect(warnings).toEqual([]);

    // MainWindow commits the fully prepared document once. Undo/redo restore exact snapshots,
    // including the hand-drawn input; no engine runs again during history traversal.
    const history = { past: [document], present: prepared, future: [] };
    const attemptsBeforeUndo = [...attempted];
    expect(undo(history).past).toHaveLength(0);
    expect(undo(history).present).toBe(document);
    expect(redo(undo(history)).present).toBe(prepared);
    expect(attempted).toEqual(attemptsBeforeUndo);
  }, 60_000);

  it.each([0, 1])("reads RDKit alternate %i stereo correctly in the document frame", async index => {
    const smiles = fixtures[4][1]; // cholesterol
    const parsed = await depictInWorker(smiles, generateSmiles2DMolfile, () => {});
    const document = insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, parsed.depiction, smiles, SMILES_PASTE_OPTIONS);
    const before = document.pages[0].objects[0] as MoleculeObject;
    const alternate = (await createRdkit2DRelayouts())[index];
    let rejectReadBack = false;
    let rejectedReadBacks = 0;
    const alternateSpy = vi.fn((molfile: string) => { rejectReadBack = false; return alternate(molfile); });
    // A collinear primary fails quality. Simulate unavailable stereo perception for the next
    // candidate's read-back only; it must be skipped before the real RDKit candidate is accepted.
    const collinear = (molfile: string) => {
      const depiction = relayoutMolfile2D(molfile);
      return { ...depiction, atoms: depiction.atoms.map((atom, i) => ({ ...atom, x: i, y: 0 })) };
    };
    const invalidAlternate = vi.fn((molfile: string) => { rejectReadBack = true; return collinear(molfile); });
    const target = nativeDrawingStyleFromObjectStyle(before.style).bondLengthPx;
    const referenceMolfile = stereoPerceptionMolfile(before);
    const perceiveStereo = (molfile: string) => {
      const perceived = perceiveStereoCentersFromMolfile(molfile);
      if (rejectReadBack && molfile !== referenceMolfile) {
        rejectedReadBacks++;
        return perceived.map(entry => ({ ...entry, descriptor: "unspecified" as const }));
      }
      return perceived;
    };
    const options = { targetBondLengthPx: target, perceiveStereo };
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, collinear, {
      ...options, alternateRelayouts: [invalidAlternate, alternateSpy]
    });
    expect(invalidAlternate).toHaveBeenCalledOnce();
    expect(alternateSpy).toHaveBeenCalledOnce();
    expect(rejectedReadBacks).toBeGreaterThan(0);
    const after = cleaned.pages[0].objects[0] as MoleculeObject;
    expect(perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(after)))
      .toEqual(perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(before)));
    const module = await ensureRdkit();
    expect(inspectStructureInWorker(module, stereoPerceptionMolfile(after)))
      .toEqual(inspectStructureInWorker(module, stereoPerceptionMolfile(before)));
    expect(quality(after, target).passes).toBe(true);
  }, 60_000);
});
