import { afterAll, beforeAll, describe, expect, it, vi } from "../../../node_modules/vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { ensureRdkit, generateSmiles2DMolfile, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import {
  assertMoleculeMatchesSmiles, ChemicalIdentityMismatchError, inspectHydrogenNormalizedIdentity
} from "./chemicalIdentity";
import { createSmilesMolecule, pastedStructureDepictionFromMolfile } from "./molecule";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

describe("unverifiable input stereo", () => {
  it.each([
    "F[C@](Cl)=C=C(Br)I", "F[C@@](Cl)=C=C(Br)I",
    "OC(Cl)=[C@]=C(C)F", "OC(Cl)=[C@@]=C(C)F",
    "OC(Cl)=[C@AL1]=C(C)F", "OC(Cl)=[C@AL2]=C(C)F",
    "F[C@AL1](Cl)=C=C(Br)I", "F[C@AL2](Cl)=C=C(Br)I"
  ])("refuses axial stereo in %s", async input => {
    expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(), input)).toEqual({
      valid: false, reason: "allene (axial) stereochemistry cannot be verified or drawn."
    });
  });

  it.each([
    "F/C=C=C=C/F", "F/C=C=C=C\\F", "[2H]/C=C=C=C/[2H]", "C(/F)=C=C=C/F",
    "C/1=C=C=C/CCC1", "CC.F/C=C=C=C/F"
  ])("refuses cumulene cis/trans in %s", async input => {
    expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(), input)).toEqual({
      valid: false, reason: "cumulene cis/trans stereochemistry cannot be verified or drawn."
    });
  });

  it.each(["F/C=C/C=C=C=C", "CC=C=C=CCC/C=C/C", "CC=C=C=CC.C/C=C/C"])(
    "verifies ordinary alkene E/Z beside an unspecified cumulene: %s", async input => {
      const module = await ensureRdkit();
      const source = inspectHydrogenNormalizedIdentity(module, input);
      if (!source.valid) throw new Error(source.reason);
      expect(source.canonicalSmiles).toMatch(/[\\/]/);
      const output = await generateSmiles2DMolfile(input);
      expect(inspectHydrogenNormalizedIdentity(module, output, source.canonicalSmiles)).toMatchObject({
        valid: true, canonicalSmiles: source.canonicalSmiles
      });
    });

  it("does not interpret direction marks in a molfile header as SMILES bonds", async () => {
    const module = await ensureRdkit();
    const molfile = (await generateSmiles2DMolfile("FC=C=C=CF"))
      .replace(/^[^\r\n]*/, "F/C=C=C=C/F");
    expect(inspectHydrogenNormalizedIdentity(module, molfile).valid).toBe(true);
  });

  it("checks unsupported stereo on the input reference before RDKit can erase it", async () => {
    expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(),
      "OC(Cl)=[C@@]=C(C)F", "OC(Cl)=[C@]=C(C)F")).toEqual({
      valid: false, reason: "allene (axial) stereochemistry cannot be verified or drawn."
    });
  });

  it.each([
    ["OC(Cl)=C=C(C)F", "OC(Cl)=[C@]=C(C)F"],
    ["FC=C=C=CF", "F/C=C=C=C/F"]
  ])("ignores output stereo where the input %s leaves it open", async (input, output) => {
    const module = await ensureRdkit();
    const source = inspectHydrogenNormalizedIdentity(module, input);
    if (!source.valid) throw new Error(source.reason);
    expect(inspectHydrogenNormalizedIdentity(module, output, source.canonicalSmiles)).toMatchObject({
      valid: true, canonicalSmiles: source.canonicalSmiles
    });
  });

  it.each([
    ["N[Pt@SP1](N)(Cl)Cl", "square-planar"],
    ["F[P@TB1](Cl)(Br)(N)I", "trigonal-bipyramidal"],
    ["F[Co@OH1](Cl)(Br)(N)(O)I", "octahedral"]
  ])("names the non-tetrahedral stereo in %s", async (input, kind) => {
    expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(), input)).toEqual({
      valid: false, reason: `${kind} stereochemistry cannot be verified or drawn.`
    });
  });

  it.each([
    "C[C@H](C)C", "[C@H](F)(F)F", "C[C@H](O)CC", "FC(Cl)=C=C(Br)I", "FC=C=C=CF",
    "O=C=[C@](F)Cl", "O=C=[C@@](F)Cl", "C[N@]=C=O",
    "C[P@](CC)(c1ccccc1)=[N+]=P(c1ccccc1)(c1ccccc1)c1ccccc1"
  ])(
    "allows harmless chirality marks and supported or unspecified stereo: %s", async input => {
      expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(), input).valid).toBe(true);
    });
});

