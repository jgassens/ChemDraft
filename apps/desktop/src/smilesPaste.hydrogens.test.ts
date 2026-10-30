import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import {
  assertMoleculeMatchesSmiles, inspectHydrogenNormalizedIdentity, stereoPerceptionMolfile,
  type InspectChemicalIdentity
} from "@chemdraft/document-workflow-core";
import type { RdkitJson } from "@chemdraft/rdkit-adapter";
import { ensureRdkit, resetRdkitForTesting } from "../../../packages/rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/testing";
import { checkedSmilesPaste, checkedSmilesGridPaste } from "./smilesPasteIdentity";
import { depictSmilesForPaste, depictSmilesListForPaste } from "./smilesListPaste";

const point = { x: 200, y: 200 };
const inspect: InspectChemicalIdentity = async (_format, value, stereoReference) =>
  inspectHydrogenNormalizedIdentity(await ensureRdkit(), value, stereoReference);

beforeAll(async () => {
  installRealRdkitModuleLoader();
  await ensureRdkit();
}, 30_000);
afterAll(() => resetRdkitForTesting());

interface HydrogenCase {
  smiles: string;
  /** Explicit native atoms after folding only ordinary neutral H. */
  counts: Record<string, number>;
  folded: number;
  charges: [string, number][];
  singleBonds: number;
  openDoubleBonds: number;
  specifiedDoubleBonds?: number;
}

// These all succeed with the vendored RDKit. In particular, HCl folds to Cl with one
// implicit H; that is the permitted ordinary-H fold, not loss of the hydrogen atom.
const cases: HydrogenCase[] = [
  { smiles: "[2H]C([2H])([2H])O", counts: { C: 1, D: 3, O: 1 }, folded: 0,
    charges: [], singleBonds: 4, openDoubleBonds: 0 },
  { smiles: "[H]C([2H])([2H])O", counts: { C: 1, D: 2, O: 1 }, folded: 1,
    charges: [], singleBonds: 3, openDoubleBonds: 0 },
  { smiles: "[H]C([3H])=CC", counts: { C: 3, T: 1 }, folded: 1,
    charges: [], singleBonds: 2, openDoubleBonds: 1 },
  { smiles: "[3H]C=CC", counts: { C: 3, T: 1 }, folded: 0,
    charges: [], singleBonds: 2, openDoubleBonds: 1 },
  { smiles: "C/C([2H])=C/C", counts: { C: 4, D: 1 }, folded: 0,
    charges: [], singleBonds: 3, openDoubleBonds: 0, specifiedDoubleBonds: 1 },
  { smiles: "[H+]", counts: { H: 1 }, folded: 0,
    charges: [["H", 1]], singleBonds: 0, openDoubleBonds: 0 },
  { smiles: "[Na+].[H-]", counts: { Na: 1, H: 1 }, folded: 0,
    charges: [["Na", 1], ["H", -1]], singleBonds: 0, openDoubleBonds: 0 },
  { smiles: "[H][H]", counts: { H: 2 }, folded: 0,
    charges: [], singleBonds: 1, openDoubleBonds: 0 },
  { smiles: "[H]Cl", counts: { Cl: 1 }, folded: 1,
    charges: [], singleBonds: 0, openDoubleBonds: 0 },
  { smiles: "[H]C([H])([H])O.[H+]", counts: { C: 1, O: 1, H: 1 }, folded: 3,
    charges: [["H", 1]], singleBonds: 1, openDoubleBonds: 0 },
  { smiles: "[Na+].[H-].[H]C(C)=CC", counts: { Na: 1, H: 1, C: 4 }, folded: 1,
    charges: [["Na", 1], ["H", -1]], singleBonds: 2, openDoubleBonds: 1 },
  { smiles: "[H]C([H])([H])O", counts: { C: 1, O: 1 }, folded: 3,
    charges: [], singleBonds: 1, openDoubleBonds: 0 }
];

function countElements(atoms: readonly { element: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const atom of atoms) counts[atom.element] = (counts[atom.element] ?? 0) + 1;
  return counts;
}

