import { smilesListDecision, smilesListTokens, type SmilesListCandidate } from "@chemdraft/clipboard-adapter";
import type { PastedStructureDepiction } from "./documentWorkflow";
import { depictSmilesOffThread } from "./depiction2d/client";
import type { DepictionRequestOptions } from "@chemdraft/rdkit-adapter";
import { SmilesIdentityEngineUnavailableError, SmilesPasteIdentityError } from "./smilesPasteIdentity";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { pastedStructureDepictionFromMolfile, type StructureTemplateMoleculeOptions } from "@chemdraft/document-workflow-core";
import { templateMoleculeForSmiles } from "./structureTemplateInsertion";

type TemplatePastePlacement = Pick<StructureTemplateMoleculeOptions, "document" | "centre" | "reservedObjectIds">;

export interface SmilesListPasteOptions {
  signal?: AbortSignal;
  inspectInput?: (smiles: string, signal?: AbortSignal) => Promise<void>;
  templatePlacement?: TemplatePastePlacement;
}

/** A valid input with no drawable atoms is an item failure, not a worker failure. */
class EmptySmilesDepictionError extends Error {}
const EMPTY_DEPICTION_MESSAGE = "The 2D depiction engine returned no atoms.";

export function unspecifiedDoubleBondNotice(count: number): string {
  return `E/Z was not specified for ${count} double bond(s) in the pasted structure. Confirm the geometry.`;
}

/** Only unparseable text returns undefined; engine failures and chemistry refusals throw. */
export async function depictSmilesForPaste(
  smiles: string,
  options: DepictionRequestOptions = {},
  templatePlacement?: TemplatePastePlacement
): Promise<{ depiction: PastedStructureDepiction; stereoCount: number; warnings?: string[]; molecule?: MoleculeObject } | undefined> {
  if (smiles.trim().length === 0) return undefined;
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
    if (result.depiction.atoms.length === 0) throw new EmptySmilesDepictionError(EMPTY_DEPICTION_MESSAGE);
    const count = result.depiction.bonds.filter(bond => bond.stereo === "either").length;
    return count ? { ...result, warnings: [...(result.warnings ?? []), unspecifiedDoubleBondNotice(count)] } : result;
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
  skippedItems: { line: number; token: string; reason: string }[];
  /** Per-item chemistry or empty-depiction failures, including the input and specific reason. */
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
  options: SmilesListPasteOptions = {}
): Promise<SmilesListPasteResult | undefined> | undefined {
  // No promise or engine load for prose: the caller can insert its text synchronously.
  if (candidates.length < 2) return undefined;
  return depictSmilesListCandidates(text, candidates, onProgress, options);
}

async function depictSmilesListCandidates(
  text: string,
  candidates: readonly SmilesListCandidate[],
  onProgress?: (completed: number, total: number) => void,
  { signal, inspectInput, templatePlacement = { document: createEmptyDocument(), centre: { x: 0, y: 0 } } }: SmilesListPasteOptions = {}
): Promise<SmilesListPasteResult | undefined> {
  const entries: SmilesListPasteResult["entries"] = [];
  const failures: SmilesListPasteResult["failures"] = [];
  const warnings: string[] = [];
  const handledTokens = new Set<string>();
  const identityRefusalReasons = new Map<string, string>();
  const placement = { ...templatePlacement, reservedObjectIds: templatePlacement.reservedObjectIds ?? new Set<string>() };
  const tokens = smilesListTokens(text);
  const firstTokenColumns = new Map<number, number>();
  for (const token of tokens) {
    if (!firstTokenColumns.has(token.line)) firstTokenColumns.set(token.line, token.column);
  }
  let parsedFirstTokenLines = 0;
  let openDoubleBonds = 0;
  let identityRefusals = 0;
  for (const [index, candidate] of candidates.entries()) {
    signal?.throwIfAborted();
    let parsed: Awaited<ReturnType<typeof depictSmilesForPaste>> = undefined;
    let identityRefused = false;
    try {
      await inspectInput?.(candidate.token, signal);
      signal?.throwIfAborted();
      parsed = await depictSmilesForPaste(candidate.token, { signal, priority: "background" }, placement);
    } catch (error) {
      if (error instanceof SmilesPasteIdentityError ||
        error instanceof SmilesIdentityEngineUnavailableError) {
        identityRefused = true;
        identityRefusals += 1;
        // The status renderer already names the token; retain the refusal's detail without
        // repeating the whole input (which can be a large host molecule).
        const prefix = `SMILES paste refused: chemical identity could not be verified for "${candidate.token}": `;
        const detail = (error.message.startsWith(prefix) ? error.message.slice(prefix.length)
          : error.message.replace(/^SMILES paste refused:\s*/, "")).replace(/\s+/g, " ").trim();
        identityRefusalReasons.set(`${candidate.line}:${candidate.column}`,
          detail.length > 160 ? `${detail.slice(0, 159)}…` : detail);
      } else if (!isSmilesChemistryRefusal(error) && !(error instanceof EmptySmilesDepictionError)) throw error;
      failures.push({ input: candidate.token, error: error.message });
      handledTokens.add(`${candidate.line}:${candidate.column}`);
    }
    if (parsed) {
      handledTokens.add(`${candidate.line}:${candidate.column}`);
      entries.push({ smiles: candidate.token, depiction: parsed.depiction, ...(parsed.molecule ? { molecule: parsed.molecule } : {}) });
      const count = parsed.depiction.bonds.filter(bond => bond.stereo === "either").length;
      openDoubleBonds += count;
      warnings.push(...(parsed.warnings ?? []).filter(warning => warning !== unspecifiedDoubleBondNotice(count))
        .map((warning) => `${candidate.token}: ${warning}`));
    }
    if ((parsed || identityRefused) && candidate.column === firstTokenColumns.get(candidate.line)) {
      parsedFirstTokenLines += 1;
    }
    if (candidates.length > 20 && (index + 1) % 10 === 0) {
      onProgress?.(index + 1, candidates.length);
      // Cached engines can finish each await in a microtask; yield so progress can paint.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const lineCount = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
  // Unsupported stereo counts as a structure when deciding whether this is a list or prose.
  if (smilesListDecision({
    candidates: tokens.length, parsed: entries.length + identityRefusals, lineCount, parsedFirstTokenLines
  })) {
    if (openDoubleBonds) warnings.push(unspecifiedDoubleBondNotice(openDoubleBonds));
    const skippedItems = tokens.filter(token => !handledTokens.has(`${token.line}:${token.column}`)
      || identityRefusalReasons.has(`${token.line}:${token.column}`))
      .map(({ line, column, token }) => ({ line, token,
        reason: identityRefusalReasons.get(`${line}:${column}`) ?? "not valid SMILES" }));
    return { entries, skipped: skippedItems.length, skippedItems, failures, ...(warnings.length ? { warnings } : {}) };
  }
  // Even a list with too few valid entries must retain the reasons it was refused.
  if (failures.length > identityRefusals) throw new SmilesListPasteError(failures);
  return undefined;
}
