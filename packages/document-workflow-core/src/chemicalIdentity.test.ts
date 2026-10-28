import { afterAll, beforeAll, describe, expect, it } from "../../../node_modules/vitest";
import { ensureRdkit, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { ChemicalIdentityMismatchError, inspectHydrogenNormalizedIdentity } from "./chemicalIdentity";

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
