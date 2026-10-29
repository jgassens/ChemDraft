import { beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import { ensureRdkit } from "../../rdkit-adapter/src/conformer";
import { compositionFromRdkitJson } from "../../rdkit-adapter/src/composition";
import { chargeSeparationCases } from "./chargeSeparationFixtures";
import type { ExportWarning } from "@chemdraft/export-engine";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { engineSmilesAtomWarnings, moleculeSmiles } from "../src/moleculeSmiles";
import { metalCounterionCases, metalHydrogenLossCases, preservedRadicalExportCases, radicalExportCases, readAtomStates } from "./radicalExportFixtures";

beforeAll(() => { installNodeRdkitModuleLoader(); });

it.each(chargeSeparationCases)("reports charge-only sanitization once for $name", async ({ molecule, smiles: expected, formula, charge, changedAtoms }) => {
  const warnings: ExportWarning[] = [];
  const smiles = await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers);
  expect(smiles).toBe(expected);
  expect(warnings).toEqual([expect.objectContaining({
    code: "export.smiles_charge_separated", severity: "info", objectId: molecule.id
  })]);
  expect(warnings[0]!.message.match(/Atom /g)).toHaveLength(changedAtoms);
  expect(warnings[0]!.message).toContain("drawn with formal charge 0; SMILES reparses with formal charge");
  const rdkit = await ensureRdkit();
  const reparsed = rdkit.get_mol(smiles)!;
  try {
    const composition = compositionFromRdkitJson(JSON.parse(reparsed.get_json()));
    expect(composition.formula).toBe(formula);
    expect(composition.formalCharge).toBe(charge);
  } finally { reparsed.delete(); }
});

it.each(["nRad", "hydrogenCount", "isotope", "element", "formalCharge"] as const)(
  "keeps charge losses when %s also changes", async (field) => {
    const { molecule } = chargeSeparationCases[0]!;
    const identifiers = (await computeStructureIdentifiers(
      moleculeToMolfileV2000(molecule, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents, { includeAtomStates: true }
    ))!;
    const state = identifiers.smilesAtomStates![0]!;
    if (field === "element") state.element = "N";
    else state[field] += 1;
    const warnings = engineSmilesAtomWarnings(molecule, identifiers);
    expect(warnings.some((warning) => warning.code === "export.smiles_charge_loss")).toBe(true);
    expect(warnings.some((warning) => warning.severity === "info")).toBe(false);
  }
);

it("compares states per atom after canonical reordering, including H, charge and isotope", async () => {
  const molecule = structuredClone(preservedRadicalExportCases[0]!.molecule);
  // Input order O,C,N; canonical order starts at N. Both values and atom attribution matter.
  molecule.atoms = [
    { id: "oxygen", element: "O", x: 0, y: 0, formalCharge: 0 },
    { id: "carbon", element: "C", x: 28, y: 0, formalCharge: 0 },
    { id: "nitrogen", element: "N", x: 56, y: 0, formalCharge: 0 }
  ];
  molecule.bonds = [
    { id: "oc", fromAtomId: "oxygen", toAtomId: "carbon", order: "single" },
    { id: "cn", fromAtomId: "carbon", toAtomId: "nitrogen", order: "single" }
  ];
  const correct = await computeStructureIdentifiers("OCN", { includeAtomStates: true });
  expect(correct?.smilesAtomOrder).toEqual([2, 1, 0]);
  expect(engineSmilesAtomWarnings(molecule, correct)).toEqual([]);
  const changed = await computeStructureIdentifiers("O[13CH2][NH3+]", { includeAtomStates: true });
  expect(engineSmilesAtomWarnings(molecule, changed)).toEqual([
    expect.objectContaining({ code: "export.smiles_isotope_loss", message:
      "Atom carbon (C) is drawn with isotope 0; SMILES reparses with isotope 13." }),
    expect.objectContaining({ code: "export.smiles_hydrogen_loss", message:
      "Atom nitrogen (N) is drawn with 2 total hydrogens; SMILES reparses with 3 total hydrogens." }),
    expect.objectContaining({ code: "export.smiles_charge_loss", message:
      "Atom nitrogen (N) is drawn with formal charge 0; SMILES reparses with formal charge 1." })
  ]);
});

it("warns if the engine cannot provide a complete atom correspondence", async () => {
  const molecule = preservedRadicalExportCases[0]!.molecule;
  expect(engineSmilesAtomWarnings(molecule, { smiles: "CN(C)C" })).toEqual([
    expect.objectContaining({ code: "export.smiles_atom_state_unverified" })
  ]);
});

it("keeps identifier-only engines compatible while requiring evidence for drawn radicals", async () => {
  const molecule = structuredClone(preservedRadicalExportCases[0]!.molecule);
  const identifiersOnly = async () => ({ smiles: "CN(C)C" });
  const warnings: ExportWarning[] = [];
  expect(await moleculeSmiles(molecule, 0, warnings, identifiersOnly)).toBe("CN(C)C");
  expect(warnings).toEqual([]);
  await moleculeSmiles(molecule, 0, warnings, identifiersOnly, undefined, { requireEngineAtomStates: true });
  expect(warnings).toEqual([expect.objectContaining({ code: "export.smiles_atom_state_unverified" })]);

  molecule.atoms[0]!.markRadicals = 1;
  const radicalWarnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, radicalWarnings, identifiersOnly);
  expect(radicalWarnings).toEqual([expect.objectContaining({ code: "export.smiles_atom_state_unverified" })]);
});

