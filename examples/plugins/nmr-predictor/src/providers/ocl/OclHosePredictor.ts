import * as OCL from "openchemlib";

import type {
  NmrEstimateProvenance,
  NmrMultiplet,
  NmrNucleus,
  NmrPredictionOptions,
  NmrPredictionRequest,
  NmrPredictionResult,
  NmrPredictor,
  NmrPredictorCapabilities,
  NmrResonance
} from "../../domain/contracts";
import { PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM } from "../../domain/contracts";
import { NmrError, NmrErrorCodes } from "../../domain/errors";
import { fingerprintStructureInput } from "../../domain/fingerprint";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../../domain/warnings";
import { normalizeStructure } from "../../application/normalizeStructure";
import { computeMultiplet } from "./coupling";
import { atomEnvironmentCodes, environmentKey, MAX_SPHERES } from "./environmentCode";
import { estimateCarbonShiftWithApplicability } from "./functionalGroupFallback";
import { estimateProtonIncrement } from "./incrementEstimator";
import type { CompiledNmrDatabase, NmrDatabaseEntry, NmrDatabaseProvenance } from "./localDatabase";
import { buildStructureDepiction } from "./structureDepiction";
import bundledDatabase from "./nmrshiftdb2.database.json";

const SMALL_POPULATION_THRESHOLD = 3;
const LABILE_HYDROGEN_HOSTS = new Set([7, 8, 16]);

export interface OclHosePredictorOptions {
  database?: CompiledNmrDatabase;
  now?: () => string;
}

interface Match {
  code: string;
  entry: NmrDatabaseEntry;
}

interface PredictionCounts {
  estimated: number;
  omitted: number;
}

type Statistic = NmrPredictionOptions["statistic"];

/**
 * Experimentally-grounded predictor: derive local OCL environments, search the bundled HOSE database
 * deepest-first, and disclose thin matches. A rule estimate is emitted only when its estimator says
 * the chemistry is applicable; otherwise the unsupported unmatched environment is omitted with a
 * stable warning. All output remains serializable worker/store data.
 */
export class OclHosePredictor implements NmrPredictor {
  private readonly database: CompiledNmrDatabase;
  private readonly now: () => string;

  constructor(options: OclHosePredictorOptions = {}) {
    this.database = options.database ?? (bundledDatabase as unknown as CompiledNmrDatabase);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get provenance(): NmrDatabaseProvenance {
    return this.database.provenance;
  }

  getCapabilities(): NmrPredictorCapabilities {
    return {
      id: "chemdraft.ocl-hose",
      version: this.database.provenance.version,
      execution: "worker-js",
      nuclei: this.database.provenance.nuclei,
      supportsAtomAssignments: true,
      supportsUncertainty: true,
      supportsCouplings: true,
      supportsSolvent: false,
      supportsConformers: false,
      supportsStereochemistry: false
    };
  }

  async predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    throwIfAborted(signal);
    const { molecule, normalized } = normalizeStructure(request.structure);
    const maxSpheres = Math.max(
      1,
      ...(request.options.hoseLevels.length ? request.options.hoseLevels : [MAX_SPHERES])
    );

    // Normalization warnings describe chemistry the parser preserved but the predictor cannot fully
    // model. They must survive into the final result rather than being discarded at this boundary.
    const warnings: NmrPredictionWarning[] = [...normalized.warnings];
    const resonances: NmrResonance[] = [];
    const totals: PredictionCounts = { estimated: 0, omitted: 0 };

    for (const nucleus of dedupeNuclei(request.nuclei)) {
      throwIfAborted(signal);
      const counts =
        nucleus === "13C"
          ? predictCarbon(this.database, molecule, request.options.statistic, maxSpheres, resonances, warnings)
          : predictProton(this.database, molecule, request, maxSpheres, resonances, warnings);
      totals.estimated += counts.estimated;
      totals.omitted += counts.omitted;
    }

    if (totals.estimated > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.RuleEstimated,
          `${totals.estimated} resonance(s) had no database match and are shown as disclosed rule estimates (low confidence).`,
          { severity: "warning" }
        )
      );
    }
    if (totals.omitted > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.PartialPrediction,
          `${totals.omitted} unmatched atom environment(s) were omitted because no applicable rule estimate exists.`,
          { severity: "warning", details: { omittedEnvironmentCount: totals.omitted } }
        )
      );
    }

    return {
      schemaVersion: "1",
      sourceFingerprint: request.sourceFingerprint || fingerprintStructureInput(request.structure),
      backend: {
        id: "chemdraft.ocl-hose",
        version: this.database.provenance.version,
        dataVersion: this.database.provenance.name,
        method: "hose-fragment",
        license: this.database.provenance.license,
        attribution: this.database.provenance.attribution,
        source: this.database.provenance.source
      },
      resonances,
      warnings,
      generatedAt: this.now(),
      depiction: buildStructureDepiction(molecule)
    };
  }
}

