import type { ComputeStructureIdentifiers } from "./moleculeSmiles";

/** Compare the raw source with the exact final CTAB, using the caller's identifier engine.
 * No stereo masking, coordinate rewriting, or native SMILES fallback is safe at this boundary.
 */
export async function assertMolfileExportIdentity(
  sourceMolfile: string,
  exportedMolfile: string,
  computeStructureIdentifiers: ComputeStructureIdentifiers | undefined,
  label: string
): Promise<void> {
  const canonicalSmiles = async (molfile: string, side: "source" | "exported"): Promise<string> => {
    try {
      const identifiers = await computeStructureIdentifiers?.(molfile);
      if (!identifiers?.smiles) throw new Error("canonical SMILES unavailable");
      return identifiers.smiles;
    } catch (error) {
      throw new Error(`${label} refused: could not verify the ${side} structure (${error instanceof Error ? error.message : String(error)}).`);
    }
  };
  const source = await canonicalSmiles(sourceMolfile, "source");
  const exported = await canonicalSmiles(exportedMolfile, "exported");
  if (source !== exported) {
    throw new Error(`${label} refused: exported coordinates would change the structure (${source} became ${exported}).`);
  }
}
