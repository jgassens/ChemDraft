import * as OCL from "openchemlib";

import type { NmrNucleus, NmrPredictionOptions } from "../../domain/contracts";
import { atomEnvironmentCodes, protonHostAtom, MAX_SPHERES } from "./environmentCode";
import { estimateProtonIncrement } from "./incrementEstimator";
import type { CompiledNmrDatabase } from "./localDatabase";
import { matchEnvironment, shiftFor } from "./OclHosePredictor";
import type { NmredataRecord } from "./nmredata";

/**
 * Leakage-free accuracy benchmark (ADR-0026). The corpus is split by *structure identity* (OCL
 * idcode), so every record of the same compound — duplicates included — lands on the same side and a
 * held-out molecule can never have contributed shifts to the database it is scored against. Held-out
 * assignments are scored through the production lookup itself (`matchEnvironment` + `shiftFor`),
 * never a reimplementation.
 */

export interface CorpusSplit {
  train: NmredataRecord[];
  heldOut: NmredataRecord[];
  /** Records whose molfile OCL could not parse; they stay in train (they are unusable for scoring). */
  unparseable: number;
}

export interface SplitOptions {
  /** Per-mille of structure identities to hold out (20 = 2%). */
  holdOutPerMille: number;
  seed: number;
}

/** Deterministic, seed-stable FNV-1a — no RNG, so a rerun reproduces the exact split. */
export function structureBucket(idcode: string, seed: number): number {
  let hash = 0x811c9dc5;
  const text = `${idcode}#${seed}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 1000;
}

export function splitCorpusByStructure(records: readonly NmredataRecord[], options: SplitOptions): CorpusSplit {
  const train: NmredataRecord[] = [];
  const heldOut: NmredataRecord[] = [];
  let unparseable = 0;
  for (const record of records) {
    let idcode: string | undefined;
    try {
      const molecule = OCL.Molecule.fromMolfile(record.molfile);
      idcode = molecule.getAllAtoms() > 0 ? molecule.getIDCode() : undefined;
    } catch {
      idcode = undefined;
    }
    if (idcode === undefined) {
      unparseable += 1;
      train.push(record);
      continue;
    }
    (structureBucket(idcode, options.seed) < options.holdOutPerMille ? heldOut : train).push(record);
  }
  return { train, heldOut, unparseable };
}

export type BenchmarkTier = "high" | "medium" | "low";

export interface BenchmarkRow {
  nucleus: NmrNucleus;
  /** Index of the held-out record this row came from (for per-structure accounting). */
  structureIndex: number;
  assignedPpm: number;
  /** Production HOSE lookup result; absent = no database match at any sphere (uncovered). */
  hosePpm?: number;
  sphere?: number;
  n?: number;
  tier?: BenchmarkTier;
  /** Bounded additive-increment estimate for the same host (¹H only, where applicable). */
  incrementPpm?: number;
}

/** Mirrors the production confidence tier (composePredictionReport): low = shallow or thin evidence,
 * high = specific environment with a healthy population. */
export function benchmarkTier(sphere: number, n: number): BenchmarkTier {
  if (sphere <= 1 || n < 3) return "low";
  if (sphere >= 3 && n >= 8) return "high";
  return "medium";
}

export interface EvaluateOptions {
  statistic?: NmrPredictionOptions["statistic"];
  maxSpheres?: number;
}

/** Score every usable held-out assignment against the (train-only) database. Assignment semantics —
 * molfile atom mapping, proton→host resolution, first listed atom — mirror `buildNmrDatabase`
 * ingestion so the benchmark asks exactly the question the database answers. */
export function evaluateHeldOut(
  database: CompiledNmrDatabase,
  heldOut: readonly NmredataRecord[],
  options: EvaluateOptions = {}
): BenchmarkRow[] {
  const statistic = options.statistic ?? "median";
  const maxSpheres = options.maxSpheres ?? MAX_SPHERES;
  const rows: BenchmarkRow[] = [];

  for (let structureIndex = 0; structureIndex < heldOut.length; structureIndex += 1) {
    const record = heldOut[structureIndex];
    let molecule: OCL.Molecule;
    try {
      molecule = OCL.Molecule.fromMolfile(record.molfile);
    } catch {
      continue;
    }
    if (molecule.getAllAtoms() === 0) {
      continue;
    }
    for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
      molecule.setAtomMapNo(atom, atom + 1, false);
    }
    molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const oclAtomByMolfileIndex = new Map<number, number>();
    for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
      oclAtomByMolfileIndex.set(molecule.getAtomMapNo(atom), atom);
    }

    for (const assignment of record.assignments) {
      const nucleus: NmrNucleus | undefined = record.carbonLabels.has(assignment.label)
        ? "13C"
        : record.protonLabels.has(assignment.label)
          ? "1H"
          : undefined;
      if (!nucleus) continue;
      const oclAtom = oclAtomByMolfileIndex.get(assignment.atoms[0]);
      if (oclAtom === undefined) continue;

      let codeAtom = oclAtom;
      if (nucleus === "13C") {
        if (molecule.getAtomicNo(oclAtom) !== 6) continue;
      } else {
        if (molecule.getAtomicNo(oclAtom) !== 1) continue;
        codeAtom = protonHostAtom(molecule, oclAtom);
        if (codeAtom < 0) continue;
      }

      const row: BenchmarkRow = { nucleus, structureIndex, assignedPpm: assignment.shift };
      const found = matchEnvironment(database, nucleus, atomEnvironmentCodes(molecule, codeAtom, maxSpheres));
      if (found) {
        row.hosePpm = shiftFor(found.entry, statistic);
        row.sphere = found.entry.sphere;
        row.n = found.entry.n;
        row.tier = benchmarkTier(found.entry.sphere, found.entry.n);
      }
      if (nucleus === "1H") {
        const increment = estimateProtonIncrement(molecule, codeAtom);
        if (increment.applicable) {
          row.incrementPpm = increment.ppm;
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

export interface ErrorStats {
  count: number;
  mae: number;
  medianAe: number;
  p90Ae: number;
}

export interface NucleusBenchmark {
  assigned: number;
  matched: number;
  coverage: number;
  structures: number;
  hose: ErrorStats;
  byTier: Partial<Record<BenchmarkTier, ErrorStats>>;
  /** ¹H only: HOSE vs increment on the subset where both produced a value. */
  incrementComparison?: {
    count: number;
    hose: ErrorStats;
    increment: ErrorStats;
    lowTier?: { count: number; hose: ErrorStats; increment: ErrorStats };
  };
}

export type BenchmarkSummary = Partial<Record<NmrNucleus, NucleusBenchmark>>;

function errorStats(errors: readonly number[]): ErrorStats {
  const sorted = [...errors].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) {
    return { count: 0, mae: 0, medianAe: 0, p90Ae: 0 };
  }
  const mae = sorted.reduce((sum, value) => sum + value, 0) / count;
  const mid = Math.floor(count / 2);
  const medianAe = count % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p90Ae = sorted[Math.min(count - 1, Math.ceil(count * 0.9) - 1)];
  return { count, mae: round3(mae), medianAe: round3(medianAe), p90Ae: round3(p90Ae) };
}

export function aggregateBenchmark(rows: readonly BenchmarkRow[]): BenchmarkSummary {
  const summary: BenchmarkSummary = {};
  for (const nucleus of ["1H", "13C"] as const) {
    const assigned = rows.filter((row) => row.nucleus === nucleus);
    if (assigned.length === 0) continue;
    const matched = assigned.filter((row) => row.hosePpm !== undefined);
    const errorsOf = (subset: readonly BenchmarkRow[], value: (row: BenchmarkRow) => number | undefined) =>
      subset.flatMap((row) => {
        const predicted = value(row);
        return predicted === undefined ? [] : [Math.abs(row.assignedPpm - predicted)];
      });

    const byTier: Partial<Record<BenchmarkTier, ErrorStats>> = {};
    for (const tier of ["high", "medium", "low"] as const) {
      const tierRows = matched.filter((row) => row.tier === tier);
      if (tierRows.length > 0) {
        byTier[tier] = errorStats(errorsOf(tierRows, (row) => row.hosePpm));
      }
    }

    const nucleusSummary: NucleusBenchmark = {
      assigned: assigned.length,
      matched: matched.length,
      coverage: round3(matched.length / assigned.length),
      structures: new Set(assigned.map((row) => row.structureIndex)).size,
      hose: errorStats(errorsOf(matched, (row) => row.hosePpm)),
      byTier
    };

    if (nucleus === "1H") {
      const both = matched.filter((row) => row.incrementPpm !== undefined);
      if (both.length > 0) {
        const lowTier = both.filter((row) => row.tier === "low");
        nucleusSummary.incrementComparison = {
          count: both.length,
          hose: errorStats(errorsOf(both, (row) => row.hosePpm)),
          increment: errorStats(errorsOf(both, (row) => row.incrementPpm)),
          ...(lowTier.length > 0
            ? {
                lowTier: {
                  count: lowTier.length,
                  hose: errorStats(errorsOf(lowTier, (row) => row.hosePpm)),
                  increment: errorStats(errorsOf(lowTier, (row) => row.incrementPpm))
                }
              }
            : {})
        };
      }
    }
    summary[nucleus] = nucleusSummary;
  }
  return summary;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
