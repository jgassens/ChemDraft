import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  analysisCacheKey,
  analysisHash,
  assertTautomerPolicy,
  changesChemicalIdentity,
  composeAtomMappings,
  composeTransformationChain,
  hashInterpretation,
  hashSource,
  identityAtomMapping,
  interpretationChangesIdentity,
  invertAtomMapping,
  mapDerivedToSource,
  mapSourceToDerived,
  MolecularInterpretationSchema,
  sourceAtomsFor,
  type MolecularInterpretation,
  type Transformation
} from "./interpretation";

function transformation(overrides: Partial<Transformation> = {}): Transformation {
  return {
    name: "identity",
    version: "1.0.0",
    atomMapping: [],
    componentsRemoved: [],
    componentsRetained: [],
    componentsNeutralized: [],
    bondOrderChanges: 0,
    aromaticityChanges: 0,
    hydrogenChanges: 0,
    tautomerChanged: false,
    chargeChanges: 0,
    unrepresentableFeatures: [],
    ...overrides
  };
}

function interpretation(overrides: Partial<MolecularInterpretation> = {}): MolecularInterpretation {
  return {
    id: "source",
    label: "as drawn",
    sourceHash: "fnv1a64:0000000000000000",
    interpretationHash: "fnv1a64:1111111111111111",
    componentPolicy: "whole-input",
    explicitHydrogenPolicy: "as-drawn",
    isotopePolicy: "preserve-labels",
    aromaticityModel: "rdkit-default",
    transformations: [],
    ...overrides
  };
}

describe("atom mapping", () => {
  it("composes two steps and drops atoms either step lost", () => {
    // Sodium benzoate: strip the counterion (source atoms 0..8, sodium is 8), then add hydrogens,
    // which reindexes nothing but shifts nothing either. Atom 8 has no derived counterpart and must
    // not reappear.
    const stripCounterion: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 7]
    ];
    const reorder: ReadonlyArray<readonly [number, number]> = [
      [0, 7],
      [1, 6],
      [2, 5],
      [3, 4],
      [4, 3],
      [5, 2],
      [6, 1],
      [7, 0]
    ];

    const composed = composeAtomMappings(stripCounterion, reorder);
    expect(composed).toHaveLength(8);
    expect(mapSourceToDerived(composed, 0)).toBe(7);
    expect(mapSourceToDerived(composed, 7)).toBe(0);
    expect(mapSourceToDerived(composed, 8)).toBeUndefined();
  });

  it("drops a source atom whose intermediate index the second step discards", () => {
    const first: ReadonlyArray<readonly [number, number]> = [
      [10, 0],
      [11, 1]
    ];
    const second: ReadonlyArray<readonly [number, number]> = [[0, 0]];

    const composed = composeAtomMappings(first, second);
    expect(composed).toEqual([[10, 0]]);
    expect(mapSourceToDerived(composed, 11)).toBeUndefined();
  });

  it("composes a whole ledger in order", () => {
    const chain = composeTransformationChain([
      transformation({
        name: "largest-organic-fragment",
        atomMapping: [
          [0, 0],
          [1, 1],
          [2, 2]
        ]
      }),
      transformation({
        name: "neutralize",
        atomMapping: [
          [0, 2],
          [1, 1],
          [2, 0]
        ]
      })
    ]);

    expect(chain).toEqual([
      [0, 2],
      [1, 1],
      [2, 0]
    ]);
  });

  it("returns an empty mapping for an empty ledger rather than throwing", () => {
    expect(composeTransformationChain([])).toEqual([]);
  });

  it("inverts and round-trips", () => {
    const mapping = identityAtomMapping(4);
    expect(mapping).toHaveLength(4);
    const shifted: ReadonlyArray<readonly [number, number]> = [
      [0, 3],
      [1, 2]
    ];
    expect(invertAtomMapping(shifted)).toEqual([
      [3, 0],
      [2, 1]
    ]);
    expect(mapDerivedToSource(shifted, 3)).toBe(0);
  });

  it("maps a derived-space result back to the atoms the user drew", () => {
    const salt = interpretation({
      id: "largest-organic-fragment",
      transformations: [
        transformation({
          name: "largest-organic-fragment",
          componentsRemoved: ["[Na+]"],
          atomMapping: [
            [1, 0],
            [2, 1],
            [3, 2]
          ]
        })
      ]
    });

    // A substructure match on derived atoms 0 and 2 sits on drawn atoms 1 and 3.
    expect(sourceAtomsFor(salt, [0, 2])).toEqual([1, 3]);
    // A derived atom with no source (an added hydrogen) is silently absent, not mapped to 0.
    expect(sourceAtomsFor(salt, [9])).toEqual([]);
  });

  it("treats an empty ledger as the identity, not as a total loss of mapping", () => {
    // The `source` interpretation carries no transformations, so derived index *is* source index.
    // Returning the empty set here would silently drop every per-atom result on the one
    // interpretation guaranteed to exist.
    expect(sourceAtomsFor(interpretation(), [0, 3, 11])).toEqual([0, 3, 11]);
    expect(sourceAtomsFor(interpretation(), [])).toEqual([]);
  });
});

