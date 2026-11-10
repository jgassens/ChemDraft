import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import type { ComputeStructureIdentifiers } from "./moleculeSmiles";

/** Compare the raw source with the exact final CTAB, using the caller's identifier engine.
 * When either canonical identity is unavailable, compare the coordinate-free CTAB graph.
 * Never mask stereo, rewrite coordinates, or substitute native SMILES at this boundary.
 */
export async function assertMolfileExportIdentity(
  sourceMolfile: string,
  exportedMolfile: string,
  computeStructureIdentifiers: ComputeStructureIdentifiers | undefined,
  label: string
): Promise<void> {
  const canonicalSmiles = async (molfile: string): Promise<string | undefined> => {
    try {
      return (await computeStructureIdentifiers?.(molfile))?.smiles || undefined;
    } catch {
      return undefined;
    }
  };
  const source = await canonicalSmiles(sourceMolfile);
  const exported = await canonicalSmiles(exportedMolfile);
  if (source !== undefined && exported !== undefined) {
    if (source !== exported) {
      throw new Error(`${label} refused: exported coordinates would change the structure (${source} became ${exported}).`);
    }
    return;
  }
  const structure = (molfile: string, side: "source" | "exported") => {
    try {
      return coordinateFreeStructure(molfile);
    } catch (error) {
      throw new Error(`${label} refused: could not verify the ${side} structure (${error instanceof Error ? error.message : String(error)}).`);
    }
  };
  if (structure(sourceMolfile, "source") !== structure(exportedMolfile, "exported")) {
    throw new Error(`${label} refused: exported coordinates would change the structure (coordinate-free MOL atom or bond data differ).`);
  }
}

function coordinateFreeStructure(molfile: string): string {
  const graph = parseMolfileGraph(molfile);
  const lines = molfile.replace(/\r\n?/g, "\n").split("\n");
  const radicals = graph.atoms.map(() => 0);
  const bondEncoding: { type: number; stereo: number }[] = [];
  // The clipboard parser owns element/charge/isotope and directed connectivity. Supplement
  // fields it does not expose: MDL radical codes, exact query bond types, and raw stereo flags.
  if (graph.format === "molfile-v2000") {
    const counts = lines.findIndex(line => /V2000\s*$/.test(line));
    const atomStart = counts + 1;
    for (const [index] of graph.atoms.entries()) {
      // Atom-block charge code 4 denotes a doublet radical.
      radicals[index] = Number(lines[atomStart + index]!.slice(36, 39)) === 4 ? 2 : 0;
    }
    const bondStart = atomStart + graph.atoms.length;
    for (const line of lines.slice(bondStart, bondStart + graph.bonds.length)) {
      bondEncoding.push({ type: Number(line.slice(6, 9)), stereo: Number(line.slice(9, 12)) });
    }
    for (const line of lines.slice(bondStart + graph.bonds.length)) {
      if (line.trim() === "M  END") break;
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== "M" || fields[1] !== "RAD") continue;
      for (let index = 0; index < Number(fields[2]); index++) {
        const atomIndex = Number(fields[3 + index * 2]) - 1;
        if (!graph.atoms[atomIndex]) throw new Error("MOL radical has an invalid atom reference.");
        radicals[atomIndex] = Number(fields[4 + index * 2]);
      }
    }
  } else {
    // Join V3000 continuations before reading attributes; the graph parser does the same.
    let block = lines.filter(line => /^M  V30\s/.test(line)).map(line => line.slice(7)).join("\n");
    block = block.replace(/-\n/g, "");
    let section: "ATOM" | "BOND" | undefined;
    let atomIndex = 0;
    for (const line of block.split("\n")) {
      if (line === "BEGIN ATOM") { section = "ATOM"; continue; }
      if (line === "BEGIN BOND") { section = "BOND"; continue; }
      if (line.startsWith("END ")) { section = undefined; continue; }
      if (section === "ATOM") radicals[atomIndex++] = Number(line.match(/\bRAD=(\d+)\b/)?.[1] ?? 0);
      if (section === "BOND") bondEncoding.push({
        type: Number(line.split(/\s+/)[1]), stereo: Number(line.match(/\bCFG=(\d+)\b/)?.[1] ?? 0)
      });
    }
  }
  const atomIndices = new Map(graph.atoms.map((atom, index) => [atom.id, index]));
  return JSON.stringify({
    atoms: graph.atoms.map((atom, index) => [atom.element, atom.formalCharge, atom.isotope ?? 0, radicals[index]]),
    bonds: graph.bonds.map((bond, index) => {
      const from = atomIndices.get(bond.fromAtomId);
      const to = atomIndices.get(bond.toAtomId);
      if (from === undefined || to === undefined) throw new Error("MOL bond has an invalid atom reference.");
      return [from, to, bond.order, bond.bondStyle ?? null, bond.stereo ?? null, bondEncoding[index]];
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  });
}