function match(database: CompiledNmrDatabase, nucleus: NmrNucleus, codes: readonly string[]): Match | undefined {
  for (const code of codes) {
    const entry = database.entries[environmentKey(nucleus, code)];
    if (entry) return { code, entry };
  }
  return undefined;
}

function predictCarbon(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  statistic: Statistic,
  maxSpheres: number,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): PredictionCounts {
  const matched = new Map<string, { match: Match; atoms: number[] }>();
  const unmatched = new Map<string, number[]>();

  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) !== 6) continue;
    const codes = atomEnvironmentCodes(molecule, atom, maxSpheres);
    const found = match(database, "13C", codes);
    if (!found) {
      pushGroup(unmatched, codes[codes.length - 1], atom);
      continue;
    }
    const group = matched.get(found.code) ?? { match: found, atoms: [] };
    group.atoms.push(atom);
    matched.set(found.code, group);
  }

  for (const group of matched.values()) {
    resonances.push(
      buildResonance(
        "13C",
        group.match,
        statistic,
        group.atoms,
        group.atoms.length,
        group.atoms.map(() => ({ element: "C", count: 1 })),
        warnings
      )
    );
  }

  const estimatedGroups = new Map<string, { code: string; ppm: number; estimator: NmrEstimateProvenance; atoms: number[] }>();
  let omitted = 0;
  for (const [code, atoms] of unmatched) {
    for (const atom of atoms) {
      const estimate = estimateCarbonShiftWithApplicability(molecule, atom);
      if (!estimate.applicable) {
        omitted += 1;
        warnOmitted(warnings, "13C", atom, code, estimate.reason);
        continue;
      }
      const key = estimateGroupKey(code, estimate.ppm, estimate.estimator);
      const group = estimatedGroups.get(key) ?? { code, ppm: estimate.ppm, estimator: estimate.estimator, atoms: [] };
      group.atoms.push(atom);
      estimatedGroups.set(key, group);
    }
  }
  for (const group of estimatedGroups.values()) {
    resonances.push(
      buildEstimatedResonance(
        "13C",
        group.atoms,
        group.atoms.length,
        group.atoms.map(() => ({ element: "C", count: 1 })),
        group.ppm,
        group.code,
        group.estimator
      )
    );
  }
  return { estimated: estimatedGroups.size, omitted };
}

