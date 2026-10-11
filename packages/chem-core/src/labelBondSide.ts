// The side of an atom label its bonds are drawn on: the geometry behind `MoleculeAtom.labelBondSide`.

/**
 * "right" when every bonded neighbour lies to the label atom's right — the test, and tolerance,
 * that draws a hydroxyl as "HO" — and "left" otherwise (a vertical bond included); undefined with
 * no neighbours. Shared by the recorder (document-workflow-core) and the CDXML writer, which warns
 * when a molecule turned round since its labels were written would read differently from its
 * drawing alone.
 */
export function drawnLabelBondSide(
  atom: { x: number },
  neighbours: readonly { x: number }[]
): "left" | "right" | undefined {
  if (neighbours.length === 0) return undefined;
  return neighbours.every((neighbour) => neighbour.x > atom.x + 0.001) ? "right" : "left";
}
