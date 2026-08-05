/**
 * Engine regression against the vendored RDKit 2026.03.3 artifact (PLANS.md §10, verification layer 1).
 *
 * "Pinned outputs from the exact RDKit/OCL/IsoSpec/MOPAC version, so a dependency bump is a visible
 * failure, not a silent number change. → Phase 2, because the pins are what make release 1's numbers
 * reviewable."
 *
 * So the numeric expectations below are **exact**, not approximate. A rebuilt WASM that shifts a
 * descriptor by one ulp should fail this file and be reviewed, not rounded away.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkInvariance,
  corpusEntry,
  propertyCorpus,
  type AnalysisResult,
  type AnalysisRun,
  type RepresentationVariant
} from "@chemdraft/analysis-core";

import {
  analyzeStructure,
  analyzeStructureDetailed,
  detectEngineCapabilities,
  rdkitAnalysisContracts,
  sourceInterpretation
} from "./analysis";
import {
  DESCRIPTOR_DETAILS_INCLUDE_SANDP,
  INCLUDE_SANDP_PROBE_SMILES,
  PINNED_RDKIT_VERSION,
  PINNED_RDKIT_WASM_SHA256
} from "./methods";
import { ensureRdkit, resetRdkitForTesting } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

let runCounter = 0;
const analyze = (value: string, format: "smiles" | "molfile-v2000" = "smiles"): Promise<AnalysisRun> => {
  runCounter += 1;
  return analyzeStructure({
    format,
    value,
    runId: `test-${runCounter}`,
    startedAt: "2026-07-30T12:00:00.000Z"
  });
};

function result(run: AnalysisRun, methodId: string): AnalysisResult {
  const found = run.results.find((candidate) => candidate.id === methodId);
  if (!found) throw new Error(`Run carried no result for "${methodId}".`);
  return found;
}

function scalar(run: AnalysisRun, methodId: string): number | null {
  const found = result(run, methodId);
  if (found.kind !== "scalar") throw new Error(`"${methodId}" is a ${found.kind}, not a scalar.`);
  return found.value;
}

function identifier(run: AnalysisRun, methodId: string): string | null {
  const found = result(run, methodId);
  if (found.kind !== "identifier") throw new Error(`"${methodId}" is a ${found.kind}, not an identifier.`);
  return found.value;
}

function composition(run: AnalysisRun): Extract<AnalysisResult, { kind: "composition" }> {
  const found = result(run, "rdkit.composition");
  if (found.kind !== "composition") throw new Error("rdkit.composition returned the wrong result kind.");
  return found;
}

describe("engine regression — aspirin, pinned to RDKit 2026.03.3", () => {
  it("returns the exact descriptor values the vendored build produces", async () => {
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");

    expect(run.status).toBe("ok");
    expect(run.engines[0]).toMatchObject({ name: "rdkit-minimallib-wasm", version: PINNED_RDKIT_VERSION });

    expect(scalar(run, "rdkit.monoisotopic-mass")).toBe(180.042258736);
    expect(scalar(run, "rdkit.average-mass")).toBe(180.15899999999996);
    expect(scalar(run, "rdkit.tpsa")).toBe(63.60000000000001);
    expect(scalar(run, "rdkit.crippen-logp")).toBe(1.3101);
    expect(scalar(run, "rdkit.crippen-mr")).toBe(44.71030000000002);
    expect(scalar(run, "rdkit.rotatable-bonds")).toBe(2);
    expect(scalar(run, "rdkit.lipinski-hba")).toBe(4);
    expect(scalar(run, "rdkit.lipinski-hbd")).toBe(1);
    expect(scalar(run, "rdkit.heavy-atom-count")).toBe(13);
    expect(scalar(run, "rdkit.aromatic-ring-count")).toBe(1);
  });

  it("returns the standard InChI and key", async () => {
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    expect(identifier(run, "rdkit.inchi")).toBe(
      "InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)"
    );
    expect(identifier(run, "rdkit.inchikey")).toBe("BSYNRYMUTXBXSQ-UHFFFAOYSA-N");
  });

  it("carries the vendored artifact hash so a rebuild changes the fingerprint", async () => {
    // Against the constant, not a literal: methods.test.ts is what ties the constant to the actual
    // bytes of vendor/RDKit_minimal.wasm. A literal here would only duplicate that check while
    // needing a hand-edit on every rebuild — and a hand-edit is exactly how provenance goes stale.
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    expect(run.engines[0]?.artifactHashes[0]).toBe(`sha256:${PINNED_RDKIT_WASM_SHA256}`);
  });

  it("reports every applicable descriptor as a finite number with a unit", async () => {
    // Aspirin has no nitrogen, so "[M+H−NH₃]⁺" correctly does not apply. The invariant is not "every
    // scalar succeeds" — it is that nothing is half-formed: an answer has a finite value and a unit,
    // and a non-answer has a reason and no value.
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    const scalars = run.results.filter((entry): entry is Extract<AnalysisResult, { kind: "scalar" }> => entry.kind === "scalar");
    expect(scalars.length).toBeGreaterThan(30);

    for (const entry of scalars) {
      expect(entry.unit, `${entry.id} unit`).toBeTruthy();
      if (entry.status === "ok") {
        expect(Number.isFinite(entry.value), `${entry.id} value`).toBe(true);
      } else {
        expect(entry.status, `${entry.id} status`).toBe("not-applicable");
        expect(entry.value, `${entry.id} value`).toBeNull();
        expect(entry.applicability.reasons.length, `${entry.id} reason`).toBeGreaterThan(0);
      }
    }

    // And the run as a whole still reads as the success it was.
    expect(run.status).toBe("ok");
  });
});

describe("composition is source-preserving", () => {
  it("keeps sodium benzoate a salt", async () => {
    const run = await analyze(corpusEntry("sodium-benzoate").smiles);
    const result = composition(run);

    expect(result.formula).toBe("C7H5NaO2");
    expect(result.formalCharge).toBe(0);
    expect(result.components.map((component) => component.formula).sort()).toEqual(["C7H5O2", "Na"]);
    expect(result.components.find((component) => component.formula === "Na")?.charge).toBe(1);
    expect(result.components.find((component) => component.formula === "C7H5O2")?.charge).toBe(-1);
  });

  it("records an explicit ¹³C label in the formula and the monoisotopic mass, and in the average mass too", async () => {
    const labelled = await analyze("[13CH3]C(=O)O");
    const unlabelled = await analyze("CC(=O)O");

    expect(composition(labelled).formula).toBe("[13C]CH4O2");
    expect(composition(labelled).hasExplicitIsotopes).toBe(true);
    expect(composition(unlabelled).formula).toBe("C2H4O2");
    expect(composition(unlabelled).hasExplicitIsotopes).toBe(false);

    expect(scalar(labelled, "rdkit.monoisotopic-mass")).toBe(61.024484208000004);
    expect(scalar(unlabelled, "rdkit.monoisotopic-mass")).toBe(60.021129368000004);
    // The average mass moves too: a labelled position uses that isotope's mass rather than the
    // element's abundance-weighted average. This is the case that keeps `dalton` and `gram-per-mole`
    // from being treated as aliases.
    expect(scalar(labelled, "rdkit.average-mass")).toBe(61.044354840000004);
    expect(scalar(unlabelled, "rdkit.average-mass")).toBe(60.05200000000001);
  });

  it("collapses cisplatin's two ammines into a multiplicity", async () => {
    const run = await analyze(corpusEntry("cisplatin").smiles);
    const result = composition(run);

    expect(result.formula).toBe("Cl2H6N2Pt");
    expect(result.components).toHaveLength(2);
    expect(result.components.find((component) => component.formula === "H3N")?.multiplicity).toBe(2);
    expect(result.components.reduce((total, component) => total + component.multiplicity, 0)).toBe(
      corpusEntry("cisplatin").expectedComponentCount
    );
  });

  it("counts TEMPO's unpaired electron", async () => {
    const run = await analyze(corpusEntry("tempo-radical").smiles);
    expect(composition(run).formula).toBe("C9H18NO");
    expect(composition(run).radicalElectronCount).toBe(1);
  });

  it("parses every corpus entry — a corpus SMILES that does not parse tests nothing", async () => {
    // This check earned its place immediately: the imidazolium entry was first written
    // `C[n+]1ccnc1`, which RDKit rejects because the neutral ring nitrogen has no hydrogen to
    // kekulise around. Every downstream assertion on it was passing vacuously.
    for (const entry of propertyCorpus) {
      const run = await analyze(entry.smiles);
      expect(run.status, `${entry.id} (${entry.smiles}) failed to parse`).not.toBe("failed");
    }
  });

  it("agrees with every corpus entry that pins a formula, charge, or component count", async () => {
    for (const entry of propertyCorpus) {
      const run = await analyze(entry.smiles);
      const result = composition(run);
      if (entry.expectedSourceFormula) {
        expect(result.formula, `${entry.id} formula`).toBe(entry.expectedSourceFormula);
      }
      if (entry.expectedSourceCharge !== undefined) {
        expect(result.formalCharge, `${entry.id} charge`).toBe(entry.expectedSourceCharge);
      }
      expect(
        result.components.reduce((total, component) => total + component.multiplicity, 0),
        `${entry.id} component count`
      ).toBe(entry.expectedComponentCount);
    }
  });
});

describe("declining beats a confident wrong number", () => {
  it("refuses Crippen logP for sodium benzoate, which RDKit would answer with a fallback contribution", async () => {
    // The whole argument for the decline rule in one assertion. RDKit reports −2.9459 for the salt and
    // +0.0501 for the anion; the entire three-log-unit gap is sodium taking a default atom type.
    const salt = await analyze("[Na+].[O-]C(=O)c1ccccc1");
    const logP = result(salt, "rdkit.crippen-logp");

    expect(logP.status).toBe("unsupported");
    expect(logP.kind === "scalar" && logP.value).toBe(null);
    expect(logP.applicability.status).toBe("out-of-domain");
    expect(logP.applicability.unsupportedFeatures).toEqual(["Na"]);
    expect(logP.warnings[0]?.code).toBe("method.unparameterized_element");
    expect(logP.warnings[0]?.affectedResultIds).toEqual(["rdkit.crippen-logp"]);

    // The anion, which every Crippen parameter covers, still answers.
    const anion = await analyze("[O-]C(=O)c1ccccc1");
    expect(scalar(anion, "rdkit.crippen-logp")).toBe(0.05009999999999992);
  });

  it("declines every method each corpus entry says it must", async () => {
    for (const entry of propertyCorpus) {
      if (!entry.mustDecline) continue;
      const run = await analyze(entry.smiles);
      for (const methodId of entry.mustDecline) {
        const declined = result(run, methodId);
        expect(["unsupported", "not-applicable"], `${entry.id} / ${methodId}`).toContain(declined.status);
        expect(declined.warnings.length, `${entry.id} / ${methodId} warning`).toBeGreaterThan(0);
      }
    }
  });

  it("still answers the topological descriptors it declines the parameterised ones for", async () => {
    // Declining is per method, not per structure: a graph count has no element parameterisation to
    // fall outside of, so ferrocene still reports its rings and heavy atoms.
    const run = await analyze(corpusEntry("ferrocene").smiles);
    expect(result(run, "rdkit.crippen-logp").status).toBe("unsupported");
    expect(scalar(run, "rdkit.heavy-atom-count")).toBe(11);
    expect(scalar(run, "rdkit.ring-count")).toBe(2);
    expect(result(run, "rdkit.composition").status).toBe("ok");
    expect(run.status).toBe("unsupported");
  });

  it("keeps identifiers working for the organometallics the descriptors refuse", async () => {
    const run = await analyze(corpusEntry("ferrocene").smiles);
    expect(identifier(run, "rdkit.inchikey")).toBe("KTWOOEGAPBSYNW-UHFFFAOYSA-N");
  });
});

describe("unsupported and malformed input", () => {
  it("fails a structure RDKit cannot parse, with no results and an error warning", async () => {
    const run = await analyze("C1CC");
    expect(run.status).toBe("failed");
    expect(run.results).toHaveLength(0);
    expect(run.warnings.map((entry) => entry.code)).toContain("structure.parse_failed");
  });

  it("fails empty input rather than reporting an empty molecule", async () => {
    const run = await analyze("   ");
    expect(run.status).toBe("failed");
    expect(run.warnings.map((entry) => entry.code)).toContain("structure.empty");
  });

  it("refuses a structure over the heavy-atom limit before any descriptor runs", async () => {
    // The molecule-size limit §5 asks for, enforced here because the atom count is only knowable after
    // parsing. `unsupported` rather than `failed`: nothing went wrong, the structure is outside what
    // this call agreed to compute.
    const run = await analyzeStructure({
      format: "smiles",
      value: "C".repeat(40),
      runId: "limit-1",
      startedAt: "2026-07-30T12:00:00.000Z",
      maxHeavyAtoms: 20
    });

    expect(run.status).toBe("unsupported");
    expect(run.results).toHaveLength(0);
    expect(run.warnings[0]?.code).toBe("structure.too_many_atoms");
    expect(run.warnings[0]?.message).toMatch(/40 heavy atoms, over the 20 limit/);
  });

  it("lets a structure at the limit through", async () => {
    const run = await analyzeStructure({
      format: "smiles",
      value: "C".repeat(20),
      runId: "limit-2",
      startedAt: "2026-07-30T12:00:00.000Z",
      maxHeavyAtoms: 20,
      methodIds: ["rdkit.composition"]
    });
    expect(run.status).toBe("ok");
  });
});

describe("run identity", () => {
  it("fingerprints identically for the same structure and differently for a different one", async () => {
    const first = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    const second = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    const other = await analyze("CCO");

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(other.fingerprint);
    // The fingerprint covers inputs only — two runs an hour apart are the same run.
    expect(first.runId).not.toBe(second.runId);
  });

  it("carries exactly the source interpretation, and every result points at it", async () => {
    const run = await analyze("CC(=O)Oc1ccccc1C(=O)O");
    expect(run.interpretations).toHaveLength(1);
    expect(run.interpretations[0]).toMatchObject({ id: "source", componentPolicy: "whole-input" });
    expect(run.interpretations[0]?.transformations).toEqual([]);
    for (const entry of run.results) expect(entry.interpretationId).toBe("source");
  });

  it("hashes the same text in two formats differently", () => {
    const asSmiles = sourceInterpretation("smiles", "CCO");
    const asMolfile = sourceInterpretation("molfile-v2000", "CCO");
    expect(asSmiles.sourceHash).not.toBe(asMolfile.sourceHash);
  });
});

describe("representation invariance", () => {
  const REFERENCE: RepresentationVariant = {
    id: "aspirin-canonical",
    kind: "canonical",
    value: "CC(=O)Oc1ccccc1C(=O)O",
    format: "smiles"
  };

  const VARIANTS: RepresentationVariant[] = [
    { id: "rooted-elsewhere", kind: "smiles-permutation", value: "O=C(O)c1ccccc1OC(C)=O", format: "smiles" },
    { id: "rooted-at-ring", kind: "smiles-permutation", value: "c1ccc(C(=O)O)c(OC(C)=O)c1", format: "smiles" },
    { id: "kekule", kind: "kekule", value: "CC(=O)OC1=CC=CC=C1C(=O)O", format: "smiles" },
    { id: "explicit-h", kind: "explicit-hydrogens", value: "[CH3][C](=O)O[c]1[cH][cH][cH][cH][c]1[C](=O)[OH]", format: "smiles" }
  ];

  /**
   * Integer counts must agree exactly; real-valued descriptors are sums over per-atom contributions,
   * so the last floating-point bit follows atom ordering. Aspirin's TPSA is 63.60000000000001 written
   * one way and 63.6 written another — a 7.1e-15 difference this harness found on its first run.
   * 1e-9 is far tighter than any chemically meaningful change and far looser than summation noise.
   */
  const EXACT_METHODS = ["rdkit.rotatable-bonds", "rdkit.heavy-atom-count", "rdkit.aromatic-ring-count"];
  const APPROXIMATE_METHODS = [
    "rdkit.tpsa",
    "rdkit.crippen-logp",
    "rdkit.crippen-mr",
    "rdkit.monoisotopic-mass",
    "rdkit.average-mass",
    "rdkit.kappa2",
    "rdkit.chi1v",
    "rdkit.labute-asa"
  ];

  it("gives the same descriptors however aspirin is written down", async () => {
    // The property that fixture tests cannot check, because a fixture only ever exercises one
    // spelling. If any of these disagree beyond summation noise, something in the pipeline is reading
    // input order rather than structure.
    const runs = new Map<string, AnalysisRun>();
    for (const variant of [REFERENCE, ...VARIANTS]) {
      runs.set(variant.id, await analyze(variant.value));
    }

    for (const methodId of EXACT_METHODS) {
      const report = checkInvariance(REFERENCE, VARIANTS, (variant) => scalar(runs.get(variant.id)!, methodId));
      expect(report.invariant, `${methodId}: ${JSON.stringify(report.deviations)}`).toBe(true);
    }

    for (const methodId of APPROXIMATE_METHODS) {
      const report = checkInvariance(
        REFERENCE,
        VARIANTS,
        (variant) => scalar(runs.get(variant.id)!, methodId) ?? Number.NaN,
        { tolerance: 1e-9 }
      );
      expect(report.invariant, `${methodId}: ${JSON.stringify(report.deviations)}`).toBe(true);
    }
  });

  it("records summation-order sensitivity in the contract rather than hiding it in a tolerance", async () => {
    const { rdkitMethodContracts } = await import("./methods");
    const tpsa = rdkitMethodContracts().find((contract) => contract.id === "rdkit.tpsa");
    expect(tpsa?.conventions.some((convention) => convention.includes("last floating-point bit"))).toBe(true);
  });

  it("gives the same formula and InChIKey however aspirin is written down", async () => {
    const runs = new Map<string, AnalysisRun>();
    for (const variant of [REFERENCE, ...VARIANTS]) {
      runs.set(variant.id, await analyze(variant.value));
    }

    const formula = checkInvariance(REFERENCE, VARIANTS, (variant) => composition(runs.get(variant.id)!).formula);
    expect(formula.invariant, JSON.stringify(formula.deviations)).toBe(true);

    const key = checkInvariance(REFERENCE, VARIANTS, (variant) => identifier(runs.get(variant.id)!, "rdkit.inchikey"));
    expect(key.invariant, JSON.stringify(key.deviations)).toBe(true);
    expect(key.reference).toBe("BSYNRYMUTXBXSQ-UHFFFAOYSA-N");
  });
});

