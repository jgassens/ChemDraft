/**
 * The isotope-envelope engine (PLANS.md §8, Release 2).
 *
 * IsoSpec exists here because neither the vendored RDKit MinimalLib nor OpenChemLib 9.22.1 exposes
 * per-isotope abundances — checked directly, not assumed (see `docs/architecture/dependency-inventory.md`).
 * Without an abundance table there is no envelope, only the first-order M/M+1/M+2 approximation the
 * mass-fragment demo still ships.
 *
 * This module is the engine boundary only: it loads the artifact and types its surface. Method
 * contracts, classification, and the `DistributionResult` mapping belong with the analysis wiring, not
 * here, for the same reason the RDKit adapter keeps them out of its loader.
 */

/** The IsoSpec release these bindings were built from. */
export const PINNED_ISOSPEC_VERSION = "2.3.5";

/**
 * The commit the artifact was built from. Pinned by SHA rather than by version string because
 * IsoSpec's in-tree `CMakeLists.txt` still reads `VERSION 2.3.4` at the `v2.3.5` tag — the two
 * disagree, so neither string alone identifies the source.
 */
export const PINNED_ISOSPEC_COMMIT = "e6b1ef7cc146632cdaaf887dcff8c73949167835";

/**
 * SHA-256 of `vendor/IsoSpec.wasm`. Travels in the engine environment of any run that uses it, so a
 * rebuilt artifact changes the run fingerprint. `isospec.real.test.ts` checks it against the bytes on
 * disk and against `vendor/BUILD.md`, so prose, constant, and artifact cannot drift apart.
 */
export const PINNED_ISOSPEC_WASM_SHA256 = "2199faaddd03df4c6d9bca79a2b1ec673608e90b8ba58940bf67d9e6b79a954a";

/** Number of isotopic entries compiled into the artifact. Asserted against the loaded binary. */
export const ISOSPEC_ISOTOPIC_ENTRY_COUNT = 292;

/**
 * IsoSpec requires an explicit count on **every** element: `H2O1`, never `H2O`. A formula with a
 * trailing implicit 1 is rejected outright rather than mis-parsed, which is the safe failure — but it
 * means RDKit's Hill formula (`C10H11N3O3S`) cannot be passed through unchanged.
 */
export function explicitFormulaCounts(hillFormula: string): string {
  return hillFormula.replace(/([A-Z][a-z]?)(\d*)/g, (match, element: string, count: string) =>
    match === "" ? "" : `${element}${count === "" ? "1" : count}`
  );
}

/** One truncation policy IsoSpec offers, named as `DistributionResult.truncation.policy` names it. */
export type IsoSpecTruncationPolicy =
  | "relative-intensity-threshold"
  | "absolute-probability-threshold"
  | "cumulative-probability";

export interface IsoSpecEnvelope {
  ok: true;
  policy: IsoSpecTruncationPolicy;
  threshold: number;
  peakCount: number;
  /** Probability the retained peaks account for — `DistributionResult.truncation.coveredProbability`. */
  coveredProbability: number;
  masses: number[];
  probabilities: number[];
}

export interface IsoSpecFailure {
  ok: false;
  error: string;
}

export interface IsoSpecIsotope {
  element: string;
  atomicNumber: number;
  massNumber: number;
  mass: number;
  abundance: number;
}

/** The raw Embind surface of `vendor/IsoSpec.js`. Every call returns JSON. */
export interface IsoSpecModule {
  version(): string;
  envelope_from_threshold(formula: string, threshold: number, absolute: boolean): string;
  /**
   * The same policy over isotopes supplied directly, for compositions the formula parser cannot spell.
   * `masses` and `probabilities` are flattened: one run of `sum(isotopeCounts)` entries in dimension
   * order. The wrapper validates the lengths, because IsoSpec itself would read past the end.
   */
  envelope_from_threshold_isotopes(
    isotopeCounts: number[],
    atomCounts: number[],
    masses: number[],
    probabilities: number[],
    threshold: number,
    absolute: boolean
  ): string;
  envelope_from_total_prob(formula: string, targetProb: number, optimize: boolean): string;
  isotope_table(): string;
}

export type IsoSpecModuleLoader = () => Promise<IsoSpecModule>;

let loader: IsoSpecModuleLoader | null = null;
let pending: Promise<IsoSpecModule> | null = null;

