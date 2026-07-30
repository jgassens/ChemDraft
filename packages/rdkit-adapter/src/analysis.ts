/**
 * The real RDKit-backed structure analysis (PLANS.md §9, Release 1).
 *
 * Replaces the fixture-backed placeholder: ten hardcoded SMILES with hand-entered masses, which §7
 * calls what it is — "a second implementation by another name".
 *
 * The shape of a run, in order:
 *
 *   1. Hash the source exactly as it arrived, format included.
 *   2. Parse and sanitise **once** through RDKit.
 *   3. Emit the `source` interpretation — no transformations, so derived atom indices *are* the atoms
 *      the user drew. Every other interpretation is Phase 3's business.
 *   4. Derive composition from `get_json()`, masses and descriptors from `get_descriptors()`,
 *      identifiers from the InChI library and the canonical SMILES writer.
 *   5. Decline, per method, for elements the method has no parameters for.
 *
 * Step 5 is the one that matters. RDKit answers every descriptor for every structure it can parse, and
 * several of those answers are produced by an unparameterised element falling through to a default:
 * sodium benzoate's Crippen logP is −2.95 against the benzoate anion's +0.05. Nothing in the engine
 * flags that. The contracts do.
 */
import {
  aggregateStatus,
  AnalysisSchemaVersion,
  analysisCacheKey,
  elementsOutsideParameterization,
  hashInterpretation,
  hashSource,
  MethodRegistry,
  methodKey,
  runFingerprint,
  SOURCE_INTERPRETATION_ID,
  type AnalysisResult,
  type AnalysisRun,
  type AnalysisStatus,
  type AnalysisWarning,
  type MethodContract,
  type MolecularInterpretation
} from "@chemdraft/analysis-core";

import { compositionFromRdkitJson, type DerivedComposition, type RdkitJson } from "./composition";
import { ensureRdkit, type RdkitJsMol, type RdkitMinimalModule } from "./conformer";
import {
  descriptorBindings,
  PINNED_RDKIT_VERSION,
  PINNED_RDKIT_WASM_SHA256,
  rdkitMethodContracts
} from "./methods";

export type AnalysisInputFormat = "smiles" | "molfile-v2000" | "molfile-v3000";

export interface AnalyzeStructureRequest {
  format: AnalysisInputFormat;
  value: string;
  /** Caller-supplied so runs are reproducible in tests and traceable in the app. */
  runId: string;
  /** ISO-8601. Supplied rather than read from the clock, so a run's identity never depends on time. */
  startedAt: string;
  finishedAt?: string;
  /** Restrict the run to these method ids. Omit for every registered method. */
  methodIds?: readonly string[];
}

/** The analysis surface `analyzeStructure` needs beyond what the conformer path already uses. */
interface AnalysisMol extends RdkitJsMol {
  get_descriptors(): string;
  get_json(): string;
  get_inchi(): string;
  get_num_atoms(): number;
  get_num_bonds(): number;
  is_valid(): boolean;
  get_stereo_tags(): string;
}

interface AnalysisModule extends RdkitMinimalModule {
  get_inchikey_for_inchi(inchi: string): string;
}

const REQUIRED_MOL_METHODS = [
  "get_descriptors",
  "get_json",
  "get_inchi",
  "get_num_atoms",
  "get_num_bonds",
  "get_smiles",
  "get_stereo_tags"
] as const;

/**
 * Fail loudly and once if the loaded module predates the analysis bindings, rather than letting every
 * method trip its own `undefined is not a function` deeper in.
 */
function assertAnalysisSurface(module: RdkitMinimalModule, mol: RdkitJsMol): asserts mol is AnalysisMol {
  const missing = REQUIRED_MOL_METHODS.filter(
    (name) => typeof (mol as unknown as Record<string, unknown>)[name] !== "function"
  );
  if (typeof (module as unknown as Record<string, unknown>).get_inchikey_for_inchi !== "function") {
    missing.push("get_inchikey_for_inchi" as (typeof REQUIRED_MOL_METHODS)[number]);
  }
  if (missing.length > 0) {
    throw new Error(
      `The loaded RDKit MinimalLib build is missing the analysis bindings: ${missing.join(", ")}. ` +
        `Expected the vendored ${PINNED_RDKIT_VERSION} artifact (see packages/rdkit-adapter/vendor/BUILD.md).`
    );
  }
}