describe("identity-changing transformations", () => {
  it("flags component removal, neutralisation, tautomer changes, and bond-order edits", () => {
    expect(changesChemicalIdentity(transformation({ componentsRemoved: ["[Na+]"] }))).toBe(true);
    expect(changesChemicalIdentity(transformation({ componentsNeutralized: ["[O-]"] }))).toBe(true);
    expect(changesChemicalIdentity(transformation({ tautomerChanged: true }))).toBe(true);
    expect(changesChemicalIdentity(transformation({ chargeChanges: -1 }))).toBe(true);
    expect(changesChemicalIdentity(transformation({ bondOrderChanges: 2 }))).toBe(true);
  });

  it("does not flag hydrogen addition or aromaticity perception alone", () => {
    // Adding explicit hydrogens or re-perceiving aromaticity does not change what the molecule *is*,
    // so it must not trigger the UI's "— change" disclosure. Over-warning is how a real warning
    // stops being read.
    expect(changesChemicalIdentity(transformation({ hydrogenChanges: 8 }))).toBe(false);
    expect(changesChemicalIdentity(transformation({ aromaticityChanges: 6 }))).toBe(false);
  });

  it("reports identity change across a whole interpretation", () => {
    expect(interpretationChangesIdentity(interpretation())).toBe(false);
    expect(
      interpretationChangesIdentity(
        interpretation({ transformations: [transformation({ hydrogenChanges: 4 })] })
      )
    ).toBe(false);
    expect(
      interpretationChangesIdentity(
        interpretation({ transformations: [transformation({ componentsRemoved: ["[Cl-]"] })] })
      )
    ).toBe(true);
  });
});

describe("tautomer policy", () => {
  it("throws when a tautomer-sensitive method meets an interpretation without a policy", () => {
    expect(() => assertTautomerPolicy(interpretation(), "nmr.h1")).toThrowError(/tautomerPolicy/);
  });

  it("accepts an explicit policy, including 'as-drawn'", () => {
    expect(() =>
      assertTautomerPolicy(interpretation({ tautomerPolicy: "as-drawn" }), "nmr.h1")
    ).not.toThrow();
  });
});

describe("hashing and cache keys", () => {
  it("is deterministic and distinguishes different inputs", () => {
    expect(analysisHash("CC(=O)Oc1ccccc1C(=O)O")).toBe(analysisHash("CC(=O)Oc1ccccc1C(=O)O"));
    expect(analysisHash("CCO")).not.toBe(analysisHash("CCN"));
    expect(analysisHash("")).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("distinguishes the same text in two formats", () => {
    expect(hashSource("smiles", "CCO")).not.toBe(hashSource("molfile-v2000", "CCO"));
  });

  it("ignores the display label but not the policy", () => {
    const base = {
      id: "neutralized",
      sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
      componentPolicy: "largest-organic-fragment" as const,
      explicitHydrogenPolicy: "implicit",
      isotopePolicy: "preserve-labels",
      aromaticityModel: "rdkit-default",
      transformations: []
    };

    // The label is display text; changing "counterion removed" to "salt stripped" must not evict the
    // whole session cache.
    expect(hashInterpretation(base)).toBe(hashInterpretation({ ...base }));
    expect(hashInterpretation(base)).not.toBe(
      hashInterpretation({ ...base, componentPolicy: "whole-input" })
    );
    expect(hashInterpretation(base)).not.toBe(
      hashInterpretation({ ...base, tautomerPolicy: "canonical" })
    );
  });

  it("keys the cache independently of parameter insertion order", () => {
    const shared = {
      sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
      interpretationHash: "fnv1a64:bbbbbbbbbbbbbbbb",
      methodId: "rdkit.tpsa",
      methodVersion: "1.0.0"
    };

    expect(analysisCacheKey({ ...shared, parameters: { includeSandP: true, version: 2 } })).toBe(
      analysisCacheKey({ ...shared, parameters: { version: 2, includeSandP: true } })
    );
    expect(analysisCacheKey({ ...shared, parameters: { includeSandP: true } })).not.toBe(
      analysisCacheKey({ ...shared, parameters: { includeSandP: false } })
    );
    expect(analysisCacheKey({ ...shared, engineHashes: ["a", "b"] })).toBe(
      analysisCacheKey({ ...shared, engineHashes: ["b", "a"] })
    );
    // A rebuilt WASM artifact must not serve cached numbers from the old one.
    expect(analysisCacheKey({ ...shared, engineHashes: ["a"] })).not.toBe(
      analysisCacheKey({ ...shared, engineHashes: ["a2"] })
    );
  });
});

describe("MolecularInterpretationSchema", () => {
  it("accepts a source interpretation and rejects unknown fields", () => {
    expect(MolecularInterpretationSchema.safeParse(interpretation()).success).toBe(true);
    expect(
      MolecularInterpretationSchema.safeParse({ ...interpretation(), tautomerPolicyy: "typo" }).success
    ).toBe(false);
  });

  it("rejects an unknown component policy", () => {
    expect(
      MolecularInterpretationSchema.safeParse({ ...interpretation(), componentPolicy: "biggest-bit" })
        .success
    ).toBe(false);
  });
});

describe("the source file stays searchable", () => {
  it("uses the \\x00 escape rather than embedding literal NUL bytes", () => {
    // Three hash functions here joined their fields with a raw U+0000 byte typed straight into the
    // source. Same string at runtime, but `file(1)` reported this module as `data`, ripgrep's walk
    // silently SKIPPED it, and read tools refused it — in the one file that holds the atom-mapping
    // algebra, which is the worst file in the repo to be invisible to search. It was the only such
    // file in the tree.
    //
    // The needle is built with `fromCharCode` so this test does not reintroduce the very byte it
    // guards against.
    const source = readFileSync(new URL("./interpretation.ts", import.meta.url), "utf8");
    expect(source.includes(String.fromCharCode(0)), "a literal NUL byte is back in interpretation.ts").toBe(
      false
    );
    // The separator itself still has to be there — the point was never to remove it.
    expect(source).toContain("\\x00");
  });
});