/** Injected by the host (Vite loader in the app, `./testing` under Node). */
export function setIsoSpecModuleLoader(next: IsoSpecModuleLoader | null): void {
  loader = next;
  pending = null;
}

export function resetIsoSpecForTesting(): void {
  loader = null;
  pending = null;
}

export function ensureIsoSpec(): Promise<IsoSpecModule> {
  if (!loader) {
    return Promise.reject(new Error("No IsoSpec module loader installed — call setIsoSpecModuleLoader first."));
  }
  pending ??= loader();
  return pending;
}

function parseEnvelope(json: string): IsoSpecEnvelope | IsoSpecFailure {
  return JSON.parse(json) as IsoSpecEnvelope | IsoSpecFailure;
}

/** Keep peaks at or above `threshold` × the most intense peak. */
export function envelopeFromThreshold(
  module: IsoSpecModule,
  formula: string,
  threshold: number,
  absolute = false
): IsoSpecEnvelope | IsoSpecFailure {
  return parseEnvelope(module.envelope_from_threshold(formula, threshold, absolute));
}

/** One element of the molecule, or one isotope-labelled position, as a dimension of the convolution. */
export interface IsoSpecDimension {
  /** How many atoms of this kind the molecule has. */
  atomCount: number;
  /**
   * The isotopes those atoms may be. The natural-abundance set for an ordinary element; a single
   * entry at abundance 1 for an atom the drawing labelled, which is what makes `[13C]` expressible.
   */
  isotopes: readonly { mass: number; abundance: number }[];
}

/**
 * The threshold policy over explicitly supplied isotopes rather than a formula.
 *
 * The flattening happens here so no caller has to know the layout, and the engine's own length checks
 * stay the backstop rather than the only guard.
 */
export function envelopeFromThresholdIsotopes(
  module: IsoSpecModule,
  dimensions: readonly IsoSpecDimension[],
  threshold: number,
  absolute = false
): IsoSpecEnvelope | IsoSpecFailure {
  const isotopeCounts: number[] = [];
  const atomCounts: number[] = [];
  const masses: number[] = [];
  const probabilities: number[] = [];

  for (const dimension of dimensions) {
    isotopeCounts.push(dimension.isotopes.length);
    atomCounts.push(dimension.atomCount);
    for (const isotope of dimension.isotopes) {
      masses.push(isotope.mass);
      probabilities.push(isotope.abundance);
    }
  }

  return parseEnvelope(
    module.envelope_from_threshold_isotopes(isotopeCounts, atomCounts, masses, probabilities, threshold, absolute)
  );
}

/** Smallest peak set covering `targetProb` of the distribution. */
export function envelopeFromTotalProb(
  module: IsoSpecModule,
  formula: string,
  targetProb: number,
  optimize = true
): IsoSpecEnvelope | IsoSpecFailure {
  return parseEnvelope(module.envelope_from_total_prob(formula, targetProb, optimize));
}

/**
 * The abundance set compiled into the artifact.
 *
 * Read from the binary rather than from a table duplicated in TypeScript: the intensities depend
 * entirely on these numbers, and IsoSpec's own repository records no provenance for them, so the one
 * defensible statement is "these are the values the shipped engine used".
 */
export function isotopeTable(module: IsoSpecModule): IsoSpecIsotope[] {
  return (JSON.parse(module.isotope_table()) as { entries: IsoSpecIsotope[] }).entries;
}

/** Parsed tables, per module. 292 entries is a small parse, but the envelope path hits it per run. */
const tableCache = new WeakMap<IsoSpecModule, IsoSpecIsotope[]>();

function cachedTable(module: IsoSpecModule): IsoSpecIsotope[] {
  let entries = tableCache.get(module);
  if (!entries) {
    entries = isotopeTable(module);
    tableCache.set(module, entries);
  }
  return entries;
}

/**
 * The electron mass **this binary** carries, in daltons.
 *
 * IsoSpec's tables include explicit `electron` and `missing electron` entries alongside the 292
 * isotopic ones. Reading the constant from there rather than writing `0.000548579909065` into the
 * source keeps the same rule the masses follow: the number in a result came from the shipped engine,
 * and a rebuilt artifact that revised it would move the result rather than silently disagree with a
 * constant frozen in TypeScript.
 *
 * It also agrees with RDKit's, which is a genuine cross-engine check rather than a tautology — the
 * mass module derives the same quantity as hydrogen minus the proton, and the two tables were compiled
 * independently.
 */
