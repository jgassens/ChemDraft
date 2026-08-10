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

import { compositionFromRdkitJson, elementSymbol, type DerivedComposition, type RdkitJson } from "./composition";
import { ensureRdkit, type RdkitJsMol, type RdkitMinimalModule } from "./conformer";
import {
  deriveInterpretation,
  describeInterpretation,
  fragmentTransformation,
  largestOrganicFragmentPlan,
  neutralizeTransformation,
  referenceProtomerMolblock,
  referenceProtomerTransformation,
  REFERENCE_PROTOMER_POLICY,
  stripMolblockCharges,
  subsetRdkitJson,
  type DerivedInterpretationId,
  referenceTautomerTransformation,
  REFERENCE_TAUTOMER_POLICY
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
  PINNED_PKA_MODEL_SHA256,
  PINNED_RDKIT_WASM_SHA256,
  rdkitMethodContracts,
  type RdkitEngineCapabilities,
  CANONICAL_TAUTOMER_PROBE_SMILES
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
  IONIZATION_CONFIDENCE_BANDS,
  IONIZATION_SITES_METHOD_ID,
  combineSiteEstimates,
  depictionFor,
  ionizationContract,
  scanIonizableSites,
  scoreSitesWithHammett,
  molblockWithChargedAtom,
  molblockWithCharges,
  scoreSiteTransitions,
  protonatedCarbonylSites
} from "./ionization";
import { macroscopicApplies, macroscopicFromSites } from "./protonation";
import type { PkaMolecularGraph } from "./pkaModel";
// Re-exported so the barrel and every existing importer keep working; it LIVES in its own module so
// `constants.ts` can offer it without the engine. See that file for why the split exists.
import { sourceInterpretation } from "./sourceInterpretation";

export { sourceInterpretation };
// The corpus size is read from the shipped artifact, never typed here. The decline messages quote it
// to the user, and a hand-typed count drifts the moment the corpus is regenerated — which is exactly
// what happened: three call sites still said 7,053 after the corpus reached 12,096.
import { PKA_GNN_TRAINING } from "./pkaGnn";
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

/**
 * Whether the loaded artifact can actually canonicalise a tautomer (vendor patch #7).
 *
 * Probed BY VALUE, never by whether the method exists. Acetylacetone's enol form has the diketone as its
 * canonical tautomer, so a binding that ran MolStandardize returns a DIFFERENT structure and one that
 * did not returns the input, an empty string, or nothing at all. "The call succeeded" would report the
 * patch present while silently canonicalising nothing — the exact failure patch #6 documents.
 */
function probeCanonicalTautomer(module: AnalysisModule): boolean {
  const probe = module.get_mol(CANONICAL_TAUTOMER_PROBE_SMILES) as AnalysisMol | null;
  if (!probe) return false;
  try {
    if (typeof probe.get_canonical_tautomer_molblock !== "function") return false;
    const molblock = probe.get_canonical_tautomer_molblock();
    if (!molblock) return false;
    const rebuilt = module.get_mol(molblock) as AnalysisMol | null;
    if (!rebuilt) return false;
    try {
      const before = probe.get_smiles?.();
      const after = rebuilt.get_smiles?.();
      return typeof before === "string" && typeof after === "string" && before !== after;
    } finally {
      rebuilt.delete();
    }
  } catch {
    return false;
  } finally {
    probe.delete();
  }
}

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
          withFlag.tpsa !== withoutFlag.tpsa,
        canonicalTautomer: probeCanonicalTautomer(module)
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
    ...jobackContracts(),
    ionizationContract()
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

  if (context.contract.resultKind === "identifier") {
    return { ...shared, kind: "identifier", identifierType: "smiles", value: null };
  }
  // An ionization result declines in its own shape rather than as a bare scalar. Empty `sites` and
  // `unassessed` is what `payloadIsAbsent` reads as "no payload", which is what a non-ok status
  // requires — and a consumer that switched on `kind` would otherwise be handed a scalar where it
  // expects a site list.
  if (context.contract.resultKind === "ionization") {
    return { ...shared, kind: "ionization", sites: [], unassessed: [] };
  }
  return { ...shared, kind: "scalar", value: null, unit: context.contract.unit ?? "dimensionless" };
}

/**
 * Declined because the input is more than one molecule.
 *
 * A pKa belongs to a species, and two species drawn side by side are not one. Co-drawn phenol and
 * acetic acid produced a macroscopic ladder of 4.99 and 10.93 — a two-step titration curve for
 * something that does not exist — and `CC(=O)O.CC(=O)O` came out as a diprotic acid. Even a bare
 * counterion moves the answer, because the model reads whole-molecule descriptors: acetic acid alone
 * scores 4.50, with sodium 4.62, with iron 4.57.
 *
 * The fallback ladder then offers the largest organic fragment, so a salt still gets its answer, the
 * way `rdkit.crippen-logp` already behaves on sodium benzoate.
 */
