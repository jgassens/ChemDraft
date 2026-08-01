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
export const PINNED_ISOSPEC_WASM_SHA256 = "6cff998904cd567eba2e010d6d0fd384e346e21689c66dbef583997a13c37b66";

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
