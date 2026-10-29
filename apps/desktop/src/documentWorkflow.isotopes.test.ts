import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPatches, createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import {
  createSmilesMolecule, moleculeSmiles, nativeSingleBondGraphSmiles
} from "@chemdraft/document-workflow-core";
import { isotopeFixtures } from "../../../packages/document-workflow-core/src/isotopes.fixtures";
// Keep the oracle and its Node loader on this worktree's single RDKit instance.
import { generateSmiles2DMolfile, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../../packages/rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { depictInWorker } from "./depiction2d/depict";
import {
  applyEditorSaveResultWithLabelWarnings, createNativeMolfileMolecule,
  applyNativeAtomElementTarget, applyNativeAtomLabelDraft, createNativeSavePayload, openNativeDocument
} from "./documentWorkflow";

const point = { x: 200, y: 200 };

describe.each([false, true])("isotope relabelling (typed=%s)", (literal) => {
  it.each(["N", "Cl", "D", "T", "C", "CH3"])("updates carbon-13 when relabelled to %s", (element) => {
    const document = createEmptyDocument();
    const molecule = createSmilesMolecule(document, point, {
      atoms: [{ element: "C", isotope: 13, x: 0, y: 0, charge: 0 }], bonds: []
    }, "[13CH4]");
    if (molecule.type !== "molecule") throw new Error("Expected a molecule");
    const atom = molecule.atoms[0]!;
    // Include an already visible/literal C so retyping C exercises the no-change fast path.
    atom.labelVisible = true;
    if (literal) atom.labelLiteral = true;
    const inserted = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: molecule }
    ]);
    const target = { kind: "atom" as const, objectId: molecule.id, atomId: atom.id, distanceToPointer: 0 };
    const result = literal
      ? applyNativeAtomLabelDraft(inserted, target, element, { element: "C", literal: true })
      : applyNativeAtomElementTarget(inserted, target, element);
    const relabelled = result.pages[0]!.objects[0];
    if (relabelled?.type !== "molecule") throw new Error("Expected a molecule");
    expect(relabelled.atoms[0]!.element).toBe(element);
    if (element === "C") {
      expect(result).toBe(inserted);
      expect(relabelled.atoms[0]!.isotope).toBe(13);
    } else {
      expect(relabelled.atoms[0]).not.toHaveProperty("isotope");
    }
    expect(relabelled.atoms[0]!.labelLiteral === true).toBe(literal);
    expect(relabelled.chemistry?.isotopeLabels).toEqual(
      element === "C" ? ["13C"] : element === "D" ? ["2H"] : element === "T" ? ["3H"] : []
    );
  });
});

beforeAll(async () => {
  installRealRdkitModuleLoader();
  await ensureOclResources();
});
afterAll(() => resetRdkitForTesting());

async function canonical(input: string): Promise<string> {
  const result = await computeStructureIdentifiers(input);
  if (!result?.smiles) throw new Error(`RDKit could not canonicalize ${input}`);
  return result.smiles;
}

