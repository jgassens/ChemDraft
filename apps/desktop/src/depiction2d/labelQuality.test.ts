import { Resvg } from "@resvg/resvg-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { pastedStructureDepictionFromMolfile, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { atomLabelRunFontSize, moleculeLayoutLabelBoxes, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import * as layoutEngine from "@chemdraft/layout-engine";
import { ensureOclResources, perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import * as rdkitDepiction from "@chemdraft/rdkit-adapter/depiction";
import { createDepictionWorkerClient, type DepictionWorkerPort } from "@chemdraft/rdkit-adapter/depiction";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "../../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../../packages/rdkit-adapter/src/testing";
import * as workflow from "../documentWorkflow";
import { depictInWorker, type PasteDepiction } from "./depict";
import { inspectStructureInWorker } from "./identityInspect";
import { nativeMoleculeLayoutQuality } from "./layoutQuality";
import { gatePasteDepiction } from "./qualityGate";

// Atom indices follow the input SMILES/standard depiction, and cover every originally flagged pair.
const fixtures = [
  { smiles: "Nc1cc(N)cc([N+](=O)[O-])c1", pairs: [[7, 9]] },
  { smiles: "CCC(=O)c1ccc([N+](=O)[O-])cc1", pairs: [[8, 9], [8, 10]] },
  { smiles: "CC(=O)c1ccc(C)c([N+](=O)[O-])c1", pairs: [[9, 10], [9, 11]] },
  { smiles: "O=[N+]([O-])c1c(O)cccc1O", pairs: [[0, 1], [1, 2]] },
  { smiles: "NNC(=O)C(=O)NN", pairs: [[0, 1], [6, 7]] },
  { smiles: "Cc1ccccc1NNc1ccccc1C", pairs: [[7, 8]] },
  { smiles: "O=c1[nH][nH]c2c(Cl)cccc12", pairs: [[2, 3]] },
  { smiles: "O=S(=O)(O)c1ccc2ccc(O)cc2c1", pairs: [[0, 1], [1, 2]] },
  { smiles: "c1ccn2nnnc2c1", pairs: [[4, 5], [5, 6]] },
  { smiles: "O=C(O)C1(C(=O)O)CCOCC1", pairs: [[2, 5]] }
];
const insert = (depiction: PasteDepiction["depiction"], smiles: string) => workflow.insertSmilesMolecule(
  createEmptyDocument(), { x: 400, y: 400 }, depiction, smiles, workflow.SMILES_PASTE_OPTIONS);
const moleculeOf = (document: ReturnType<typeof insert>) => document.pages[0].objects[0] as MoleculeObject;
const rawDepiction = async (smiles: string) => pastedStructureDepictionFromMolfile(
  await generateSmiles2DMolfile(smiles, { openUnspecifiedDoubleBonds: true }));
type Box = { x: number; y: number; width: number; height: number };
const boxDistance = (a: Box, b: Box) => Math.hypot(
  Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width),
  Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height));

beforeAll(async () => { installRealRdkitModuleLoader(); await ensureOclResources(); });
afterAll(() => resetRdkitForTesting());
afterEach(() => vi.restoreAllMocks());

