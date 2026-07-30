import { describe, expect, it } from "vitest";

import { MethodContractSchema, MethodRegistry, methodKey, type MethodContract } from "./methodContract";
import type { MolecularInterpretation } from "./interpretation";

function contract(overrides: Partial<MethodContract> = {}): MethodContract {
  return {
    id: "rdkit.tpsa",
    publicName: "Topological polar surface area (TPSA)",
    version: "1.0.0",
    implementation: {
      engine: "rdkit-minimallib-wasm",
      engineVersion: "2026.03.3",
      symbol: "JSMol::get_descriptors.tpsa",
      parameters: { includeSandP: false }
    },
    defaultInterpretationId: "source",
    resultKind: "scalar",
    unit: "square-angstrom",
    conventions: ["Ertl 2000 fragment definitions", "sulfur and phosphorus excluded (includeSandP=false)"],
    classification: {
      derivation: "fragment-rule",
      claim: "descriptor",
      determinism: "deterministic",
      flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
    },
    supportedChemistry: ["organic C/H/N/O/S/P/halogen"],
    knownUnsupportedChemistry: ["boron", "silicon", "transition metals"],
    declinesWhen: ["the structure contains an element with no Ertl fragment definition"],
    accuracyClaims: [],
    citations: [],
    datasets: [],
    versionIncrementTriggers: ["any change to includeSandP", "an RDKit release that alters the Ertl tables"],
    tautomerSensitive: false,
    ...overrides
  };
}

function interpretation(overrides: Partial<MolecularInterpretation> = {}): MolecularInterpretation {
  return {
    id: "source",
    label: "as drawn",
    sourceHash: "fnv1a64:aaaaaaaaaaaaaaaa",
    interpretationHash: "fnv1a64:bbbbbbbbbbbbbbbb",
    componentPolicy: "whole-input",
    explicitHydrogenPolicy: "as-drawn",
    isotopePolicy: "preserve-labels",
    aromaticityModel: "rdkit-default",
    transformations: [],
    ...overrides
  };
}

describe("MethodContractSchema", () => {
  it("accepts a complete contract", () => {
    expect(MethodContractSchema.safeParse(contract()).success).toBe(true);
  });

  it("requires a unit for scalar and distribution results", () => {
    expect(MethodContractSchema.safeParse(contract({ unit: undefined })).success).toBe(false);
    expect(
      MethodContractSchema.safeParse(contract({ resultKind: "identifier", unit: undefined })).success
    ).toBe(true);
  });

  it("requires at least one declining condition", () => {
    // An empty list reads as "nobody thought about it" — and a predictor that returns a number for
    // everything is more dangerous than one that declines (PLANS.md §10).
    expect(MethodContractSchema.safeParse(contract({ declinesWhen: [] })).success).toBe(false);
  });

  it("accepts an explicit never-declines statement", () => {
    expect(
      MethodContractSchema.safeParse(
        contract({
          id: "rdkit.composition",
          resultKind: "composition",
          unit: undefined,
          declinesWhen: ["never — composition is defined for any structure that parses"]
        })
      ).success
    ).toBe(true);
  });

  it("requires a convention-dependent method to name its conventions", () => {
    expect(MethodContractSchema.safeParse(contract({ conventions: [] })).success).toBe(false);
  });

  it("requires a calibrated method to cite its parameters or data", () => {
    const crippen = contract({
      id: "rdkit.crippen-logp",
      publicName: "Crippen logP",
      unit: "log10-unit",
      conventions: ["Wildman–Crippen atom contributions"],
      classification: {
        derivation: "fragment-rule",
        claim: "prediction",
        determinism: "deterministic",
        flags: {
          conventionDependent: true,
          experimentallyCalibrated: true,
          trainedOnExperimentalData: false
        }
      }
    });

    expect(MethodContractSchema.safeParse(crippen).success).toBe(false);
    expect(
      MethodContractSchema.safeParse({
        ...crippen,
        citations: [
          {
            id: "wildman-crippen-1999",
            kind: "journal",
            title: "Prediction of Physicochemical Parameters by Atomic Contributions",
            year: 1999
          }
        ]
      }).success
    ).toBe(true);
  });

  it("requires version-increment triggers", () => {
    expect(MethodContractSchema.safeParse(contract({ versionIncrementTriggers: [] })).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      MethodContractSchema.safeParse({ ...contract(), accuracy: "pretty good" }).success
    ).toBe(false);
  });
});

