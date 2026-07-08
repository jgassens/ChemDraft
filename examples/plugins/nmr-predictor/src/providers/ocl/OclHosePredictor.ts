import type * as OCL from "openchemlib";

import type {
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
import { atomEnvironmentCodes, environmentKey, MAX_SPHERES } from "./environmentCode";
import type { CompiledNmrDatabase, NmrDatabaseEntry, NmrDatabaseProvenance } from "./localDatabase";
import bundledDatabase from "./nmrshiftdb2.database.json";

const SMALL_POPULATION_THRESHOLD = 3;
const LABILE_HYDROGEN_HOSTS = new Set([7, 8, 16]); // N, O, S

export interface OclHosePredictorOptions {
  database?: CompiledNmrDatabase;
  now?: () => string;
}

interface Match {
  code: string;
  entry: NmrDatabaseEntry;
}

/**
 * Experimentally-grounded predictor: reuses ChemDraft's OpenChemLib to derive an atom's environment
 * code, then looks it up in a compiled HOSE-code → shift database (NMRShiftDB2 by default, ADR-0014),
 * falling back from the deepest sphere to the shallowest. It reports the aggregated median shift with
 * its dispersion and sample count, groups equivalent environments, and warns (never fabricates) when
 * coverage is thin. Method label `hose-fragment`. All I/O is serializable — worker/store safe.
 *
 * The ~800 KB database is a static import so the worker bundles it directly (workers can't
 * code-split). The desktop keeps it off the main thread by loading this class lazily on the in-thread
 * fallback path only (see the desktop's `registerBundledPlugins`).
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
      supportsCouplings: false,
      supportsSolvent: false,
      supportsConformers: false,
      supportsStereochemistry: false
    };
  }

  async predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    throwIfAborted(signal);
    const { molecule } = normalizeStructure(request.structure);
    // Honor the requested HOSE depth: the deepest level requested caps generation/search.
    const maxSpheres = Math.max(1, ...(request.options.hoseLevels.length ? request.options.hoseLevels : [MAX_SPHERES]));

    const warnings: NmrPredictionWarning[] = [];
    const resonances: NmrResonance[] = [];
    let unmatched = 0;

    for (const nucleus of dedupeNuclei(request.nuclei)) {
      throwIfAborted(signal);
      unmatched +=
        nucleus === "13C"
          ? predictCarbon(this.database, molecule, maxSpheres, resonances, warnings)
          : predictProton(this.database, molecule, request, maxSpheres, resonances, warnings);
    }

    if (unmatched > 0 && resonances.length > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.PartialPrediction,
          `${unmatched} atom environment(s) had no database match; the prediction is partial.`
        )
      );
    }

    return {
      schemaVersion: "1",
      sourceFingerprint: request.sourceFingerprint ?? fingerprintStructureInput(request.structure),
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
      generatedAt: this.now()
    };
  }
}

function match(database: CompiledNmrDatabase, nucleus: NmrNucleus, codes: readonly string[]): Match | undefined {
  for (const code of codes) {
    // codes are deepest-first, so the first hit is the most specific available sphere.
    const entry = database.entries[environmentKey(nucleus, code)];
    if (entry) {
      return { code, entry };
    }
  }
  return undefined;
}

function predictCarbon(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  maxSpheres: number,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): number {
  const matched = new Map<string, { match: Match; atoms: number[] }>();
  const unmatched = new Map<string, number[]>();

  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) !== 6) {
      continue;
    }
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
      buildResonance("13C", group.match, group.atoms, group.atoms.length, group.atoms.map(() => ({ element: "C", count: 1 })), warnings)
    );
  }
  let unmatchedCount = 0;
  for (const [code, atoms] of unmatched) {
    unmatchedCount += atoms.length;
    warnings.push(noMatchWarning("13C", code, atoms));
  }
  return unmatchedCount;
}

function predictProton(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  request: NmrPredictionRequest,
  maxSpheres: number,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): number {
  const matched = new Map<string, { match: Match; atoms: number[]; protons: number[] }>();
  const unmatched = new Map<string, number[]>();
  let omittedLabile = 0;

  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const protonCount = molecule.getAllHydrogens(atom);
    if (protonCount === 0) {
      continue;
    }
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
    const totalProtons = group.protons.reduce((sum, count) => sum + count, 0);
    resonances.push(
      buildResonance("1H", group.match, group.atoms, totalProtons, group.protons.map((count) => ({ element: "H", count })), warnings)
    );
  }
  let unmatchedCount = 0;
  for (const [code, atoms] of unmatched) {
    unmatchedCount += atoms.reduce((sum, atom) => sum + molecule.getAllHydrogens(atom), 0);
    warnings.push(noMatchWarning("1H", code, atoms));
  }
  return unmatchedCount;
}

function buildResonance(
  nucleus: NmrNucleus,
  match: Match,
  atoms: readonly number[],
  equivalentNuclei: number,
  refs: readonly { element: string; count: number }[],
  warnings: NmrPredictionWarning[]
): NmrResonance {
  const { entry, code } = match;
  if (entry.n < SMALL_POPULATION_THRESHOLD) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.SmallReferencePopulation,
        `Only ${entry.n} reference shift(s) for ${nucleus} ${entry.median} ppm.`,
        { severity: "info", atomIndices: [...atoms] }
      )
    );
  }
  if (entry.sphere <= 1) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.LowHoseSphereMatch,
        `${nucleus} ${entry.median} ppm matched only a 1-sphere environment; confidence is low.`,
        { severity: "info", atomIndices: [...atoms] }
      )
    );
  }

  return {
    id: `${nucleus === "13C" ? "c" : "h"}-${Math.min(...atoms)}`,
    nucleus,
    deltaPpm: entry.median,
    atomRefs: atoms.map((atom, index) => ({
      sourceAtomIndex: atom,
      element: refs[index].element,
      equivalentCount: refs[index].count
    })),
    equivalentNuclei,
    // stdev is absent for single-observation environments (localDatabase omits it for n < 2).
    uncertainty: { standardDeviationPpm: entry.stdev, minimumPpm: entry.min, maximumPpm: entry.max },
    evidence: { method: "hose-fragment", matchedSphere: entry.sphere, sampleCount: entry.n, environmentCode: code },
    flags: []
  };
}

function noMatchWarning(nucleus: NmrNucleus, code: string, atoms: readonly number[]): NmrPredictionWarning {
  return nmrWarning(NmrWarningCodes.NoFragmentMatch, `No ${nucleus} database match for environment ${code}.`, {
    severity: "warning",
    atomIndices: [...atoms],
    details: { nucleus, environmentCode: code }
  });
}

function pushGroup(groups: Map<string, number[]>, key: string, atom: number): void {
  const existing = groups.get(key);
  if (existing) {
    existing.push(atom);
  } else {
    groups.set(key, [atom]);
  }
}

function dedupeNuclei(nuclei: readonly NmrNucleus[]): NmrNucleus[] {
  return [...new Set(nuclei)];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled.");
  }
}