async function rawGraph(value: string): Promise<RdkitJson> {
  // Never normalize H in these independent atom/isotope/charge assertions: doing so
  // could hide the same atom loss on both sides of the production identity check.
  const molecule = (await ensureRdkit()).get_mol(value, JSON.stringify({ removeHs: false }));
  try {
    if (!molecule?.get_json) throw new Error("Expected the real RDKit atom graph");
    return JSON.parse(molecule.get_json()) as RdkitJson;
  } finally { molecule?.delete(); }
}

function atomInventory(graph: RdkitJson, includeImplicitHs = false): string[] {
  return graph.molecules.flatMap(molecule => molecule.atoms.flatMap(atom => {
    const z = atom.z ?? graph.defaults?.atom?.z ?? 6;
    const isotope = atom.isotope ?? graph.defaults?.atom?.isotope ?? 0;
    const charge = atom.chg ?? graph.defaults?.atom?.chg ?? 0;
    const hydrogens = includeImplicitHs ? atom.impHs ?? graph.defaults?.atom?.impHs ?? 0 : 0;
    return [`${z}:${isotope}:${charge}`, ...Array<string>(hydrogens).fill("1:0:0")];
  })).sort();
}

async function expectExactHydrogenGraph(molecule: MoleculeObject, fixture: HydrogenCase) {
  const { counts, smiles, charges, openDoubleBonds, specifiedDoubleBonds = 0 } = fixture;
  const atomCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  expect(molecule.atoms).toHaveLength(atomCount);
  expect(countElements(molecule.atoms)).toEqual(counts);
  expect(molecule.atoms.filter(atom => atom.formalCharge).map(atom =>
    [atom.element, atom.formalCharge]).sort()).toEqual([...charges].sort());
  // D/T are native aliases with no redundant numeric isotope field. Check every
  // field, then independently check their mass numbers in the stored molfile below.
  expect(molecule.atoms.map(atom => atom.isotope)).toEqual(Array(atomCount).fill(undefined));
  expect(molecule.bonds).toHaveLength(fixture.singleBonds + openDoubleBonds + specifiedDoubleBonds);
  expect(molecule.bonds.filter(bond => bond.order === "single")).toHaveLength(fixture.singleBonds);
  const doubles = molecule.bonds.filter(bond => bond.order === "double");
  expect(doubles).toHaveLength(openDoubleBonds + specifiedDoubleBonds);
  expect(doubles.filter(bond => bond.stereo === "either")).toHaveLength(openDoubleBonds);

  const source = await rawGraph(smiles);
  const output = await rawGraph(stereoPerceptionMolfile(molecule));
  expect(source.molecules.flatMap(graph => graph.atoms)).toHaveLength(atomCount + fixture.folded);
  expect(output.molecules.flatMap(graph => graph.atoms)).toHaveLength(atomCount);
  const atomicNumbers: Record<string, number> = { H: 1, D: 1, T: 1, C: 6, O: 8, Na: 11, Cl: 17 };
  const expectedAtoms = Object.entries(counts).flatMap(([element, count]) =>
    Array.from({ length: count }, () => `${atomicNumbers[element]}:${element === "D" ? 2 : element === "T" ? 3 : 0}`));
  expect(output.molecules.flatMap(graph => graph.atoms.map(atom =>
    `${atom.z ?? output.defaults?.atom?.z ?? 6}:${atom.isotope ?? output.defaults?.atom?.isotope ?? 0}`
  )).sort()).toEqual(expectedAtoms.sort());
  // Including RDKit's implicit H proves folding preserves the TOTAL atoms, isotopes
  // and individual charges, including HCl and the neutral-H + charged-H mixtures.
  expect(atomInventory(output, true)).toEqual(atomInventory(source, true));
  if (specifiedDoubleBonds) {
    expect(output.molecules.flatMap(graph => graph.bonds).filter(bond =>
      bond.bo === 2 && (bond.stereo === "cis" || bond.stereo === "trans")))
      .toHaveLength(specifiedDoubleBonds);
  }
  // Full graph identity also checks isotope attachment and the specified E/Z sense.
  await assertMoleculeMatchesSmiles(molecule, smiles, inspect);
}

