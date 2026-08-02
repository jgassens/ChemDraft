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
  deriveInterpretation,
  describeInterpretation,
  fragmentTransformation,
  largestOrganicFragmentPlan,
  neutralizeTransformation,
  stripMolblockCharges,
  subsetRdkitJson,
  type DerivedInterpretationId
} from "./interpretations";
import {
  ADDUCTS,
  NEUTRAL_LOSSES,
  adductComponentSmiles,
  adductContracts,
  adductMethodId,
  adductMz,
  lossIsCompositionallyPossible,
  neutralLossContracts,
  neutralLossMethodId,
  neutralLossMz
} from "./mass";
import {
  DESCRIPTOR_DETAILS_INCLUDE_SANDP,
  INCLUDE_SANDP_PROBE_SMILES,
  UNPATCHED_CAPABILITIES,
  descriptorBindings,
  PINNED_RDKIT_VERSION,
  PINNED_RDKIT_WASM_SHA256,
  rdkitMethodContracts,
  type RdkitEngineCapabilities
} from "./methods";
import {
  DEFAULT_ENVELOPE_RELATIVE_THRESHOLD,
  ISOTOPE_ENVELOPE_METHOD_ID,
  computeEnvelope,
  envelopeResult,
  isotopeEnvelopeContract
} from "./envelope";
import {
  JOBACK_PC_METHOD_ID,
  JOBACK_TB_METHOD_ID,
  JOBACK_TC_METHOD_ID,
  JOBACK_VC_METHOD_ID,
  fragmentForJoback,
  jobackContracts,
  jobackCriticalPressure,
  jobackCriticalTemperature,
  jobackCriticalVolume,
  jobackNormalBoilingPoint,
  jobackUncertainty,
  type JobackEstimate,
  type JobackFragmentation
} from "./joback";
import {
  PINNED_ISOSPEC_VERSION,
  PINNED_ISOSPEC_WASM_SHA256,
  ensureIsoSpec,
  type IsoSpecModule
} from "@chemdraft/isospec-adapter";

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
  /**
   * Derived interpretations to offer, in preference order, when a method declines under `source`
   * because of an element it has no parameters for (PLANS.md §1).
   *
   * The source result is **kept** alongside the derived one — nothing is silently substituted. A run
   * on sodium benzoate carries both "Crippen logP: unsupported, Na has no parameters" and "Crippen
   * logP on the largest organic fragment: 0.0501, [Na+] removed", and the UI picks which to lead with.
   *
   * Pass `[]` to compute strictly against the structure as drawn.
   */
  fallbackInterpretations?: readonly DerivedInterpretationId[];
  /**
   * Force every method onto one derived interpretation instead of `source` — the "— change"
   * affordance §1 asks the UI to offer. When the interpretation cannot be derived for this structure,
   * the run falls back to `source` and says so.
   */
  interpretationOverride?: DerivedInterpretationId;
  /**
   * Refuse a structure with more than this many heavy atoms (PLANS.md §5, "molecule and memory
   * limits"). Enforced here rather than in the scheduler because the atom count is only knowable after
   * parsing, and it is the honest proxy for memory: MinimalLib exposes no heap cap, so bounding the
   * molecule is what bounds worst-case allocation. Omit for no limit.
   */
  maxHeavyAtoms?: number;
}

const DEFAULT_FALLBACK_INTERPRETATIONS: readonly DerivedInterpretationId[] = [
  "largest-organic-fragment",
  "neutralized"
];