describe.each(["RDKit", "OpenChemLib"] as const)("%s isotope foundation", (engine) => {
  it.each(isotopeFixtures)("round-trips $smiles ($formula, $exactMass u)", async (fixture) => {
    const document = createEmptyDocument();
    const molfile = engine === "RDKit"
      ? await generateSmiles2DMolfile(fixture.smiles, { standardOnly: true })
      : depictSmiles2D(fixture.smiles).molfile;
    const parsed = parseMolfileGraph(molfile);
    const molecule = createNativeMolfileMolecule(document, point, molfile, parsed.format, parsed);
    const expected = await canonical(fixture.smiles);
    expect(molecule.chemistry?.formula).toBe(fixture.formula);
    expect(molecule.chemistry?.exactMass).toBe(fixture.exactMass);
    expect(await canonical(await moleculeSmiles(molecule, 0, [], computeStructureIdentifiers)))
      .toBe(expected);

    // The pure graph writer carries the same isotope tokens. It deliberately has no stereo
    // notation, so stereo-bearing cases above use the native MOL bridge and the injected engine.
    if (!fixture.smiles.includes("/")) {
      expect(await canonical(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds))).toBe(expected);
    }
    for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      const output = write(molecule, {
        fromDocFrame: true,
        kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
      }).contents;
      const graph = parseMolfileGraph(output);
      const roundTrip = createNativeMolfileMolecule(document, point, output, graph.format, graph);
      expect(roundTrip.atoms.map(({ element, isotope }) => ({ element, isotope })))
        .toEqual(molecule.atoms.map(({ element, isotope }) => ({ element, isotope })));
      expect(roundTrip.chemistry?.formula).toBe(fixture.formula);
      expect(roundTrip.chemistry?.exactMass).toBe(fixture.exactMass);
      expect(await canonical(await moleculeSmiles(roundTrip, 0, [], computeStructureIdentifiers)))
        .toBe(expected);
    }

    // Exercise the actual forced fallback used by the worker, as well as native MOL import.
    const result = await depictInWorker(fixture.smiles, generateSmiles2DMolfile, () => {}, {
      standardOnly: true,
      ...(engine === "OpenChemLib" ? { rdkitLoadFailure: "forced fallback in isotope test" } : {})
    });
    const pasted = createSmilesMolecule(document, point, result.depiction, fixture.smiles);
    if (pasted.type !== "molecule") throw new Error("Expected a molecule");
    expect(pasted.chemistry?.formula).toBe(fixture.formula);
    expect(pasted.chemistry?.exactMass).toBe(fixture.exactMass);
    expect(await canonical(await moleculeSmiles(pasted, 0, [], computeStructureIdentifiers))).toBe(expected);

    const inserted = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0]!.id, object: molecule }
    ]);
    const reopened = openNativeDocument(createNativeSavePayload(inserted).contents);
    expect(reopened.document).toBeDefined();
    const saved = reopened.document!.pages[0]!.objects[0] as MoleculeObject;
    expect(saved.atoms).toEqual(molecule.atoms);
    expect(await canonical(await moleculeSmiles(saved, 0, [], computeStructureIdentifiers))).toBe(expected);
  });
});

it("keeps V3000 MASS properties when the structure editor saves back to native atoms", async () => {
  const document = createEmptyDocument();
  const original = createNativeMolfileMolecule(document, point,
    await generateSmiles2DMolfile("[13CH3][18OH]", { standardOnly: true }), "molfile-v2000");
  const selected = applyPatches(document, [
    { op: "addObject", pageId: document.pages[0]!.id, object: original },
    { op: "setSelection", objectIds: [original.id] }
  ]);
  const saved: MoleculeObject = {
    ...original, atoms: [], bonds: [], structureFormat: "molfile-v3000",
    structure: moleculeToMolfileV3000(original, {
      fromDocFrame: true, kekuleBondOrders: new Map()
    }).contents
  };
  const result = applyEditorSaveResultWithLabelWarnings(selected, { object: saved, warnings: [] });
  const restored = result.document.pages[0]!.objects[0] as MoleculeObject;
  expect(restored.atoms.map(({ element, isotope }) => ({ element, isotope }))).toEqual([
    { element: "C", isotope: 13 }, { element: "O", isotope: 18 }
  ]);
});

it("imports isotope molecules from SDF records and ignores record data after M END", async () => {
  const fixtures = [isotopeFixtures[0], isotopeFixtures[9], isotopeFixtures[12]];
  const records: string[] = [];
  for (const fixture of fixtures) {
    records.push(await generateSmiles2DMolfile(fixture.smiles, { standardOnly: true }));
  }
  const sdf = records.map((mol) => `${mol}\n> <NOTE>\nM  ISO  1   1  99\n\n$$$$`).join("\n");
  const blocks = sdf.split("$$$$").filter((block) => block.trim());
  for (const [index, block] of blocks.entries()) {
    const graph = parseMolfileGraph(block);
    const molecule = createNativeMolfileMolecule(createEmptyDocument(), point, block, graph.format, graph);
    expect(molecule.chemistry?.formula).toBe(fixtures[index]!.formula);
    expect(molecule.chemistry?.exactMass).toBe(fixtures[index]!.exactMass);
    expect(await canonical(await moleculeSmiles(molecule, 0, [], computeStructureIdentifiers)))
      .toBe(await canonical(fixtures[index]!.smiles));
  }
});
