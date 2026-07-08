import type {
  NmrAtomReference,
  NmrNucleus,
  NmrPredictionRequest,
  NmrPredictionResult,
  NmrPredictor,
  NmrPredictorCapabilities,
  NmrResonance
} from "../../domain/contracts";
import { NmrError, NmrErrorCodes } from "../../domain/errors";
import { fingerprintStructureInput } from "../../domain/fingerprint";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../../domain/warnings";
import { normalizeStructure } from "../../application/normalizeStructure";
import {
  collectCarbonEnvironments,
  collectProtonEnvironments,
  type AtomEnvironment,
  type ProtonEnvironment
} from "./fixtureEnvironment";
import { FIXTURE_DATABASE, FIXTURE_DATA_VERSION, type FixtureShift } from "./fixtureDatabase";

const SMALL_POPULATION_THRESHOLD = 3;
const ENVIRONMENT_SPHERES = 2;

export interface FixtureHosePredictorOptions {
  /** Injectable clock for deterministic `generatedAt` in tests. Defaults to `Date.now`. */
  now?: () => string;
  version?: string;
}

/**
 * The deterministic Phase 1 provider. It normalizes the structure, derives a fixture environment code
 * per atom, looks each up in {@link FIXTURE_DATABASE}, groups equal environments into one resonance
 * (equivalent nuclei), and records `NMR_NO_FRAGMENT_MATCH` for anything it cannot cover — yielding
 * complete, partial, or empty results without ever throwing on unknown chemistry (only on
 * unparseable input). All synthetic; method label `fixture-fragment`.
 */
export class FixtureHosePredictor implements NmrPredictor {
  private readonly now: () => string;
  private readonly version: string;

  constructor(options: FixtureHosePredictorOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.version = options.version ?? "1.0.0";
  }

  getCapabilities(): NmrPredictorCapabilities {
    return {
      id: "chemdraft.fixture-hose",
      version: this.version,
      execution: "worker-js",
      nuclei: ["1H", "13C"],
      supportsAtomAssignments: true,
      supportsUncertainty: true,
      supportsCouplings: false,
      supportsSolvent: false,
      supportsConformers: false,
      supportsStereochemistry: false
    };
  }

  async predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    throwIfAborted(signal);
    const { molecule, normalized } = normalizeStructure(request.structure);

    const warnings: NmrPredictionWarning[] = [...normalized.warnings];
    const resonances: NmrResonance[] = [];
    let unmatchedAtoms = 0;

    for (const nucleus of dedupeNuclei(request.nuclei)) {
      throwIfAborted(signal);
      if (nucleus === "13C") {
        unmatchedAtoms += this.predictCarbon(molecule, resonances, warnings);
      } else {
        unmatchedAtoms += this.predictProton(molecule, request, resonances, warnings);
      }
    }

