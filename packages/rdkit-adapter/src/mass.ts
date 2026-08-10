/**
 * Adduct m/z tooling (PLANS.md §9, Release 2).
 *
 * "m/z and adduct tooling · fragment formulas and exact-mass bookkeeping with **no** intensity or
 * MS/MS claims."
 *
 * **Every mass here comes from RDKit.** The ion components below are SMILES, and their exact masses
 * are read from `get_descriptors().exactmw` on the loaded engine — measured once per module, then
 * added and subtracted. That is bookkeeping over engine-supplied numbers, the same category as the
 * composition derivation, and it is what keeps §7's rule intact: no second mass table ships here.
 *
 * **It also means the electron bookkeeping is RDKit's, not ours.** Measured on the vendored build,
 * `[NH4+]` is 18.03382554809 while NH₃ + H is 18.034374128 — exactly one electron mass lower. So
 * `[H+]` really is the proton (1.00727645209, not hydrogen's 1.007825032), and
 * `[M+H]⁺ = M + mass([H+])` and `[M−H]⁻ = M − mass([H+])` are both correct without inventing a CODATA
 * constant or choosing an electron convention. Both were verified against aspirin: 181.049535 and
 * 179.034982.
 *
 * **No intensities.** An adduct series is a list of positions. Which ions a real spectrum shows depends
 * on the source, the solvent, and the analyte, none of which this knows — so nothing here reports a
 * relative abundance, and the contracts say so.
 */
import type { CitationRef, MethodContract } from "@chemdraft/analysis-core";

/** The proton, and the identity from which every other adduct mass is derived. */
export const PROTON_SMILES = "[H+]";

export interface AdductSpec {
  /** Stable id fragment: the method is `rdkit.mz.<id>`. */
  id: string;
  /** Rendered form, e.g. "[M+H]⁺". */
  label: string;
  /** Signed charge of the ion. `m/z` divides the ion mass by its magnitude. */
  charge: number;
  /** Ion components added to the neutral molecule, as SMILES. Their masses come from the engine. */
  add: readonly string[];
  /** Protons removed from the molecule. Mass-equivalent to subtracting `mass([H+])` each. */
  removeProtons: number;
}

/**
 * The common electrospray series. Deliberately short: each entry is a public number with its own
 * contract, so this list is a product decision rather than a dumping ground.
 */
export const ADDUCTS: readonly AdductSpec[] = [
  { id: "M+H", label: "[M+H]⁺", charge: 1, add: [PROTON_SMILES], removeProtons: 0 },
  { id: "M+Na", label: "[M+Na]⁺", charge: 1, add: ["[Na+]"], removeProtons: 0 },
  { id: "M+K", label: "[M+K]⁺", charge: 1, add: ["[K+]"], removeProtons: 0 },
  { id: "M+NH4", label: "[M+NH₄]⁺", charge: 1, add: ["[NH4+]"], removeProtons: 0 },
  { id: "M+2H", label: "[M+2H]²⁺", charge: 2, add: [PROTON_SMILES, PROTON_SMILES], removeProtons: 0 },
  { id: "M-H", label: "[M−H]⁻", charge: -1, add: [], removeProtons: 1 },
  { id: "M+Cl", label: "[M+Cl]⁻", charge: -1, add: ["[Cl-]"], removeProtons: 0 },
  { id: "M+HCOO", label: "[M+HCOO]⁻", charge: -1, add: ["[O-]C=O"], removeProtons: 0 },
  { id: "M-2H", label: "[M−2H]²⁻", charge: -2, add: [], removeProtons: 2 }
];

/**
 * Neutral losses reported from the protonated ion — Release 2's "fragment formulas and exact-mass
 * bookkeeping with **no** intensity or MS/MS claims".
 *
 * This is bookkeeping, emphatically not fragmentation prediction. It answers "if this molecule lost
 * water, where would the protonated ion sit?" — a question with an arithmetic answer — and says
 * nothing about whether it *would*, how readily, or at what collision energy.
 *
 * The one gate applied is compositional: a loss must be a sub-formula of the molecule, so a structure
 * with no oxygen never reports a water loss. That check is element counting, not chemistry — it will
 * happily allow a water loss from a molecule whose oxygens are all ketones, and the contract says so.
 */
