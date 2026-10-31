/** P8: real paste kernel -> native document -> identity/stereo-checked cleanup candidates. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as OCL from "openchemlib";
import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, undo, redo, type MoleculeObject } from "@chemdraft/chem-core";
import { ensureOclResources, relayoutMolfile2D, perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { inspectHydrogenNormalizedIdentity, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { evaluateLayoutQuality, repairLayoutOverlaps, type LayoutQuality, type LayoutRepair } from "@chemdraft/layout-engine";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { createRdkit2DRelayouts } from "../../../packages/rdkit-adapter/src/relayout2d";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { depictInWorker } from "./depiction2d/depict";
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
  return evaluateLayoutQuality(m.atoms, m.bonds.map(b => ({ from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)! })), reference);
}
function metrics(q: LayoutQuality) {
  return { min: q.minBondLength, max: q.maxBondLength, std: q.bondLengthStdDev,
    nearest: q.nearestAtomPairDistance, nearestNonBonded: q.nearestNonBondedAtomPairDistance,
    overlaps: q.overlappingAtoms.length, crossings: q.crossings.length,
    atomsOnBonds: q.atomBondOverlaps.length, collinearBonds: q.collinearBondOverlaps.length,
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
    ["norbornane", "C1CC2CCC1C2", "RDKit default"],
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
    const winner = cleaned === document ? "kept original" : labels.find((_, i) =>
      JSON.stringify(applyNativeMoleculeEngineRelayout(document, before.id, () => depictions[i], options).pages[0].objects[0]) === JSON.stringify(after));
    console.log("P8_CAGE " + JSON.stringify({ name, winner,
      candidates: Object.fromEntries(depictions.map((d, i) => [labels[i], metrics(evaluateLayoutQuality(d.atoms, d.bonds))])),
      committed: metrics(quality(after)), warnings }));
    expect(cleaned).not.toBe(document);
    expect(winner).toBe(expectedWinner);
    expect(quality(after).overlappingAtoms).toEqual([]);
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
    expect.soft(quality(before, target).hardDefects, "input must have no overlaps/crossings").toBe(0);
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
    const cleaned = applyNativeMoleculeEngineRelayout(document, before.id, primary, options);
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
    const oclQuality = evaluateLayoutQuality(generated.get("OCL")!.atoms, generated.get("OCL")!.bonds);
    expect(oclQuality.passes).toBe(oclPasses);
    if (oclPasses) expect(attempted).toEqual(["OCL"]);
    let winner = kept ? "kept original" : "unknown";
    let winningRepair: LayoutRepair | undefined;
    if (!kept) {
      for (const [label, depiction] of generated) {
        const candidate = applyNativeMoleculeEngineRelayout(document, before.id, () => depiction, {
          targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile
        });
        if (JSON.stringify(candidate.pages[0].objects[0]) === JSON.stringify(after)) {
          winner = label;
          for (const repair of repairLayoutOverlaps(depiction.atoms, depiction.bonds)) {
            const repaired = { ...depiction, atoms: depiction.atoms.map((atom, i) => ({ ...atom, ...repair.atoms[i] })) };
            const repairedCandidate = applyNativeMoleculeEngineRelayout(document, before.id, () => repaired, {
              targetBondLengthPx: target, perceiveStereo: perceiveStereoCentersFromMolfile
            });
            if (JSON.stringify(repairedCandidate.pages[0].objects[0]) === JSON.stringify(after)) {
              winningRepair = repair;
              winner += ` + ${repair.kind}`;
              break;
            }
          }
          break;
        }
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
      original: metrics(quality(before)),
      candidates: Object.fromEntries([...allGenerated].map(([label, depiction]) =>
        [label, metrics(evaluateLayoutQuality(depiction.atoms, depiction.bonds))])),
      committed: metrics(committed), repair: winningRepair ? {
        kind: winningRepair.kind, pivot: winningRepair.pivot, angleDegrees: winningRepair.angleDegrees,
        movedAtoms: winningRepair.movedAtoms, metrics: metrics(winningRepair.quality)
      } : undefined, warnings }));
    expect(winner).not.toBe("unknown");
    if (oclPasses) expect(winner).toBe("OCL");
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