/** The source interpretation: what the user drew, sanitised but not derived. */
export function sourceInterpretation(format: string, value: string): MolecularInterpretation {
  const sourceHash = hashSource(format, value);
  const policy = {
    id: SOURCE_INTERPRETATION_ID,
    sourceHash,
    componentPolicy: "whole-input" as const,
    explicitHydrogenPolicy: "as-drawn — implicit hydrogens stay implicit, explicit ones stay explicit",
    isotopePolicy: "preserve-labels",
    aromaticityModel: "rdkit-default",
    transformations: []
  };
  return {
    ...policy,
    label: "as drawn",
    interpretationHash: hashInterpretation(policy)
  };
}

function warning(
  code: string,
  message: string,
  severity: AnalysisWarning["severity"],
  affectedResultIds: string[] = []
): AnalysisWarning {
  return { code, severity, message, affectedResultIds };
}

interface ResultContext {
  contract: MethodContract;
  interpretation: MolecularInterpretation;
  composition: DerivedComposition;
}

/** Shared fields every result carries, so a variant only spells out what makes it that variant. */
function resultBase(context: ResultContext) {
  return {
    id: context.contract.id,
    label: context.contract.publicName,
    methodId: context.contract.id,
    methodVersion: context.contract.version,
    interpretationId: context.interpretation.id,
    classification: context.contract.classification,
    uncertainties: [],
    citations: context.contract.citations,
    datasets: context.contract.datasets,
    rawArtifacts: []
  };
}

/**
 * The decline. `unsupported` rather than `not-applicable`: the method *would* apply to this claim, it
 * just has no parameters for these elements — and saying which elements is the whole value of it.
 */
function declineForElements(context: ResultContext, outside: string[]): AnalysisResult {
  const message =
    `${context.contract.publicName} has no parameters for ${outside.join(", ")}; ` +
    "returning a number would mean reporting a fallback contribution as a result.";
  const base = resultBase(context);
  const shared = {
    ...base,
    status: "unsupported" as const,
    applicability: {
      status: "out-of-domain" as const,
      reasons: [message],
      unsupportedFeatures: outside
    },
    warnings: [warning("method.unparameterized_element", message, "warning", [base.id])]
  };

  return context.contract.resultKind === "identifier"
    ? { ...shared, kind: "identifier", identifierType: "smiles", value: null }
    : { ...shared, kind: "scalar", value: null, unit: context.contract.unit ?? "dimensionless" };
}

function failedIdentifier(context: ResultContext, identifierType: "inchi" | "inchikey" | "canonical-smiles", reason: string): AnalysisResult {
  const base = resultBase(context);
  return {
    ...base,
    kind: "identifier",
    identifierType,
    status: "failed",
    value: null,
    applicability: { status: "undetermined", reasons: [reason], unsupportedFeatures: [] },
    warnings: [warning(`identifier.${identifierType}_unavailable`, reason, "warning", [base.id])]
  };
}

export interface RdkitAnalysisEngine {
  version: string;
  contracts: MethodContract[];
  registry: MethodRegistry;
}

/** Build the registry against the live engine so a rebuilt artifact flows into every cache key. */
export async function rdkitAnalysisEngine(): Promise<RdkitAnalysisEngine> {
  const module = await ensureRdkit();
  const version = typeof module.version === "function" ? module.version() : PINNED_RDKIT_VERSION;
  const contracts = rdkitMethodContracts(version);
  const registry = new MethodRegistry();
  for (const contract of contracts) registry.register(contract);
  return { version, contracts, registry };
}

/** CIP descriptors as RDKit perceived them, plus a note for centres the drawing left unassigned. */
export function stereochemistryLabels(stereoTagsJson: string, unspecifiedCentres: number): string[] {
  let tags: { CIP_atoms?: [number, string][]; CIP_bonds?: [number[], string][] } = {};
  try {
    tags = JSON.parse(stereoTagsJson) as typeof tags;
  } catch {
    return [];
  }
  // RDKit tags an unassigned centre "(?)". The unspecified count below already says how many there
  // are, so emitting both would report the same gap twice in two different vocabularies.
  const assigned = (descriptor: string): boolean => descriptor !== "(?)";
  const labels = [
    ...(tags.CIP_atoms ?? [])
      .filter(([, descriptor]) => assigned(descriptor))
      .map(([atom, descriptor]) => `atom ${atom} ${descriptor}`),
    ...(tags.CIP_bonds ?? [])
      .filter(([, descriptor]) => assigned(descriptor))
      .map(([atoms, descriptor]) => `bond ${atoms.join("-")} ${descriptor}`)
  ];
  if (unspecifiedCentres > 0) {
    labels.push(`${unspecifiedCentres} unspecified stereocentre${unspecifiedCentres === 1 ? "" : "s"}`);
  }
  return labels;
}

export interface DetailedAnalysis {
  run: AnalysisRun;
  /** Present whenever the structure parsed; absent on a failed parse. */
  composition?: DerivedComposition;
  stereochemistry: string[];
}