export interface NeutralLossSpec {
  id: string;
  label: string;
  /** SMILES for the neutral lost, whose mass comes from the engine like every other component. */
  smiles: string;
  /** Element counts that must be present in the molecule for the loss to be compositionally possible. */
  requires: Readonly<Record<string, number>>;
}

export const NEUTRAL_LOSSES: readonly NeutralLossSpec[] = [
  { id: "H2O", label: "H₂O", smiles: "O", requires: { H: 2, O: 1 } },
  { id: "NH3", label: "NH₃", smiles: "N", requires: { N: 1, H: 3 } },
  { id: "CO", label: "CO", smiles: "[C-]#[O+]", requires: { C: 1, O: 1 } },
  { id: "CO2", label: "CO₂", smiles: "O=C=O", requires: { C: 1, O: 2 } },
  { id: "HCOOH", label: "HCOOH", smiles: "OC=O", requires: { C: 1, H: 2, O: 2 } },
  { id: "CH3OH", label: "CH₃OH", smiles: "CO", requires: { C: 1, H: 4, O: 1 } },
  { id: "HCl", label: "HCl", smiles: "Cl", requires: { H: 1, Cl: 1 } }
];

export function neutralLossMethodId(loss: NeutralLossSpec): string {
  return `rdkit.mz.M+H-${loss.id}`;
}

/** Whether the molecule has enough of each element for the loss to be compositionally possible. */
export function lossIsCompositionallyPossible(
  loss: NeutralLossSpec,
  elementCounts: ReadonlyMap<string, number>
): boolean {
  return Object.entries(loss.requires).every(([symbol, needed]) => (elementCounts.get(symbol) ?? 0) >= needed);
}

/** Every SMILES whose exact mass the adduct table needs from the engine. */
export function adductComponentSmiles(): string[] {
  return [
    ...new Set([
      PROTON_SMILES,
      ...ADDUCTS.flatMap((adduct) => adduct.add),
      ...NEUTRAL_LOSSES.map((loss) => loss.smiles)
    ])
  ];
}

export function adductMethodId(adduct: AdductSpec): string {
  return `rdkit.mz.${adduct.id}`;
}

/**
 * The ion's m/z, given the neutral molecule's monoisotopic mass and the engine's ion-component masses.
 *
 * Returns `undefined` when a component mass is missing rather than substituting a guess — a missing
 * mass means the engine could not parse that ion, and an m/z computed around the gap would be wrong
 * without looking wrong.
 */
export function adductMz(
  neutralMonoisotopicMass: number,
  adduct: AdductSpec,
  componentMasses: ReadonlyMap<string, number>
): number | undefined {
  const proton = componentMasses.get(PROTON_SMILES);
  if (adduct.removeProtons > 0 && proton === undefined) return undefined;

  let mass = neutralMonoisotopicMass;
  for (const component of adduct.add) {
    const componentMass = componentMasses.get(component);
    if (componentMass === undefined) return undefined;
    mass += componentMass;
  }
  mass -= adduct.removeProtons * (proton ?? 0);

  const magnitude = Math.abs(adduct.charge);
  return magnitude === 0 ? undefined : mass / magnitude;
}

// --- contracts -------------------------------------------------------------------------------------

const RDKIT_CITATION: CitationRef = {
  id: "rdkit",
  kind: "software",
  title: "RDKit: Open-source cheminformatics",
  authors: "Greg Landrum and contributors",
  url: "https://www.rdkit.org/"
};

const SHARED_CONVENTIONS = [
  "monoisotopic: the most abundant isotope of each element unless an atom carries an explicit label",
  "ion masses come from RDKit's own exactmw for the charged component, so the electron bookkeeping is " +
    "the engine's — [H+] is the proton (1.00727645) rather than hydrogen (1.00782503)",
  "m/z divides the ion mass by the magnitude of its charge",
  "POSITION ONLY — no relative abundance is reported, because which ions a spectrum actually shows " +
    "depends on the source, solvent, and analyte, none of which this method knows"
];

