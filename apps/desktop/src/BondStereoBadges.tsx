import type { MoleculeObject } from "@chemdraft/chem-core";
import { nativeMoleculeBondDrawingStyle, nativeMultipleBondGapPx, planMoleculeAtomLabels } from "@chemdraft/layout-engine";

export const OPEN_DOUBLE_BOND_TOOLTIP = "E/Z was not specified for this double bond. Confirm the geometry by redrawing the bond or choosing 'Use drawn geometry'.";

/** Editor status chrome only. Label bounds come from the shared renderer. */
export function BondStereoBadges({ molecule }: { molecule: MoleculeObject }) {
  const openBonds = molecule.bonds.filter(bond => bond.order === "double" && bond.stereo === "either");
  if (!openBonds.length) return null;
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  const labels = planMoleculeAtomLabels(molecule).map(plan => plan.layout.bounds);
  return <>{openBonds.flatMap(bond => {
    const from = atoms.get(bond.fromAtomId), to = atoms.get(bond.toAtomId);
    if (!from || !to) return [];
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (!length) return [];
    const style = nativeMoleculeBondDrawingStyle(molecule, bond.id);
    const clearance = Math.max(14, nativeMultipleBondGapPx(style) + 8 + Math.max(style.bondStrokeWidthPx, style.bondBoldWidthPx) / 2);
    // Position the status icon, without changing any molecule drawing geometry.
    const candidates = [clearance, -clearance, clearance + 8, -clearance - 8, clearance + 16, -clearance - 16, clearance + 28, -clearance - 28].map(offset => ({
      x: (from.x + to.x) / 2 - dy / length * offset,
      y: (from.y + to.y) / 2 + dx / length * offset
    }));
    const point = candidates.find(p => labels.every(b =>
      p.x + 7 < b.x || p.x - 7 > b.x + b.width || p.y + 7 < b.y || p.y - 7 > b.y + b.height)) ?? candidates[0];
    const x = point.x - molecule.x, y = point.y - molecule.y;
    return [<g key={bond.id} className="native-atom-invalid-marker native-bond-stereo-marker" data-unspecified-bond-id={bond.id}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}>
      <title>{OPEN_DOUBLE_BOND_TOOLTIP}</title>
      <circle className="native-atom-invalid-ring" cx={x} cy={y} r="6" />
      <text className="native-atom-invalid-exclamation" x={x} y={y}>!</text>
    </g>];
  })}</>;
}