function declineForComponents(context: ResultContext, componentCount: number): AnalysisResult {
  const message =
    `This structure is ${componentCount} separate components, and a pKa belongs to one species. ` +
    `Zero of the model's ${PKA_GNN_TRAINING.samples.toLocaleString("en-US")} training labels is ` +
    "multi-component, and the descriptors it reads (mass, polar surface area, logP, charge) are " +
    "computed over everything drawn — so a counterion or a second molecule shifts the answer " +
    "without appearing in it.";
  const base = resultBase(context);
  return {
    ...base,
    kind: "ionization",
    status: "unsupported",
    applicability: {
      status: "out-of-domain",
      reasons: [message],
      unsupportedFeatures: ["multi-component structure"]
    },
    warnings: [warning("ionization.multi_component", message, "warning", [base.id])],
    sites: [],
    unassessed: []
  };
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

/**
 * A method that threw, reported as itself rather than as the end of the run.
 *
 * `failed`, deliberately, and not one of the decline statuses: every decline in this engine is a
 * considered statement about the chemistry, and an exception is not one of those. It is the engine
 * going wrong, the reader should be able to tell the difference, and `aggregateStatus` ranks it so the
 * run says something went wrong too.
 */
function failedMethod(contract: MethodContract, context: DerivedContext, error: unknown): AnalysisResult {
  const message = error instanceof Error ? error.message : String(error);
  const base = resultBase({
    contract,
    interpretation: context.interpretation,
    composition: context.composition
  });
  return {
    ...base,
    kind: "scalar",
    status: "failed",
    value: null,
    unit: contract.unit ?? "dimensionless",
    applicability: { status: "undetermined", reasons: [message], unsupportedFeatures: [] },
    warnings: [
      warning(
        "method.threw",
        `${contract.publicName} could not be computed: ${message}`,
        "error",
        [base.id]
      )
    ]
  };
}

/**
 * The identifier does not exist for this structure, which is not the same as the attempt going wrong.
 *
 * `failed` means something broke and the number is unknown; `unsupported` means the standard has no
 * representation for what was drawn. InChI has none for a dummy atom, so `*c1ccccc1` — a structure
 * RDKit parses without complaint and every other method scores happily — should report a capability
 * gap and leave the run's status alone. Filing it as `failed` dragged the whole run to `failed` and
 * told the reader something had broken when nothing had. §8b's decline-versus-failure line.
 */
function unsupportedIdentifier(
  context: ResultContext,
  identifierType: "inchi" | "inchikey" | "canonical-smiles",
  reason: string,
  unsupportedFeatures: string[] = []
): AnalysisResult {
  const base = resultBase(context);
  return {
    ...base,
    kind: "identifier",
    identifierType,
    status: "unsupported",
    value: null,
    applicability: { status: "out-of-domain", reasons: [reason], unsupportedFeatures },
    warnings: [warning(`identifier.${identifierType}_unavailable`, reason, "info", [base.id])]
  };
}



/** CIP descriptors as RDKit perceived them, plus a note for centres the drawing left unassigned. */
export function stereochemistryLabels(stereoTagsJson: string, unspecifiedCentres: number): string[] {
  let tags: { CIP_atoms?: [number, string][]; CIP_bonds?: [number, number, string][] } = {};
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
    // A CIP_bonds entry is a FLAT triple — `[16, 17, "(E)"]` — not `[atoms[], descriptor]` the way a
    // CIP_atoms entry is `[atom, descriptor]`. Read as a pair it took atom 17 for the descriptor,
    // which is never "(?)" so it always passed the filter, and then called `.join` on a number.
    // Every molecule with an assigned double-bond stereocentre threw out of the whole analysis run;
    // `C/C=C/C` was enough. Found by the SAMPL6 end-to-end benchmark, which is the first thing here
    // that fed the pipeline arbitrary drug-like structures instead of chosen ones.
    ...(tags.CIP_bonds ?? [])
      .filter(([, , descriptor]) => assigned(descriptor))
      .map(([begin, end, descriptor]) => `bond ${begin}-${end} ${descriptor}`)
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
          artifactHashes: [
            `sha256:${PINNED_RDKIT_WASM_SHA256}`,
            // The pKa artifacts are evaluated in-process by this adapter rather than by a second
            // engine, so they belong on this entry's artifact list — which `EngineEnvironment` already
            // documents as "the executable, model, and data artifacts the run depended on". Only when
            // the run actually produced a pKa, mirroring how IsoSpec is named only when it ran.
            ...(results.some((result) => result.methodId === IONIZATION_SITES_METHOD_ID)
              ? [`sha256:${PINNED_PKA_MODEL_SHA256}`]
              : [])
          ]
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
        // Every artifact that decided a number here, so rebuilding any of them invalidates the cache.
        engineHashes: [
          PINNED_RDKIT_WASM_SHA256,
          ...(isospec ? [PINNED_ISOSPEC_WASM_SHA256] : []),
          ...(results.some((result) => result.methodId === IONIZATION_SITES_METHOD_ID)
            ? [PINNED_PKA_MODEL_SHA256]
            : [])
        ]
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
            // "atoms", not "heavy atoms". `get_num_atoms()` counts EXPLICIT hydrogens too, so a
            // molfile that writes its hydrogens out is measured on a different scale from the SMILES
            // for the same molecule — and the message named the scale it was not using. The guard is a
            // work budget, so counting what the engine will actually process is right; only the word
            // was wrong.
            `The structure has ${mol.get_num_atoms()} atoms, over the ${request.maxHeavyAtoms} limit for this analysis.`,
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
    // A method id that matches no contract used to vanish silently, so a caller's typo produced a run
    // missing a method with nothing anywhere to say so — and `methodIds` is exactly the surface a
    // caller uses when they care which methods ran.
    if (wanted) {
      const known = new Set(contracts.map((contract) => contract.id));
      const unknown = [...wanted].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        extraWarnings.push(
          warning(
            "request.unknown_method",
            `No method is registered for ${unknown.join(", ")}, so ${
              unknown.length === 1 ? "it was" : "they were"
            } not computed.`,
            "warning"
          )
        );
      }
    }
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
      // ONE METHOD'S EXCEPTION MUST NOT COST THE OTHER SIXTY-ONE.
      //
      // Every branch below can throw — a WASM abort, a SMARTS the build cannot compile, a `RangeError`
      // out of a large envelope — and an uncaught throw here abandoned the whole run: a user who drew
      // one structure got nothing rather than sixty-one answers and one decline. The declines this
      // codebase is careful about are all deliberate; this is the accidental kind, and it deserves the
      // same treatment. A method that throws is reported as `failed` WITH its message, which is
      // honestly different from a decline and is a state the report already renders.
      try {
        runOneMethod(contract);
      } catch (error) {
        results.push(failedMethod(contract, primary, error));
      }
    }

    function runOneMethod(contract: MethodContract): void {
      // Runs the §1 tautomer-policy check before anything touches the engine.
      registry.assertRunnable(contract.id, primary.interpretation);

      // The envelope is the one method a second engine computes, and it is driven by the composition
      // rather than by the molecule handle — so it does not go through the RDKit dispatch, and the
      // element-parameterisation check below does not apply to it (IsoSpec's own tables decide, and
      // it says so itself when an element is missing).
      if (contract.id === ISOTOPE_ENVELOPE_METHOD_ID) {
        results.push(envelopeResultFor(contract, primary, isospec));
        return;
      }

      if (JOBACK_METHOD_IDS.has(contract.id)) {
        jobackFragmentation ??= fragmentationFor(primary, module);
        results.push(jobackResultFor(contract, primary, jobackFragmentation));
        return;
      }

      // Every method's own computation, so the fallback ladder below can re-run whichever one declined.
      //
      // pKa alone is routed away from the structure as drawn, to the canonical protomer named by its
      // own `defaultInterpretationId` — a field that has been on `MethodContract` since the ledger was
      // written and that nothing read until now. A pKa is a property of a molecular FAMILY, and the
      // four drawings of glycine gave four different answers, the pH-7 zwitterion giving none at all.
      // The element and component checks still run on the structure AS DRAWN, so a salt still declines
      // in its own right rather than being silently absorbed by the canonicalization.
      const computeFor = (context: DerivedContext): AnalysisResult => {
        if (contract.id !== IONIZATION_SITES_METHOD_ID) {
          return resultFor(contract, context, module, ionMasses);
        }
        // An explicit override wins: a caller who asked to see a particular form gets that form,
        // canonicalization included. Silently substituting a different one would make the panel's
        // disclosure line a lie.
        // The canonical TAUTOMER when the loaded artifact can produce one, and the canonical protomer
        // otherwise. The tautomer derivation stacks on the protomer, so asking for it gets both; it
        // returns undefined when vendor patch #7 is absent or when the drawn tautomer was already
        // canonical, and the protomer form is then exactly what shipped before.
        const canonical = request.interpretationOverride
          ? undefined
          : derive("reference-tautomer") ?? derive("reference-protomer");
        if (!canonical || canonical === context) return ionizationResultFor(contract, context, module);
        registry.assertRunnable(contract.id, canonical.interpretation);
        // The SUBMITTED structure is passed alongside the canonical one, and only for the unsupported
        // -basicity notice. Measured: `reference-protomer` strips the charge from a drawn `C=[OH+]` in
        // every case, so a protonated carbonyl is neutral by the time the site scan sees it — the state
        // the USER presented is the only place that question is visible at all. Indices are shared: both
        // derivations preserve atom order, which `siteDetection.real.test.ts` asserts over 12,062
        // molecules.
        return withProtomerNotice(
          ionizationResultFor(contract, canonical, module, context),
          canonical.interpretation
        );
      };

      const outside = elementsOutsideParameterization(contract, primary.composition.presentElements);
      // Multi-component input is out of domain for pKa specifically, and the evidence is the same shape
      // as the element rule: ZERO of the 12,096 training labels has more than one component — re-counted
      // over the current four-source corpus, not carried over from the 7,053-row one. The element
      // check does not catch it — `CCN.Cl` and `Oc1ccccc1.CC(=O)O` are all in-set elements — and the
      // whole-molecule descriptors the model is fed (mass, TPSA, logP, charge) include every component,
      // so co-drawn phenol and acetic acid returned a fabricated two-step ladder for a species that does
      // not exist. Multiplicity, not `components.length`: identical components collapse into one entry
      // with a count, so `CC(=O)O.CC(=O)O` has length 1.
      const componentCount = primary.composition.components.reduce(
        (total, component) => total + component.multiplicity,
        0
      );
      const multiComponent =
        contract.id === IONIZATION_SITES_METHOD_ID && componentCount > 1 ? componentCount : 0;

      if (outside.length === 0 && multiComponent === 0) {
        results.push(computeFor(primary));
        return;
      }

      // Declined as given. Keep that result — nothing is silently substituted — and then look for an
      // interpretation that brings the method into its domain, so the run can carry both.
      const context = { contract, interpretation: primary.interpretation, composition: primary.composition };
      results.push(
        outside.length > 0 ? declineForElements(context, outside) : declineForComponents(context, multiComponent)
      );
      if (primary !== sourceContext) return;

      for (const fallbackId of fallbacks) {
        const candidate = derive(fallbackId);
        if (!candidate) continue;
        if (elementsOutsideParameterization(contract, candidate.composition.presentElements).length > 0) continue;
        if (
          contract.id === IONIZATION_SITES_METHOD_ID &&
          candidate.composition.components.reduce((total, component) => total + component.multiplicity, 0) > 1
        ) {
          continue;
        }
        registry.assertRunnable(contract.id, candidate.interpretation);
        results.push(
          withDerivationNotice(
            computeFor(candidate),
            candidate.interpretation,
            derivationReason(outside, multiComponent)
          )
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
    molecules: { atoms: { impHs?: number; chg?: number }[] }[];
    defaults?: { atom?: { impHs?: number; chg?: number } };
  };
  const atoms = json.molecules[0]?.atoms ?? [];
  const defaultImpHs = json.defaults?.atom?.impHs ?? 0;
  const defaultCharge = json.defaults?.atom?.chg ?? 0;
  const totalAtoms = atoms.length + atoms.reduce((sum, atom) => sum + (atom.impHs ?? defaultImpHs), 0);
  // Per-atom formal charge, read from `get_json()` rather than re-derived — §8b. The fragmentation
  // needs it to keep neutral-atom patterns off charged atoms; without it pyridinium matched the
  // pyrrole-type `>NH (ring)` and every Joback property came back in-domain.
  const formalCharges = new Map<number, number>(
    atoms.map((atom, index) => [index, atom.chg ?? defaultCharge])
  );
  return fragmentForJoback(
    module as unknown as Parameters<typeof fragmentForJoback>[0],
    context.mol as unknown as Parameters<typeof fragmentForJoback>[1],
    atoms.map((_, index) => index),
    totalAtoms,
    formalCharges
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

/**
 * The molecule as the pKa model expects it: implicit hydrogens, Kekulé bond orders, and the same
 * descriptor names `get_descriptors()` uses. Built here rather than in the model module so the model
 * stays free of any RDKit JSON detail.
 */
function modelGraph(
  context: DerivedContext,
  json: { molecules: { atoms: { z?: number; chg?: number; impHs?: number }[]; bonds: { atoms: number[]; bo?: number }[] }[];
          defaults?: { atom?: { chg?: number; impHs?: number }; bond?: { bo?: number } } },
  defaultZ: number
): PkaMolecularGraph {
  const molecule = json.molecules[0];
  const defaultCharge = json.defaults?.atom?.chg ?? 0;
  const defaultHydrogens = json.defaults?.atom?.impHs ?? 0;
  const defaultOrder = json.defaults?.bond?.bo ?? 1;
  return {
    atoms: (molecule?.atoms ?? []).map((atom) => ({
      element: elementSymbol(atom.z ?? defaultZ),
      charge: atom.chg ?? defaultCharge,
      hydrogens: atom.impHs ?? defaultHydrogens
    })),
    bonds: (molecule?.bonds ?? []).map((bond) => ({
      atoms: [bond.atoms[0]!, bond.atoms[1]!] as [number, number],
      order: bond.bo ?? defaultOrder
    })),
    descriptors: context.descriptors
  };
}

/** Ionizable sites: scan in, `IonizationResult` out. */
/**
 * Atoms of `mol` that are a protonated carbonyl or thiocarbonyl — chemistry the site table cannot value.
 *
 * Reads `get_json()` rather than building a full graph: element, charge, hydrogen count and bond order are
 * all this needs, and it runs on the SUBMITTED structure where the state is still visible.
 */
function unsupportedBasicityIn(mol: AnalysisMol): number[] {
  const json = JSON.parse(mol.get_json()) as {
    molecules: { atoms: { z?: number; chg?: number; impHs?: number }[];
                 bonds: { atoms: number[]; bo?: number }[] }[];
    defaults?: { atom?: { z?: number; chg?: number; impHs?: number }; bond?: { bo?: number } };
  };
  const molecule = json.molecules[0];
  if (!molecule) return [];
  const ad = json.defaults?.atom ?? {};
  const bd = json.defaults?.bond?.bo ?? 1;
  const atoms = molecule.atoms.map((atom) => ({
    element: elementSymbol(atom.z ?? ad.z ?? 6),
    charge: atom.chg ?? ad.chg ?? 0,
    hydrogens: atom.impHs ?? ad.impHs ?? 0
  }));
  const bonds = molecule.bonds.map((bond) => ({
    atoms: [bond.atoms[0]!, bond.atoms[1]!] as [number, number],
    order: bond.bo ?? bd
  }));
  return protonatedCarbonylSites({ atoms, bonds, descriptors: {} });
}

function ionizationResultFor(
  contract: MethodContract,
  context: DerivedContext,
  module: RdkitMinimalModule,
  /** The structure as SUBMITTED, when canonicalization replaced it. See `unsupportedBasicityIn`. */
  submitted?: DerivedContext
): AnalysisResult {
  const base = resultBase({ contract, interpretation: context.interpretation, composition: context.composition });
  const json = JSON.parse(context.mol.get_json()) as {
    molecules: {
      atoms: { z?: number; chg?: number; impHs?: number }[];
      bonds: { atoms: number[]; bo?: number }[];
    }[];
    defaults?: { atom?: { z?: number; chg?: number; impHs?: number }; bond?: { bo?: number } };
  };
  const defaultZ = json.defaults?.atom?.z ?? 6;
  const elements = (json.molecules[0]?.atoms ?? []).map((atom) => elementSymbol(atom.z ?? defaultZ));

  // The site patterns need explicit hydrogens, and adding them mutates — so this works on a COPY.
  // Mutating `context.mol` would hand every later method a hydrogen-explicit molecule and silently
  // change descriptor values that were computed against the implicit form.
  const copy = (module as unknown as { get_mol_copy?: (mol: unknown) => AnalysisMol }).get_mol_copy;
  const withHydrogens = copy ? copy.call(module, context.mol) : undefined;
  if (!withHydrogens) {
    const reason = "This RDKit build cannot copy a molecule, so ionizable sites were not scanned.";
    return {
      ...base,
      kind: "ionization",
      status: "unsupported",
      sites: [],
      unassessed: [],
      applicability: { status: "undetermined", reasons: [reason], unsupportedFeatures: [] },
      warnings: [warning("ionization.engine_unavailable", reason, "warning", [base.id])]
    };
  }

  let scan;
  try {
    (withHydrogens as unknown as { add_hs_in_place(): void }).add_hs_in_place();
    scan = scanIonizableSites(
      module as unknown as Parameters<typeof scanIonizableSites>[0],
      withHydrogens as unknown as Parameters<typeof scanIonizableSites>[1],
      elements
    );
  } finally {
    withHydrogens.delete();
  }

  // Score with the trained model, on the IMPLICIT-hydrogen graph the model was trained against.
  // Feature-ising the hydrogen-explicit copy would change degree and neighbour counts for every site.
  const graph = modelGraph(context, json, defaultZ);

  /**
   * The same molecule with one atom protonated, for scoring a BASIC site.
   *
   * Only the formal charge is written into the molblock; RDKit adds the proton itself on re-parse, so a
   * pyridine nitrogen at +1 picks up one hydrogen and an -NH2 picks up a third. Descriptors are
   * recomputed from that microstate rather than adjusted by hand — net charge, TPSA and HBD all move,
   * and the model was trained on the real values.
   *
   * The element sequence is checked before the graph is used: a re-parse that reordered atoms would
   * score the wrong site, silently.
   */
  const protonatedAt = (atomIndex: number): PkaMolecularGraph | undefined => {
    const source = copy ? copy.call(module, context.mol) : undefined;
    if (!source) return undefined;
    let molblock: string | undefined;
    try {
      const withCoords = source as unknown as { get_molblock?(): string };
      molblock = withCoords.get_molblock?.();
    } finally {
      source.delete();
    }
    if (!molblock) return undefined;

    const edited = molblockWithChargedAtom(molblock, atomIndex);
    if (!edited) return undefined;
    const protonated = module.get_mol(edited) as AnalysisMol | null;
    if (!protonated) return undefined;
    try {
      const protonatedJson = JSON.parse(protonated.get_json()) as typeof json;
      const built = modelGraph(
        { ...context, descriptors: JSON.parse(protonated.get_descriptors()) as Record<string, number> },
        protonatedJson,
        protonatedJson.defaults?.atom?.z ?? 6
      );
      if (built.atoms.length !== graph.atoms.length) return undefined;
      for (let i = 0; i < built.atoms.length; i += 1) {
        if (built.atoms[i]!.element !== graph.atoms[i]!.element) return undefined;
      }
      // The protonation has to have actually happened, or the "basic" value would describe the neutral
      // form under a basic label — the exact confusion this whole path exists to remove.
      const target = built.atoms[atomIndex];
      if (!target || target.charge !== graph.atoms[atomIndex]!.charge + 1) return undefined;
      if (target.hydrogens !== graph.atoms[atomIndex]!.hydrogens + 1) return undefined;
      return built;
    } catch {
      return undefined;
    } finally {
      protonated.delete();
    }
  };

  scan = scoreSiteTransitions(scan, graph, protonatedAt);

  // Chemistry the site table has no entry for, reported rather than silently absent — and read off the
  // SUBMITTED structure, because canonicalization has already neutralised it here. A method-scope
  // limitation is declared once in `knownUnsupportedChemistry`; this is the per-molecule case where the
  // unsupported state is the one the user actually put in front of the method.
  const unsupportedBasicity = submitted ? unsupportedBasicityIn(submitted.mol) : [];
  if (unsupportedBasicity.length > 0) {
    scan = {
      ...scan,
      unassessed: [
        ...scan.unassessed,
        {
          atomIndices: unsupportedBasicity,
          feature: "protonated carbonyl or thiocarbonyl",
          reason:
            "A protonated carbonyl or thiocarbonyl, as drawn. No tabulated site type covers the " +
            "basicity of a C=O or a C=S, so this method cannot value that rung and reports it rather " +
            "than omitting it. Such states titrate near pKa -5 to 0. The structure was scored as its " +
            "neutral form, whose own sites are reported above."
        }
      ]
    };
  }

  // Then a second, independent opinion wherever the Hammett relationship reaches, and let the two
  // methods' disagreement set the confidence. It reaches few sites and says so on the rest; where it
  // does reach, the pair is measurably better than either alone.
  const fromHammett = scoreSitesWithHammett(scan, graph);
  if (fromHammett.length > 0) {
    scan = {
      sites: combineSiteEstimates({ model: scan.sites, hammett: fromHammett }),
      unassessed: scan.unassessed
    };
  }

  // Macroscopic pKa: what a titration measures, folded from the microscopic ladder. Needs a molecule
  // per microstate, built the same way the basic-pKa path builds its one.
  const graphForDeltas = (deltas: ReadonlyMap<number, number>): PkaMolecularGraph | undefined => {
    if (deltas.size === 0) return graph;
    const source = copy ? copy.call(module, context.mol) : undefined;
    if (!source) return undefined;
    let molblock: string | undefined;
    try {
      molblock = (source as unknown as { get_molblock?(): string }).get_molblock?.();
    } finally {
      source.delete();
    }
    if (!molblock) return undefined;
    const edited = molblockWithCharges(molblock, deltas);
    if (!edited) return undefined;
    const built = module.get_mol(edited) as AnalysisMol | null;
    if (!built) return undefined;
    try {
      const builtJson = JSON.parse(built.get_json()) as typeof json;
      const out = modelGraph(
        { ...context, descriptors: JSON.parse(built.get_descriptors()) as Record<string, number> },
        builtJson,
        builtJson.defaults?.atom?.z ?? 6
      );
      if (out.atoms.length !== graph.atoms.length) return undefined;
      for (let i = 0; i < out.atoms.length; i += 1) {
        if (out.atoms[i]!.element !== graph.atoms[i]!.element) return undefined;
      }
      return out;
    } catch {
      return undefined;
    } finally {
      built.delete();
    }
  };
  const macroscopic = macroscopicFromSites(scan.sites, graph, graphForDeltas);

  // Coordinates for drawing the sites on the structure. On a COPY for the same reason the hydrogen
  // pass uses one: `set_new_coords` mutates, and handing every later method a molecule that suddenly
  // has a conformer is the kind of change that shows up somewhere unrelated.
  let depiction: ReturnType<typeof depictionFor>;
  const forDepiction = copy ? copy.call(module, context.mol) : undefined;
  if (forDepiction) {
    try {
      depiction = depictionFor(forDepiction as unknown as Parameters<typeof depictionFor>[0], graph);
    } finally {
      forDepiction.delete();
    }
  }

  // Nothing ionizable is the method not applying, not failing — the same shape as a neutral loss a
  // composition cannot supply. It must not drag the run's status down.
  if (scan.sites.length === 0 && scan.unassessed.length === 0) {
    // "No tabulated ionizable site matched this structure" describes THE STRUCTURE THAT WAS SCORED, and
    // when an interpretation has fired that is not the structure the user drew. Measured: an enol reaches
    // this branch because the canonical tautomer rewrote it to its keto form, which genuinely has no O-H —
    // `Vinyl_alcohol` and `Alcohol` both match the drawn enol at the right atom. So the message was true
    // of a molecule the user never submitted and read as "there is nothing ionizable here", which is the
    // silent-omission failure this method spends most of its conventions trying to avoid.
    //
    // The substitution IS disclosed in a separate interpretation warning, but two warnings do not connect
    // themselves; the one a reader meets first has to carry the whole story.
    // "No ionizable site" IS NOT WHAT THIS BRANCH KNOWS. It knows that no site type in a 47-entry table
    // matched, which is a statement about the method's vocabulary, not about the molecule. The two read
    // identically to a user and only one of them is true, so the wording says which.
    const derived = context.interpretation.id !== SOURCE_INTERPRETATION_ID;
    const reason = derived
      ? `No SUPPORTED ionization event was identified in this structure as scored, which is the ` +
        `${describeInterpretation(context.interpretation)} rather than the drawing as submitted. ` +
        `This is not evidence that the molecule has no ionizable site: a tautomer or protomer that was ` +
        `rewritten away may carry one — an enol scored as its keto form is the common case — and the ` +
        `site table does not cover every ionizable group.`
      : "No SUPPORTED ionization event was identified in this structure. That means no tabulated site " +
        "type matched, which is a limit of this method's site vocabulary rather than a finding about " +
        "the molecule; absence of a site here is not evidence that there is none.";
    return {
      ...base,
      kind: "ionization",
      status: "not-applicable",
      sites: [],
      unassessed: [],
      // The depiction was computed above and used to be dropped here, so a structure with no sites
      // reported no atoms either — which made an interpretation substitution impossible to see from the
      // result, and made a site-detection audit unable to tell a missing site from a missing molecule.
      ...(depiction ? { depiction } : {}),
      applicability: { status: "out-of-domain", reasons: [reason], unsupportedFeatures: [] },
      warnings: [warning("ionization.no_sites", reason, "info", [base.id])]
    };
  }

  const notes = scan.unassessed.map((entry) =>
    warning("ionization.unassessed_site", entry.reason, "warning", [base.id])
  );

  return {
    ...base,
    kind: "ionization",
    // `partial` when something was recognised but could not be scored: the reader is looking at an
    // incomplete picture, and the status is where that belongs.
    status: scan.unassessed.length > 0 ? "partial" : "ok",
    sites: scan.sites,
    ...(depiction ? { depiction, confidenceBands: IONIZATION_CONFIDENCE_BANDS } : {}),
    ...(macroscopicApplies(macroscopic)
      ? { macroscopic: { pKa: macroscopic.pKa, inconsistency: macroscopic.inconsistency,
                         microstates: macroscopic.microstateCount,
                         ...(macroscopic.distribution ? { distribution: macroscopic.distribution } : {}),
                         zwitterionic: macroscopic.zwitterionic } }
      : { macroscopicDeclined: macroscopic.declined }),
    unassessed: scan.unassessed,
    applicability: {
      status: scan.unassessed.length > 0 ? "borderline" : "in-domain",
      reasons: scan.unassessed.map((entry) => entry.reason),
      // Each withheld site names its own reason. This used to be the literal `["metal-adjacent site"]`
      // whenever ANYTHING was withheld, so a fully dissociated sulfonic acid, an unactivated amine and
      // a protonless nitrogen were all reported as being next to a metal the molecule did not contain
      // — a fabricated provenance tag on an otherwise honest decline.
      unsupportedFeatures: [...new Set(scan.unassessed.map((entry) => entry.feature))]
    },
    warnings: notes
  };
}

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
    })
  );
}