function predictProton(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  request: NmrPredictionRequest,
  maxSpheres: number,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): PredictionCounts {
  const matched = new Map<string, { match: Match; atoms: number[]; protons: number[] }>();
  const unmatched = new Map<string, number[]>();
  let omittedLabile = 0;

  const potentiallyDiastereotopic = potentiallyDiastereotopicMethyleneAtoms(molecule);
  if (potentiallyDiastereotopic.length > 0) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.PotentiallyDiastereotopicHydrogens,
        `${potentiallyDiastereotopic.length} methylene site(s) in this stereogenic structure may contain chemically nonequivalent hydrogens; when predicted, this model reports one carbon-hosted shift per site and does not predict separate diastereotopic values.`,
        {
          severity: "info",
          atomIndices: potentiallyDiastereotopic,
          details: { methyleneSiteCount: potentiallyDiastereotopic.length }
        }
      )
    );
  }

  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const protonCount = molecule.getAllHydrogens(atom);
    if (protonCount === 0) continue;
    if (LABILE_HYDROGEN_HOSTS.has(molecule.getAtomicNo(atom)) && request.options.ignoreLabileHydrogens) {
      omittedLabile += protonCount;
      continue;
    }
    const codes = atomEnvironmentCodes(molecule, atom, maxSpheres);
    const found = match(database, "1H", codes);
    if (!found) {
      pushGroup(unmatched, codes[codes.length - 1], atom);
      continue;
    }
    const group = matched.get(found.code) ?? { match: found, atoms: [], protons: [] };
    group.atoms.push(atom);
    group.protons.push(protonCount);
    matched.set(found.code, group);
  }

  if (omittedLabile > 0) {
    warnings.push(
      nmrWarning(NmrWarningCodes.LabileProtonOmitted, `${omittedLabile} exchangeable (labile) proton(s) were omitted.`, {
        severity: "info"
      })
    );
  }

  for (const group of matched.values()) {
    // A shallow HOSE code can group atoms whose longer-range substituents (and therefore additive
    // estimates or coupling patterns) differ. Split on the derived per-atom data instead of borrowing
    // `group.atoms[0]` for every atom in the group.
    const subgroups = new Map<
      string,
      { atoms: number[]; protons: number[]; multiplet: NmrMultiplet; crossCheck?: NmrResonance["crossCheck"] }
    >();
    group.atoms.forEach((atom, index) => {
      const multiplet = computeMultiplet(molecule, atom);
      const crossCheck = protonCrossCheck(molecule, atom, group.match.entry, request.options.statistic);
      const key = JSON.stringify({
        protonCount: group.protons[index],
        multiplet: multipletGroupingSignature(multiplet),
        crossCheck
      });
      const subgroup = subgroups.get(key) ?? { atoms: [], protons: [], multiplet, crossCheck };
      subgroup.atoms.push(atom);
      subgroup.protons.push(group.protons[index]);
      subgroups.set(key, subgroup);
    });

    for (const subgroup of subgroups.values()) {
      resonances.push(
        buildResonance(
          "1H",
          group.match,
          request.options.statistic,
          subgroup.atoms,
          subgroup.protons.reduce((sum, count) => sum + count, 0),
          subgroup.protons.map((count) => ({ element: "H", count })),
          warnings,
          subgroup.multiplet,
          subgroup.crossCheck
        )
      );
    }
  }

  const estimatedGroups = new Map<
    string,
    {
      code: string;
      ppm: number;
      estimator: NmrEstimateProvenance;
      atoms: number[];
      protons: number[];
      multiplet: NmrMultiplet;
    }
  >();
  let omitted = 0;
  for (const [code, atoms] of unmatched) {
    for (const atom of atoms) {
      const estimate = estimateProtonIncrement(molecule, atom);
      if (!estimate.applicable) {
        omitted += 1;
        warnOmitted(warnings, "1H", atom, code, estimate.reason);
        continue;
      }
      const protonCount = molecule.getAllHydrogens(atom);
      const multiplet = computeMultiplet(molecule, atom);
      const key = JSON.stringify({
        estimate: estimateGroupKey(code, estimate.ppm, estimate.estimator),
        protonCount,
        multiplet: multipletGroupingSignature(multiplet)
      });
      const group = estimatedGroups.get(key) ?? {
        code,
        ppm: estimate.ppm,
        estimator: estimate.estimator,
        atoms: [],
        protons: [],
        multiplet
      };
      group.atoms.push(atom);
      group.protons.push(protonCount);
      estimatedGroups.set(key, group);
    }
  }
  for (const group of estimatedGroups.values()) {
    resonances.push(
      buildEstimatedResonance(
        "1H",
        group.atoms,
        group.protons.reduce((sum, count) => sum + count, 0),
        group.protons.map((count) => ({ element: "H", count })),
        group.ppm,
        group.code,
        group.estimator,
        group.multiplet
      )
    );
  }
  return { estimated: estimatedGroups.size, omitted };
}

/** Independent additive comparison. Applicability determines whether a value is available; the
 * selected HOSE mean/median remains primary and its quality only affects interpretation. */
const CROSS_CHECK_ABS_FLOOR_PPM = 0.4;
const CROSS_CHECK_SIGMA_MULTIPLE = 1.5;
function protonCrossCheck(
  molecule: OCL.Molecule,
  atom: number,
  entry: NmrDatabaseEntry,
  statistic: Statistic
): NmrResonance["crossCheck"] | undefined {
  const estimate = estimateProtonIncrement(molecule, atom);
  if (!estimate.applicable) return undefined;
  const reason = protonCrossCheckReason(entry);
  const referencePpm = shiftFor(entry, statistic);
  const threshold = Math.max(CROSS_CHECK_ABS_FLOOR_PPM, CROSS_CHECK_SIGMA_MULTIPLE * (entry.stdev ?? 0));
  return {
    incrementPpm: estimate.ppm,
    disagrees: Math.abs(referencePpm - estimate.ppm) > threshold,
    reason,
    estimator: estimate.estimator
  };
}

function protonCrossCheckReason(
  entry: NmrDatabaseEntry
): "routine-applicability" | "weak-applicability" | "high-dispersion" {
  if (entry.sphere <= 1 || entry.n < SMALL_POPULATION_THRESHOLD) return "weak-applicability";
  if ((entry.stdev ?? 0) >= PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM) return "high-dispersion";
  return "routine-applicability";
}

/** A CH₂ group in a constitutionally stereogenic molecule may contain a diastereotopic proton pair.
 * This is a disclosure detector only: it never splits the host or fabricates two shifts. */