/** m/z of [M+H−L]⁺, or `undefined` when a component mass is missing. */
export function neutralLossMz(
  neutralMonoisotopicMass: number,
  loss: NeutralLossSpec,
  componentMasses: ReadonlyMap<string, number>
): number | undefined {
  const proton = componentMasses.get(PROTON_SMILES);
  const lossMass = componentMasses.get(loss.smiles);
  if (proton === undefined || lossMass === undefined) return undefined;
  return neutralMonoisotopicMass + proton - lossMass;
}

export function neutralLossContracts(engineVersion: string): MethodContract[] {
  return NEUTRAL_LOSSES.map((loss) => ({
    id: neutralLossMethodId(loss),
    publicName: `[M+H−${loss.label}]⁺`,
    version: "1.0.0",
    implementation: {
      engine: "rdkit-minimallib-wasm",
      engineVersion,
      symbol: "JSMol::get_descriptors.exactmw + proton − neutral loss",
      parameters: { loss: loss.id, lossSmiles: loss.smiles, charge: 1 }
    },
    defaultInterpretationId: "source",
    resultKind: "scalar",
    unit: "thomson",
    conventions: [
      ...SHARED_CONVENTIONS,
      "BOOKKEEPING, NOT FRAGMENTATION PREDICTION — this is where the ion would sit if the loss occurred, " +
        "with no claim that it does, how readily, or at what collision energy",
      "the loss is gated on composition only: the molecule must contain enough of each element. A water " +
        "loss is offered for any structure with an oxygen and two hydrogens, including ones whose oxygens " +
        "are all ketones"
    ],
    classification: {
      derivation: "convention",
      claim: "composition",
      determinism: "deterministic",
      flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
    },
    supportedChemistry: ["any neutral structure containing the lost fragment's elements"],
    knownUnsupportedChemistry: ["structures already carrying a formal charge"],
    declinesWhen: [
      "the structure as drawn already carries a net formal charge",
      `the composition does not contain ${loss.label} — the loss is not compositionally possible`,
      "the engine could not supply a mass for the lost neutral"
    ],
    accuracyClaims: [],
    citations: [RDKIT_CITATION],
    datasets: [],
    versionIncrementTriggers: [
      "an RDKit release that adopts revised isotope masses",
      "any change to the loss recorded in implementation.parameters"
    ],
    tautomerSensitive: false
  }));
}

export function adductContracts(engineVersion: string): MethodContract[] {
  return ADDUCTS.map((adduct) => ({
    id: adductMethodId(adduct),
    // Just the ion notation: the `thomson` unit symbol supplies the "m/z", and a public name that
    // repeats it renders as "[M+H]⁺ m/z … 181.0495 m/z".
    publicName: adduct.label,
    version: "1.0.0",
    implementation: {
      engine: "rdkit-minimallib-wasm",
      engineVersion,
      symbol: "JSMol::get_descriptors.exactmw + ion component masses",
      parameters: {
        adduct: adduct.id,
        charge: adduct.charge,
        add: adduct.add.join("+"),
        removeProtons: adduct.removeProtons
      }
    },
    defaultInterpretationId: "source",
    resultKind: "scalar",
    unit: "thomson",
    conventions: SHARED_CONVENTIONS,
    classification: {
      derivation: "convention",
      claim: "composition",
      determinism: "deterministic",
      flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
    },
    supportedChemistry: ["any neutral structure RDKit parses and sanitises"],
    knownUnsupportedChemistry: ["structures already carrying a formal charge"],
    declinesWhen: [
      "the structure as drawn already carries a net formal charge, so [M+…] is not defined for it — " +
        "the neutral M the adduct notation refers to does not exist here",
      "the engine could not supply a mass for one of the ion components"
    ],
    accuracyClaims: [],
    citations: [RDKIT_CITATION],
    datasets: [],
    versionIncrementTriggers: [
      "an RDKit release that adopts revised isotope masses",
      "any change to the charge, components, or proton count recorded in implementation.parameters"
    ],
    tautomerSensitive: false
  }));
}
