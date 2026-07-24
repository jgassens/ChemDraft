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
  /** Sum of explicit atomic formal charges in the parsed structure. */
  netCharge: number;
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

/** Electron rest mass in unified atomic mass units. Formula weights are sums of neutral atomic
 *  masses, so a positive ion loses this mass per charge and a negative ion gains it. */
const ELECTRON_MASS_U = 0.000548579909065;

/** Natural abundances (%) used by this deliberately first-order approximation. Store absolute
 *  abundances together and derive heavy/light ratios uniformly: report intensities are relative to
 *  the all-light (monoisotopic) peak, never a mixture of absolute percentages and ratios. */
const ISOTOPE_ABUNDANCES: Record<string, { light: number; m1?: number; m2?: number }> = {
  H: { light: 99.9885, m1: 0.0115 },
  C: { light: 98.93, m1: 1.07 },
  N: { light: 99.631, m1: 0.369 },
  O: { light: 99.757, m1: 0.038, m2: 0.205 },
  Si: { light: 92.23, m1: 4.67, m2: 3.1 },
  S: { light: 94.99, m1: 0.75, m2: 4.25 },
  Cl: { light: 75.78, m2: 24.22 },
  Br: { light: 50.69, m2: 49.31 }
};

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
  const netCharge = totalFormalCharge(molecule);
  const monoisotopicMass = mf.absoluteWeight - netCharge * ELECTRON_MASS_U;
  const averageMass = mf.relativeWeight - netCharge * ELECTRON_MASS_U;
  const counts = parseFormulaCounts(mf.formula);

  // Adduct constants are defined for a neutral precursor and already include electron-mass
  // corrections. Applying them to an input that is already charged invents misleading ions (for
  // example [M+H]+ for tetramethylammonium), so charged inputs report their native ion only.
  const ions = netCharge === 0
    ? ADDUCTS.map((adduct) => ({
        species: adduct.species,
        mz: round4((monoisotopicMass + adduct.delta) / Math.abs(adduct.charge)),
        charge: adduct.charge
      }))
    : [{ species: nativeIonLabel(netCharge), mz: round4(monoisotopicMass / Math.abs(netCharge)), charge: netCharge }];

  return {
    formula: mf.formula,
    netCharge,
    monoisotopicMass: round4(monoisotopicMass),
    averageMass: round2(averageMass),
    ions,
    isotopePattern: isotopePattern(counts)
  };
}

function totalFormalCharge(molecule: OCL.Molecule): number {
  let charge = 0;
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    charge += molecule.getAtomCharge(atom);
  }
  return charge;
}

function nativeIonLabel(charge: number): string {
  const magnitude = Math.abs(charge);
  return `[M]${magnitude === 1 ? "" : magnitude}${charge > 0 ? "+" : "-"}`;
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
    const abundance = ISOTOPE_ABUNDANCES[element];
    if (!abundance) continue;
    m1 += ((abundance.m1 ?? 0) / abundance.light) * 100 * n;
    m2 += ((abundance.m2 ?? 0) / abundance.light) * 100 * n;
  }
  // ¹³C₂ combinatorial contribution to M+2 (two heavy carbons in one molecule).
  const nC = counts.C ?? 0;
  const carbon = ISOTOPE_ABUNDANCES.C!;
  const c13ToC12 = (carbon.m1 ?? 0) / carbon.light;
  m2 += ((nC * (nC - 1)) / 2) * c13ToC12 * c13ToC12 * 100;

  const peaks: MassIsotopePeak[] = [{ label: "M", relativeIntensity: 100 }];
  if (m1 > 0.05) peaks.push({ label: "M+1", relativeIntensity: round2(m1) });
  if (m2 > 0.05) peaks.push({ label: "M+2", relativeIntensity: round2(m2) });
  return peaks;
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const round2 = (value: number): number => Math.round(value * 1e2) / 1e2;
