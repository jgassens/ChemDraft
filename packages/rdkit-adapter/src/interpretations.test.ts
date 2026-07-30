import { describe, expect, it } from "vitest";

import { hashInterpretation, type MolecularInterpretation } from "@chemdraft/analysis-core";

import type { RdkitJson } from "./composition";
import {
  deriveInterpretation,
  describeInterpretation,
  fragmentTransformation,
  largestOrganicFragmentPlan,
  neutralizeTransformation,
  stripMolblockCharges,
  subsetRdkitJson
} from "./interpretations";

function json(atoms: RdkitJson["molecules"][number]["atoms"], bonds: RdkitJson["molecules"][number]["bonds"] = []): RdkitJson {
  return {
    defaults: { atom: { z: 6, impHs: 0, chg: 0, nRad: 0, isotope: 0 }, bond: { bo: 1 } },
    molecules: [{ atoms, bonds }]
  };
}

/** [Na+].[O-]C(=O)c1ccccc1 as RDKit writes it. */
const SODIUM_BENZOATE = json(
  [
    { z: 11, chg: 1 },
    { z: 8, chg: -1 },
    {},
    { z: 8 },
    {},
    { impHs: 1 },
    { impHs: 1 },
    { impHs: 1 },
    { impHs: 1 },
    { impHs: 1 }
  ],
  [
    { atoms: [1, 2] },
    { bo: 2, atoms: [2, 3] },
    { atoms: [2, 4] },
    { bo: 2, atoms: [4, 5] },
    { atoms: [5, 6] },
    { bo: 2, atoms: [6, 7] },
    { atoms: [7, 8] },
    { bo: 2, atoms: [8, 9] },
    { atoms: [9, 4] }
  ]
);

const sourceInterpretation: MolecularInterpretation = {
  id: "source",
  label: "as drawn",
  sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
  interpretationHash: "fnv1a64:bbbbbbbbbbbbbbbb",
  componentPolicy: "whole-input",
  explicitHydrogenPolicy: "as-drawn",
  isotopePolicy: "preserve-labels",
  aromaticityModel: "rdkit-default",
  transformations: []
};

describe("largestOrganicFragmentPlan", () => {
  it("keeps the carbon-containing component and names what it dropped", () => {
    const plan = largestOrganicFragmentPlan(SODIUM_BENZOATE);
    expect(plan).toBeDefined();
    expect(plan!.keptAtoms).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(plan!.keptFormula).toBe("C7H5O2");
    expect(plan!.removedFormulas).toEqual(["Na"]);
    expect(plan!.ambiguous).toBe(false);
  });

  it("returns undefined for a single component — there is nothing to select", () => {
    // Not a failure: offering an identity transformation would put a second, indistinguishable
    // interpretation in the run for every ordinary molecule.
    expect(largestOrganicFragmentPlan(json([{}, {}], [{ atoms: [0, 1] }]))).toBeUndefined();
  });

  it("returns undefined when no component contains carbon", () => {
    // Cisplatin. There is no organic fragment, and picking the largest inorganic one would be a
    // different interpretation wearing this one's name.
    const cisplatin = json(
      [{ z: 7, impHs: 3 }, { z: 7, impHs: 3 }, { z: 17 }, { z: 78 }, { z: 17 }],
      [{ atoms: [2, 3] }, { atoms: [3, 4] }]
    );
    expect(largestOrganicFragmentPlan(cisplatin)).toBeUndefined();
  });

  it("breaks ties on the lowest source atom index, so the choice survives a reordering", () => {
    // Two identical two-carbon components. Without a deterministic tie-break the chosen fragment would
    // depend on component discovery order, and the same molecule written twice would answer twice.
    const twins = json([{}, {}, {}, {}], [{ atoms: [0, 1] }, { atoms: [2, 3] }]);
    const plan = largestOrganicFragmentPlan(twins);
    expect(plan!.keptAtoms).toEqual([0, 1]);
  });

  it("flags the choice as arbitrary when a discarded component was organic and no smaller", () => {
    // Ferrocene's two cyclopentadienyl rings. Half the molecule is being thrown away and which half is
    // a coin flip, so the ledger says so rather than presenting the survivor as "the" fragment.
    const ferrocene = json(
      [
        { z: 26, chg: 2 },
        { impHs: 1 },
        { impHs: 1 },
        { impHs: 1 },
        { impHs: 1, chg: -1 },
        { impHs: 1 },
        { impHs: 1 },
        { impHs: 1 },
        { impHs: 1 },
        { impHs: 1, chg: -1 },
        { impHs: 1 }
      ],
      [
        { atoms: [1, 2] },
        { atoms: [2, 3] },
        { atoms: [3, 4] },
        { atoms: [4, 5] },
        { atoms: [5, 1] },
        { atoms: [6, 7] },
        { atoms: [7, 8] },
        { atoms: [8, 9] },
        { atoms: [9, 10] },
        { atoms: [10, 6] }
      ]
    );
    const plan = largestOrganicFragmentPlan(ferrocene);
    expect(plan!.ambiguous).toBe(true);
    expect(plan!.removedFormulas).toContain("C5H5");
    expect(fragmentTransformation(plan!).unrepresentableFeatures[0]).toMatch(/arbitrary/);
  });
});