describe("supported and harmless atom stereo", () => {
  it.each([
    "C[S@](=O)(=N)c1ccccc1",
    "C[S@](=O)(=NC)c1ccccc1",
    "O=[S@@](=NC(C)=O)(C)c1ccccc1",
    "C[S@](=O)c1ccccc1", "C[C@H](C)C", "O=C=[C@](F)Cl", "C[N@]=C=O",
    "C[P@](CC)(c1ccccc1)=[N+]=P(c1ccccc1)(c1ccccc1)c1ccccc1"
  ])("matches its own drawing: %s", async input => {
    const module = await ensureRdkit();
    const depiction = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(input));
    const molecule = createSmilesMolecule(createEmptyDocument(), { x: 100, y: 100 }, depiction, input);
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    await expect(assertMoleculeMatchesSmiles(molecule, input, async (_format, value, reference) =>
      inspectHydrogenNormalizedIdentity(module, value, reference))).resolves.toBeUndefined();
  });

  it("refuses an inverted sulfoximine drawing as a stereochemistry mismatch", async () => {
    const module = await ensureRdkit();
    const input = "C[S@](=O)(=N)c1ccccc1";
    const inverted = "C[S@@](=O)(=N)c1ccccc1";
    const depiction = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(inverted));
    const molecule = createSmilesMolecule(createEmptyDocument(), { x: 100, y: 100 }, depiction, inverted);
    if (molecule.type !== "molecule") throw new Error("Expected molecule");
    await expect(assertMoleculeMatchesSmiles(molecule, input, async (_format, value, reference) =>
      inspectHydrogenNormalizedIdentity(module, value, reference)))
      .rejects.toThrow("(stereochemistry)");
  });
});

describe("chemical identity mismatch classification", () => {
  it("uses plain canonical identity without substructure search when the input has no stereo", async () => {
    const real = await ensureRdkit();
    const get_mol = vi.fn((value: string, options?: string) => {
      const mol = real.get_mol(value, options);
      if (!mol) return mol;
      return {
        generate_3d_embed: (details: string) => mol.generate_3d_embed(details),
        optimize_3d_conformer: (details: string) => mol.optimize_3d_conformer(details),
        get_json: () => mol.get_json!(), get_smiles: () => mol.get_smiles!(), delete: () => mol.delete(),
        get_substruct_matches: () => { throw new Error("Unnecessary symmetry search"); }
      };
    });
    const input = "CCC(O[Si](C)(C)C(C)(C)C)C";
    const source = inspectHydrogenNormalizedIdentity({ get_mol }, input);
    if (!source.valid) throw new Error(source.reason);
    const result = inspectHydrogenNormalizedIdentity({ get_mol },
      "CC[C@H](O[Si](C)(C)C(C)(C)C)C", source.canonicalSmiles);
    expect(result).toMatchObject({ valid: true, canonicalSmiles: source.canonicalSmiles });
  });

  it.each([
    ["C[C@H](O)[C@@H](N)C", "C[C@@H](O)[C@H](N)C", "stereochemistry"],
    ["c1ccccc1-c1ccccc1", "c1ccccc1", "chemical identity"],
    ["[13CH4]", "C", "isotope labels or their positions"],
    ["[NH4+]", "N", "charges"]
  ])("classifies %s -> %s", async (input, changed, difference) => {
    const module = await ensureRdkit();
    const source = inspectHydrogenNormalizedIdentity(module, input);
    const output = inspectHydrogenNormalizedIdentity(module, changed);
    if (!source.valid || !output.valid) throw new Error("Expected parseable structures");
    const error = new ChemicalIdentityMismatchError("test", source.canonicalSmiles, output.canonicalSmiles,
      source.facts, output.facts);
    expect(error.difference).toBe(difference);
  });
});
