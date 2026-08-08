/**
 * The two honesty behaviours, held to their scope.
 *
 * A method that cannot represent a chemistry should say so where it is asked, and stay quiet where it is
 * not. Both halves are load-bearing: warning on every neutral carbonyl would attach a caveat to 45.8% of
 * this corpus's molecules and stop being read, which is how a warning becomes decoration.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure } from "./analysis";
import { IONIZATION_SITES_METHOD_ID, ionizationContract } from "./ionization";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

let counter = 0;
async function ionization(smiles: string) {
  counter += 1;
  const run = await analyzeStructure({
    format: "smiles", value: smiles, runId: `unsup-${counter}`,
    startedAt: "2026-08-08T00:00:00.000Z"
  } as never);
  return run.results.find((entry) => entry.methodId === IONIZATION_SITES_METHOD_ID);
}

describe("carbonyl basicity is a declared scope limit, not a per-molecule warning", () => {
  it("reports the protonated state as unassessed when that is the state presented", async () => {
    // Corpus rows: thiobenzoate S-protonated at pKa -5.53, and an amide O-protonated at -3.7.
    for (const smiles of ["CCSC(=[OH+])c1cccc(Br)c1", "CC=[OH+]", "CC(N)=[SH+]"]) {
      const result = await ionization(smiles);
      expect(result?.kind, smiles).toBe("ionization");
      if (result?.kind !== "ionization") continue;
      const reasons = result.unassessed.map((entry) => entry.reason).join(" ");
      expect(reasons, `${smiles} should name the unsupported basicity`)
        .toMatch(/protonated carbonyl or thiocarbonyl/i);
    }
  });

  it("stays SILENT on a neutral carbonyl, which 45.8% of the corpus contains", async () => {
    for (const smiles of ["CC(=O)O", "CC(=O)Nc1ccc(O)cc1", "CC(C)=O", "O=C(N)N"]) {
      const result = await ionization(smiles);
      if (result?.kind !== "ionization") continue;
      const reasons = result.unassessed.map((entry) => entry.reason).join(" ");
      expect(reasons, `${smiles} must not carry a carbonyl-basicity caveat`)
        .not.toMatch(/protonated carbonyl or thiocarbonyl/i);
    }
  });

  it("says no SUPPORTED EVENT rather than no ionizable site", async () => {
    // Butane has nothing; an enol has an O-H the table matches but the tautomer rewrite removes.
    for (const smiles of ["CCCC", "CC=CO"]) {
      const result = await ionization(smiles);
      if (result?.kind !== "ionization") continue;
      const reason = result.applicability.reasons.join(" ");
      expect(reason, smiles).toMatch(/No SUPPORTED ionization event/);
      expect(reason, `${smiles} must not imply the molecule has none`)
        .toMatch(/not evidence|does not cover every/i);
    }
  });

  it("states the interval's coverage on BOTH sets, naming where the curve was fitted", () => {
    const conventions = ionizationContract().conventions.join(" ");
    expect(conventions).toMatch(/OOF calibration corpus/);
    expect(conventions).toMatch(/external development set/);
    expect(conventions).toMatch(/57\.3%/);
    expect(conventions).toMatch(/exchangeab/i);
    // And the scope limit is declared once, where a reader looks for limits.
    expect(ionizationContract().knownUnsupportedChemistry.join(" "))
      .toMatch(/BASICITY of a carbonyl oxygen/);
  });
});