describe("subsetRdkitJson", () => {
  it("carries only atoms and bonds, reindexed", () => {
    const subset = JSON.parse(subsetRdkitJson(SODIUM_BENZOATE, [1, 2, 3, 4, 5, 6, 7, 8, 9])) as RdkitJson;
    expect(subset.molecules[0]!.atoms).toHaveLength(9);
    expect(subset.molecules[0]!.atoms[0]).toEqual({ z: 8, chg: -1 });
    expect(subset.molecules[0]!.bonds[0]).toEqual({ atoms: [0, 1] });
    expect(subset.molecules[0]!.bonds).toHaveLength(9);
  });

  it("drops the extensions block, whose indices the subset invalidates", () => {
    // RDKit's `rdkitRepresentation` extension holds aromatic atom and bond indices keyed by the
    // ORIGINAL numbering. Carrying it onto a subset points it at atoms that no longer exist and
    // `get_mol` returns null — which is exactly how this was found.
    const withExtension = {
      ...SODIUM_BENZOATE,
      molecules: [
        {
          ...SODIUM_BENZOATE.molecules[0]!,
          extensions: [{ name: "rdkitRepresentation", aromaticAtoms: [4, 5, 6, 7, 8, 9] }]
        }
      ]
    } as RdkitJson;

    const subset = JSON.parse(subsetRdkitJson(withExtension, [1, 2, 3])) as Record<string, unknown>;
    expect((subset.molecules as Record<string, unknown>[])[0]).not.toHaveProperty("extensions");
  });

  it("keeps the defaults block, since atoms omit fields that match it", () => {
    const subset = JSON.parse(subsetRdkitJson(SODIUM_BENZOATE, [2, 4])) as RdkitJson;
    expect(subset.defaults?.atom?.z).toBe(6);
    // Bonds whose partner was dropped go with it rather than dangling.
    expect(subset.molecules[0]!.bonds).toHaveLength(1);
  });

  it("throws when there is no molecule to subset", () => {
    expect(() => subsetRdkitJson({ molecules: [] }, [0])).toThrowError(/no molecule/);
  });
});

describe("stripMolblockCharges", () => {
  it("removes M CHG records and counts what it removed", () => {
    const molblock = ["  header", "  4  3  0  0", "M  CHG  1   4  -1", "M  END"].join("\n");
    const result = stripMolblockCharges(molblock);
    expect(result.molblock).not.toContain("M  CHG");
    expect(result.molblock).toContain("M  END");
    expect(result.chargedAtomCount).toBe(1);
    expect(result.netChargeRemoved).toBe(-1);
  });

  it("reads every pair on a multi-charge record", () => {
    // A zwitterion: two atoms charged, net zero. The count is what matters — a net of zero would say
    // nothing happened about the one case where neutralisation matters most.
    const molblock = ["M  CHG  2   1   1   5  -1", "M  END"].join("\n");
    const result = stripMolblockCharges(molblock);
    expect(result.chargedAtomCount).toBe(2);
    expect(result.netChargeRemoved).toBe(0);
  });

  it("reports nothing to strip for a neutral molblock", () => {
    const result = stripMolblockCharges(["  header", "M  END"].join("\n"));
    expect(result.chargedAtomCount).toBe(0);
    expect(result.molblock).toContain("M  END");
  });

  it("leaves other M records alone", () => {
    const molblock = ["M  ISO  1   1  13", "M  RAD  1  11   2", "M  CHG  1   4  -1", "M  END"].join("\n");
    const result = stripMolblockCharges(molblock);
    expect(result.molblock).toContain("M  ISO");
    expect(result.molblock).toContain("M  RAD");
    expect(result.molblock).not.toContain("M  CHG");
  });
});

