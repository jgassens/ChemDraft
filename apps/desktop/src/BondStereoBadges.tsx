import type { MoleculeObject } from "@chemdraft/chem-core";
import { nativeMoleculeBondDrawingStyle, nativeMultipleBondGapPx, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import type { BondStereoBadgeRequest } from "./useBondStereoPopover";

export const OPEN_DOUBLE_BOND_TOOLTIP = "E/Z was not specified for this double bond. Confirm the geometry by redrawing the bond or choosing 'Use drawn geometry'.";

/** Resolve editor chrome before the canvas routes a press to handles or molecule tools.
 * Client bounds include the actual SVG placement and zoom, even when a handle covers it.
 */
export function bondStereoBadgeAtPointer(canvas: Element, event: { target: EventTarget | null; clientX: number; clientY: number }): SVGGElement | undefined {
  const direct = event.target instanceof Element ? event.target.closest<SVGGElement>("[data-unspecified-bond-id]") : null;
  if (direct && canvas.contains(direct)) return direct;
  return [...canvas.querySelectorAll<SVGGElement>("[data-unspecified-bond-id]")].reverse().find(badge => {
    const rect = badge.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
}

/** Editor status chrome only. Label bounds come from the shared renderer. */
export function BondStereoBadges({ molecule, onOpen }: { molecule: MoleculeObject; onOpen?: (request: BondStereoBadgeRequest) => void }) {
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
      role="button" tabIndex={0} aria-label="E/Z not specified" aria-haspopup="dialog"
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
      onPointerUp={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onOpen?.({ objectId: molecule.id, bondId: bond.id,
        rect: event.currentTarget.getBoundingClientRect(), keyboard: false }); }}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) onOpen?.({ objectId: molecule.id, bondId: bond.id,
          rect: event.currentTarget.getBoundingClientRect(), keyboard: true });
      }}>
      <title>{OPEN_DOUBLE_BOND_TOOLTIP}</title>
      <circle className="native-atom-invalid-ring" cx={x} cy={y} r="6" />
      <text className="native-atom-invalid-exclamation" x={x} y={y}>!</text>
    </g>];
  })}</>;
}