it("does not treat partial atom-state evidence as an identifier-only engine", async () => {
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(preservedRadicalExportCases[0]!.molecule, 0, warnings,
    async () => ({ smiles: "CN(C)C", smilesAtomStates: [] }));
  expect(warnings).toEqual([expect.objectContaining({ code: "export.smiles_atom_state_unverified" })]);
});

it("reparses native isotope-radical spelling when the molfile radical encoding fails", async () => {
  const { molecule } = radicalExportCases.find(({ name }) => name === "D / 2")!;
  const warnings: ExportWarning[] = [];
  expect(await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers)).toBe("[2H]");
  expect(warnings).toEqual([expect.objectContaining({
    code: "export.smiles_radical_loss",
    message: "Atom a (D) is drawn with 2 radical electrons; SMILES reparses with 1 radical electron."
  })]);
});

it("requires engine evidence for strict callers even when the fallback predictor would be uncertain", async () => {
  const molecule = preservedRadicalExportCases.find(({ name }) => name === "typed Pt")!.molecule;
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, warnings, async () => undefined, undefined,
    { requireEngineAtomStates: true });
  expect(warnings).toEqual([expect.objectContaining({ code: "export.smiles_atom_state_unverified" })]);
});

it("reparses native radical spelling with a branched traversal in a different atom order", async () => {
  const molecule = structuredClone(preservedRadicalExportCases[0]!.molecule);
  molecule.atoms[3]!.markRadicals = 3;
  const warnings: ExportWarning[] = [];
  const smiles = await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers);
  expect(warnings).toEqual([]);
  expect((await readAtomStates(smiles)).map(({ radicals }) => radicals).sort()).toEqual([0, 0, 0, 3]);
  // A stated hydrogen count that the native writer cannot carry must also be checked here.
  molecule.atoms[0]!.hydrogenCount = 2;
  const changedWarnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, changedWarnings, computeStructureIdentifiers);
  expect(changedWarnings).toEqual([expect.objectContaining({ code: "export.smiles_hydrogen_loss",
    message: "Atom a0 (C) is drawn with 2 total hydrogens; SMILES reparses with 3 total hydrogens." })]);
});

