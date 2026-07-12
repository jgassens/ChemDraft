import type { NmrNucleus } from "../../domain/contracts";

/** Aggregated shift statistics for one nucleus-environment (a HOSE-style fragment). */
export interface NmrDatabaseEntry {
  nucleus: NmrNucleus;
  /** Sphere depth of the environment code this entry is keyed by. */
  sphere: number;
  n: number;
  median: number;
  mean: number;
  /** Population standard deviation; omitted for n < 2, where "0" would falsely imply zero dispersion. */
  stdev?: number;
  min: number;
  max: number;
}

/** Provenance for a compiled database — the PLANS data-provenance checklist, surfaced at runtime. */
export interface NmrDatabaseProvenance {
  name: string;
  version: string;
  source: string;
  license: string;
  licenseUrl?: string;
  attribution: string;
  structureCount: number;
  entryCount: number;
  nuclei: readonly NmrNucleus[];
  generatedAt: string;
  note: string;
  /** Pruning rule the compiler enforced: environments with fewer observations were dropped.
   * Recorded (with the pre-prune count) so a rebuild from the same raw input is reproducible. */
  minObservations?: number;
  /** Environment count before the minObservations prune. */
  rawEntryCount?: number;
  /** SHA-256 of the exact raw input file the artifact was compiled from. */
  inputSha256?: string;
  /** Byte length of that raw input file. */
  inputBytes?: number;
}

export interface CompiledNmrDatabase {
  provenance: NmrDatabaseProvenance;
  /** Keyed by {@link environmentKey}: `${nucleus}@${environmentCode}`. */
  entries: Record<string, NmrDatabaseEntry>;
}

/** Compute population statistics for a set of observed shifts (assumes non-empty). */
export function summarizeShifts(shifts: readonly number[]): Omit<NmrDatabaseEntry, "nucleus" | "sphere"> {
  const sorted = [...shifts].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    n,
    median: round(median),
    mean: round(mean),
    // A single observation has no meaningful dispersion — leave stdev absent rather than reporting 0.
    ...(n >= 2 ? { stdev: round(Math.sqrt(variance)) } : {}),
    min: round(sorted[0]),
    max: round(sorted[n - 1])
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
