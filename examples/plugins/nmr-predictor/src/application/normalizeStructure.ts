import * as OCL from "openchemlib";

import type { ChemicalStructureInput, NormalizedMolecule } from "../domain/contracts";
import { NmrError, NmrErrorCodes } from "../domain/errors";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../domain/warnings";

/** normalizeStructure's output: the internal OpenChemLib molecule (never serialized/sent out) plus a
 *  serializable summary. Providers read `molecule`; the worker sends only `normalized` across. */
export interface NormalizedStructure {
  molecule: OCL.Molecule;
  normalized: NormalizedMolecule;
}

// Elements represented by the bundled reference corpus and the provider's documented coarse rules.
// Silicon is intentionally absent: OCL can parse it, but this predictor has no supported Si model.
const SUPPORTED_ATOMIC_NUMBERS = new Set([1, 5, 6, 7, 8, 9, 15, 16, 17, 35, 53]);

/**
 * Convert a generic snapshot's (format, value) into the narrower {@link ChemicalStructureInput},
 * rejecting "unknown" and empty payloads before any prediction. This is the boundary the plan
 * requires: a snapshot may report "unknown", but a request must not.
 */
export function toChemicalStructureInput(format: string, value: string): ChemicalStructureInput {
  if (format !== "smiles" && format !== "molfile-v2000" && format !== "molfile-v3000") {
    throw new NmrError(
      NmrErrorCodes.UnsupportedStructureFormat,
      `NMR prediction does not support the "${format}" structure format.`,
      { format }
    );
  }
  if (value.trim() === "") {
    throw new NmrError(NmrErrorCodes.EmptyStructure, "The selected structure has no structure payload.");
  }
  return { format, value };
}

/**
 * Parse and normalize a structure with the OpenChemLib that ChemDraft already ships. The normalized
 * OCL molecule is the primary internal object; a molfile round-trip is not forced. Aromaticity/ring
 * perception is materialized (`cHelperRings`) so downstream environment generation is stable.
 */
export function normalizeStructure(input: ChemicalStructureInput): NormalizedStructure {
  if (input.value.trim() === "") {
    throw new NmrError(NmrErrorCodes.EmptyStructure, "The selected structure has no structure payload.");
  }

  let molecule: OCL.Molecule;
  try {
    molecule =
      input.format === "smiles"
        ? OCL.Molecule.fromSmiles(input.value)
        : OCL.Molecule.fromMolfile(input.value);
  } catch (cause) {
    throw new NmrError(NmrErrorCodes.StructureParseFailed, `Could not parse the ${input.format} structure.`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  if (molecule.getAllAtoms() === 0) {
    throw new NmrError(NmrErrorCodes.StructureParseFailed, `The ${input.format} structure parsed to zero atoms.`);
  }

  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);

  const warnings: NmrPredictionWarning[] = [];
  const chargedAtoms = collectAtoms(
    molecule,
    (atom) => molecule.getAtomCharge(atom) !== 0 && !isCanonicalNitroChargeAtom(molecule, atom)
  );
  if (chargedAtoms.length > 0) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.ChargedStructure,
        "Formal charges are preserved, but charge effects are outside the bounded prediction model.",
        { severity: "warning", atomIndices: chargedAtoms }
      )
    );
  }

  const isotopeAtoms = collectAtoms(molecule, (atom) => molecule.getAtomMass(atom) !== 0);
  if (isotopeAtoms.length > 0) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.IsotopeNotSupported,
        "Explicit isotope labels are preserved, but isotope-dependent shifts are not modeled.",
        { severity: "warning", atomIndices: isotopeAtoms }
      )
    );
  }

  const radicalAtoms = collectAtoms(
    molecule,
    (atom) => molecule.getAtomRadical(atom) !== OCL.Molecule.cAtomRadicalStateNone
  );
  if (radicalAtoms.length > 0) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.RadicalNotSupported,
        "Radical state is preserved, but radical-induced shifts are not modeled.",
        { severity: "warning", atomIndices: radicalAtoms }
      )
    );
  }

  const unsupportedAtoms = collectAtoms(
    molecule,
    (atom) => !SUPPORTED_ATOMIC_NUMBERS.has(molecule.getAtomicNo(atom))
  );
  if (unsupportedAtoms.length > 0) {
    const elements = [...new Set(unsupportedAtoms.map((atom) => molecule.getAtomLabel(atom)))].sort();
    warnings.push(
      nmrWarning(
        NmrWarningCodes.UnsupportedElement,
        `Unsupported element(s) ${elements.join(", ")} are preserved, but shifts involving them are omitted unless a database match exists.`,
        { severity: "warning", atomIndices: unsupportedAtoms, details: { elements } }
      )
    );
  }

  const normalized: NormalizedMolecule = {
    sourceFormat: input.format,
    canonicalSmiles: safeIsomericSmiles(molecule),
    providerAtomCount: molecule.getAllAtoms(),
    warnings
  };

  return { molecule, normalized };
}

function collectAtoms(molecule: OCL.Molecule, predicate: (atom: number) => boolean): number[] {
  const atoms: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (predicate(atom)) {
      atoms.push(atom);
    }
  }
  return atoms;
}

/** Ordinary nitro groups are represented as N+/O- resonance forms in SMILES. That formal-charge
 * pair is part of the explicit NO2 increment-table class, so it must not trigger the broad
 * "charged chemistry is unsupported" warning used for salts and genuinely ionic structures. */
function isCanonicalNitroChargeAtom(molecule: OCL.Molecule, atom: number): boolean {
  const candidateNitrogens: number[] = [];
  if (molecule.getAtomicNo(atom) === 7) {
    candidateNitrogens.push(atom);
  } else if (molecule.getAtomicNo(atom) === 8) {
    for (let index = 0; index < molecule.getConnAtoms(atom); index += 1) {
      const neighbor = molecule.getConnAtom(atom, index);
      if (molecule.getAtomicNo(neighbor) === 7) candidateNitrogens.push(neighbor);
    }
  }

  return candidateNitrogens.some((nitrogen) => {
    if (molecule.getAtomCharge(nitrogen) !== 1) return false;
    const oxygens: number[] = [];
    for (let index = 0; index < molecule.getConnAtoms(nitrogen); index += 1) {
      const neighbor = molecule.getConnAtom(nitrogen, index);
      if (molecule.getAtomicNo(neighbor) === 8) oxygens.push(neighbor);
    }
    if (oxygens.length !== 2 || ![nitrogen, ...oxygens].includes(atom)) return false;
    return oxygens.filter((oxygen) => molecule.getAtomCharge(oxygen) === -1).length === 1 &&
      oxygens.filter((oxygen) => molecule.getAtomCharge(oxygen) === 0).length === 1;
  });
}

function safeIsomericSmiles(molecule: OCL.Molecule): string | undefined {
  try {
    return molecule.toIsomericSmiles();
  } catch {
    return undefined;
  }
}