export function electronMass(module: IsoSpecModule): number {
  const electron = cachedTable(module).find((entry) => entry.element === "electron");
  if (!electron) {
    throw new Error("IsoSpec's isotope table carries no `electron` entry — cannot do charge bookkeeping.");
  }
  return electron.mass;
}

/**
 * One element's natural-abundance isotopes, in the shipped table's own order.
 *
 * `undefined` when the element is not one IsoSpec covers — a decline the caller renders, not an error.
 * This is the same coverage the formula parser has, reached by symbol instead of by name.
 */
export function isotopesOf(
  module: IsoSpecModule,
  symbol: string
): { mass: number; abundance: number }[] | undefined {
  const name = ELEMENT_NAMES_BY_SYMBOL[symbol];
  if (!name) return undefined;
  const entries = cachedTable(module)
    .filter((entry) => entry.element === name)
    .map((entry) => ({ mass: entry.mass, abundance: entry.abundance }));
  return entries.length > 0 ? entries : undefined;
}

/** One specific isotope's mass, for an atom the drawing labelled. `undefined` if the table lacks it. */
export function isotopeMass(module: IsoSpecModule, symbol: string, massNumber: number): number | undefined {
  const name = ELEMENT_NAMES_BY_SYMBOL[symbol];
  if (!name) return undefined;
  return cachedTable(module).find((entry) => entry.element === name && entry.massNumber === massNumber)?.mass;
}

/**
 * Every element IsoSpec's table covers, keyed by the symbol RDKit writes.
 *
 * The table names elements in full (`"carbon"`), so reaching it from a periodic-table symbol needs
 * this mapping. It exists purely to address that table, which is why it lives beside it — and a test
 * asserts every name here resolves against the shipped binary, so the two cannot drift.
 */
export const ELEMENT_NAMES_BY_SYMBOL: Readonly<Record<string, string>> = {
  H: "hydrogen", He: "helium", Li: "lithium", Be: "beryllium", B: "boron", C: "carbon",
  N: "nitrogen", O: "oxygen", F: "fluorine", Ne: "neon", Na: "sodium", Mg: "magnesium",
  Al: "aluminium", Si: "silicon", P: "phosphorus", S: "sulfur", Cl: "chlorine", Ar: "argon",
  K: "potassium", Ca: "calcium", Sc: "scandium", Ti: "titanium", V: "vanadium", Cr: "chromium",
  Mn: "manganese", Fe: "iron", Co: "cobalt", Ni: "nickel", Cu: "copper", Zn: "zinc",
  Ga: "gallium", Ge: "germanium", As: "arsenic", Se: "selenium", Br: "bromine", Kr: "krypton",
  Rb: "rubidium", Sr: "strontium", Y: "yttrium", Zr: "zirconium", Nb: "niobium", Mo: "molybdenum",
  Ru: "ruthenium", Rh: "rhodium", Pd: "palladium", Ag: "silver", Cd: "cadmium", In: "indium",
  Sn: "tin", Sb: "antimony", Te: "tellurium", I: "iodine", Xe: "xenon", Cs: "caesium",
  Ba: "barium", La: "lanthanum", Ce: "cerium", Pr: "praseodymium", Nd: "neodymium", Sm: "samarium",
  Eu: "europium", Gd: "gadolinium", Tb: "terbium", Dy: "dysprosium", Ho: "holmium", Er: "erbium",
  Tm: "thulium", Yb: "ytterbium", Lu: "lutetium", Hf: "hafnium", Ta: "tantalum", W: "tungsten",
  Re: "rhenium", Os: "osmium", Ir: "iridium", Pt: "platinum", Au: "gold", Hg: "mercury",
  Tl: "thallium", Pb: "lead", Bi: "bismuth", U: "uranium", Th: "thorium", Pa: "protactinium"
};


/**
 * §5 transport: envelopes cross the worker boundary as typed arrays, not arrays of objects.
 * Structured-clone-safe and compact — an insulin envelope is ~1300 peaks.
 */
export function envelopeToTypedArrays(envelope: IsoSpecEnvelope): {
  positions: Float64Array;
  intensities: Float64Array;
} {
  return {
    positions: Float64Array.from(envelope.masses),
    intensities: Float64Array.from(envelope.probabilities)
  };
}
