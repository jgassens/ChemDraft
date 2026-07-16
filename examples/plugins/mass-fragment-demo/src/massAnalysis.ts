import * as OCL from "openchemlib";

/** Structure the analyzer accepts — the same formats the selection boundary emits (molfile preferred). */
export interface MassAnalysisInput {
  format: "smiles" | "molfile-v2000" | "molfile-v3000";
  value: string;
}

export interface MassIon {
  /** e.g. "[M+H]+". */
  species: string;
  /** Monoisotopic m/z. */
  mz: number;
  charge: number;
}

export interface MassIsotopePeak {
  /** "M", "M+1", "M+2". */
  label: string;
  /** Intensity relative to the monoisotopic peak (M = 100). */
  relativeIntensity: number;
}

export interface MassReport {
  formula: string;
  monoisotopicMass: number;
  averageMass: number;
  ions: MassIon[];
  isotopePattern: MassIsotopePeak[];
}

export class MassAnalysisError extends Error {
  constructor(
    readonly code: "EMPTY_STRUCTURE" | "PARSE_FAILED" | "NO_ATOMS",
    message: string
  ) {
    super(message);
    this.name = "MassAnalysisError";
  }
}

/** Standard ESI adduct m/z offsets (monoisotopic, electron mass folded in). Positive- and
 *  negative-mode species common in small-molecule MS. m/z = (M + delta) / |charge|. */
const ADDUCTS: readonly { species: string; delta: number; charge: number }[] = [
  { species: "[M+H]+", delta: 1.007276, charge: 1 },
  { species: "[M+Na]+", delta: 22.989218, charge: 1 },
  { species: "[M+NH4]+", delta: 18.033823, charge: 1 },
  { species: "[M+K]+", delta: 38.963158, charge: 1 },
  { species: "[M+H-H2O]+", delta: 1.007276 - 18.010565, charge: 1 },
  { species: "[M-H]-", delta: -1.007276, charge: -1 }
];

/** First-order relative isotopic abundances (%) of the heavier isotopes, per atom of the element
 *  (IUPAC/NIST). M+1 is dominated by ¹³C; M+2 by ³⁷Cl / ⁸¹Br / ³⁴S. Higher combinatorial terms beyond
 *  the ¹³C₂ contribution are omitted — this is a labelled approximation, not a full convolution. */
const M1_PER_ATOM: Record<string, number> = { C: 1.07, N: 0.369, H: 0.0115, O: 0.038, S: 0.75, Si: 5.08 };
const M2_PER_ATOM: Record<string, number> = { O: 0.205, S: 4.25, Cl: 31.96, Br: 97.28, Si: 3.35 };
const C13 = 0.0107; // fraction, for the ¹³C₂ M+2 combinatorial term

/**
 * Compute the mass fingerprint of a structure: molecular formula, monoisotopic and average mass,
 * common adduct m/z, and a first-order M/M+1/M+2 isotope pattern. Pure over its input; the only
 * dependency is OpenChemLib for parsing + formula/weights.
 */
export function analyzeMass(input: MassAnalysisInput): MassReport {
  if (!input.value.trim()) {
    throw new MassAnalysisError("EMPTY_STRUCTURE", "No structure to analyze.");
  }

  let molecule: OCL.Molecule;
  try {
    molecule = input.format === "smiles" ? OCL.Molecule.fromSmiles(input.value) : OCL.Molecule.fromMolfile(input.value);
  } catch (error) {
    throw new MassAnalysisError("PARSE_FAILED", `Could not parse the ${input.format} structure: ${(error as Error).message}`);
  }
  if (molecule.getAllAtoms() === 0) {
    throw new MassAnalysisError("NO_ATOMS", "The structure has no atoms.");
  }

  const mf = molecule.getMolecularFormula();
  const monoisotopicMass = mf.absoluteWeight;
  const averageMass = mf.relativeWeight;
  const counts = parseFormulaCounts(mf.formula);

  const ions = ADDUCTS.map((adduct) => ({
    species: adduct.species,
    mz: round4((monoisotopicMass + adduct.delta) / Math.abs(adduct.charge)),
    charge: adduct.charge
  }));

  return { formula: mf.formula, monoisotopicMass: round4(monoisotopicMass), averageMass: round2(averageMass), ions, isotopePattern: isotopePattern(counts) };
}

/** Parse Hill-notation formula ("C9H8O4", "CHCl3") into element counts; bare symbol ⇒ count 1. */
export function parseFormulaCounts(formula: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, element, digits] of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    if (!element) continue;
    counts[element] = (counts[element] ?? 0) + (digits ? Number(digits) : 1);
  }
  return counts;
}

function isotopePattern(counts: Record<string, number>): MassIsotopePeak[] {
  let m1 = 0;
  let m2 = 0;
  for (const [element, n] of Object.entries(counts)) {
    m1 += (M1_PER_ATOM[element] ?? 0) * n;
    m2 += (M2_PER_ATOM[element] ?? 0) * n;
  }
  // ¹³C₂ combinatorial contribution to M+2 (two heavy carbons in one molecule).
  const nC = counts.C ?? 0;
  m2 += ((nC * (nC - 1)) / 2) * C13 * C13 * 100;

  const peaks: MassIsotopePeak[] = [{ label: "M", relativeIntensity: 100 }];
  if (m1 > 0.05) peaks.push({ label: "M+1", relativeIntensity: round2(m1) });
  if (m2 > 0.05) peaks.push({ label: "M+2", relativeIntensity: round2(m2) });
  return peaks;
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const round2 = (value: number): number => Math.round(value * 1e2) / 1e2;
