import type { MoleculeObject } from "@chemdraft/chem-core";
import { planMoleculeAtomLabels } from "@chemdraft/layout-engine";

/** Measure the renderer's actual upright text boxes at the molecule's normal style. */
export function renderedLabelClearance(molecule: MoleculeObject) {
  const boxes = planMoleculeAtomLabels(molecule).map(plan => ({
    atomId: plan.atom.id, label: plan.label,
    left: plan.anchor.x + plan.layout.bounds.x,
    top: plan.anchor.y + plan.layout.bounds.y,
    right: plan.anchor.x + plan.layout.bounds.x + plan.layout.bounds.width,
    bottom: plan.anchor.y + plan.layout.bounds.y + plan.layout.bounds.height
  }));
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  let labelGapPx = Infinity, bondGapPx = Infinity;
  const collisions: string[] = [];
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const gap = Math.hypot(Math.max(0, box.left - other.right, other.left - box.right),
        Math.max(0, box.top - other.bottom, other.top - box.bottom));
      labelGapPx = Math.min(labelGapPx, gap);
      if (gap === 0) collisions.push(`${box.atomId} ${box.label} / ${other.atomId} ${other.label}`);
    }
    for (const bond of molecule.bonds) {
      if (bond.fromAtomId === box.atomId || bond.toAtomId === box.atomId) continue;
      const a = atoms.get(bond.fromAtomId)!, b = atoms.get(bond.toAtomId)!;
      // Distance to a convex box along a segment is convex; ternary minimisation
      // measures all four edges and corners without substituting atom centres.
      const distanceAt = (t: number) => {
        const x = a.x + t * (b.x - a.x), y = a.y + t * (b.y - a.y);
        return Math.hypot(Math.max(0, box.left - x, x - box.right), Math.max(0, box.top - y, y - box.bottom));
      };
      let low = 0, high = 1;
      for (let step = 0; step < 60; step++) {
        const first = (2 * low + high) / 3, second = (low + 2 * high) / 3;
        if (distanceAt(first) < distanceAt(second)) high = second; else low = first;
      }
      const gap = Math.min(distanceAt(0), distanceAt(1), distanceAt((low + high) / 2));
      bondGapPx = Math.min(bondGapPx, gap);
      if (gap < 1e-6) collisions.push(`${box.atomId} ${box.label} / bond ${bond.id}`);
    }
  }
  return { labelGapPx, bondGapPx, collisions };
}