    if (unmatchedAtoms > 0 && resonances.length > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.PartialPrediction,
          `${unmatchedAtoms} atom environment(s) had no fixture match; the prediction is partial.`,
          { severity: "warning" }
        )
      );
    }

    const sourceFingerprint = request.sourceFingerprint ?? fingerprintStructureInput(request.structure);

    return {
      schemaVersion: "1",
      sourceFingerprint,
      backend: {
        id: "chemdraft.fixture-hose",
        version: this.version,
        dataVersion: FIXTURE_DATA_VERSION,
        method: "fixture-fragment"
      },
      resonances,
      warnings,
      generatedAt: this.now()
    };
  }

  private predictCarbon(
    molecule: Parameters<typeof collectCarbonEnvironments>[0],
    resonances: NmrResonance[],
    warnings: NmrPredictionWarning[]
  ): number {
    const groups = groupBy(collectCarbonEnvironments(molecule, ENVIRONMENT_SPHERES), (env) => env.environmentCode);
    let unmatched = 0;
    for (const [environmentCode, members] of groups) {
      const shift = FIXTURE_DATABASE.get(environmentCode)?.carbon13;
      if (shift === undefined) {
        unmatched += members.length;
        warnings.push(noFragmentMatchWarning("13C", environmentCode, members));
        continue;
      }
      // One ¹³C nucleus per carbon; sum of equivalentCount == equivalentNuclei (members.length).
      const atomRefs: NmrAtomReference[] = members.map((member) => ({
        sourceAtomIndex: member.atomIndex,
        element: member.element,
        equivalentCount: 1
      }));
      resonances.push(buildResonance("13C", environmentCode, shift, members, atomRefs, members.length, warnings));
    }
    return unmatched;
  }

  private predictProton(
    molecule: Parameters<typeof collectProtonEnvironments>[0],
    request: NmrPredictionRequest,
    resonances: NmrResonance[],
    warnings: NmrPredictionWarning[]
  ): number {
    const all = collectProtonEnvironments(molecule, ENVIRONMENT_SPHERES);
    const usable: ProtonEnvironment[] = [];
    let omittedLabile = 0;
    for (const proton of all) {
      if (proton.labile && request.options.ignoreLabileHydrogens) {
        omittedLabile += proton.protonCount;
        continue;
      }
      usable.push(proton);
    }
    if (omittedLabile > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.LabileProtonOmitted,
          `${omittedLabile} exchangeable (labile) proton(s) were omitted; enable them only with defensible data.`,
          { severity: "info" }
        )
      );
    }

    const groups = groupBy(usable, (env) => env.environmentCode);
    let unmatched = 0;
    for (const [environmentCode, members] of groups) {
      const shift = FIXTURE_DATABASE.get(environmentCode)?.proton1H;
      const protonCount = members.reduce((sum, member) => sum + member.protonCount, 0);
      if (shift === undefined) {
        unmatched += protonCount;
        warnings.push(noFragmentMatchWarning("1H", environmentCode, members));
        continue;
      }
      // ¹H refs describe the protons (element "H"); each host contributes its own proton count, so
      // the per-ref equivalentCount sums to equivalentNuclei (total protons).
      const atomRefs: NmrAtomReference[] = members.map((member) => ({
        sourceAtomIndex: member.atomIndex,
        element: "H",
        equivalentCount: member.protonCount
      }));
      resonances.push(buildResonance("1H", environmentCode, shift, members, atomRefs, protonCount, warnings));
    }
    return unmatched;
  }
}

function buildResonance(
  nucleus: NmrNucleus,
  environmentCode: string,
  shift: FixtureShift,
  members: readonly AtomEnvironment[],
  atomRefs: readonly NmrAtomReference[],
  equivalentNuclei: number,
  warnings: NmrPredictionWarning[]
): NmrResonance {
  if (shift.sampleCount < SMALL_POPULATION_THRESHOLD) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.SmallReferencePopulation,
        `Fixture reference population for ${nucleus} ${shift.shiftPpm} ppm is ${shift.sampleCount}.`,
        { severity: "info", atomIndices: members.map((member) => member.atomIndex) }
      )
    );
  }

  const firstAtomIndex = Math.min(...members.map((member) => member.atomIndex));
  return {
    id: `${nucleus === "13C" ? "c" : "h"}-${firstAtomIndex}`,
    nucleus,
    deltaPpm: shift.shiftPpm,
    atomRefs,
    equivalentNuclei,
    uncertainty: { standardDeviationPpm: shift.standardDeviationPpm },
    evidence: {
      method: "fixture-fragment",
      matchedSphere: ENVIRONMENT_SPHERES,
      sampleCount: shift.sampleCount,
      environmentCode
    },
    flags: []
  };
}

function noFragmentMatchWarning(
  nucleus: NmrNucleus,
  environmentCode: string,
  members: readonly AtomEnvironment[]
): NmrPredictionWarning {
  return nmrWarning(
    NmrWarningCodes.NoFragmentMatch,
    `No ${nucleus} fixture fragment matched environment ${environmentCode}.`,
    { severity: "warning", atomIndices: members.map((member) => member.atomIndex), details: { nucleus, environmentCode } }
  );
}

function dedupeNuclei(nuclei: readonly NmrNucleus[]): NmrNucleus[] {
  const seen = new Set<NmrNucleus>();
  const ordered: NmrNucleus[] = [];
  for (const nucleus of nuclei) {
    if (!seen.has(nucleus)) {
      seen.add(nucleus);
      ordered.push(nucleus);
    }
  }
  return ordered;
}

/** Group items by a key, preserving first-seen key order for deterministic output. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = groups.get(k);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(k, [item]);
    }
  }
  return groups;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    // Cancellation is not a provider failure — callers (M8) drop it silently rather than surfacing it.
    throw new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled.");
  }
}