describe("stereochemistry", () => {
  it("reports RDKit's CIP descriptors rather than a coarse category", async () => {
    const detailed = await analyzeStructureDetailed({
      format: "smiles",
      value: "C[C@H](O)C(=O)O",
      runId: "stereo-1",
      startedAt: "2026-07-30T12:00:00.000Z"
    });
    expect(detailed.stereochemistry).toEqual(["atom 1 (S)"]);
  });

  it("names unspecified centres instead of leaving them silent", async () => {
    const detailed = await analyzeStructureDetailed({
      format: "smiles",
      value: "CC(O)C(=O)O",
      runId: "stereo-2",
      startedAt: "2026-07-30T12:00:00.000Z"
    });
    expect(detailed.stereochemistry).toEqual(["1 unspecified stereocentre"]);
  });
});

describe("method selection", () => {
  it("runs only the requested methods", async () => {
    const run = await analyzeStructure({
      format: "smiles",
      value: "CC(=O)Oc1ccccc1C(=O)O",
      runId: "subset-1",
      startedAt: "2026-07-30T12:00:00.000Z",
      methodIds: ["rdkit.composition", "rdkit.tpsa"]
    });
    expect(run.results.map((entry) => entry.id).sort()).toEqual(["rdkit.composition", "rdkit.tpsa"]);
  });
});