describe.each([
  { route: "engine", compute: computeStructureIdentifiers },
  { route: "native fallback", compute: undefined }
])("radical SMILES export: $route", ({ compute }) => {
  it.each(metalHydrogenLossCases)("warns before exporting an undrawn radical or hydride: $name", async ({ molecule, states }) => {
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, warnings, compute);
    expect(warnings).toContainEqual(expect.objectContaining({
      code: compute ? expect.stringMatching(/^export\.smiles_(radical|hydrogen)_loss$/) : "export.smiles_radical_loss", objectId: molecule.id,
      message: expect.stringContaining(`Atom ${molecule.atoms[0]!.id}`)
    }));
    expect(warnings[0]!.message).not.toContain("would imply 0");
    // Canonical SMILES ordering may differ, but these cases change the molecular totals too.
    const total = (entries: typeof states) => entries.reduce((sum, atom) => sum + atom.radicals + atom.hydrogens, 0);
    expect(total(await readAtomStates(smiles))).not.toBe(total(states));
  });

  it.each(metalCounterionCases)("keeps ordinary counterions warning-free: $name", async ({ molecule, states }) => {
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, warnings, compute);
    expect(warnings).toEqual([]);
    expect(await readAtomStates(smiles)).toEqual(states);
  });

  it.each(preservedRadicalExportCases)("preserves supported atom states: $name", async (entry) => {
    const { molecule, states, smiles: expectedSmiles } = entry;
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, warnings, compute);
    if (!compute && "fallbackNeedsEngine" in entry) {
      expect(warnings).toEqual([expect.objectContaining({
        code: "export.smiles_radical_loss",
        message: expect.stringContaining("cannot be reliably determined without the structure engine")
      })]);
    } else expect(warnings).toEqual([]);
    expect((await computeStructureIdentifiers(smiles))?.smiles).toBe(expectedSmiles);
    expect(await readAtomStates(smiles, true)).toEqual(states);
  });

  it.each(radicalExportCases)("preserves every atom property or warns: $name", async ({ molecule, states, loss }) => {
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, warnings, compute);
    const actual = await readAtomStates(smiles);
    if (loss) {
      expect(warnings).toContainEqual(expect.objectContaining({
        code: "export.smiles_radical_loss", objectId: molecule.id,
        message: expect.stringContaining(`Atom ${molecule.atoms[0]!.id}`)
      }));
    } else {
      expect(warnings).toEqual([]);
      expect(actual).toEqual(states);
    }
  });

  it("reports the inferred radicals of an incomplete literal N label", async () => {
    const molecule = structuredClone(preservedRadicalExportCases[2]!.molecule);
    molecule.atoms[1]!.element = "N";
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, warnings, compute);
    expect(warnings).toEqual([expect.objectContaining({
      code: "export.smiles_radical_loss",
      message: compute
        ? "Atom a1 (N) is drawn with 0 radical electrons; SMILES reparses with 2 radical electrons."
        : "Atom a1 (N) is drawn with 0 radical electrons; SMILES would imply 2 radical electrons with its hydrogen count and formal charge."
    })]);
    expect((await readAtomStates(smiles))[1]).toMatchObject({ radicals: 2, hydrogens: 0, charge: 0 });
  });

  it.each(["D", "T"])("describes the actual hydrogen/radical change for lone %s", async (element) => {
    const molecule = structuredClone(radicalExportCases.find(({ name }) => name === "D / 2")!.molecule);
    Object.assign(molecule.atoms[0]!, { element, markRadicals: 0 });
    const warnings: ExportWarning[] = [];
    const smiles = await moleculeSmiles(molecule, 0, warnings, compute);
    expect(warnings).toEqual([expect.objectContaining({
      code: compute ? "export.smiles_hydrogen_loss" : "export.smiles_radical_loss",
      message: compute
        ? `Atom a (${element}) is drawn with 0 total hydrogens; SMILES reparses with 1 total hydrogen.`
        : `Atom a (${element}) is drawn with 0 radical electrons; SMILES cannot preserve its hydrogen count: the engine adds 1 hydrogen; the native writer instead implies 1 radical electron.`
    })]);
    expect(await readAtomStates(smiles)).toEqual([{
      radicals: compute ? 0 : 1, hydrogens: compute ? 1 : 0, charge: 0, isotope: element === "D" ? 2 : 3
    }]);
  });

  it("uses singular radical electron for a drawn count of one", async () => {
    const warnings: ExportWarning[] = [];
    await moleculeSmiles(radicalExportCases[0]!.molecule, 0, warnings, compute);
    expect(warnings[0]!.message).toBe(compute
      ? "Atom a (C) is drawn with 1 radical electron; SMILES reparses with 4 radical electrons."
      : "Atom a (C) is drawn with 1 radical electron; SMILES would imply 4 radical electrons with its hydrogen count and formal charge.");
  });
});

it("explains why preserving three radicals requires the stereo-limited native writer", async () => {
  const molecule = structuredClone(radicalExportCases.find(({ name }) => name === "C / 3")!.molecule);
  molecule.atoms.push({ id: "b", element: "C", x: 28, y: 0, formalCharge: 0 });
  molecule.bonds.push({ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "wedge" } });
  const warnings: ExportWarning[] = [];
  await moleculeSmiles(molecule, 0, warnings, computeStructureIdentifiers);
  expect(warnings).toEqual([expect.objectContaining({
    code: "export.smiles_stereo_dropped",
    message: expect.stringContaining("the native writer required to preserve its radical count does not support stereochemistry")
  })]);
});
