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

export interface MassReport {
  formula: string;
  /** Sum of explicit atomic formal charges in the parsed structure. */
  netCharge: number;
  monoisotopicMass: number;
  averageMass: number;
  ions: MassIon[];
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


/**
 * Compute the mass fingerprint of a structure: molecular formula, monoisotopic and average mass, and
 * common adduct m/z. Pure over its input; the only dependency is OpenChemLib for parsing +
 * formula/weights.
 *
 * **No isotope pattern here.** This used to end with a first-order M/M+1/M+2 estimate over an
 * eight-element abundance table with no recorded source — a second, worse implementation of chemistry
 * the application already owns, written only because the SDK boundary (ADR-0028 §1) stops a plugin
 * importing the core's engines. The real envelope now comes from the host through
 * `chemistry.compute`, so the plugin asks instead of approximating.
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
    ions
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


const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const round2 = (value: number): number => Math.round(value * 1e2) / 1e2;