function potentiallyDiastereotopicMethyleneAtoms(molecule: OCL.Molecule): number[] {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  let hasStereoCenter = false;
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.isAtomStereoCenter(atom)) {
      hasStereoCenter = true;
      break;
    }
  }
  if (!hasStereoCenter) return [];

  const methylenes: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 6 && molecule.getAllHydrogens(atom) === 2) {
      methylenes.push(atom);
    }
  }
  return methylenes;
}

function buildResonance(
  nucleus: NmrNucleus,
  match: Match,
  statistic: Statistic,
  atoms: readonly number[],
  equivalentNuclei: number,
  refs: readonly { element: string; count: number }[],
  warnings: NmrPredictionWarning[],
  multiplet?: NmrMultiplet,
  crossCheck?: NmrResonance["crossCheck"]
): NmrResonance {
  const { entry, code } = match;
  const deltaPpm = shiftFor(entry, statistic);
  if (entry.n < SMALL_POPULATION_THRESHOLD) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.SmallReferencePopulation,
        `Only ${entry.n} reference shift(s) for ${nucleus} ${deltaPpm} ppm.`,
        { severity: "info", atomIndices: [...atoms] }
      )
    );
  }
  if (entry.sphere <= 1) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.LowHoseSphereMatch,
        `${nucleus} ${deltaPpm} ppm matched only a 1-sphere environment; confidence is low.`,
        { severity: "info", atomIndices: [...atoms] }
      )
    );
  }

  return {
    id: `${nucleus === "13C" ? "c" : "h"}-${Math.min(...atoms)}`,
    nucleus,
    deltaPpm,
    atomRefs: atoms.map((atom, index) => ({
      sourceAtomIndex: atom,
      element: refs[index].element,
      equivalentCount: refs[index].count
    })),
    equivalentNuclei,
    uncertainty: { standardDeviationPpm: entry.stdev, minimumPpm: entry.min, maximumPpm: entry.max },
    evidence: { method: "hose-fragment", matchedSphere: entry.sphere, sampleCount: entry.n, environmentCode: code },
    ...(multiplet ? { multiplet } : {}),
    ...(crossCheck ? { crossCheck } : {}),
    flags: []
  };
}

function buildEstimatedResonance(
  nucleus: NmrNucleus,
  atoms: readonly number[],
  equivalentNuclei: number,
  refs: readonly { element: string; count: number }[],
  shift: number,
  code: string,
  estimator: NmrEstimateProvenance,
  multiplet?: NmrMultiplet
): NmrResonance {
  const resonance: NmrResonance = {
    id: `${nucleus === "13C" ? "c" : "h"}-est-${Math.min(...atoms)}`,
    nucleus,
    deltaPpm: round2(shift),
    atomRefs: atoms.map((atom, index) => ({
      sourceAtomIndex: atom,
      element: refs[index].element,
      equivalentCount: refs[index].count
    })),
    equivalentNuclei,
    evidence: { method: "rule-estimated", environmentCode: code, estimator },
    flags: ["rule-estimated"]
  };
  if (multiplet) resonance.multiplet = multiplet;
  return resonance;
}

function warnOmitted(
  warnings: NmrPredictionWarning[],
  nucleus: NmrNucleus,
  atom: number,
  code: string,
  reason: string
): void {
  warnings.push(
    nmrWarning(
      NmrWarningCodes.NoFragmentMatch,
      `No ${nucleus} database match or applicable rule estimate for atom ${atom}; the resonance was omitted (${reason}).`,
      {
        severity: "warning",
        atomIndices: [atom],
        details: { nucleus, environmentCode: code, estimateInapplicableReason: reason }
      }
    )
  );
}

function shiftFor(entry: NmrDatabaseEntry, statistic: Statistic): number {
  return statistic === "mean" ? entry.mean : entry.median;
}

function estimateGroupKey(code: string, ppm: number, estimator: NmrEstimateProvenance): string {
  return JSON.stringify({ code, ppm: round2(ppm), estimator });
}

/** Coupling partner indices identify representative atoms, not distinct spectral patterns. Exclude
 * them when grouping equivalent environments so symmetric atoms such as ethane's two carbons remain
 * one six-proton resonance while genuinely different J/kind/count patterns still split. */
function multipletGroupingSignature(multiplet: NmrMultiplet): unknown {
  return {
    label: multiplet.label,
    couplings: multiplet.couplings.map(({ jHz, partnerCount, kind }) => ({ jHz, partnerCount, kind }))
  };
}

function pushGroup(groups: Map<string, number[]>, key: string, atom: number): void {
  const existing = groups.get(key);
  if (existing) existing.push(atom);
  else groups.set(key, [atom]);
}

function dedupeNuclei(nuclei: readonly NmrNucleus[]): NmrNucleus[] {
  return [...new Set(nuclei)];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled.");
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
