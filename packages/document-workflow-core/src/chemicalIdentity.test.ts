import { afterAll, beforeAll, describe, expect, it } from "../../../node_modules/vitest";
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
  it.each(["F[C@](Cl)=C=C(Br)I", "F[C@@](Cl)=C=C(Br)I"])("refuses axial stereo in %s", async input => {
    expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(), input)).toEqual({
      valid: false, reason: "allene (axial) stereochemistry cannot be verified or drawn."
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

  it.each(["C[C@H](C)C", "[C@H](F)(F)F", "C[C@H](O)CC", "FC(Cl)=C=C(Br)I"])(
    "allows harmless chirality marks and supported or unspecified stereo: %s", async input => {
      expect(inspectHydrogenNormalizedIdentity(await ensureRdkit(), input).valid).toBe(true);
    });
});

describe("supported sulfur stereo", () => {
  it.each([
    "C[S@](=O)(=N)c1ccccc1",
    "C[S@](=O)(=NC)c1ccccc1",
    "O=[S@@](=NC(C)=O)(C)c1ccccc1",
    "C[S@](=O)c1ccccc1"
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
