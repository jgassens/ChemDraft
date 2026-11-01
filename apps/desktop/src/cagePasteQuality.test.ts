/** P8b: the real paste kernel and identity-checked Clean Up must prefer legible cages. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { ensureOclResources, relayoutMolfile2D, perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { evaluateLayoutQuality, moleculeLayoutLabelBoxes, type LayoutQuality } from "@chemdraft/layout-engine";
import * as layoutEngine from "@chemdraft/layout-engine";
import * as workflow from "./documentWorkflow";
import * as rdkitDepiction from "@chemdraft/rdkit-adapter/depiction";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import { pastedStructureDepictionFromMolfile, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { createRdkit2DRelayouts } from "../../../packages/rdkit-adapter/src/relayout2d";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { depictInWorker } from "./depiction2d/depict";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";
import { applyNativeMoleculeEngineRelayout, insertSmilesMolecule, SMILES_PASTE_OPTIONS } from "./documentWorkflow";
import { depictSmilesForPaste, depictSmilesListForPaste } from "./smilesListPaste";
import { gatePasteDepiction } from "./depiction2d/qualityGate";

// Use the exact worker kernel with real engines, without a second worker's independent module cache.
vi.mock("./depiction2d/client", () => ({ depictSmilesOffThread: (smiles: string) =>
  depictInWorker(smiles, generateSmiles2DMolfile, () => {}) }));

const cage = "C1CC2CC3CC1CC(C2)C3";
function quality(m: MoleculeObject) {
  const ids = new Map(m.atoms.map((a, i) => [a.id, i]));
  return evaluateLayoutQuality(m.atoms, m.bonds.map(b => ({ from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)! })),
    undefined, undefined, undefined, moleculeLayoutLabelBoxes(m));
}
const atomDefects = (q: LayoutQuality) => q.overlappingAtoms.length + q.atomBondOverlaps.length + q.collinearBondOverlaps.length;
const metrics = (q: LayoutQuality) => ({ atoms: q.overlappingAtoms, onBonds: q.atomBondOverlaps,
  collinear: q.collinearBondOverlaps, labelBonds: q.labelBondOverlaps, labelLabels: q.labelLabelOverlaps,
  crossings: q.crossings, nearest: q.nearestAtomPairDistance });
const insert = (depiction: Parameters<typeof insertSmilesMolecule>[2], smiles = cage) =>
  insertSmilesMolecule(createEmptyDocument(), { x: 400, y: 400 }, depiction, smiles, SMILES_PASTE_OPTIONS);
beforeAll(async () => { installRealRdkitModuleLoader(); await ensureOclResources(); });
afterAll(() => resetRdkitForTesting());
afterEach(() => vi.restoreAllMocks());

describe("bridged cage paste quality (real engines)", () => {
  it("commits five crossings over one atom overlap, rather than comparing their total counts", () => {
    const points = Array.from({ length: 5 }, (_, i) => ({ element: "C", charge: 0,
      x: Math.cos(i * Math.PI * 2 / 5), y: Math.sin(i * Math.PI * 2 / 5) }));
    const bonds = points.map((_, from) => ({ from, to: (from + 2) % 5, order: "single" as const, wedge: null }));
    const drawn = points.map((_, i) => ({ ...points[(i * 3) % 5] }));
    drawn[0] = { ...drawn[0], x: drawn[0].x * 0.3 + drawn[2].x * 0.7, y: drawn[0].y * 0.3 + drawn[2].y * 0.7 };
    const document = insert({ atoms: drawn, bonds }, "C1CCCC1");
    const before = document.pages[0].objects[0] as MoleculeObject;
    expect(quality(before).overlappingAtoms).toHaveLength(1);
    expect(quality(before).crossings).toHaveLength(0);
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, () => ({ atoms: points, bonds }),
      { targetBondLengthPx: 22, perceiveStereo: perceiveStereoCentersFromMolfile });
    expect(cleaned).not.toBe(document);
    const after = quality(cleaned.pages[0].objects[0] as MoleculeObject);
    expect(layoutEngine.layoutAtomAndLabelDefects(after)).toBe(0);
    expect(after.crossings).toHaveLength(5);
    expect(after.hardDefects).toBeGreaterThan(quality(before).hardDefects);
  });

  it("reproduces the raw overlap and commits a crossing-only Clean Up candidate", async () => {
    const raw = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(cage, { openUnspecifiedDoubleBonds: true }));
    const document = insert(raw);
    const before = document.pages[0].objects[0] as MoleculeObject;
    expect(atomDefects(quality(before))).toBeGreaterThan(0);
    const engines = [relayoutMolfile2D, ...await createRdkit2DRelayouts()];
    const candidates = engines.map(engine => {
      const depiction = engine(stereoPerceptionMolfile(before));
      return metrics(quality(insert(depiction).pages[0].objects[0] as MoleculeObject));
    });
    const warnings: string[] = [];
    const contactRepairs = vi.spyOn(layoutEngine, "repairBridgedLayoutContacts");
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, engines[0], {
      targetBondLengthPx: 22, alternateRelayouts: engines.slice(1), warnings, perceiveStereo: perceiveStereoCentersFromMolfile
    });
    console.log("P8B_CAGE " + JSON.stringify({ pasted: metrics(quality(before)),
      candidates: Object.fromEntries(candidates.map((q, i) => [["OCL", "RDKit CoordGen", "RDKit default"][i], q])),
      contactRepairs: contactRepairs.mock.calls.map((args, i) => ({ engine: ["OCL", "RDKit CoordGen", "RDKit default"][i],
        defects: contactRepairs.mock.results[i].value
          ? metrics(evaluateLayoutQuality(contactRepairs.mock.results[i].value, args[1])) : "no qualifying repair" })),
      committed: metrics(quality(cleaned.pages[0].objects[0] as MoleculeObject)), warnings }));
    expect(cleaned).not.toBe(document);
    const after = cleaned.pages[0].objects[0] as MoleculeObject;
    expect(after.atoms.map(({ x: _x, y: _y, ...atom }) => atom))
      .toEqual(before.atoms.map(({ x: _x, y: _y, ...atom }) => atom));
    expect(after.bonds.map(b => [b.id, b.fromAtomId, b.toAtomId, b.order]))
      .toEqual(before.bonds.map(b => [b.id, b.fromAtomId, b.toAtomId, b.order]));
    expect(atomDefects(quality(after))).toBe(0);
    expect(quality(after).crossings.length).toBeGreaterThan(0);
    const module = await ensureRdkit();
    expect(inspectStructureInWorker(module, stereoPerceptionMolfile(after)))
      .toEqual(inspectStructureInWorker(module, stereoPerceptionMolfile(before)));
  }, 60_000);

  it("pastes the cage without atom-level defects", async () => {
    const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout");
    const standardResults: Parameters<typeof gatePasteDepiction>[0][] = [];
    const parsed = await depictInWorker(cage, generateSmiles2DMolfile, result => standardResults.push(result));
    expect(select).toHaveBeenCalledOnce();
    const pasted = insert(parsed.depiction);
    const molecule = pasted.pages[0].objects[0] as MoleculeObject;
    expect(atomDefects(quality(molecule))).toBe(0);
    expect(quality(molecule).labelBondOverlaps).toEqual([]);
    expect(quality(molecule).labelLabelOverlaps).toEqual([]);
    for (const standard of standardResults) {
      expect(atomDefects(quality(insert(standard.depiction).pages[0].objects[0] as MoleculeObject))).toBe(0);
    }
    const module = await ensureRdkit();
    const drawnIdentity = inspectStructureInWorker(module, stereoPerceptionMolfile(molecule));
    const inputIdentity = inspectStructureInWorker(module, cage);
    if (!drawnIdentity.valid || !inputIdentity.valid) throw new Error("Cage identity inspection failed");
    expect(drawnIdentity.canonicalSmiles).toBe(inputIdentity.canonicalSmiles);
    const empty = createEmptyDocument();
    const history = { past: [empty], present: pasted, future: [] };
    // Preparation never commits: the insertion is the sole history entry, with exact redo.
    const { undo, redo } = await import("@chemdraft/chem-core");
    expect(undo(history).present).toBe(empty);
    expect(redo(undo(history)).present).toBe(pasted);
    expect(select).toHaveBeenCalledOnce();
  }, 60_000);

  it("gates the cage inside a SMILES list before the single grid insertion", async () => {
    const text = `${cage}\nc1ccccc1`;
    const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout");
    const list = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(list?.entries).toHaveLength(2);
    expect(list?.warnings).toBeUndefined();
    expect(select).toHaveBeenCalledOnce();
    const placed = workflow.insertSmilesMoleculeGrid(createEmptyDocument(), { x: 400, y: 400 }, list!.entries);
    expect(placed.objectIds).toHaveLength(2);
    for (const molecule of placed.document.pages[0].objects as MoleculeObject[]) {
      expect(layoutEngine.layoutAtomAndLabelDefects(quality(molecule))).toBe(0);
    }
  }, 60_000);

  it("repairs the cage through the real worker transport within its layout deadline", async () => {
    const { depictSmilesOffThread } = await vi.importActual<typeof import("./depiction2d/client")>("./depiction2d/client");
    const pasted = await depictSmilesOffThread(cage);
    expect(layoutEngine.layoutAtomAndLabelDefects(quality(insert(pasted.depiction).pages[0].objects[0] as MoleculeObject))).toBe(0);
    expect(pasted.warnings ?? []).toEqual([]);
  }, 60_000);

  it("keeps an unfixable drawing and never calls its unchanged status already clean", async () => {
    const raw = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(cage));
    const document = insert(raw);
    const molecule = document.pages[0].objects[0] as MoleculeObject;
    // Simulate exhausted local repairs while retaining real engine parsing/mapping/read-back.
    vi.spyOn(layoutEngine, "repairBridgedLayoutContacts").mockReturnValue(undefined);
    const warnings: string[] = [];
    const kept = applyNativeMoleculeEngineRelayout(document, molecule.id, () => raw,
      { targetBondLengthPx: 22, warnings, perceiveStereo: perceiveStereoCentersFromMolfile });
    expect(kept).toBe(document);
    const status = workflow.cleanUpStructureStatus(kept, [molecule.id], false, warnings);
    expect(status).toContain("Clean Up couldn't fix");
    expect(status).toContain("overlapping atoms");
    expect(status).not.toContain("already clean");
    const pasted = await gatePasteDepiction({ depiction: raw, stereoCount: 0 }, cage);
    expect(pasted.depiction).toBe(raw);
    expect(pasted.warnings).toContain("Pasted structure still has overlapping atoms; no generated layout cleared the overlaps.");
    const text = `${cage}\nc1ccccc1`;
    const list = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(list?.entries).toHaveLength(2);
    expect(list?.warnings).toContain(`${cage}: Pasted structure still has overlapping atoms; no generated layout cleared the overlaps.`);
  }, 60_000);

  const normal = [
    "c1ccccc1",
    "CN(C)C1=CC2=C(C=C1)C(=C3C=CC(=[N+](C)C)C=C3O2)C4=C(C=C(C=C4)C(=O)[O-])C(=O)O",
    "O=C1OC2(c3ccccc31)c1ccc(O)cc1Oc1cc(O)ccc12",
    "Oc1ccc2c(c1)oc1cc(=O)ccc-1c2-c1ccccc1C(=O)O",
    "c1ccc2nc3ccccc3cc2c1",
    "CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C",
    "c1ccc2c(c1)Cc1ccccc1O2",
    "CN(C)c1ccc2cc3ccc(=[N+](C)C)cc3oc2c1"
  ];
  it.each(normal.map((smiles, index) => ({ smiles, gateRequired: index === 1 })))(
    "only runs alternates when the original depiction fails the gate: $smiles", async ({ smiles, gateRequired }) => {
    const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout");
    const alternates = vi.spyOn(rdkitDepiction, "createRdkit2DRelayouts");
    const raw = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles, { openUnspecifiedDoubleBonds: true }));
    const pasted = await depictSmilesForPaste(smiles);
    // TMR's original depiction has label/bond collisions: enforcing the requested label gate repairs it.
    if (gateRequired) {
      expect(quality(insert(raw, smiles).pages[0].objects[0] as MoleculeObject).labelBondOverlaps.length).toBeGreaterThan(0);
      expect(layoutEngine.layoutAtomAndLabelDefects(quality(insert(pasted!.depiction, smiles).pages[0].objects[0] as MoleculeObject))).toBe(0);
      expect(select).toHaveBeenCalledOnce();
      expect(alternates).toHaveBeenCalledOnce();
    } else {
      expect(pasted?.depiction).toEqual(raw);
      expect(select).not.toHaveBeenCalled();
      expect(alternates).not.toHaveBeenCalled();
    }
  }, 60_000);
});
