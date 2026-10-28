import { smilesListDecision, smilesListTokens, type SmilesListCandidate } from "@chemdraft/clipboard-adapter";
import type { PastedStructureDepiction } from "./documentWorkflow";
import { depictSmilesOffThread } from "./depiction2d/client";
import type { DepictionRequestOptions } from "@chemdraft/rdkit-adapter";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { pastedStructureDepictionFromMolfile, type StructureTemplateMoleculeOptions } from "@chemdraft/document-workflow-core";
import { templateMoleculeForSmiles } from "./structureTemplateInsertion";

type TemplatePastePlacement = Pick<StructureTemplateMoleculeOptions, "document" | "centre" | "reservedObjectIds">;

/** Only unparseable text returns undefined; engine failures and chemistry refusals throw. */
export async function depictSmilesForPaste(
  smiles: string,
  options: DepictionRequestOptions = {},
  templatePlacement?: TemplatePastePlacement
): Promise<{ depiction: PastedStructureDepiction; stereoCount: number; warnings?: string[]; molecule?: MoleculeObject } | undefined> {
  try {
    // A known host must not depend on a generic coordinate generator succeeding first.
    // Build once at document default size; insertion reuses this molecule (the grid only translates it).
    const molecule = await templateMoleculeForSmiles(smiles,
      templatePlacement?.document ?? createEmptyDocument(),
      templatePlacement?.centre ?? { x: 0, y: 0 },
      templatePlacement?.reservedObjectIds);
    options.signal?.throwIfAborted();
    if (molecule) {
      templatePlacement?.reservedObjectIds?.add(molecule.id);
      const { perceiveStereoCentersFromMolfile } = await import("@chemdraft/ocl-adapter");
      return { molecule, depiction: pastedStructureDepictionFromMolfile(molecule.structure),
        stereoCount: perceiveStereoCentersFromMolfile(molecule.structure)
        .filter(centre => centre.isStereoCenter && centre.descriptor !== "unspecified").length };
    }
    const result = await depictSmilesOffThread(smiles, { priority: "interactive", ...options });
    return result.depiction.atoms.length > 0 ? result : undefined;
  } catch (error) {
    if ((error as { notSmiles?: boolean })?.notSmiles === true) return undefined;
    throw error;
  }
}

/** Any OpenChemLib refusal to change the structure (an invented radical or hydrogen). */
function isSmilesChemistryRefusal(error: unknown): error is Error {
  return error instanceof Error && (error as { smilesChemistryRefusal?: unknown }).smilesChemistryRefusal === true;
}

export interface SmilesListPasteResult {
  entries: { smiles: string; depiction: PastedStructureDepiction; molecule?: MoleculeObject }[];
  skipped: number;
  /** Per-item chemistry failures, including the input and the adapter's specific reason. */
  failures: SmilesListPasteFailure[];
  warnings?: string[];
}

export interface SmilesListPasteFailure {
  input: string;
  error: string;
}

/** A rejected list preserves its individual chemistry refusals for the status surface. */
export class SmilesListPasteError extends Error {
  readonly failures: readonly SmilesListPasteFailure[];

  constructor(failures: readonly SmilesListPasteFailure[]) {
    super("No structures in the SMILES list could be placed.");
    this.name = "SmilesListPasteError";
    this.failures = failures;
  }
}

export function depictSmilesListForPaste(
  text: string,
  candidates: readonly SmilesListCandidate[],
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
  templatePlacement?: TemplatePastePlacement
): Promise<SmilesListPasteResult | undefined> | undefined {
  // No promise or engine load for prose: the caller can insert its text synchronously.
  if (candidates.length < 2) return undefined;
  return depictSmilesListCandidates(text, candidates, onProgress, signal, templatePlacement);
}

async function depictSmilesListCandidates(
  text: string,
  candidates: readonly SmilesListCandidate[],
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
  templatePlacement: TemplatePastePlacement = { document: createEmptyDocument(), centre: { x: 0, y: 0 } }
): Promise<SmilesListPasteResult | undefined> {
  const entries: SmilesListPasteResult["entries"] = [];
  const failures: SmilesListPasteResult["failures"] = [];
  const warnings: string[] = [];
  const placement = { ...templatePlacement, reservedObjectIds: templatePlacement.reservedObjectIds ?? new Set<string>() };
  const tokens = smilesListTokens(text);
  const firstTokenColumns = new Map<number, number>();
  for (const token of tokens) {
    if (!firstTokenColumns.has(token.line)) firstTokenColumns.set(token.line, token.column);
  }
  let parsedFirstTokenLines = 0;
  for (const [index, candidate] of candidates.entries()) {
    signal?.throwIfAborted();
    let parsed: Awaited<ReturnType<typeof depictSmilesForPaste>> = undefined;
    try {
      parsed = await depictSmilesForPaste(candidate.token, { signal, priority: "background" }, placement);
    } catch (error) {
      if (!isSmilesChemistryRefusal(error)) throw error;
      failures.push({ input: candidate.token, error: error.message });
    }
    if (parsed) {
      entries.push({ smiles: candidate.token, depiction: parsed.depiction, ...(parsed.molecule ? { molecule: parsed.molecule } : {}) });
      warnings.push(...(parsed.warnings ?? []).map((warning) => `${candidate.token}: ${warning}`));
      if (candidate.column === firstTokenColumns.get(candidate.line)) parsedFirstTokenLines += 1;
    }
    if (candidates.length > 20 && (index + 1) % 10 === 0) {
      onProgress?.(index + 1, candidates.length);
      // Cached engines can finish each await in a microtask; yield so progress can paint.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const lineCount = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
  if (smilesListDecision({ candidates: tokens.length, parsed: entries.length, lineCount, parsedFirstTokenLines })) {
    return { entries, skipped: tokens.length - entries.length - failures.length, failures, ...(warnings.length ? { warnings } : {}) };
  }
  // Even a list with too few valid entries must retain the reasons it was refused.
  if (failures.length > 0) throw new SmilesListPasteError(failures);
  return undefined;
}