/**
 * Attach the disclosure §1 requires to a result computed on a derived interpretation.
 *
 * An `info` warning rather than a `warning`: the derivation is not a problem, it is a fact the reader
 * must have. Naming the element that forced it keeps the two results legible as a pair.
 */
/** The disclosure that a pKa was computed on the canonical protomer rather than on the drawing. */
function withProtomerNotice(
  result: AnalysisResult,
  interpretation: MolecularInterpretation
): AnalysisResult {
  return {
    ...result,
    warnings: [
      ...result.warnings,
      warning(
        "interpretation.derived",
        `Computed on the ${describeInterpretation(interpretation)}. A pKa describes a molecular ` +
          "family rather than one drawing of it, so every protonation state of this structure is " +
          "assessed from the same reference form and returns the same values." +
          (interpretation.tautomerPolicy
            ? " The drawn tautomer was not the one scored either: an azole 1,3-H shift is faster than " +
              "any titration, so two such drawings are one substance and now give one answer."
            : ""),
        "info",
        [result.id]
      )
    ]
  };
}

function withDerivationNotice(
  result: AnalysisResult,
  interpretation: MolecularInterpretation,
  forcedBy: string
): AnalysisResult {
  return {
    ...result,
    warnings: [
      ...result.warnings,
      warning(
        "interpretation.derived",
        `Computed on ${describeInterpretation(interpretation)}, because ${forcedBy}.`,
        "info",
        [result.id]
      )
    ]
  };
}

