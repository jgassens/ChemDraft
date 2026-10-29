import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyPatch, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import {
  assertMoleculeMatchesSmiles, createSmilesMolecule, inspectHydrogenNormalizedIdentity,
  pastedStructureDepictionFromMolfile, stereoPerceptionMolfile,
  type InspectChemicalIdentity
} from "@chemdraft/document-workflow-core";
import { ensureRdkit, generateSmiles2DMolfile } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import {
  isotopeInsertSmiles, expectIsotopeGraph
} from "../../../packages/document-workflow-core/test/isotopeInsertFixtures";
import {
  checkedSmilesPaste, checkedSmilesGridPaste, createPasteIdentityInspector, verifySmilesPasteInput,
  verifySmilesGridEntries, verifySmilesPaste
} from "./smilesPasteIdentity";
import { insertSmilesMolecule, insertSmilesMoleculeGrid, SMILES_PASTE_OPTIONS } from "./documentWorkflow";
import { depictSmilesForPaste, depictSmilesListForPaste, smilesListFailureStatus } from "./smilesListPaste";
import * as depictionClient from "./depiction2d/client";
import type { StructureInspector } from "./depiction2d/identityProtocol";
import { IDENTITY_VERIFICATION_BUDGET_MS, IdentityWorkerUnavailableError } from "./depiction2d/identityWorkerClient";
import { structureFromSmilesForPlugin } from "./plugins/pluginChemistry";
import { applyAssistantWrite, buildInsertStructures } from "./assistant/writeBuilder";
import { verifyNormalizedAssistantWrite } from "./assistant/normalizedWrite";
import { testContext } from "./assistant/tools/testContext";

const point = { x: 200, y: 200 };
const inspect: InspectChemicalIdentity = async (_format, value, stereoReference) =>
  inspectHydrogenNormalizedIdentity(await ensureRdkit(), value, stereoReference);
beforeAll(() => installRealRdkitModuleLoader());

async function verify(molecule: MoleculeObject, smiles: string) {
  await assertMoleculeMatchesSmiles(molecule, smiles, inspect);
  const source = (await ensureRdkit()).get_mol(smiles, JSON.stringify({ removeHs: true }));
  try { expectIsotopeGraph(molecule, source!.get_molblock!()); }
  finally { source?.delete(); }
}