function onlyMolecule(objects: readonly unknown[]): MoleculeObject {
  expect(objects).toHaveLength(1);
  expect(objects[0]).toMatchObject({ type: "molecule" });
  return objects[0] as MoleculeObject;
}

describe("SMILES paste hydrogen preservation", () => {
  it.each(cases)("accepts single paste with exact identity: $smiles", async fixture => {
    const document = createEmptyDocument();
    const before = structuredClone(document);
    const parsed = await depictSmilesForPaste(fixture.smiles);
    expect(parsed).toBeDefined();
    const pasted = await checkedSmilesPaste(document, point, parsed!.depiction, fixture.smiles, inspect);
    await expectExactHydrogenGraph(onlyMolecule(pasted.pages[0]!.objects), fixture);
    expect(document).toEqual(before);
  }, 30_000);

  it.each(cases)("accepts list paste with exact identity: $smiles", async fixture => {
    const document = createEmptyDocument();
    const before = structuredClone(document);
    const text = `${fixture.smiles}\nCCO`;
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(parsed?.failures).toEqual([]);
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.entries.map(entry => entry.smiles)).toEqual([fixture.smiles, "CCO"]);
    const pasted = await checkedSmilesGridPaste(document, point, parsed!.entries, inspect);
    expect(pasted.failures).toEqual([]);
    expect(pasted.objectIds).toHaveLength(2);
    expect(pasted.document.pages[0]!.objects).toHaveLength(2);
    const molecule = pasted.document.pages[0]!.objects[0] as MoleculeObject;
    await expectExactHydrogenGraph(molecule, fixture);
    expect(document).toEqual(before);
  }, 30_000);

  // Successful paste alone is insufficient: exercise the real #245 inspector with
  // deliberately damaged depictions and require specific, per-entry refusal errors.
  it.each([
    ["[2H]C([2H])([2H])O", "CO", "isotope labels or their positions"],
    ["[H]C([2H])([2H])O", "CO", "isotope labels or their positions"],
    ["[H]C([3H])=CC", "C=CC", "isotope labels or their positions"],
    ["[3H]C=CC", "C=CC", "isotope labels or their positions"],
    ["C/C([2H])=C/C", "C/C=C/C", "isotope labels or their positions"],
    ["C/C([2H])=C/C", "C/C([2H])=C\\C", "stereochemistry"],
    ["[H+]", "[H-]", "charges"],
    ["[Na+].[H-]", "[Na+]", "charges"],
    ["[H][H]", "[H+]", "charges"],
    ["[H]Cl", "[Cl-]", "charges"],
    ["[H]C([H])([H])O.[H+]", "CO", "charges"],
    ["[Na+].[H-].[H]C(C)=CC", "[Na+].CC=CC", "charges"]
  ])("refuses changed identity in single and list paste: %s -> %s", async (smiles, changed, difference) => {
    const document = createEmptyDocument();
    const before = structuredClone(document);
    const altered = await depictSmilesForPaste(changed);
    expect(altered).toBeDefined();
    const message = `SMILES paste refused: the drawn structure would change ${difference}`;
    await expect(checkedSmilesPaste(document, point, altered!.depiction, smiles, inspect))
      .rejects.toThrow(message);
    const text = `${smiles}\nCCO`;
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(parsed?.entries).toHaveLength(2);
    const entries = parsed!.entries.map((entry, index) =>
      index === 0 ? { ...entry, depiction: altered!.depiction } : entry);
    const pasted = await checkedSmilesGridPaste(document, point, entries, inspect);
    expect(pasted.failures).toEqual([{ input: smiles, error: expect.stringContaining(message) }]);
    expect(pasted.objectIds).toHaveLength(1);
    await assertMoleculeMatchesSmiles(onlyMolecule(pasted.document.pages[0]!.objects), "CCO", inspect);
    expect(document).toEqual(before);
  }, 30_000);
});