describe("renderer label collision regressions", () => {
  it("exempts bonded labels only, retaining non-bonded label pairs and nonincident bonds", () => {
    const atoms = [{ x: 0, y: 0 }, { x: 22, y: 0 }, { x: 11, y: 0 }];
    const boxes = atoms.map((_, atom) => ({ atom, x: 0, y: -5, width: 22, height: 10 }));
    const q = layoutEngine.evaluateLayoutQuality(atoms, [{ from: 0, to: 1 }], 22,
      undefined, undefined, boxes);
    expect(q.labelLabelOverlaps).toEqual([[0, 2], [1, 2]]);
    expect(q.labelBondOverlaps).toEqual([[2, 0]]);
  });

  it.each(fixtures)("keeps the paste coordinates without alternates: $smiles", async ({ smiles, pairs }) => {
    const raw = await rawDepiction(smiles);
    const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout");
    const alternates = vi.spyOn(rdkitDepiction, "createRdkit2DRelayouts");
    const result = { depiction: raw, stereoCount: 0 };
    expect(await gatePasteDepiction(result, smiles)).toBe(result);
    const pasted = await depictInWorker(smiles, generateSmiles2DMolfile, () => {});
    expect(pasted.depiction).toEqual(raw);
    expect(pasted.warnings).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(alternates).not.toHaveBeenCalled();
    const molecule = moleculeOf(insert(raw, smiles));
    const quality = nativeMoleculeLayoutQuality(molecule);
    expect(quality.labelLabelOverlaps).toEqual([]);
    expect(quality.labelBondOverlaps).toEqual([]);
    const contacts = layoutEngine.evaluateLayoutContacts(raw.atoms, raw.bonds);
    expect(contacts.overlappingAtoms).toEqual(quality.overlappingAtoms);
    expect(contacts.atomBondOverlaps).toEqual(quality.atomBondOverlaps);
    expect(contacts.collinearBondOverlaps).toEqual(quality.collinearBondOverlaps);

    const plans = planMoleculeAtomLabels(molecule), boxes = moleculeLayoutLabelBoxes(molecule);
    // Render the canvas's exact text runs: same anchor, H side, scripts, font and dy.
    // Resvg measures ink rather than the padded rectangle used to clip bonds.
    const glyphs = plans.map(plan => {
      const runs = plan.layout.runs.map(run => `<text x="${run.x}" y="${run.y}" dy="0.35em" text-anchor="${run.textAnchor}" font-size="${atomLabelRunFontSize(run.script, plan.drawingStyle) ?? plan.fontSizePx}">${run.text}</text>`).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><g transform="translate(${plan.anchor.x} ${plan.anchor.y})" font-family="${plan.fontFamily}" font-weight="${plan.fontWeight}" font-style="${plan.fontStyle}">${runs}</g></svg>`;
      const glyph = new Resvg(svg).getBBox()!;
      const box = boxes.find(box => molecule.atoms[box.atom].id === plan.atom.id)!;
      expect(glyph.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(glyph.y).toBeGreaterThanOrEqual(box.y - 0.5);
      expect(glyph.x + glyph.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(glyph.y + glyph.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
      // Tight extents, not a centred em square plus clipping padding.
      expect(box.height - glyph.height).toBeLessThan(3);
      return glyph;
    });
    const measurements = pairs.map(([a, b]) => {
      const i = plans.findIndex(plan => plan.atom === molecule.atoms[a]);
      const j = plans.findIndex(plan => plan.atom === molecule.atoms[b]);
      return { atoms: [a, b], labels: [plans[i].label, plans[j].label],
        distancePx: boxDistance(glyphs[i], glyphs[j]), distanceL: boxDistance(glyphs[i], glyphs[j]) / 22 };
    });
    console.log("LABEL_GLYPH_DISTANCES " + JSON.stringify({ smiles, measurements }));
    if (smiles === fixtures[9].smiles) {
      expect(measurements[0].distancePx).toBeGreaterThan(3);
      // Non-bonded labels still count if their actual glyph envelopes overlap.
      const ids = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
      const touching = boxes.map(box => box.atom === 2 ? { ...box, ...boxes.find(b => b.atom === 5)!, atom: 2 } : box);
      expect(layoutEngine.evaluateLayoutQuality(molecule.atoms, molecule.bonds.map(b => ({
        from: ids.get(b.fromAtomId)!, to: ids.get(b.toAtomId)!
      })), undefined, undefined, undefined, touching).labelLabelOverlaps).toContainEqual([2, 5]);
    }
  });

  it.each([fixtures[5].smiles, fixtures[6].smiles, fixtures[8].smiles])(
    "Clean Up keeps OpenChemLib without loading RDKit alternates: %s", async smiles => {
      const document = insert(await rawDepiction(smiles), smiles), molecule = moleculeOf(document);
      const primary = vi.fn(relayoutMolfile2D), loadRdkit = vi.fn(async () => []);
      const options = { targetBondLengthPx: 22, perceiveStereo: perceiveStereoCentersFromMolfile };
      const expected = workflow.applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D, options);
      const cleaned = await workflow.prepareNativeMoleculeEngineRelayout(document, molecule.id, primary, loadRdkit, options);
      expect(primary).toHaveBeenCalledOnce();
      expect(loadRdkit).not.toHaveBeenCalled();
      expect(cleaned).toEqual(expected);
      expect(nativeMoleculeLayoutQuality(moleculeOf(cleaned)).passes).toBe(true);
    });
});

describe("paste repair deadline and chemistry", () => {
  const cage = "C1CC2CC3CC1CC(C2)C3";
  it("returns the original warned standard depiction through transport when alternate selection stalls", async () => {
    const molfile = await generateSmiles2DMolfile(cage, { openUnspecifiedDoubleBonds: true });
    const raw = pastedStructureDepictionFromMolfile(molfile);
    const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout")
      .mockImplementation(() => new Promise(() => {}));
    const worker: DepictionWorkerPort<PasteDepiction> = { onmessage: null, onerror: null,
      terminate: vi.fn(), postMessage: ({ id, smiles, standardOnly }) => {
        void depictInWorker(smiles, async (_input, options) => {
          options.onStandardMolfile?.(molfile);
          return molfile;
        }, result => worker.onmessage?.({ data: { id, stage: "standard", result } }), { standardOnly })
          .then(result => worker.onmessage?.({ data: { id, stage: "result", result } }));
      } };
    const factory = vi.fn(() => worker);
    const pasted = await createDepictionWorkerClient(factory, 50)(cage);
    expect(select).toHaveBeenCalledOnce();
    expect(pasted.depiction).toEqual(raw);
    expect(pasted.warnings).toContainEqual(expect.stringContaining("overlapping atoms"));
    expect(pasted.warnings).toContainEqual(expect.stringContaining("layout deadline"));
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("standardOnly publishes the defective standard and never selects alternates or repairs", async () => {
    const molfile = await generateSmiles2DMolfile(cage);
    const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout");
    const repair = vi.spyOn(layoutEngine, "repairBridgedLayoutContacts");
    const onStandard = vi.fn();
    const pasted = await depictInWorker(cage, async (_input, options) => {
      options.onStandardMolfile?.(molfile);
      return molfile;
    }, onStandard, { standardOnly: true });
    expect(onStandard).toHaveBeenCalledOnce();
    expect(pasted.depiction).toEqual(pastedStructureDepictionFromMolfile(molfile));
    expect(pasted.warnings).toContainEqual(expect.stringContaining("overlapping atoms"));
    expect(select).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it.each(["[13CH3][C@H](O)[C@H]([NH3+])C(=O)[O-]", "CC=CC"])(
    "serializes alternate-path chemistry without losing isotope, charge or directed stereo: %s", async smiles => {
      const raw = await rawDepiction(smiles);
      const expectedDocument = insert(raw, smiles), expected = moleculeOf(expectedDocument);
      // Inject a hard contact, then supply a selected, valid layout. This isolates the
      // serializer after candidate selection, including its directed wedge/hash endpoints.
      const defective = { ...raw, atoms: raw.atoms.map((atom, i) => i === raw.atoms.length - 1
        ? { ...atom, x: raw.atoms[0].x, y: raw.atoms[0].y } : atom) };
      const select = vi.spyOn(workflow, "prepareNativeMoleculeEngineRelayout").mockResolvedValue(expectedDocument);
      const pasted = await gatePasteDepiction({ depiction: defective, stereoCount: 2 }, smiles);
      expect(select).toHaveBeenCalledOnce();
      expect(pasted.depiction).not.toBe(defective);
      const actual = moleculeOf(insert(pasted.depiction, smiles));
      const facts = (m: MoleculeObject) => ({
        atoms: m.atoms.map(atom => [atom.element, atom.isotope, atom.formalCharge]),
        bonds: m.bonds.map(bond => [m.atoms.findIndex(a => a.id === bond.fromAtomId),
          m.atoms.findIndex(a => a.id === bond.toAtomId), bond.order, bond.stereo, bond.display?.bondStyle])
      });
      expect(facts(actual)).toEqual(facts(expected));
      const module = await ensureRdkit();
      expect(inspectStructureInWorker(module, stereoPerceptionMolfile(actual)))
        .toEqual(inspectStructureInWorker(module, stereoPerceptionMolfile(expected)));
      const input = inspectStructureInWorker(module, smiles), output = inspectStructureInWorker(module, stereoPerceptionMolfile(actual));
      expect(output.valid && input.valid && output.canonicalSmiles === input.canonicalSmiles).toBe(true);
      if (smiles === "CC=CC") expect(actual.bonds.some(bond => bond.stereo === "either")).toBe(true);
      else {
        expect(raw.bonds.some(bond => bond.wedge === "wedge")).toBe(true);
        expect(raw.bonds.some(bond => bond.wedge === "hashed")).toBe(true);
        expect(actual.atoms.some(atom => atom.isotope === 13)).toBe(true);
        expect(actual.atoms.map(atom => atom.formalCharge)).toContain(1);
        expect(actual.atoms.map(atom => atom.formalCharge)).toContain(-1);
      }
    });
});