describe("describeInterpretation", () => {
  it("describes the source as drawn", () => {
    expect(describeInterpretation(sourceInterpretation)).toBe("as drawn");
  });

  it("produces the disclosure line §1 asks the UI to show", () => {
    const fragment = fragmentTransformation({
      keptAtoms: [1, 2],
      keptFormula: "C7H5O2",
      removedFormulas: ["Na"],
      ambiguous: false
    });
    expect(describeInterpretation({ ...sourceInterpretation, transformations: [fragment] })).toBe(
      "largest organic fragment · Na removed"
    );
  });

  it("counts charges rather than netting them", () => {
    const neutralize = neutralizeTransformation({
      atomCount: 5,
      neutralizedFormula: "C2H5NO2",
      chargedAtomCount: 2,
      netChargeRemoved: 0,
      hydrogenChanges: 0
    });
    expect(describeInterpretation({ ...sourceInterpretation, transformations: [neutralize] })).toBe(
      "neutralised · 2 charges removed"
    );
  });

  it("summarises a long removal list rather than reciting it", () => {
    const fragment = fragmentTransformation({
      keptAtoms: [0],
      keptFormula: "C6H6",
      removedFormulas: ["Na", "Cl", "H2O"],
      ambiguous: false
    });
    expect(describeInterpretation({ ...sourceInterpretation, transformations: [fragment] })).toBe(
      "largest organic fragment · 3 components removed"
    );
  });

  it("joins a chained ledger in order", () => {
    const fragment = fragmentTransformation({
      keptAtoms: [1],
      keptFormula: "C7H5O2",
      removedFormulas: ["Na"],
      ambiguous: false
    });
    const neutralize = neutralizeTransformation({
      atomCount: 9,
      neutralizedFormula: "C7H6O2",
      chargedAtomCount: 1,
      netChargeRemoved: -1,
      hydrogenChanges: 1
    });
    expect(
      describeInterpretation({ ...sourceInterpretation, transformations: [fragment, neutralize] })
    ).toBe("largest organic fragment · Na removed · neutralised · 1 charge removed");
  });
});

describe("deriveInterpretation", () => {
  const step = fragmentTransformation({
    keptAtoms: [1, 2],
    keptFormula: "C7H5O2",
    removedFormulas: ["Na"],
    ambiguous: false
  });

  it("generates its label from the ledger, so the two cannot drift", () => {
    const derived = deriveInterpretation({
      id: "largest-organic-fragment",
      base: sourceInterpretation,
      step,
      componentPolicy: "largest-organic-fragment"
    });
    expect(derived.label).toBe("largest organic fragment · Na removed");
    expect(derived.componentPolicy).toBe("largest-organic-fragment");
    expect(derived.transformations).toHaveLength(1);
    expect(derived.sourceHash).toBe(sourceInterpretation.sourceHash);
  });

  it("hashes differently from its base, so the two never share a cache entry", () => {
    const derived = deriveInterpretation({
      id: "largest-organic-fragment",
      base: sourceInterpretation,
      step,
      componentPolicy: "largest-organic-fragment"
    });
    expect(derived.interpretationHash).not.toBe(sourceInterpretation.interpretationHash);
    expect(derived.interpretationHash).toBe(
      hashInterpretation({
        id: derived.id,
        sourceHash: derived.sourceHash,
        componentPolicy: derived.componentPolicy,
        explicitHydrogenPolicy: derived.explicitHydrogenPolicy,
        isotopePolicy: derived.isotopePolicy,
        aromaticityModel: derived.aromaticityModel,
        transformations: derived.transformations
      })
    );
  });

  it("appends to the base ledger rather than replacing it", () => {
    const fragment = deriveInterpretation({
      id: "largest-organic-fragment",
      base: sourceInterpretation,
      step,
      componentPolicy: "largest-organic-fragment"
    });
    const neutralised = deriveInterpretation({
      id: "neutralized",
      base: fragment,
      step: neutralizeTransformation({
        atomCount: 9,
        neutralizedFormula: "C7H6O2",
        chargedAtomCount: 1,
        netChargeRemoved: -1,
        hydrogenChanges: 1
      })
    });

    expect(neutralised.transformations.map((entry) => entry.name)).toEqual([
      "largest-organic-fragment",
      "neutralize"
    ]);
    // The component policy travels with the chain: a neutralised fragment is still a fragment.
    expect(neutralised.componentPolicy).toBe("largest-organic-fragment");
  });
});