export async function analyzeStructure(request: AnalyzeStructureRequest): Promise<AnalysisRun> {
  return (await analyzeStructureDetailed(request)).run;
}

/**
 * The full analysis plus the two things the older `ChemistryAdapter` contract needs that do not belong
 * in a result — atom/bond counts and CIP labels. Kept on one parse rather than making the adapter run
 * a second one.
 */
export async function analyzeStructureDetailed(request: AnalyzeStructureRequest): Promise<DetailedAnalysis> {
  const interpretation = sourceInterpretation(request.format, request.value);
  const module = (await ensureRdkit()) as AnalysisModule;
  const engineVersion = typeof module.version === "function" ? module.version() : PINNED_RDKIT_VERSION;
  const contracts = rdkitMethodContracts(engineVersion);
  const registry = new MethodRegistry();
  for (const contract of contracts) registry.register(contract);

  const runWarnings: AnalysisWarning[] = [];
  if (engineVersion !== PINNED_RDKIT_VERSION) {
    // Not fatal — the numbers may well be fine — but the pinned regression fixtures no longer describe
    // this build, so the run says so rather than letting a silent version drift pass review.
    runWarnings.push(
      warning(
        "engine.version_drift",
        `RDKit reports ${engineVersion}; the method contracts and regression fixtures are pinned to ${PINNED_RDKIT_VERSION}.`,
        "warning"
      )
    );
  }

  const finish = (
    status: AnalysisStatus,
    results: AnalysisResult[],
    extraWarnings: AnalysisWarning[] = [],
    detail: { composition?: DerivedComposition; stereochemistry?: string[] } = {}
  ): DetailedAnalysis => ({
    ...(detail.composition ? { composition: detail.composition } : {}),
    stereochemistry: detail.stereochemistry ?? [],
    run: {
      schemaVersion: AnalysisSchemaVersion,
      runId: request.runId,
      sourceHash: interpretation.sourceHash,
      interpretations: [interpretation],
      engines: [
        {
          name: "rdkit-minimallib-wasm",
          version: engineVersion,
          artifactHashes: [`sha256:${PINNED_RDKIT_WASM_SHA256}`]
        }
      ],
      startedAt: request.startedAt,
      ...(request.finishedAt ? { finishedAt: request.finishedAt } : {}),
      status,
      results,
      warnings: [...runWarnings, ...extraWarnings],
      fingerprint: runFingerprint({
        sourceHash: interpretation.sourceHash,
        interpretationHashes: [interpretation.interpretationHash],
        methodKeys: results.map((result) => {
          const contract = registry.get(result.methodId);
          return contract ? methodKey(contract) : result.methodId;
        }),
        engineHashes: [PINNED_RDKIT_WASM_SHA256]
      })
    }
  });

  if (request.value.trim().length === 0) {
    return finish("failed", [], [warning("structure.empty", "The structure input is empty.", "error")]);
  }

  const mol = module.get_mol(request.value);
  if (!mol) {
    return finish(
      "failed",
      [],
      [
        warning(
          "structure.parse_failed",
          `RDKit could not parse the ${request.format} input.`,
          "error"
        )
      ]
    );
  }

  try {
    assertAnalysisSurface(module, mol);
    if (mol.get_num_atoms() === 0) {
      return finish(
        "failed",
        [],
        [warning("structure.empty", "The input parsed to a structure with no atoms.", "error")]
      );
    }

    const composition = compositionFromRdkitJson(JSON.parse(mol.get_json()) as RdkitJson);
    const descriptors = JSON.parse(mol.get_descriptors()) as Record<string, number>;
    const wanted = request.methodIds ? new Set(request.methodIds) : undefined;
    const selected = contracts.filter((contract) => !wanted || wanted.has(contract.id));
    const results: AnalysisResult[] = [];

    for (const contract of selected) {
      // Runs the §1 tautomer-policy check before anything touches the engine.
      registry.assertRunnable(contract.id, interpretation);
      const context: ResultContext = { contract, interpretation, composition };

      const outside = elementsOutsideParameterization(contract, composition.presentElements);
      if (outside.length > 0) {
        results.push(declineForElements(context, outside));
        continue;
      }

      results.push(computeResult(context, module, mol, descriptors, composition));
    }

    return finish(aggregateStatus(results.map((result) => result.status)), results, [], {
      composition,
      stereochemistry: stereochemistryLabels(
        mol.get_stereo_tags(),
        descriptors.NumUnspecifiedAtomStereoCenters ?? 0
      )
    });
  } finally {
    mol.delete();
  }
}

const DESCRIPTOR_BINDINGS = new Map(descriptorBindings().map((binding) => [binding.methodId, binding]));

