import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyDocument, serializeDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE, refreshNativeSingleBondGraph } from "@chemdraft/document-workflow-core";
import { loadAgentDocument } from "./documentInput";

// A lone H atom is H• today (owner decision 2026-11-23). A file saved by release 1.2.2 caches it as the
// bare atom with no radical ([H], H, radicalCount 0); one saved by an earlier release candidate caches the
// H2 reading ([HH], H2, 2.016). The desktop re-derives both on open (document-workflow-core's
// `withImpliedRadicalChemistryRederived`); the headless loader every CLI and MCP document command uses
// must read the same file the same way.

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "chemdraft-lone-h-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const loneH: MoleculeAtom = { id: "h", element: "H", x: 0, y: 0, formalCharge: 0 };
const moleculeOf = (structure: string, chemistry: MoleculeObject["chemistry"]): MoleculeObject => ({
  id: "lone", type: "molecule", x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure, superatoms: [], rGroups: [], atoms: [loneH], bonds: [], chemistry
});
/** Today's record of the drawing, as every graph edit derives it. */
const today = () => refreshNativeSingleBondGraph(moleculeOf("", undefined), [loneH], []);
const fileWith = async (molecule: MoleculeObject) => {
  const base = createEmptyDocument();
  const path = join(directory, "lone-h.chemdraft");
  await writeFile(path, serializeDocument({ ...base, pages: [{ ...base.pages[0]!, objects: [molecule] }] }));
  return path;
};
const loadedMolecule = async (path: string) => {
  const opened = await loadAgentDocument(path);
  return { molecule: opened.document!.pages[0]!.objects[0] as MoleculeObject, warnings: opened.warnings };
};

describe("headless document load: historical lone-H caches", () => {
  it("re-derives release 1.2.2's [H] / H cache with no radical to H•", async () => {
    const current = today();
    expect(current.structure).toBe("[H]");
    expect(current.chemistry).toMatchObject({ formula: "H", radicalCount: 1 });
    const stale = moleculeOf("[H]", { ...current.chemistry!, radicalCount: 0 });

    const { molecule, warnings } = await loadedMolecule(await fileWith(stale));
    expect(molecule.structure).toBe("[H]");
    expect(molecule.chemistry).toEqual(current.chemistry);
    expect(warnings.filter((warning) => warning.code === IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE)).toEqual([]);
  });

  it("re-derives an earlier release candidate's [HH] / H2 cache to [H] / H", async () => {
    const current = today();
    const stale = moleculeOf("[HH]", { ...current.chemistry!, formula: "H2", averageMass: 2.016, exactMass: 2.01565, radicalCount: 0 });

    const { molecule, warnings } = await loadedMolecule(await fileWith(stale));
    expect(molecule.structure).toBe("[H]");
    expect(molecule.chemistry).toEqual(current.chemistry);
    expect(molecule.chemistry).toMatchObject({ formula: "H", averageMass: 1.008, radicalCount: 1 });
    expect(warnings.filter((warning) => warning.code === IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE)).toEqual([]);
  });

  it("keeps a cache that is not ChemDraft's own earlier output, and names it as the desktop open report does", async () => {
    const current = today();
    const foreign = moleculeOf("[HH]", { ...current.chemistry!, formula: "H2", averageMass: 2.016, exactMass: 2.01565,
      radicalCount: 0, stereochemistry: ["kept"] });

    const { molecule, warnings } = await loadedMolecule(await fileWith(foreign));
    expect(molecule.structure).toBe("[HH]");
    expect(molecule.chemistry).toEqual(foreign.chemistry);
    expect(warnings.filter((warning) => warning.code === IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE))
      .toEqual([expect.objectContaining({ sourceObjectId: "lone" })]);
  });
});