describe("engine capability detection (vendor patch #6)", () => {
  it("reports the committed artifact as patched, because it is", async () => {
    const module = (await ensureRdkit()) as never as Parameters<typeof detectEngineCapabilities>[0];
    // Both patches, asserted exactly. `canonicalTautomer` flips to true with the artifact that carries
    // vendor patch #7 — and until it does, this line is what says the binding is genuinely absent
    // rather than present-but-silent.
    expect(detectEngineCapabilities(module)).toEqual({
      descriptorIncludeSandP: true,
      canonicalTautomer: true
    });
  });

  it("detects by value, not by whether the call succeeded", async () => {
    // The measurement that forced this, kept because it still governs the design: on the
    // PRE-REBUILD artifact, get_descriptors('{"includeSandP":true}') did NOT throw — it returned the
    // same 34.14 for CS(=O)(=O)C. Arity detection would have reported the patch as present and the
    // run would have labelled an S-excluded number with the S-included convention. The assertion
    // below is the positive half of that: the flag has to move the number, not merely be accepted.
    const module = (await ensureRdkit()) as never as {
      get_mol(smiles: string): { get_descriptors(details?: string): string; delete(): void } | null;
    };
    const probe = module.get_mol(INCLUDE_SANDP_PROBE_SMILES)!;
    const withoutFlag = JSON.parse(probe.get_descriptors()) as Record<string, number>;
    const withFlag = JSON.parse(probe.get_descriptors(DESCRIPTOR_DETAILS_INCLUDE_SANDP)) as Record<string, number>;
    probe.delete();

    expect(withoutFlag.tpsa).toBe(34.14);
    expect(withFlag.tpsa).toBe(42.52);
  });

  it("moves TPSA and nothing else — the patch recomputes one descriptor, not the set", async () => {
    // Patch #6 reaches into a calculator that produces ~40 numbers at once. If it had perturbed any
    // of the others, every one of those contracts would be describing the wrong convention.
    const module = (await ensureRdkit()) as never as {
      get_mol(smiles: string): { get_descriptors(details?: string): string; delete(): void } | null;
    };
    const probe = module.get_mol(INCLUDE_SANDP_PROBE_SMILES)!;
    const withoutFlag = JSON.parse(probe.get_descriptors()) as Record<string, number>;
    const withFlag = JSON.parse(probe.get_descriptors(DESCRIPTOR_DETAILS_INCLUDE_SANDP)) as Record<string, number>;
    probe.delete();

    const moved = Object.keys(withoutFlag).filter((key) => withoutFlag[key] !== withFlag[key]);
    expect(moved).toEqual(["tpsa"]);
  });

  it("puts TPSA on the S-included convention, and says so in the run", async () => {
    const run = await analyze("Cc1onc(c1)NS(=O)(=O)c1ccc(N)cc1", { methodIds: ["rdkit.tpsa"] } as never);
    // Sulfamethoxazole, the §7 case: 98.22 with S excluded, 106.60 with it included — and 106.60 is
    // the number OpenChemLib independently reports (see propertyCorpus). The version bump is not
    // decoration: methodKey carries it, so cached S-excluded numbers cannot be served under the new
    // convention.
    expect(scalar(run, "rdkit.tpsa")).toBe(106.60000000000001);
    expect(result(run, "rdkit.tpsa").methodVersion).toBe("2.0.0");

    // A result carries the method version, not the convention prose — so read the convention off the
    // contract built from the capabilities actually detected on the loaded module. That is what ties
    // the disclosed convention to the binary in hand rather than to the patch set on paper.
    const module = (await ensureRdkit()) as never as Parameters<typeof detectEngineCapabilities>[0];
    const tpsa = rdkitAnalysisContracts(PINNED_RDKIT_VERSION, detectEngineCapabilities(module)).find(
      (contract) => contract.id === "rdkit.tpsa"
    );
    expect(tpsa?.version).toBe("2.0.0");
    expect(tpsa?.conventions.some((convention) => convention.includes("INCLUDED"))).toBe(true);
  });
});