function computeResult(
  context: ResultContext,
  module: AnalysisModule,
  mol: AnalysisMol,
  descriptors: Record<string, number>,
  composition: DerivedComposition
): AnalysisResult {
  const base = resultBase(context);
  const inDomain = { status: "in-domain" as const, reasons: [], unsupportedFeatures: [] };

  switch (context.contract.id) {
    case "rdkit.composition":
      return {
        ...base,
        kind: "composition",
        status: "ok",
        applicability: inDomain,
        warnings: [],
        formula: composition.formula,
        formalCharge: composition.formalCharge,
        elements: composition.elements,
        components: composition.components,
        hasExplicitIsotopes: composition.hasExplicitIsotopes,
        radicalElectronCount: composition.radicalElectronCount
      };

    case "rdkit.inchi": {
      let inchi = "";
      try {
        inchi = mol.get_inchi();
      } catch (error) {
        return failedIdentifier(context, "inchi", error instanceof Error ? error.message : String(error));
      }
      if (!inchi.startsWith("InChI=")) {
        return failedIdentifier(context, "inchi", "The InChI library returned no identifier for this structure.");
      }
      return {
        ...base,
        kind: "identifier",
        identifierType: "inchi",
        status: "ok",
        applicability: inDomain,
        warnings: [],
        value: inchi,
        flavour: "standard"
      };
    }

    case "rdkit.inchikey": {
      let key = "";
      try {
        const inchi = mol.get_inchi();
        key = inchi.startsWith("InChI=") ? module.get_inchikey_for_inchi(inchi) : "";
      } catch (error) {
        return failedIdentifier(context, "inchikey", error instanceof Error ? error.message : String(error));
      }
      if (!key) {
        return failedIdentifier(context, "inchikey", "No InChI was generated, so no key could be derived.");
      }
      return {
        ...base,
        kind: "identifier",
        identifierType: "inchikey",
        status: "ok",
        applicability: inDomain,
        warnings: [],
        value: key,
        flavour: "standard"
      };
    }

    case "rdkit.canonical-smiles": {
      const smiles = mol.get_smiles?.() ?? "";
      if (!smiles) {
        return failedIdentifier(context, "canonical-smiles", "RDKit returned an empty canonical SMILES.");
      }
      return {
        ...base,
        kind: "identifier",
        identifierType: "canonical-smiles",
        status: "ok",
        applicability: inDomain,
        warnings: [],
        value: smiles,
        flavour: "rdkit-isomeric-canonical"
      };
    }

    default: {
      const binding = DESCRIPTOR_BINDINGS.get(context.contract.id);
      const descriptorKey =
        binding?.descriptorKey ??
        (context.contract.id === "rdkit.average-mass"
          ? "amw"
          : context.contract.id === "rdkit.monoisotopic-mass"
            ? "exactmw"
            : undefined);

      if (!descriptorKey) {
        return {
          ...base,
          kind: "scalar",
          status: "failed",
          value: null,
          unit: context.contract.unit ?? "dimensionless",
          applicability: { status: "undetermined", reasons: ["no engine binding"], unsupportedFeatures: [] },
          warnings: [
            warning("method.no_binding", `No engine binding for method "${context.contract.id}".`, "error", [base.id])
          ]
        };
      }

      const value = descriptors[descriptorKey];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        // A descriptor the engine did not return is a contract/engine mismatch, not a chemistry
        // limitation — so it fails rather than declining.
        return {
          ...base,
          kind: "scalar",
          status: "failed",
          value: null,
          unit: context.contract.unit ?? "dimensionless",
          applicability: { status: "undetermined", reasons: [`engine returned no "${descriptorKey}"`], unsupportedFeatures: [] },
          warnings: [
            warning(
              "method.descriptor_missing",
              `The RDKit build returned no "${descriptorKey}" descriptor.`,
              "error",
              [base.id]
            )
          ]
        };
      }

      return {
        ...base,
        kind: "scalar",
        status: "ok",
        applicability: inDomain,
        warnings: [],
        value,
        unit: context.contract.unit ?? "dimensionless",
        ...(binding?.decimalPlaces !== undefined ? { decimalPlaces: binding.decimalPlaces } : {})
      };
    }
  }
}

/** Convenience for the session cache Phase 4 will own: the §1 key for one method in one run. */
export function cacheKeyFor(run: AnalysisRun, contract: MethodContract): string {
  return analysisCacheKey({
    sourceHash: run.sourceHash,
    interpretationHash: run.interpretations[0]?.interpretationHash ?? "",
    methodId: contract.id,
    methodVersion: contract.version,
    parameters: contract.implementation.parameters,
    engineHashes: [PINNED_RDKIT_WASM_SHA256]
  });
}
