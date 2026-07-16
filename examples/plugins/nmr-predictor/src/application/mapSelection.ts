import type { PluginSelectedMolecule } from "@chemdraft/plugin-api";

import type { ChemicalStructureInput } from "../domain/contracts";
import { isNmrError, NmrErrorCodes } from "../domain/errors";
import { toChemicalStructureInput } from "./normalizeStructure";

export interface CommandError {
  code: string;
  message: string;
}

export type MappedStructure = { ok: true; value: ChemicalStructureInput } | { ok: false; error: CommandError };

/**
 * Convert a generic selected molecule into the predictor's narrower input, rejecting "unknown"/empty
 * as a command error rather than throwing. This is the application mapper the plan calls for: a
 * snapshot may report "unknown", but a prediction request must not.
 */
export function mapSelectedMoleculeToPredictionInput(molecule: PluginSelectedMolecule): MappedStructure {
  try {
    return { ok: true, value: toChemicalStructureInput(molecule.structureFormat, molecule.structure) };
  } catch (error) {
    return { ok: false, error: toCommandError(error) };
  }
}

/** Normalize any thrown value into the `{ code, message }` shape a PluginCommandResult carries. */
export function toCommandError(error: unknown): CommandError {
  if (isNmrError(error)) {
    return { code: error.code, message: error.message };
  }
  return {
    code: NmrErrorCodes.ProviderFailure,
    message: error instanceof Error ? error.message : String(error)
  };
}

export function isCancellationError(error: unknown): boolean {
  return isNmrError(error) && error.code === NmrErrorCodes.PredictionCancelled;
}
