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
  if (hasFormalCharge(molecule)) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.ChargedStructure,
        "Formal charges are retained but not modeled by the fixture provider.",
        { severity: "info" }
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

function hasFormalCharge(molecule: OCL.Molecule): boolean {
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomCharge(atom) !== 0) {
      return true;
    }
  }
  return false;
}

function safeIsomericSmiles(molecule: OCL.Molecule): string | undefined {
  try {
    return molecule.toIsomericSmiles();
  } catch {
    return undefined;
  }
}
