import * as OCL from "openchemlib";

import type { NmrNucleus } from "../../domain/contracts";
import { atomEnvironmentCodes, environmentKey, protonHostAtom, sphereDepthOf, MAX_SPHERES } from "./environmentCode";
import { summarizeShifts, type CompiledNmrDatabase, type NmrDatabaseEntry, type NmrDatabaseProvenance } from "./localDatabase";
import { extractMolfile, parseAssignments, parseSpectrumLabels, splitRecords } from "./nmredata";

export interface BuildDatabaseOptions {
  provenance: Omit<
    NmrDatabaseProvenance,
    "structureCount" | "entryCount" | "nuclei" | "generatedAt" | "minObservations" | "rawEntryCount"
  >;
  now?: () => string;
  maxSpheres?: number;
  /** Drop environments observed fewer than this many times (bundle-size prune). Default 1 = keep
   * everything. When > 1 the rule and the pre-prune count are recorded in provenance so a rebuild
   * from the same raw input reproduces the artifact exactly. */
  minObservations?: number;
}

/**
 * Compile a NMReDATA/SDF export (e.g. `nmrshiftdb2rawdata.nmredata.sd`) into aggregated HOSE-code →
 * shift statistics. For each atom-assigned resonance it derives the atom's environment code at every
 * sphere depth (from the explicit-H molfile — codes that provably match implicit-H SMILES queries) and
 * buckets the shift; buckets are then summarized to median/mean/stdev/min/max/n. Only the compiled
 * statistics are emitted — never the raw structures — so the artifact is small and a separate,
 * attributed data asset.
 */
export function buildNmrDatabase(rawSdContent: string, options: BuildDatabaseOptions): CompiledNmrDatabase {
  // Normalize line endings so the record split and tag terminators work on CRLF exports too.
  const sdContent = rawSdContent.replace(/\r\n?/g, "\n");
  const maxSpheres = options.maxSpheres ?? MAX_SPHERES;
  const minObservations = options.minObservations ?? 1;
  const buckets = new Map<string, { nucleus: NmrNucleus; sphere: number; shifts: number[] }>();
  const nucleiSeen = new Set<NmrNucleus>();
  let structureCount = 0;

  for (const record of splitRecords(sdContent)) {
    const molfile = extractMolfile(record);
    if (!molfile) {
      continue;
    }
    const assignments = parseAssignments(record);
    if (assignments.length === 0) {
      continue;
    }
    const carbonLabels = parseSpectrumLabels(record, "NMREDATA_1D_13C");
    const protonLabels = parseSpectrumLabels(record, "NMREDATA_1D_1H");

    let molecule: OCL.Molecule;
    try {
      molecule = OCL.Molecule.fromMolfile(molfile);
    } catch {
      continue;
    }
    if (molecule.getAllAtoms() === 0) {
      continue;
    }
    // Tag the molfile's 1-based atom order before helper arrays move explicit H to the end.
    for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
      molecule.setAtomMapNo(atom, atom + 1, false);
    }
    molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const oclAtomByMolfileIndex = new Map<number, number>();
    for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
      oclAtomByMolfileIndex.set(molecule.getAtomMapNo(atom), atom);
    }

    let usedStructure = false;
    for (const assignment of assignments) {
      const nucleus: NmrNucleus | undefined = carbonLabels.has(assignment.label)
        ? "13C"
        : protonLabels.has(assignment.label)
          ? "1H"
          : undefined;
      if (!nucleus) {
        continue;
      }
      const oclAtom = oclAtomByMolfileIndex.get(assignment.atoms[0]);
      if (oclAtom === undefined) {
        continue;
      }

      let codeAtom = oclAtom;
      if (nucleus === "13C") {
        if (molecule.getAtomicNo(oclAtom) !== 6) {
          continue;
        }
      } else {
        if (molecule.getAtomicNo(oclAtom) !== 1) {
          continue;
        }
        codeAtom = protonHostAtom(molecule, oclAtom);
        if (codeAtom < 0) {
          continue;
        }
      }

      for (const code of atomEnvironmentCodes(molecule, codeAtom, maxSpheres)) {
        const key = environmentKey(nucleus, code);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.shifts.push(assignment.shift);
        } else {
          buckets.set(key, { nucleus, sphere: sphereDepthOf(code), shifts: [assignment.shift] });
        }
      }
      nucleiSeen.add(nucleus);
      usedStructure = true;
    }
    if (usedStructure) {
      structureCount += 1;
    }
  }

  const entries: Record<string, NmrDatabaseEntry> = {};
  for (const [key, bucket] of buckets) {
    if (bucket.shifts.length < minObservations) {
      continue;
    }
    entries[key] = { nucleus: bucket.nucleus, sphere: bucket.sphere, ...summarizeShifts(bucket.shifts) };
  }

  return {
    provenance: {
      ...options.provenance,
      structureCount,
      entryCount: Object.keys(entries).length,
      nuclei: [...nucleiSeen].sort(),
      generatedAt: (options.now ?? (() => new Date().toISOString()))(),
      ...(minObservations > 1 ? { minObservations, rawEntryCount: buckets.size } : {})
    },
    entries
  };
}