/** The analysis surface `analyzeStructure` needs beyond what the conformer path already uses. */
interface AnalysisMol extends RdkitJsMol {
  /** Optional details JSON — only honoured by an artifact carrying vendor patch #6. */
  get_descriptors(details?: string): string;
  get_json(): string;
  get_inchi(): string;
  get_num_atoms(): number;
  get_num_bonds(): number;
  is_valid(): boolean;
  get_stereo_tags(): string;
  /** V2000 serialisation, used by the neutralisation derivation (see ./interpretations). */
  get_v2Kmolblock(): string;
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
  "get_stereo_tags",
  "get_v2Kmolblock"
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

/**
 * Whether the loaded artifact honours the TPSA `includeSandP` details flag.
 *
 * Value-based, not arity-based, and that is not a stylistic preference. Measured against the
 * pre-rebuild artifact, `get_descriptors('{"includeSandP":true}')` did not throw — it silently ignored
 * the argument and returned the same 34.14 for `CS(=O)(=O)C`. Detecting by "did the call succeed"
 * would have reported patch #6 as present, and the run would then have labelled an S-excluded number
 * with the S-included convention. Comparing the number cannot produce that false positive. The
 * committed artifact now carries the patch, but any binary that lags the patch set fails the same
 * way, so the probe stays.
 *
 * Memoised per loaded module, so the probe costs one extra parse per worker rather than one per
 * keystroke, and a reloaded module re-probes on its own.
 */
const CAPABILITY_CACHE = new WeakMap<object, RdkitEngineCapabilities>();

export function detectEngineCapabilities(module: AnalysisModule): RdkitEngineCapabilities {
  const cached = CAPABILITY_CACHE.get(module);
  if (cached) return cached;

  let capabilities = UNPATCHED_CAPABILITIES;
  const probe = module.get_mol(INCLUDE_SANDP_PROBE_SMILES) as AnalysisMol | null;
  if (probe) {
    try {
      const withoutFlag = JSON.parse(probe.get_descriptors()) as Record<string, number>;
      const withFlag = JSON.parse(probe.get_descriptors(DESCRIPTOR_DETAILS_INCLUDE_SANDP)) as Record<string, number>;
      capabilities = {
        descriptorIncludeSandP:
          typeof withFlag.tpsa === "number" &&
          typeof withoutFlag.tpsa === "number" &&
          withFlag.tpsa !== withoutFlag.tpsa
      };
    } catch {
      // A binding that rejects the argument outright is simply unpatched.
      capabilities = UNPATCHED_CAPABILITIES;
    } finally {
      probe.delete();
    }
  }

  CAPABILITY_CACHE.set(module, capabilities);
  return capabilities;
}

/**
 * Every contract this adapter ships, composed in one place.
 *
 * Single-sourced deliberately: the Release 2 adduct series was first added to the run without being
 * added to the canonical list, and `closeout.real.test.ts` caught it as "a result with no registered
 * contract". One function means the run and the closeout check cannot disagree again.
 *
 * The isotope envelope is in this list even though a second engine computes it. The list is the set of
 * methods the run may report, not the set RDKit implements — and a contract that appeared only when
 * IsoSpec happened to load is exactly the kind of conditional surface the closeout lock exists to
 * catch. When IsoSpec cannot load, the method still appears and declines with a reason.
 */
export function rdkitAnalysisContracts(
  engineVersion: string = PINNED_RDKIT_VERSION,
  capabilities: RdkitEngineCapabilities = UNPATCHED_CAPABILITIES,
  isospecVersion: string = PINNED_ISOSPEC_VERSION
): MethodContract[] {
  return [
    ...rdkitMethodContracts(engineVersion, capabilities),
    ...adductContracts(engineVersion),
    ...neutralLossContracts(engineVersion),
    isotopeEnvelopeContract(isospecVersion),
    ...jobackContracts()
  ];
}

/**
 * Exact masses for every ion component the adduct table needs, read from the loaded engine.
 *
 * Measured once per module and then reused arithmetically, so a run pays no extra `get_mol` per
 * keystroke. Reading them from RDKit rather than shipping a table is what keeps §7's rule intact —
 * and it is also what makes the electron bookkeeping correct for free, since RDKit's `[H+]` is the
 * proton rather than hydrogen.
 */
const ION_MASS_CACHE = new WeakMap<object, Map<string, number>>();

export function resolveIonComponentMasses(module: AnalysisModule): ReadonlyMap<string, number> {
  const cached = ION_MASS_CACHE.get(module);
  if (cached) return cached;

  const masses = new Map<string, number>();
  for (const smiles of adductComponentSmiles()) {
    const ion = module.get_mol(smiles) as AnalysisMol | null;
    if (!ion) continue;
    try {
      const exact = (JSON.parse(ion.get_descriptors()) as Record<string, number>).exactmw;
      // A component the engine cannot mass is left out; `adductMz` then declines rather than guessing.
      if (typeof exact === "number" && Number.isFinite(exact)) masses.set(smiles, exact);
    } finally {
      ion.delete();
    }
  }

  ION_MASS_CACHE.set(module, masses);
  return masses;
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
    // Stated rather than left implicit, which is what a tautomer-sensitive method requires before it
    // may run (§1). "as-drawn" is the honest description: no tautomer standardisation is applied, so
    // the keto and enol forms of acetylacetone are analysed as the two different molecules they are.
    // Declaring it does not weaken the guarantee — it is the guarantee, made checkable.
    tautomerPolicy: "as-drawn — no tautomer standardisation; the drawn form is the analysed form",
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

/**
 * Result ids: the method id alone under `source`, `method@interpretation` otherwise.
 *
 * The asymmetry is deliberate. A run can now carry the same method twice — declined as drawn, answered
 * on a derived interpretation — so the ids must differ, but the source result stays addressable by
 * plain method id for every caller written before interpretations existed.
 */
export function resultId(methodId: string, interpretationId: string): string {
  return interpretationId === SOURCE_INTERPRETATION_ID ? methodId : `${methodId}@${interpretationId}`;
}

/**
 * `[M+…]` and `[M+H−…]` both name species derived from a *neutral* M. When the drawing already carries
 * a charge there is no such M, so the notation does not apply — `not-applicable` rather than
 * `unsupported`, because nothing is missing from the method; the claim just does not fit.
 */
function chargedInputDecline(base: ReturnType<typeof resultBase>, message: string): AnalysisResult {
  return {
    ...base,
    kind: "scalar",
    status: "not-applicable",
    value: null,
    unit: "thomson",
    applicability: { status: "out-of-domain", reasons: [message], unsupportedFeatures: [] },
    warnings: [warning("mass.charged_input", message, "info", [base.id])]
  };
}

/** Shared fields every result carries, so a variant only spells out what makes it that variant. */
function resultBase(context: ResultContext) {
  return {
    id: resultId(context.contract.id, context.interpretation.id),
    label:
      context.interpretation.id === SOURCE_INTERPRETATION_ID
        ? context.contract.publicName
        : `${context.contract.publicName} · ${describeInterpretation(context.interpretation)}`,
    methodId: context.contract.id,
    methodVersion: context.contract.version,
    interpretationId: context.interpretation.id,
    classification: context.contract.classification,
    uncertainties: [],
    // Copied, not referenced: the contract is rebuilt per run from the detected engine capabilities,
    // so a cached result has to carry the convention it was actually computed under.
    conventions: context.contract.conventions,
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
  const capabilities = detectEngineCapabilities(module);
  const contracts = rdkitAnalysisContracts(engineVersion, capabilities);
  const registry = new MethodRegistry();
  for (const contract of contracts) registry.register(contract);
  // Only sent when the artifact honours it; an unpatched binding would ignore it silently, and a
  // request that is silently ignored has no business appearing in a cache key.
  const descriptorDetails = capabilities.descriptorIncludeSandP ? DESCRIPTOR_DETAILS_INCLUDE_SANDP : undefined;

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

  /**
   * Interpretations derived during this run, keyed by id. Populated lazily — a neutral single-component
   * structure never pays for a derivation nothing would use — and every molecule handle in here is
   * deleted before the run returns.
   */
  const derivedInterpretations = new Map<DerivedInterpretationId, DerivedContext>();

  /**
   * The second engine, loaded only if a run actually asks for the envelope and left null when it
   * cannot be loaded at all.
   *
   * Null is not a failure of the run: the method still appears and declines with a reason (§10 — a
   * report must show what it could not compute). It is, however, a reason not to name IsoSpec in
   * `engines` or its hash in the fingerprint, because neither would describe what produced these
   * numbers.
   */
  let isospec: IsoSpecModule | null = null;

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
      // Every interpretation any result references, so provenance can always be reconstructed —
      // AnalysisRunSchema rejects a run that omits one.
      interpretations: [
        interpretation,
        ...[...new Set(results.map((entry) => entry.interpretationId))]
          .filter((id) => id !== interpretation.id)
          .map((id) => derivedInterpretations.get(id as DerivedInterpretationId)!.interpretation)
      ],
      engines: [
        {
          name: "rdkit-minimallib-wasm",
          version: engineVersion,
          artifactHashes: [`sha256:${PINNED_RDKIT_WASM_SHA256}`]
        },
        ...(isospec
          ? [
              {
                name: "isospec-wasm",
                version: PINNED_ISOSPEC_VERSION,
                artifactHashes: [`sha256:${PINNED_ISOSPEC_WASM_SHA256}`]
              }
            ]
          : [])
      ],
      startedAt: request.startedAt,
      ...(request.finishedAt ? { finishedAt: request.finishedAt } : {}),
      status,
      results,
      warnings: [...runWarnings, ...extraWarnings],
      fingerprint: runFingerprint({
        sourceHash: interpretation.sourceHash,
        interpretationHashes: [
          interpretation.interpretationHash,
          ...[...derivedInterpretations.values()].map((entry) => entry.interpretation.interpretationHash)
        ],
        methodKeys: results.map((result) => {
          const contract = registry.get(result.methodId);
          const key = contract ? methodKey(contract) : result.methodId;
          // The interpretation is part of the key, not a free variation on it: the same method on the
          // salt and on its organic fragment are two different computations.
          return `${key}#${result.interpretationId}`;
        }),
        // Both artifacts, so rebuilding either invalidates every cached number that depended on it.
        engineHashes: isospec ? [PINNED_RDKIT_WASM_SHA256, PINNED_ISOSPEC_WASM_SHA256] : [PINNED_RDKIT_WASM_SHA256]
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

    if (request.maxHeavyAtoms !== undefined && mol.get_num_atoms() > request.maxHeavyAtoms) {
      // Refused before any descriptor runs. `unsupported` rather than `failed`: nothing went wrong,
      // the structure is outside what this call agreed to compute.
      return finish(
        "unsupported",
        [],
        [
          warning(
            "structure.too_many_atoms",
            `The structure has ${mol.get_num_atoms()} heavy atoms, over the ${request.maxHeavyAtoms} limit for this analysis.`,
            "warning"
          )
        ]
      );
    }

    const sourceJson = JSON.parse(mol.get_json()) as RdkitJson;
    const composition = compositionFromRdkitJson(sourceJson);
    const descriptors = readDescriptors(mol, descriptorDetails);
    const sourceContext: DerivedContext = { interpretation, mol, composition, descriptors };
    const ionMasses = resolveIonComponentMasses(module);

    const derive = (id: DerivedInterpretationId): DerivedContext | undefined =>
      resolveDerivedContext(id, module, sourceContext, sourceJson, derivedInterpretations, descriptorDetails);

    const wanted = request.methodIds ? new Set(request.methodIds) : undefined;
    const selected = contracts.filter((contract) => !wanted || wanted.has(contract.id));
    const fallbacks = request.fallbackInterpretations ?? DEFAULT_FALLBACK_INTERPRETATIONS;

    // Loaded here rather than beside RDKit: a run that did not ask for the envelope should not pay for
    // a second WASM instantiation. `ensureIsoSpec` memoises, so a session pays once.
    if (selected.some((contract) => contract.id === ISOTOPE_ENVELOPE_METHOD_ID)) {
      isospec = await loadIsoSpecOrNull();
    }
    const results: AnalysisResult[] = [];
    const extraWarnings: AnalysisWarning[] = [];
    // Computed on first use and reused across all four Joback properties: 41 SMARTS patterns is the
    // expensive part, and a run that asks for none of them pays nothing.
    let jobackFragmentation: JobackFragmentation | undefined;

    // The "— change" affordance: one interpretation for the whole run, chosen by the caller.
    let primary = sourceContext;
    if (request.interpretationOverride) {
      const overridden = derive(request.interpretationOverride);
      if (overridden) {
        primary = overridden;
      } else {
        extraWarnings.push(
          warning(
            "interpretation.override_unavailable",
            `The "${request.interpretationOverride}" interpretation cannot be derived for this structure; ` +
              "computing against the structure as drawn instead.",
            "warning"
          )
        );
      }
    }

    for (const contract of selected) {
      // Runs the §1 tautomer-policy check before anything touches the engine.
      registry.assertRunnable(contract.id, primary.interpretation);

      // The envelope is the one method a second engine computes, and it is driven by the composition
      // rather than by the molecule handle — so it does not go through the RDKit dispatch, and the
      // element-parameterisation check below does not apply to it (IsoSpec's own tables decide, and
      // it says so itself when an element is missing).
      if (contract.id === ISOTOPE_ENVELOPE_METHOD_ID) {
        results.push(envelopeResultFor(contract, primary, isospec));
        continue;
      }

      // Joback shares the envelope's shape: driven by a fragmentation of the whole molecule rather
      // than by a per-element parameterisation check, and declining on its own terms when an atom
      // falls outside its 41 groups. The fragmentation is computed once and reused across all four
      // properties — SMARTS matching over 41 patterns is the expensive part, not the arithmetic.
      if (JOBACK_METHOD_IDS.has(contract.id)) {
        jobackFragmentation ??= fragmentationFor(primary, module);
        results.push(jobackResultFor(contract, primary, jobackFragmentation));
        continue;
      }

      const outside = elementsOutsideParameterization(contract, primary.composition.presentElements);

      if (outside.length === 0) {
        results.push(resultFor(contract, primary, module, ionMasses));
        continue;
      }

      // Declined as given. Keep that result — nothing is silently substituted — and then look for an
      // interpretation that brings the method into its domain, so the run can carry both.
      results.push(declineForElements({ contract, interpretation: primary.interpretation, composition: primary.composition }, outside));
      if (primary !== sourceContext) continue;

      for (const fallbackId of fallbacks) {
        const candidate = derive(fallbackId);
        if (!candidate) continue;
        if (elementsOutsideParameterization(contract, candidate.composition.presentElements).length > 0) continue;
        registry.assertRunnable(contract.id, candidate.interpretation);
        results.push(
          withDerivationNotice(resultFor(contract, candidate, module, ionMasses), candidate.interpretation, outside)
        );
        break;
      }
    }

    return finish(aggregateStatus(results.map((result) => result.status)), results, extraWarnings, {
      composition: primary.composition,
      stereochemistry: stereochemistryLabels(
        primary.mol.get_stereo_tags(),
        primary.descriptors.NumUnspecifiedAtomStereoCenters ?? 0
      )
    });
  } finally {
    mol.delete();
    for (const derived of derivedInterpretations.values()) derived.mol.delete();
  }
}

/** One interpretation's live molecule and everything read off it. */
interface DerivedContext {
  interpretation: MolecularInterpretation;
  mol: AnalysisMol;
  composition: DerivedComposition;
  descriptors: Record<string, number>;
}

function readDescriptors(mol: AnalysisMol, details: string | undefined): Record<string, number> {
  return JSON.parse(details ? mol.get_descriptors(details) : mol.get_descriptors()) as Record<string, number>;
}

function contextFor(
  interpretation: MolecularInterpretation,
  mol: AnalysisMol,
  descriptorDetails: string | undefined
): DerivedContext {
  return {
    interpretation,
    mol,
    composition: compositionFromRdkitJson(JSON.parse(mol.get_json()) as RdkitJson),
    descriptors: readDescriptors(mol, descriptorDetails)
  };
}

function resultFor(
  contract: MethodContract,
  context: DerivedContext,
  module: AnalysisModule,
  ionMasses: ReadonlyMap<string, number>
): AnalysisResult {
  return computeResult(
    { contract, interpretation: context.interpretation, composition: context.composition },
    module,
    context.mol,
    context.descriptors,
    context.composition,
    ionMasses
  );
}

/**
 * Load the isotope engine, or report that it is unavailable.
 *
 * Swallowing the error is deliberate and narrow: the only failure this hides is "no IsoSpec loader in
 * this environment", and the run turns that into a decline carrying the message. A structure analysis
 * should not fail wholesale because one of its ~62 methods could not reach its engine.
 */
async function loadIsoSpecOrNull(): Promise<IsoSpecModule | null> {
  try {
    return await ensureIsoSpec();
  } catch {
    return null;
  }
}

export const JOBACK_METHOD_IDS: ReadonlySet<string> = new Set([
  JOBACK_TB_METHOD_ID,
  JOBACK_TC_METHOD_ID,
  JOBACK_PC_METHOD_ID,
  JOBACK_VC_METHOD_ID
]);

/**
 * Fragment the interpretation for Joback, once per run.
 *
 * `nA` in Joback's critical-pressure correlation counts hydrogens, so implicit ones are added back —
 * reading it as the heavy-atom count gives n-octane 50.3 bar against the correct 25.35, and both look
 * like plausible critical pressures.
 */
function fragmentationFor(context: DerivedContext, module: RdkitMinimalModule): JobackFragmentation {
  const json = JSON.parse(context.mol.get_json()) as {
    molecules: { atoms: { impHs?: number }[] }[];
    defaults?: { atom?: { impHs?: number } };
  };
  const atoms = json.molecules[0]?.atoms ?? [];
  const defaultImpHs = json.defaults?.atom?.impHs ?? 0;
  const totalAtoms = atoms.length + atoms.reduce((sum, atom) => sum + (atom.impHs ?? defaultImpHs), 0);
  return fragmentForJoback(
    module as unknown as Parameters<typeof fragmentForJoback>[0],
    context.mol as unknown as Parameters<typeof fragmentForJoback>[1],
    atoms.map((_, index) => index),
    totalAtoms
  );
}

/** One Joback property: estimate, or the decline with its reason. */
function jobackResultFor(
  contract: MethodContract,
  context: DerivedContext,
  fragmentation: JobackFragmentation
): AnalysisResult {
  const estimate = JOBACK_ESTIMATORS[contract.id]!(fragmentation);
  const base = resultBase({ contract, interpretation: context.interpretation, composition: context.composition });
  const unit = contract.unit ?? "dimensionless";

  if (!estimate.ok) {
    return {
      ...base,
      kind: "scalar",
      // The estimate says which shortfall this is; see JobackEstimate. A correlation that is merely
      // out of range must not drag the run's status down the way a real capability gap does.
      status: estimate.kind,
      value: null,
      unit,
      applicability: {
        status: "out-of-domain",
        reasons: [estimate.reason],
        unsupportedFeatures: estimate.unsupportedFeature ? [estimate.unsupportedFeature] : []
      },
      warnings: [warning("joback.declined", estimate.reason, "info", [base.id])]
    };
  }

  return {
    ...base,
    kind: "scalar",
    status: "ok",
    value: estimate.value,
    unit,
    // The uncertainty is the point, not decoration: an estimate rendered as a bare number reads as a
    // measurement, which is the distinction §8a draws between `prediction` and `descriptor`.
    uncertainties: jobackUncertainty(contract.id),
    // Joback's own precision. More digits would imply the method resolves what it does not.
    decimalPlaces: 1,
    applicability: { status: "in-domain", reasons: [], unsupportedFeatures: [] },
    warnings: []
  };
}

const JOBACK_ESTIMATORS: Record<string, (fragmentation: JobackFragmentation) => JobackEstimate> = {
  [JOBACK_TB_METHOD_ID]: jobackNormalBoilingPoint,
  [JOBACK_TC_METHOD_ID]: jobackCriticalTemperature,
  [JOBACK_PC_METHOD_ID]: jobackCriticalPressure,
  [JOBACK_VC_METHOD_ID]: jobackCriticalVolume
};

/** The envelope's own dispatch: composition in, `DistributionResult` out. */
function envelopeResultFor(
  contract: MethodContract,
  context: DerivedContext,
  isospec: IsoSpecModule | null
): AnalysisResult {
  const base = resultBase({ contract, interpretation: context.interpretation, composition: context.composition });
  if (!isospec) {
    return {
      ...envelopeResult(base, {
        ok: false,
        reason:
          "The IsoSpec engine is not available in this environment, so no isotope envelope was computed.",
        unsupportedFeature: "isospec engine unavailable"
      }),
      status: "unsupported"
    };
  }

  return envelopeResult(
    base,
    computeEnvelope(isospec, {
      formula: context.composition.formula,
      formalCharge: context.composition.formalCharge,
      hasExplicitIsotopes: context.composition.hasExplicitIsotopes,
      // Already split so `[13C]` tallies apart from `C`, which is exactly the shape the explicit-isotope
      // path needs — the envelope does not re-derive it.
      elements: context.composition.elements
    }),
    DEFAULT_ENVELOPE_RELATIVE_THRESHOLD
  );
}

/**
 * Attach the disclosure §1 requires to a result computed on a derived interpretation.
 *
 * An `info` warning rather than a `warning`: the derivation is not a problem, it is a fact the reader
 * must have. Naming the element that forced it keeps the two results legible as a pair.
 */
function withDerivationNotice(
  result: AnalysisResult,
  interpretation: MolecularInterpretation,
  forcedBy: readonly string[]
): AnalysisResult {
  return {
    ...result,
    warnings: [
      ...result.warnings,
      warning(
        "interpretation.derived",
        `Computed on ${describeInterpretation(interpretation)}, because the structure as drawn contains ` +
          `${forcedBy.join(", ")}, which this method has no parameters for.`,
        "info",
        [result.id]
      )
    ]
  };
}

/**
 * Derive an interpretation once per run, or report that it does not exist for this structure.
 *
 * `undefined` is a real answer, not a failure: a single-component neutral molecule has no largest
 * organic fragment distinct from itself, cisplatin has no organic fragment at all, and a quaternary
 * ammonium has no neutral form. In each case the honest move is to offer nothing.
 */
function resolveDerivedContext(
  id: DerivedInterpretationId,
  module: AnalysisModule,
  source: DerivedContext,
  sourceJson: RdkitJson,
  cache: Map<DerivedInterpretationId, DerivedContext>,
  descriptorDetails: string | undefined
): DerivedContext | undefined {
  const cached = cache.get(id);
  if (cached) return cached;

  if (id === "largest-organic-fragment") {
    const plan = largestOrganicFragmentPlan(sourceJson);
    if (!plan) return undefined;
    const fragmentMol = module.get_mol(subsetRdkitJson(sourceJson, plan.keptAtoms)) as AnalysisMol | null;
    if (!fragmentMol) return undefined;

    const context = contextFor(
      deriveInterpretation({
        id,
        base: source.interpretation,
        step: fragmentTransformation(plan),
        componentPolicy: "largest-organic-fragment"
      }),
      fragmentMol,
      descriptorDetails
    );
    cache.set(id, context);
    return context;
  }

  // Neutralisation stacks on the fragment when there is one, so the interpretation §7 actually names —
  // "a neutralized largest organic fragment" — is reachable in one step from a salt.
  const base =
    resolveDerivedContext("largest-organic-fragment", module, source, sourceJson, cache, descriptorDetails) ??
    source;

  // The molblock is the single source of truth for "is there a charge to remove": it also catches the
  // zwitterion, whose net charge is zero while two of its atoms are charged.
  const stripped = stripMolblockCharges(base.mol.get_v2Kmolblock());
  if (stripped.chargedAtomCount === 0) return undefined;

  // `null` here is RDKit refusing to make a neutral molecule — a quaternary ammonium or a nitro group
  // has no valid neutral form. That is the correct outcome, and inventing one would be exactly the
  // chemistry call this module must not make.
  const neutralMol = module.get_mol(stripped.molblock) as AnalysisMol | null;
  if (!neutralMol) return undefined;

  const neutralised = contextFor(base.interpretation, neutralMol, descriptorDetails);
  const step = neutralizeTransformation({
    atomCount: base.composition.atomCount,
    neutralizedFormula: neutralised.composition.formula,
    chargedAtomCount: stripped.chargedAtomCount,
    netChargeRemoved: stripped.netChargeRemoved,
    // Read back off the derived molecule rather than predicted: RDKit decided the hydrogen count, and
    // working it out ourselves would be the interpretation §7 forbids.
    hydrogenChanges: hydrogenCount(neutralised.composition) - hydrogenCount(base.composition)
  });

  const context: DerivedContext = {
    ...neutralised,
    interpretation: deriveInterpretation({ id, base: base.interpretation, step })
  };
  cache.set(id, context);
  return context;
}

function hydrogenCount(composition: DerivedComposition): number {
  return composition.elements
    .filter((element) => element.symbol === "H")
    .reduce((total, element) => total + element.count, 0);
}

const DESCRIPTOR_BINDINGS = new Map(descriptorBindings().map((binding) => [binding.methodId, binding]));

function computeResult(
  context: ResultContext,
  module: AnalysisModule,
  mol: AnalysisMol,
  descriptors: Record<string, number>,
  composition: DerivedComposition,
  ionMasses: ReadonlyMap<string, number>
): AnalysisResult {
  const base = resultBase(context);
  const inDomain = { status: "in-domain" as const, reasons: [], unsupportedFeatures: [] };

  const loss = NEUTRAL_LOSSES.find((candidate) => neutralLossMethodId(candidate) === context.contract.id);
  if (loss) {
    const elementCounts = new Map<string, number>();
    for (const element of composition.elements) {
      elementCounts.set(element.symbol, (elementCounts.get(element.symbol) ?? 0) + element.count);
    }

    if (composition.formalCharge !== 0) {
      const message = `${context.contract.publicName} is not defined for an already-charged structure.`;
      return chargedInputDecline(base, message);
    }
    if (!lossIsCompositionallyPossible(loss, elementCounts)) {
      // Compositional, not chemical: the molecule simply does not contain the atoms to lose.
      const message =
        `${composition.formula} does not contain ${loss.label}, so the loss is not compositionally possible.`;
      return {
        ...base,
        kind: "scalar",
        status: "not-applicable",
        value: null,
        unit: "thomson",
        applicability: { status: "out-of-domain", reasons: [message], unsupportedFeatures: [loss.label] },
        warnings: [warning("mass.loss_impossible", message, "info", [base.id])]
      };
    }

    const lossMz = neutralLossMz(descriptors.exactmw ?? Number.NaN, loss, ionMasses);
    if (lossMz === undefined || !Number.isFinite(lossMz)) {
      const message = `The engine supplied no mass for the lost ${loss.label}.`;
      return {
        ...base,
        kind: "scalar",
        status: "failed",
        value: null,
        unit: "thomson",
        applicability: { status: "undetermined", reasons: [message], unsupportedFeatures: [] },
        warnings: [warning("mass.component_unavailable", message, "error", [base.id])]
      };
    }

    return {
      ...base,
      kind: "scalar",
      status: "ok",
      applicability: inDomain,
      warnings: [],
      value: lossMz,
      unit: "thomson",
      decimalPlaces: 4
    };
  }

  const adduct = ADDUCTS.find((candidate) => adductMethodId(candidate) === context.contract.id);
  if (adduct) {
    // [M+…] names an adduct *of a neutral M*. When the drawing already carries a charge there is no
    // such M, so the notation does not apply — `not-applicable` rather than `unsupported`, because
    // nothing is missing from the method; the claim just does not fit this structure.
    if (composition.formalCharge !== 0) {
      return chargedInputDecline(
        base,
        `${context.contract.publicName} is not defined for a structure that already carries a net ` +
          `charge of ${composition.formalCharge > 0 ? "+" : ""}${composition.formalCharge}.`
      );
    }

    const mz = adductMz(descriptors.exactmw ?? Number.NaN, adduct, ionMasses);
    if (mz === undefined || !Number.isFinite(mz)) {
      const message = `The engine supplied no mass for one of ${adduct.label}'s ion components.`;
      return {
        ...base,
        kind: "scalar",
        status: "failed",
        value: null,
        unit: "thomson",
        applicability: { status: "undetermined", reasons: [message], unsupportedFeatures: [] },
        warnings: [warning("mass.component_unavailable", message, "error", [base.id])]
      };
    }

    return {
      ...base,
      kind: "scalar",
      status: "ok",
      applicability: inDomain,
      warnings: [],
      value: mz,
      unit: "thomson",
      decimalPlaces: 4
    };
  }

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
      const descriptorKey = binding?.descriptorKey;

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
