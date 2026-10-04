import { smilesListDecision, smilesListTokens, type SmilesListCandidate } from "@chemdraft/clipboard-adapter";
import { pastedStructureDepictionFromMolfile, type PastedStructureDepiction } from "./documentWorkflow";

/** Depiction engines stay lazy; undefined preserves unparseable text. Chemistry refusals throw. */
export async function depictSmilesForPaste(
  smiles: string
): Promise<{ depiction: PastedStructureDepiction; stereoCount: number } | undefined> {
  try {
    const ocl = await import("@chemdraft/ocl-adapter");
    let depiction: PastedStructureDepiction;
    let stereoCount = 0;
    try {
      const [{ registerRdkitWasmLoader }, rdkit] = await Promise.all([
        import("./rdkitWasmLoader"),
        import("@chemdraft/rdkit-adapter")
      ]);
      registerRdkitWasmLoader();
      const generatedMolfile = await rdkit.generateSmiles2DMolfile(smiles);
      depiction = pastedStructureDepictionFromMolfile(generatedMolfile);
      stereoCount = ocl.perceiveStereoCentersFromMolfile(generatedMolfile)
        .filter((center) => center.isStereoCenter).length;
    } catch {
      // RDKit is the readability-first path for fused/bridged systems. OpenChemLib remains a
      // complete local fallback if its WASM asset cannot be loaded or cannot depict a SMILES.
      const fallback = ocl.depictSmiles2D(smiles);
      try {
        depiction = pastedStructureDepictionFromMolfile(fallback.molfile);
        stereoCount = ocl.perceiveStereoCentersFromMolfile(fallback.molfile)
          .filter((center) => center.isStereoCenter).length;
      } catch {
        // Very large layouts can overflow V2000's fixed-width coordinate columns. Preserve
        // OCL's structured atoms/bonds directly if its compatibility molfile cannot be reparsed.
        depiction = {
          atoms: fallback.atoms.map((atom) => ({
            element: atom.element,
            x: atom.x,
            y: atom.y,
            charge: atom.charge
          })),
          bonds: fallback.bonds.map((bond) => ({
            from: bond.from,
            to: bond.to,
            // Carry aromatic/unknown orders too; collapsing to single changes the chemistry.
            order: bond.order,
            wedge: bond.wedge
          }))
        };
        // Prefer perceived stereocenters; approximate with wedges only if perception also fails.
        try {
          stereoCount = ocl.perceiveStereoCentersFromMolfile(fallback.molfile)
            .filter((center) => center.isStereoCenter).length;
        } catch {
          stereoCount = fallback.bonds.filter((bond) => bond.wedge !== null).length;
        }
      }
    }
    return depiction.atoms.length > 0 ? { depiction, stereoCount } : undefined;
  } catch (error) {
    // Keep a chemical-meaning refusal distinct from ordinary prose that is not SMILES. Engines
    // stay dynamically imported, so use the error's typed name rather than a startup import.
    if (isSmilesRadicalRefusal(error)) throw error;
    return undefined;
  }
}

function isSmilesRadicalRefusal(error: unknown): error is Error {
  return error instanceof Error && error.name === "UnrequestedSmilesRadicalError";
}

export interface SmilesListPasteResult {
  entries: { smiles: string; depiction: PastedStructureDepiction }[];
  skipped: number;
  /** Per-item chemistry failures, including the input and the adapter's specific reason. */
  failures: SmilesListPasteFailure[];
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
  onProgress?: (completed: number, total: number) => void
): Promise<SmilesListPasteResult | undefined> | undefined {
  // No promise or engine load for prose: the caller can insert its text synchronously.
  if (candidates.length < 2) return undefined;
  return depictSmilesListCandidates(text, candidates, onProgress);
}

async function depictSmilesListCandidates(
  text: string,
  candidates: readonly SmilesListCandidate[],
  onProgress?: (completed: number, total: number) => void
): Promise<SmilesListPasteResult | undefined> {
  const entries: { smiles: string; depiction: PastedStructureDepiction }[] = [];
  const failures: SmilesListPasteResult["failures"] = [];
  const tokens = smilesListTokens(text);
  const firstTokenColumns = new Map<number, number>();
  for (const token of tokens) {
    if (!firstTokenColumns.has(token.line)) firstTokenColumns.set(token.line, token.column);
  }
  let parsedFirstTokenLines = 0;
  for (const [index, candidate] of candidates.entries()) {
    let parsed: Awaited<ReturnType<typeof depictSmilesForPaste>> = undefined;
    try {
      parsed = await depictSmilesForPaste(candidate.token);
    } catch (error) {
      if (!isSmilesRadicalRefusal(error)) throw error;
      failures.push({ input: candidate.token, error: error.message });
    }
    if (parsed) {
      entries.push({ smiles: candidate.token, depiction: parsed.depiction });
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
    return { entries, skipped: tokens.length - candidates.length, failures };
  }
  // Even a list with too few valid entries must retain the reasons it was refused.
  if (failures.length > 0) throw new SmilesListPasteError(failures);
  return undefined;
}
