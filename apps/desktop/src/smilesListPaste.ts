import { smilesListDecision, smilesListTokens, type SmilesListCandidate } from "@chemdraft/clipboard-adapter";
import type { PastedStructureDepiction } from "./documentWorkflow";
import { depictSmilesOffThread } from "./depiction2d/client";
import type { DepictionRequestOptions } from "@chemdraft/rdkit-adapter";
import { SmilesIdentityEngineUnavailableError, SmilesPasteIdentityError } from "./smilesPasteIdentity";

/** Only unparseable text returns undefined; engine failures and chemistry refusals throw. */
export async function depictSmilesForPaste(
  smiles: string,
  options: DepictionRequestOptions = {}
): Promise<{ depiction: PastedStructureDepiction; stereoCount: number; warnings?: string[] } | undefined> {
  try {
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
  entries: { smiles: string; depiction: PastedStructureDepiction }[];
  skipped: number;
  /** Per-item chemistry failures, including the input and the adapter's specific reason. */
  failures: SmilesListPasteFailure[];
  warnings?: string[];
}

export interface SmilesListPasteFailure {
  input: string;
  error: string;
}

export function smilesListFailureStatus(failures: readonly SmilesListPasteFailure[]): string {
  const first = failures.slice(0, 3).map(failure => `${failure.input}: ${failure.error}`).join("; ");
  return first + (failures.length > 3 ? `; and ${failures.length - 3} more` : "");
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
  inspectInput?: (smiles: string) => Promise<void>
): Promise<SmilesListPasteResult | undefined> | undefined {
  // No promise or engine load for prose: the caller can insert its text synchronously.
  if (candidates.length < 2) return undefined;
  return depictSmilesListCandidates(text, candidates, onProgress, signal, inspectInput);
}

async function depictSmilesListCandidates(
  text: string,
  candidates: readonly SmilesListCandidate[],
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
  inspectInput?: (smiles: string) => Promise<void>
): Promise<SmilesListPasteResult | undefined> {
  const entries: { smiles: string; depiction: PastedStructureDepiction }[] = [];
  const failures: SmilesListPasteResult["failures"] = [];
  const warnings: string[] = [];
  const tokens = smilesListTokens(text);
  const firstTokenColumns = new Map<number, number>();
  for (const token of tokens) {
    if (!firstTokenColumns.has(token.line)) firstTokenColumns.set(token.line, token.column);
  }
  let parsedFirstTokenLines = 0;
  let identityRefused = false;
  for (const [index, candidate] of candidates.entries()) {
    signal?.throwIfAborted();
    let parsed: Awaited<ReturnType<typeof depictSmilesForPaste>> = undefined;
    try {
      await inspectInput?.(candidate.token);
      signal?.throwIfAborted();
      parsed = await depictSmilesForPaste(candidate.token, { signal, priority: "background" });
    } catch (error) {
      if (error instanceof SmilesPasteIdentityError ||
        error instanceof SmilesIdentityEngineUnavailableError) {
        identityRefused = true;
      } else if (!isSmilesChemistryRefusal(error)) throw error;
      failures.push({ input: candidate.token, error: error.message });
    }
    if (parsed) {
      entries.push({ smiles: candidate.token, depiction: parsed.depiction });
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
  // Identity failures keep their refusal even when too few entries remain to form a grid.
  if (identityRefused || smilesListDecision({
    candidates: tokens.length, parsed: entries.length, lineCount, parsedFirstTokenLines
  })) {
    return { entries, skipped: tokens.length - entries.length - failures.length, failures, ...(warnings.length ? { warnings } : {}) };
  }
  // Even a list with too few valid entries must retain the reasons it was refused.
  if (failures.length > 0) throw new SmilesListPasteError(failures);
  return undefined;
}
