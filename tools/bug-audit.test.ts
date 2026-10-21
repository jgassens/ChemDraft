import { expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { moleculeSmiles } from "@chemdraft/document-workflow-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeEngines } from "../packages/chemdraft-cli/src/engine";
import { strictSessionFlushRefusal } from "../apps/desktop/src/documentSession";
import { validateBatchName } from "../packages/chemdraft-cli/src/output";
import { runUpdateFlow } from "../apps/desktop/src/appUpdates";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { exportStructureListSdf } from "../apps/desktop/src/structureListExport";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";

// The desktop exporter registers its browser loader. Use the real Node WASM loader in this host.
vi.mock("../apps/desktop/src/rdkitWasmLoader", () => ({ registerRdkitWasmLoader: () => installNodeEngines() }));

const molecule = (element: string, markRadicals = 0): MoleculeObject => ({
  id: "mol", type: "molecule", x: 0, y: 0, width: 20, height: 20,
  rotation: 0, style: {}, structureFormat: "molfile-v2000", structure: "",
  atoms: [{ id: "a", element, x: 0, y: 0, formalCharge: 0, markRadicals }],
  bonds: [], superatoms: [], rGroups: []
});

it("preserves a methyl radical when the structure engine is unavailable", async () => {
  installNodeEngines();
  const warnings: ExportWarning[] = [];
  const engine = await moleculeSmiles(molecule("C", 1), 0, [], computeStructureIdentifiers);
  const smiles = await moleculeSmiles(molecule("C", 1), 0, warnings, undefined);
  expect(engine).toBe("[CH3]");
  expect(smiles).toBe("[CH3]");
  expect(warnings).toEqual([]);
});

it.each([["C", 1, "[CH3]"], ["C", 2, "[CH2]"], ["O", 1, "[OH]"], ["N", 1, "[NH2]"]] as const)(
  "preserves %s with %i radical electrons even when stored SMILES is stale", async (element, radicals, expected) => {
    const source = { ...molecule(element, radicals), structureFormat: "smiles" as const, structure: element };
    expect(await moleculeSmiles(source, 0, [], undefined)).toBe(expected);
  }
);

it("preserves a radical on a bonded carbon", async () => {
  installNodeEngines();
  const source = molecule("C", 1);
  source.atoms.push({ id: "b", element: "C", x: 20, y: 0, formalCharge: 0 });
  source.bonds.push({ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" });
  const fallback = await moleculeSmiles(source, 0, [], undefined);
  expect(fallback).toContain("[CH2]");
  const identity = await computeStructureIdentifiers(fallback);
  expect(identity?.smiles).toBe((await computeStructureIdentifiers("[CH2]C"))?.smiles);
});

it("refuses an update when autosave is disabled and deleting everything is unsaved", () => {
  const refusal = strictSessionFlushRefusal({ hydrated: true, saveEnabled: false,
    blank: true, fileState: { path: "/tmp/previous-drawing.chemdraft", dirty: true } });
  expect(refusal).toBeDefined();
});

it("stops the updater before installation when an empty dirty drawing cannot be autosaved", async () => {
  const install = vi.fn(async () => undefined);
  const message = vi.fn(async () => undefined);
  const outcome = await runUpdateFlow("manual", {
    check: async () => ({ version: "1", currentVersion: "0", download: async () => undefined,
      install, close: async () => undefined }),
    confirm: async () => true, message, setStatus: () => undefined,
    flushSession: async () => {
      const refusal = strictSessionFlushRefusal({ hydrated: true, saveEnabled: false,
        blank: true, fileState: { dirty: true } });
      if (refusal) throw new Error(refusal);
    }
  });
  expect(outcome).toBe("install-failed");
  expect(install).not.toHaveBeenCalled();
  expect(message).toHaveBeenCalledWith(expect.stringContaining("autosave is off"), expect.anything());
});

it("exports the same NH2 chemistry with the engine as without it", async () => {
  installNodeEngines();
  const warnings: ExportWarning[] = [];
  const source = molecule("NH2");
  const fallback = await moleculeSmiles(source, 0, [], undefined);
  const engine = await moleculeSmiles(source, 0, warnings, computeStructureIdentifiers);
  expect(engine).toBe(fallback);
  expect(warnings).toEqual([]);
});

it("keeps a radical-bearing CH3 label as a placeholder through real SMILES and SDF engines", async () => {
  installNodeEngines();
  const source = molecule("CH3", 2);
  const warnings: ExportWarning[] = [];
  const smiles = await moleculeSmiles(source, 0, warnings, computeStructureIdentifiers);
  expect(smiles).not.toContain("[CH3]");
  expect(warnings).toContainEqual(expect.objectContaining({
    code: "export.smiles_v2000_loss", message: expect.stringContaining('Atom label "CH3"')
  }));

  const document = createEmptyDocument();
  document.pages[0]!.objects.push(source);
  const sdf = await exportStructureListSdf(document);
  expect(sdf.warnings).toContainEqual(expect.objectContaining({
    code: "export.sdf_v2000_loss", message: expect.stringContaining('Atom label "CH3"')
  }));
  expect(sdf.contents).not.toContain("[CH3]");
});

it.each(["NH2", "OH", "CH3"])("preserves a bonded %s label through real SMILES and SDF engines", async (label) => {
  installNodeEngines();
  const source = molecule("C");
  source.atoms.push({ id: "b", element: label, x: 20, y: 0, formalCharge: 0 });
  source.bonds.push({ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" });
  const expected = label === "NH2" ? "CN" : label === "OH" ? "CO" : "CC";
  expect(await moleculeSmiles(source, 0, [], computeStructureIdentifiers)).toBe(expected);
  const doc = createEmptyDocument();
  doc.pages[0]!.objects.push(source);
  const sdf = await exportStructureListSdf(doc);
  const molfile = sdf.contents.split("> <SMILES>")[0]!;
  expect(parseMolfileGraph(molfile)?.atoms.map((atom) => atom.element)).toEqual(["C", label === "NH2" ? "N" : label === "OH" ? "O" : "C"]);
  expect((await computeStructureIdentifiers(molfile))?.smiles).toBe(expected);
  expect(sdf.warnings).toEqual([]);
});

it.each(["CON", "con", "NUL", "Aux", "PRN", "COM1", "COM9", "LPT1", "LPT9", "CON "])(
  "rejects Windows device name %s used for batch output", (name) => {
    expect(() => validateBatchName(name)).toThrow(/reserved/);
  }
);

it.each(["CON-molecule", "CON molecule", "COM10", "LPT10", "ethanol"])("allows portable batch name %s", (name) => {
  expect(() => validateBatchName(name)).not.toThrow();
});