describe("isotope insert paths", () => {
  it.each(["CC=CC", "CC=CC/C=C/C"])(
    "verifies the exact open-E/Z molecule committed by single paste: %s", async smiles => {
      const document = createEmptyDocument();
      await verifySmilesPasteInput(smiles);
      const parsed = (await depictSmilesForPaste(smiles))!;
      const inspector = vi.fn(inspect);
      // Match renderPastedSmiles: verify without retaining the live document, then insert.
      await verifySmilesPaste(parsed.depiction, smiles, inspector);
      const committed = insertSmilesMolecule(document, point, parsed.depiction, smiles, SMILES_PASTE_OPTIONS);
      const molecule = committed.pages[0]!.objects[0] as MoleculeObject;
      expect(inspector.mock.calls.find(([format]) => format === "molfile")?.[1])
        .toBe(stereoPerceptionMolfile(molecule));
      const checked = await checkedSmilesPaste(document, point, parsed.depiction, smiles, inspect);
      expect(checked.pages[0]!.objects).toEqual(committed.pages[0]!.objects);
      expect(molecule.bonds.filter(bond => bond.order === "double").map(bond => bond.stereo))
        .toEqual(smiles === "CC=CC" ? ["either"] : ["either", undefined]);
      await verify(molecule, smiles);
    });

  it("verifies and commits the same open-E/Z molecules in a two-line SMILES list", async () => {
    const smiles = ["CC=CC", "CC=CC/C=C/C"];
    const text = smiles.join("\n");
    const parsed = (await depictSmilesListForPaste(text, smilesListCandidates(text),
      undefined, undefined, verifySmilesPasteInput))!;
    const document = createEmptyDocument();
    const inspector = vi.fn(inspect);
    // Match MainWindow's list path, including per-entry verification before grid placement.
    const verified = await verifySmilesGridEntries(parsed.entries, inspector);
    expect(verified.failures).toEqual([]);
    expect(verified.entries).toHaveLength(2);
    const committed = insertSmilesMoleculeGrid(document, point, verified.entries);
    const checked = await checkedSmilesGridPaste(document, point, parsed.entries, inspect);
    expect(checked.failures).toEqual([]);
    expect(checked.document.pages[0]!.objects).toEqual(committed.document.pages[0]!.objects);
    const inspectedMolfiles = inspector.mock.calls.filter(([format]) => format === "molfile");
    expect(inspectedMolfiles).toHaveLength(2);
    for (const [index, object] of committed.document.pages[0]!.objects.entries()) {
      const molecule = object as MoleculeObject;
      // Grid placement only translates the graph. Compare the complete molfile after undoing
      // that translation; this includes coordinates, atom properties and every stereo marker.
      const single = insertSmilesMolecule(document, point, parsed.entries[index]!.depiction,
        smiles[index]!, SMILES_PASTE_OPTIONS).pages[0]!.objects[0] as MoleculeObject;
      const dx = single.atoms[0]!.x - molecule.atoms[0]!.x;
      const dy = single.atoms[0]!.y - molecule.atoms[0]!.y;
      const inspected = stereoPerceptionMolfile({ ...molecule, atoms: molecule.atoms.map(atom =>
        ({ ...atom, x: atom.x + dx, y: atom.y + dy })) });
      expect(inspectedMolfiles[index]![1]).toBe(inspected);
      expect(molecule.bonds.filter(bond => bond.order === "double").map(bond => bond.stereo))
        .toEqual(index === 0 ? ["either"] : ["either", undefined]);
      await verify(molecule, smiles[index]!);
    }
  });

  it.each(["[H]C(C)=CC/C=C/C", "[H][C@](F)(Cl)C=CC", "[H]C([2H])=CC"])(
    "folds ordinary H while preserving open E/Z, isotopes and assigned stereo: %s", async smiles => {
      const parsed = (await depictSmilesForPaste(smiles))!;
      const document = await checkedSmilesPaste(createEmptyDocument(), point, parsed.depiction, smiles, inspect);
      const molecule = document.pages[0]!.objects[0] as MoleculeObject;
      expect(molecule.bonds.some(bond => bond.stereo === "either")).toBe(true);
      await verify(molecule, smiles);
    });

  it("preserves isotope and stereo identity when pasted at a non-default bond length", async () => {
    const document = createEmptyDocument();
    document.styles.drawing = { bondLengthPx: 60 };
    for (const smiles of ["[2H]/C=C/c1ccccc1", "C[C@H](O)CC"]) {
      const parsed = await depictSmilesForPaste(smiles);
      if (!parsed) throw new Error("Expected a SMILES depiction");
      await verifySmilesPaste(parsed.depiction, smiles, inspect);
      const pasted = insertSmilesMolecule(document, point, parsed.depiction, smiles);
      const molecule = pasted.pages[0]!.objects[0];
      if (!molecule || molecule.type !== "molecule") throw new Error("Expected molecule");
      expect(molecule.style.bondLengthPx).toBe(60);
      await verify(molecule, smiles);
    }
  });

  it("stops grid identity verification between entries when the list is aborted", async () => {
    const controller = new AbortController();
    const inspect = vi.fn<InspectChemicalIdentity>(async () => {
      controller.abort();
      return { valid: true, canonicalSmiles: "C" };
    });
    const entry = { smiles: "C", depiction: {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }], bonds: []
    } };
    await expect(verifySmilesGridEntries([entry, entry], inspect, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(inspect).toHaveBeenCalledTimes(2);
    inspect.mockClear();
    await expect(verifySmilesGridEntries([entry], inspect, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([["F/C=C/F", "F/C=C\\F"], ["[13CH3]O", "CO"]])(
    "returns a typed plugin failure when depiction changes the identity of %s", async (smiles, changed) => {
      const depiction = (await depictSmilesForPaste(changed))!;
      const stub = vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValueOnce(depiction);
      try {
        const result = await structureFromSmilesForPlugin({ smiles }, createEmptyDocument);
        expect(result).toMatchObject({ available: true, built: false,
          reason: expect.stringContaining("Canonical SMILES mismatch") });
      } finally { stub.mockRestore(); }
    });

  it("reserves distinct plugin object ids while identity checks await the engine", async () => {
    const depiction = (await depictSmilesForPaste("CCO"))!;
    const stub = vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValue(depiction);
    const document = createEmptyDocument();
    try {
      const results = await Promise.all([1, 2].map(() =>
        structureFromSmilesForPlugin({ smiles: "CCO" }, () => document)));
      const ids = results.map(result => {
        if (!result.available || !result.built) throw new Error(result.reason);
        return result.object.id;
      });
      expect(new Set(ids).size).toBe(2);
      expect(document.pages[0]!.objects).toEqual([]);
    } finally { stub.mockRestore(); }
  });

  it("names a failing identity engine without inserting an unverified structure", async () => {
    const document = createEmptyDocument();
    const parsed = (await depictSmilesForPaste("CCO"))!;
    const inspect = createPasteIdentityInspector(async () => {
      throw new IdentityWorkerUnavailableError("test WASM unavailable");
    });
    await expect(checkedSmilesPaste(document, point, parsed.depiction, "CCO", inspect))
      .rejects.toThrow("the RDKit engine did not load: test WASM unavailable");
    expect(document.pages[0]!.objects).toEqual([]);
  });

  it("terminates a stuck identity check, refuses insertion, and pastes the next list entry", async () => {
    const nodeEntry = "./test/identityNodeClient.mjs";
    const node: { createNodeIdentityInspector(options: {
      budgetMs: (stereoReference?: string) => number; slowStereoReference: string; onTerminate(): void
    }): StructureInspector } = await import(/* @vite-ignore */ nodeEntry);
    const terminated = vi.fn();
    const worker = node.createNodeIdentityInspector({
      budgetMs: reference => reference === "CCO" ? 50 : IDENTITY_VERIFICATION_BUDGET_MS,
      slowStereoReference: "CCO", onTerminate: terminated
    });
    const inspect = createPasteIdentityInspector(worker);
    const document = createEmptyDocument();
    const before = structuredClone(document);
    const slow = (await depictSmilesForPaste("CCO"))!;
    const next = (await depictSmilesForPaste("C"))!;
    let responsive = false;
    const heartbeat = setTimeout(() => { responsive = true; }, 5);
    try {
      await expect(checkedSmilesPaste(document, point, slow.depiction, "CCO", inspect))
        .rejects.toThrow("within 0.05 s; nothing was inserted");
      expect(responsive).toBe(true);
      expect(terminated).toHaveBeenCalledOnce();
      expect(document).toEqual(before);
      const pasted = await checkedSmilesPaste(document, point, next.depiction, "C", inspect);
      expect(pasted.pages[0]!.objects).toHaveLength(1);
      const grid = await checkedSmilesGridPaste(document, point, [
        { smiles: "CCO", depiction: slow.depiction }, { smiles: "C", depiction: next.depiction }
      ], inspect);
      expect(grid.failures).toEqual([
        { input: "CCO", error: expect.stringContaining("nothing was inserted") }
      ]);
      expect(grid.objectIds).toHaveLength(1);
      expect(terminated).toHaveBeenCalledTimes(2);
      expect(document).toEqual(before);
      const plugin = await structureFromSmilesForPlugin({ smiles: "CCO" }, () => document,
        undefined, inspect);
      expect(plugin).toMatchObject({ available: true, built: false,
        reason: expect.stringContaining("nothing was inserted") });
      expect(terminated).toHaveBeenCalledTimes(3);
    } finally { clearTimeout(heartbeat); }
  });

  it("limits named list failures to three and reports the remainder", () => {
    const failures = Array.from({ length: 5 }, (_, index) => ({ input: `input${index}`, error: "refused" }));
    expect(smilesListFailureStatus(failures))
      .toBe("input0: refused; input1: refused; input2: refused; and 2 more");
  });

  it.each([
    ["F[C@](Cl)=C=C(Br)I", "FC(Cl)=C=C(Br)I", "allene (axial)"],
    ["F[C@@](Cl)=C=C(Br)I", "FC(Cl)=C=C(Br)I", "allene (axial)"],
    ["OC(Cl)=[C@]=C(C)F", "OC(Cl)=[C@@]=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@@]=C(C)F", "OC(Cl)=[C@]=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@AL1]=C(C)F", "OC(Cl)=C=C(C)F", "allene (axial)"],
    ["OC(Cl)=[C@AL2]=C(C)F", "OC(Cl)=C=C(C)F", "allene (axial)"],
    ["F/C=C=C=C/F", "F/C=C=C=C\\F", "cumulene cis/trans"],
    ["F/C=C=C=C\\F", "F/C=C=C=C/F", "cumulene cis/trans"],
    ["N[Pt@SP1](N)(Cl)Cl", "N[Pt](N)(Cl)Cl", "square-planar"]
  ])("refuses unverifiable input stereo in paste, grid and plugin: %s", async (smiles, plain, kind) => {
    const parsed = (await depictSmilesForPaste(plain))!;
    const message = `${kind} stereochemistry cannot be verified or drawn`;
    const document = createEmptyDocument();
    await expect(checkedSmilesPaste(document, point, parsed.depiction, smiles)).rejects.toThrow(message);
    const grid = await checkedSmilesGridPaste(document, point, [{ smiles, depiction: parsed.depiction }]);
    expect(grid.objectIds).toEqual([]);
    expect(grid.failures).toEqual([{ input: smiles, error: expect.stringContaining(message) }]);
    const stub = vi.spyOn(depictionClient, "depictSmilesOffThread").mockResolvedValueOnce(parsed);
    try {
      expect(await structureFromSmilesForPlugin({ smiles }, () => document)).toMatchObject({
        available: true, built: false, reason: expect.stringContaining(message)
      });
    } finally { stub.mockRestore(); }
    expect(document.pages[0]!.objects).toEqual([]);
  });

  it("refuses square-planar input before depiction and skips it in a two-item list", async () => {
    const smiles = "N[Pt@SP1](N)(Cl)Cl";
    const depict = vi.spyOn(depictionClient, "depictSmilesOffThread");
    try {
      await expect(verifySmilesPasteInput(smiles)).rejects.toThrow(
        "square-planar stereochemistry cannot be verified or drawn");
      expect(depict).not.toHaveBeenCalled();
      const text = `${smiles}\nCCO`;
      const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text),
        undefined, undefined, verifySmilesPasteInput);
      expect(parsed?.entries.map(entry => entry.smiles)).toEqual(["CCO"]);
      expect(parsed?.failures).toEqual([
        { input: smiles, error: expect.stringContaining("square-planar stereochemistry") }
      ]);
      expect(parsed?.skipped).toBe(0);
      expect(depict.mock.calls.map(([input]) => input)).toEqual(["CCO"]);
      const result = await checkedSmilesGridPaste(createEmptyDocument(), point, parsed!.entries);
      expect(result.objectIds).toHaveLength(1);
      expect(result.failures).toEqual([]);
      const molecule = result.document.pages[0]!.objects[0];
      if (molecule?.type !== "molecule") throw new Error("Expected molecule");
      await verify(molecule, "CCO");
    } finally { depict.mockRestore(); }
  });

  it.each([
    "CC=CC", "CC(C)=CCCC(C)=CC=O", "OC(=O)C=CC(=O)O", "CC=CC1CCCCC1",
    "[2H]C=Cc1ccccc1", "C/C=C/C", "[2H]/C=C/c1ccccc1",
    "[H]C([H])([H])O", "C[C@@H](O)CC", "[H]/C(C)=C(/[H])C", "[Na+].[O-]C(=O)c1ccccc1",
    "c1cc[nH]c1", "C[N+](C)(C)C", "[2H]C([2H])([2H])O", "N[C@@H](C)C(=O)O", "F/C=C/F",
    "C1=CC=CC=C1", "C[C@H](C)C", "[C@H](F)(F)F", "O=C=[C@](F)Cl", "C[N@]=C=O",
    "C[P@](CC)(c1ccccc1)=[N+]=P(c1ccccc1)(c1ccccc1)c1ccccc1",
    "C[S@](=O)(=N)c1ccccc1", "C[S@](=O)(=NC)c1ccccc1",
    "O=[S@@](=NC(C)=O)(C)c1ccccc1"
  ])("accepts real paste depiction without changing identity: %s", async smiles => {
    const parsed = await depictSmilesForPaste(smiles);
    expect(parsed).toBeDefined();
    const pasted = await checkedSmilesPaste(createEmptyDocument(), point, parsed!.depiction, smiles);
    await verify(pasted.pages[0]!.objects[0] as MoleculeObject, smiles);
    const plugin = await structureFromSmilesForPlugin({ smiles }, createEmptyDocument);
    expect(plugin.available && plugin.built, JSON.stringify(plugin)).toBe(true);
  });

  it.each(["[H]C([H])([H])O", "[H]/C(C)=C(/[H])C"])(
    "normalizes the assistant's explicit-H inspection as well: %s", async smiles => {
      const { context, replace } = testContext(false);
      replace(createEmptyDocument());
      context.chemistry.inspectStructure = async (_format, value) => {
        const rdkit = await ensureRdkit();
        const molecule = rdkit.get_mol(value, JSON.stringify({ removeHs: false }));
        if (!molecule) throw new Error("RDKit could not parse the structure");
        try {
          const graph = JSON.parse(molecule.get_json!());
          const defaultZ = graph.defaults.atom.z;
          const heavyAtoms = graph.molecules[0].atoms.filter(
            (atom: { z?: number }) => (atom.z ?? defaultZ) !== 1).length;
          const identity = inspectHydrogenNormalizedIdentity(rdkit, value);
          if (!identity.valid) return identity;
          return { valid: true, canonicalSmiles: molecule.get_smiles!(),
            identitySmiles: identity.canonicalSmiles, heavyAtoms, formula: "test-only", warnings: [] };
        } finally { molecule.delete(); }
      };
      context.chemistry.structureFromSmiles = async ({ smiles }) => {
        const parsed = await depictSmilesForPaste(smiles);
        const object = createSmilesMolecule(context.getDocument()!, point, parsed!.depiction, smiles);
        return { available: true, built: true, object };
      };
      const inspection = await context.chemistry.inspectStructure("smiles", smiles);
      expect(inspection.valid).toBe(true);
      if (!inspection.valid) throw new Error(inspection.reason);
      expect(inspection.canonicalSmiles).toContain("[H]");
      expect(inspection.identitySmiles).not.toContain("[H]");
      const write = context.write;
      context.write = async (patch, signal, check, expectedSmiles) => {
        const before = context.getDocument()!;
        const patched = applyPatch(before, patch);
        const ids = [...expectedSmiles?.keys() ?? []];
        await verifyNormalizedAssistantWrite(context, before, patched, new Set(ids), expectedSmiles);
        return write(patch, signal, check, expectedSmiles);
      };
      const built = await buildInsertStructures(context, { items: [{ kind: "molecule", smiles }] });
      const result = await applyAssistantWrite(context, built);
      const molecule = context.getDocument()!.pages[0]!.objects.find(object =>
        result.objectIds.includes(object.id) && object.type === "molecule") as MoleculeObject;
      await verify(molecule, smiles);
    });

  it.each([
    ["N[C@@H](C)C(=O)O", "NC(C)C(=O)O"],
    ["F/C=C/F", "F/C=C\\F"], ["C/C=C/C", "C/C=C\\C"],
    ["N[C@@H](C)C(=O)O", "N[C@H](C)C(=O)O"],
    ["[NH3+]CC(=O)[O-]", "NCC(=O)O"], ["[CH3]", "C"], ["CCO", "CO"], ["CC=CC", "CCCC"]
  ])("refuses a depiction with changed chemistry or specified stereo: %s", async (smiles, stripped) => {
    const parsed = await depictSmilesForPaste(stripped);
    await expect(checkedSmilesPaste(createEmptyDocument(), point, parsed!.depiction, smiles))
      .rejects.toThrow("SMILES paste refused");
  });

  it("describes a stereo mismatch without blaming isotope labels that were preserved", async () => {
    const source = "[2H]/C=C/c1ccccc1", output = "[2H]/C=C\\c1ccccc1";
    const parsed = (await depictSmilesForPaste(output))!;
    const failure = await checkedSmilesPaste(createEmptyDocument(), point, parsed.depiction, source)
      .then(() => { throw new Error("Expected refusal"); }, (error: Error) => error);
    expect(failure.message).toContain("stereochemistry");
    expect(failure.message).toContain(`${source} -> ${output}`);
    expect(failure.message).not.toContain("isotope labels");
  });

  it("names stereochemistry when two specified centres are inverted", async () => {
    const smiles = "C[C@H](O)[C@@H](N)C", opposite = "C[C@@H](O)[C@H](N)C";
    const parsed = (await depictSmilesForPaste(opposite))!;
    await expect(checkedSmilesPaste(createEmptyDocument(), point, parsed.depiction, smiles))
      .rejects.toThrow("the drawn structure would change stereochemistry");
  });

  it.each(isotopeInsertSmiles)("preserves single paste and plugin structure %s", async smiles => {
    const source = await generateSmiles2DMolfile(smiles);
    const document = createEmptyDocument();
    const pasted = await checkedSmilesPaste(document, point, pastedStructureDepictionFromMolfile(source),
      smiles, inspect);
    await verify(pasted.pages[0]!.objects[0] as MoleculeObject, smiles);
    const plugin = await structureFromSmilesForPlugin({ smiles }, () => document);
    expect(plugin.available && plugin.built, JSON.stringify(plugin)).toBe(true);
    if (!plugin.available || !plugin.built || plugin.object.type !== "molecule") throw new Error("not built");
    await verify(plugin.object, smiles);
  });

  it("preserves every isotope and position in a list paste", async () => {
    const text = isotopeInsertSmiles.join("\n");
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(parsed?.entries).toHaveLength(isotopeInsertSmiles.length);
    const result = await checkedSmilesGridPaste(createEmptyDocument(), point, parsed!.entries, inspect);
    expect(result.failures).toEqual([]);
    for (const [index, molecule] of result.document.pages[0]!.objects.entries()) {
      await verify(molecule as MoleculeObject, isotopeInsertSmiles[index]!);
    }
  });

  it("pastes mixed specified/unspecified stereo while skipping a changed specified geometry", async () => {
    const smiles = ["CC=CC", "C/C=C/C", "[2H]C=Cc1ccccc1", "[2H]/C=C/c1ccccc1"];
    const text = smiles.join("\n");
    const parsed = (await depictSmilesListForPaste(text, smilesListCandidates(text)))!;
    const wrong = (await depictSmilesForPaste("F/C=C\\F"))!;
    const result = await checkedSmilesGridPaste(createEmptyDocument(), point,
      [...parsed.entries, { smiles: "F/C=C/F", depiction: wrong.depiction }]);
    expect(result.objectIds).toHaveLength(4);
    expect(result.failures).toEqual([
      { input: "F/C=C/F", error: expect.stringContaining("stereochemistry") }
    ]);
    for (const [index, molecule] of result.document.pages[0]!.objects.entries()) {
      await verify(molecule as MoleculeObject, smiles[index]!);
    }
  });

  it("refuses an isotope moved to the other product carbon, even with the same atom counts", async () => {
    const input = "[2H]C1C(c2ccccc2)ON=C1c1ccccc1";
    const moved = "[2H]C1(CC(=NO1)c1ccccc1)c1ccccc1";
    const depiction = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(moved));
    const document = createEmptyDocument();
    await expect(checkedSmilesPaste(document, point, depiction, input, inspect))
      .rejects.toThrow(/chemical identity|isotope labels or their positions/);
    const result = await checkedSmilesGridPaste(document, point, [{ smiles: input, depiction }], inspect);
    expect(result.document).toBe(document);
    expect(result.objectIds).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it.each(["[2H]C1C(c2ccccc2)ON=C1c1ccccc1", "[13CH3]c1ccccc1"])(
    "refuses a lossy single paste and skips only the lossy list entry: %s", async smiles => {
      const document = createEmptyDocument();
      const before = structuredClone(document);
      const stripped = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(
        smiles.replace(/\[2H\]/g, "").replace("[13CH3]", "C")));
      await expect(checkedSmilesPaste(document, point, stripped, smiles))
        .rejects.toThrow("SMILES paste refused: the drawn structure would change isotope labels");
      expect(document).toEqual(before);
      const valid = "CC(=[18O])C";
      const result = await checkedSmilesGridPaste(document, point, [
        { smiles, depiction: stripped },
        { smiles: valid,
          depiction: pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(valid)) }
      ], inspect);
      expect(result.failures).toEqual([
        { input: smiles, error: expect.stringContaining("SMILES paste refused") }
      ]);
      expect(result.objectIds).toHaveLength(1);
      await verify(result.document.pages[0]!.objects[0] as MoleculeObject, valid);
    });
});