/**
 * Why the method had to leave the structure as drawn — the same reason the decline beside it gives.
 *
 * This used to be built from the unparameterised-element list alone, and the multi-component path
 * reached it with that list guaranteed EMPTY: the branch above only declines for components when
 * `outside.length === 0`. So every co-drawn organic pair produced "because the structure as drawn
 * contains , which this method has no parameters for" — a sentence with a hole in it, naming the
 * wrong reason, on the most ordinary input there is (`Oc1ccccc1.CC(=O)O`).
 */
function derivationReason(outside: readonly string[], componentCount: number): string {
  if (outside.length > 0) {
    return `the structure as drawn contains ${outside.join(", ")}, which this method has no parameters for`;
  }
  return (
    `the structure as drawn is ${componentCount} separate components, and this method describes ` +
    "one species"
  );
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

  if (id === "reference-protomer") {
    // Stacks on the fragment for the same reason neutralisation does: a drawn salt should reach its
    // canonical protomer in one step.
    const start =
      resolveDerivedContext("largest-organic-fragment", module, source, sourceJson, cache, descriptorDetails) ??
      source;
    const built = referenceProtomerMolblock(start.mol.get_v2Kmolblock(), (candidate) => {
      const trial = module.get_mol(candidate) as AnalysisMol | null;
      if (!trial) return false;
      trial.delete();
      return true;
    });
    if (!built) return undefined;
    const protomerMol = module.get_mol(built.molblock) as AnalysisMol | null;
    if (!protomerMol) return undefined;

    const canonical = contextFor(start.interpretation, protomerMol, descriptorDetails);
    const step = referenceProtomerTransformation({
      atomCount: start.composition.atomCount,
      formula: canonical.composition.formula,
      chargesRemoved: built.chargesRemoved,
      // Read back off the derived molecule, never predicted: RDKit decided the hydrogen count.
      hydrogenChanges: hydrogenCount(canonical.composition) - hydrogenCount(start.composition)
    });
    const context: DerivedContext = {
      ...canonical,
      interpretation: {
        ...deriveInterpretation({ id, base: start.interpretation, step }),
        protomerPolicy: REFERENCE_PROTOMER_POLICY
      }
    };
    cache.set(id, context);
    return context;
  }

  if (id === "reference-tautomer") {
    // Stacks on the reference PROTOMER, in that order deliberately. Canonicalising the tautomer of a
    // charged species is territory MolStandardize was not built for and the answer would depend on which
    // ion was drawn; stripping the charges first means the tautomer choice is made on one neutral form.
    //
    // EVERY tautomer, and that took two attempts. The first restricted this to hydrogens moving between
    // NITROGENS, because canonicalising keto/enol deleted acetylacetone's only answer: RDKit's canonical
    // form is the diketone, whose acidic proton is on CARBON, and the site table covered O, N and S. Once
    // activated carbon acids were added — see `isActivatedCarbonAcid` — the diketone has an answer of its
    // own, and the restriction became unnecessary.
    //
    // Removing it is a correctness gain rather than a convenience. The method now answers about the
    // DOMINANT tautomer instead of whichever was drawn: acetylacetone reads 9.13 either way against a
    // measured 8.9, dimedone 5.18 against 5.23, 2-hydroxypyridine and 2-pyridone both 6.36/11.51. And
    // cyclohexanone reports NOTHING from either drawing, which is correct — its alpha C-H is near 26 and
    // its enol is about a millionth of the population, so the O-H answer the enol drawing used to give
    // described a species that is barely in the flask. Phenol, formally an enol, keeps its 9.94 because
    // its aromatic form is the stable tautomer and canonicalisation leaves it alone.
    const start =
      resolveDerivedContext("reference-protomer", module, source, sourceJson, cache, descriptorDetails) ??
      source;
    if (typeof start.mol.get_canonical_tautomer_molblock !== "function") return undefined;
    let molblock: string;
    try {
      molblock = start.mol.get_canonical_tautomer_molblock();
    } catch {
      return undefined;
    }
    if (!molblock) return undefined;
    const tautomerMol = module.get_mol(molblock) as AnalysisMol | null;
    if (!tautomerMol) return undefined;
    // Nothing moved: report no derivation rather than an identity step the ledger would have to explain.
    if (tautomerMol.get_smiles?.() === start.mol.get_smiles?.()) {
      tautomerMol.delete();
      return undefined;
    }

    const canonical = contextFor(start.interpretation, tautomerMol, descriptorDetails);
    const step = referenceTautomerTransformation({
      atomCount: start.composition.atomCount,
      formula: canonical.composition.formula,
      hydrogenChanges: hydrogenCount(canonical.composition) - hydrogenCount(start.composition)
    });
    const context: DerivedContext = {
      ...canonical,
      interpretation: {
        ...deriveInterpretation({ id, base: start.interpretation, step }),
        tautomerPolicy: REFERENCE_TAUTOMER_POLICY
      }
    };
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
        return unsupportedIdentifier(
          context,
          "inchi",
          "The InChI standard has no representation for this structure, so no identifier was " +
            "generated. Dummy atoms and attachment points are the usual reason: InChI describes a " +
            "definite set of elements, and an R-group is not one.",
          context.composition.presentElements.includes("*") ? ["dummy atom"] : []
        );
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
        return unsupportedIdentifier(
          context,
          "inchikey",
          "No InChI was generated for this structure, so there is nothing to hash into a key.",
          context.composition.presentElements.includes("*") ? ["dummy atom"] : []
        );
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