describe("methodKey", () => {
  it("is stable across parameter insertion order and changes with the engine version", () => {
    const a = contract({
      implementation: {
        engine: "rdkit-minimallib-wasm",
        engineVersion: "2026.03.3",
        symbol: "JSMol::get_descriptors.tpsa",
        parameters: { includeSandP: false, ertlVersion: 2000 }
      }
    });
    const b = contract({
      implementation: {
        engine: "rdkit-minimallib-wasm",
        engineVersion: "2026.03.3",
        symbol: "JSMol::get_descriptors.tpsa",
        parameters: { ertlVersion: 2000, includeSandP: false }
      }
    });
    expect(methodKey(a)).toBe(methodKey(b));

    const bumped = contract({
      implementation: { ...a.implementation, engineVersion: "2026.09.1" }
    });
    expect(methodKey(a)).not.toBe(methodKey(bumped));
  });

  it("changes when a parameter changes — patch #6 must not reuse patch #5's cache", () => {
    const before = contract();
    const after = contract({
      version: "2.0.0",
      implementation: { ...before.implementation, parameters: { includeSandP: true } }
    });
    expect(methodKey(before)).not.toBe(methodKey(after));
  });
});

describe("MethodRegistry", () => {
  it("validates on registration", () => {
    const registry = new MethodRegistry();
    expect(() => registry.register(contract({ declinesWhen: [] }))).toThrow();
    expect(registry.get("rdkit.tpsa")).toBeUndefined();
  });

  it("refuses to shadow a registered method with a different version", () => {
    const registry = new MethodRegistry();
    registry.register(contract());
    expect(() => registry.register(contract({ version: "2.0.0" }))).toThrowError(/refusing to shadow/);
  });

  it("is idempotent for the same version", () => {
    const registry = new MethodRegistry();
    registry.register(contract());
    expect(() => registry.register(contract())).not.toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it("requires a registered contract by id", () => {
    const registry = new MethodRegistry();
    expect(() => registry.require("nope")).toThrowError(/No method contract registered/);
  });

  it("blocks a tautomer-sensitive method against an interpretation with no policy", () => {
    const registry = new MethodRegistry();
    registry.register(
      contract({
        id: "nmr.c13",
        publicName: "¹³C shift prediction",
        resultKind: "spectrum",
        unit: undefined,
        tautomerSensitive: true,
        classification: {
          derivation: "database-lookup",
          claim: "prediction",
          determinism: "deterministic",
          flags: {
            conventionDependent: false,
            experimentallyCalibrated: false,
            trainedOnExperimentalData: true
          }
        },
        citations: [{ id: "nmrshiftdb2", kind: "dataset", title: "nmrshiftdb2 experimental assignments" }]
      })
    );

    expect(() => registry.assertRunnable("nmr.c13", interpretation())).toThrowError(/tautomerPolicy/);
    expect(() =>
      registry.assertRunnable("nmr.c13", interpretation({ tautomerPolicy: "as-drawn" }))
    ).not.toThrow();
  });

  it("lets a tautomer-insensitive method run without a policy", () => {
    const registry = new MethodRegistry();
    registry.register(contract());
    expect(() => registry.assertRunnable("rdkit.tpsa", interpretation())).not.toThrow();
  });

  it("lists contracts in id order", () => {
    const registry = new MethodRegistry();
    registry.register(contract({ id: "rdkit.tpsa" }));
    registry.register(
      contract({ id: "rdkit.composition", resultKind: "composition", unit: undefined, conventions: ["Hill notation"] })
    );
    expect(registry.list().map((entry) => entry.id)).toEqual(["rdkit.composition", "rdkit.tpsa"]);
  });
});
