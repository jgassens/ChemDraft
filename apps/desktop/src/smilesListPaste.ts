import { smilesListDecision, type SmilesListCandidate } from "@chemdraft/clipboard-adapter";
import { pastedStructureDepictionFromMolfile, type PastedStructureDepiction } from "./documentWorkflow";

/** Depiction engines stay lazy; undefined lets the caller preserve unparseable input as text. */
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
  } catch {
    return undefined;
  }
}

export async function depictSmilesListForPaste(
  text: string,
  candidates: readonly SmilesListCandidate[],
  onProgress?: (completed: number, total: number) => void
): Promise<{ entries: { smiles: string; depiction: PastedStructureDepiction }[]; skipped: number } | undefined> {
  const entries: { smiles: string; depiction: PastedStructureDepiction }[] = [];
  const seenLines = new Set<number>();
  let parsedFirstTokenLines = 0;
  for (const [index, candidate] of candidates.entries()) {
    const parsed = await depictSmilesForPaste(candidate.token);
    if (parsed) {
      entries.push({ smiles: candidate.token, depiction: parsed.depiction });
      if (!seenLines.has(candidate.line)) parsedFirstTokenLines += 1;
    }
    seenLines.add(candidate.line);
    if (candidates.length > 20 && (index + 1) % 10 === 0) {
      onProgress?.(index + 1, candidates.length);
      // Cached engines can finish each await in a microtask; yield so progress can paint.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const lineCount = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
  return smilesListDecision({ candidates: candidates.length, parsed: entries.length, lineCount, parsedFirstTokenLines })
    ? { entries, skipped: candidates.length - entries.length }
    : undefined;
}
