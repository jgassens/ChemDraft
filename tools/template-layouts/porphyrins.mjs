import { finishLayout, regularPolygon } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

const entries = [
  {
    id: "porphine", name: "Porphine", synonyms: ["porphin", "porphyrin (parent)", "21H,23H-porphine"],
    cid: 66868, formula: "C20H14N4",
    smiles: "C1=CC2=CC3C=CC(N=3)=CC4=CC=C(N4)C=C5C=CC(=N5)C=C1N2",
    note: "Stored as the 21H,23H tautomer chemists draw (NH on opposite pyrroles); PubChem CID 66868 lists the same compound as the 21H,22H tautomer. Tautomers have different canonical SMILES, so the stored SMILES is the drawn one."
  },
  {
    id: "tetraphenylporphyrin", name: "Tetraphenylporphyrin",
    synonyms: ["TPP", "H2TPP", "meso-tetraphenylporphyrin", "5,10,15,20-tetraphenylporphyrin", "5,10,15,20-tetraphenyl-21H,23H-porphine", "tetraphenylporphine"],
    cid: 86280046, formula: "C44H30N4",
    smiles: "C1=CC=C(C=C1)C2=C3C=CC(=C(C4=NC(=C(C5=CC=C(N5)C(=C6C=CC2=N6)C7=CC=CC=C7)C8=CC=CC=C8)C=C4)C9=CC=CC=C9)N3",
    note: "Free-base meso-tetraphenylporphyrin; the supplied Kekulé tautomer and its opposite inner NH sites are retained."
  }
];

/** Read only the explicit C/N, single/double-bond SMILES grammar used by these two identities.
 * This supplies connectivity and Kekulé orders, never coordinates or a depiction engine.
 */
function identityGraph(smiles) {
  const atoms = [], bonds = [], branches = [], closures = new Map();
  let previous = null, order = 1;
  for (const token of smiles.match(/C|N|=|\(|\)|\d/g) ?? []) {
    if (token === "C" || token === "N") {
      const next = atoms.length;
      atoms.push({ element: token });
      if (previous !== null) bonds.push([previous, next, order]);
      previous = next; order = 1;
    } else if (token === "=") order = 2;
    else if (token === "(") branches.push(previous);
    else if (token === ")") previous = branches.pop();
    else if (closures.has(token)) {
      const [start, pendingOrder] = closures.get(token);
      bonds.push([start, previous, Math.max(order, pendingOrder)]);
      closures.delete(token); order = 1;
    } else { closures.set(token, [previous, order]); order = 1; }
  }
  if (closures.size || branches.length || !/^(?:C|N|=|\(|\)|\d)+$/.test(smiles)) throw new Error("Unsupported porphyrin identity grammar.");
  const neighbours = atoms.map(() => []);
  for (const [a, b] of bonds) { neighbours[a].push(b); neighbours[b].push(a); }
  return { atoms, bonds, neighbours };
}

function porphyrinLayout(smiles) {
  const { atoms, bonds, neighbours } = identityGraph(smiles);
  // Find each pyrrole by the four-carbon path joining the two neighbours of its nitrogen.
  const pyrroles = atoms.flatMap((atom, nitrogen) => {
    if (atom.element !== "N") return [];
    const [first, last] = neighbours[nitrogen];
    for (const beta1 of neighbours[first].filter((id) => id !== nitrogen)) {
      for (const beta2 of neighbours[beta1].filter((id) => id !== first)) {
        if (neighbours[beta2].includes(last)) return [[nitrogen, first, beta1, beta2, last]];
      }
    }
    throw new Error("Missing pyrrole ring.");
  });
  const owner = new Map(pyrroles.flatMap((ring, i) => ring.map((id) => [id, i])));
  const bridges = atoms.flatMap((_, id) => {
    if (owner.has(id)) return [];
    const alpha = neighbours[id].filter((next) => owner.has(next));
    return alpha.length === 2 ? [{ id, alpha, rings: alpha.map((next) => owner.get(next)) }] : [];
  });
  if (pyrroles.length !== 4 || bridges.length !== 4) throw new Error("Expected four pyrroles and four meso bridges.");
  // Original square construction: regular unit pentagons at the corners. The meso bonds
  // make 120 degrees, and any meso phenyl lies on the outward horizontal/vertical axis.
  const radius = 1 / (2 * Math.sin(Math.PI / 5));
  const corner = -radius * Math.cos(153 * Math.PI / 180) + Math.sqrt(3) / 2;
  const mesoRadius = corner + radius * Math.sin(153 * Math.PI / 180) + 0.5;
  let current = 0, previousBridge = null;
  for (let quadrant = 0; quadrant < 4; quadrant += 1) {
    const forward = bridges.find((bridge) => bridge.rings.includes(current) && bridge !== previousBridge &&
      (quadrant !== 3 || bridge.rings.includes(0)));
    if (!forward) throw new Error("Porphyrin core is not one four-pyrrole cycle.");
    const alpha = forward.alpha.find((id) => owner.get(id) === current);
    const ring = pyrroles[current];
    const ordered = ring[1] === alpha ? ring : [ring[0], ...ring.slice(1).reverse()];
    const rotation = Math.PI / 4 + quadrant * Math.PI / 2;
    for (let i = 0; i < 5; i += 1) {
      const angle = Math.PI - i * 2 * Math.PI / 5 + rotation;
      atoms[ordered[i]].x = Math.SQRT2 * corner * Math.cos(rotation) + radius * Math.cos(angle);
      atoms[ordered[i]].y = Math.SQRT2 * corner * Math.sin(rotation) + radius * Math.sin(angle);
    }
    const angle = (quadrant + 1) * Math.PI / 2;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    Object.assign(atoms[forward.id], { x: mesoRadius * direction.x, y: mesoRadius * direction.y });
    const phenylStart = neighbours[forward.id].find((id) => !owner.has(id));
    if (phenylStart !== undefined) {
      // The attachment vertex is one bond beyond meso; the hexagon centre is one more.
      const hexagon = regularPolygon(6, angle + Math.PI);
      let atom = phenylStart, before = forward.id;
      for (let i = 0; i < 6; i += 1) {
        Object.assign(atoms[atom], {
          x: (mesoRadius + 2) * direction.x + hexagon[i].x,
          y: (mesoRadius + 2) * direction.y + hexagon[i].y
        });
        const next = neighbours[atom].find((id) => id !== before && id !== forward.id);
        before = atom; atom = next;
      }
    }
    current = forward.rings.find((id) => id !== current);
    previousBridge = forward;
  }
  if (atoms.some((atom) => !Number.isFinite(atom.x) || !Number.isFinite(atom.y))) throw new Error("Unplaced porphyrin atom.");
  return finishLayout({ atoms, bonds });
}

export const generator = {
  scriptName: "porphyrins.mjs",
  fileName: "porphyrins.ts",
  exportName: "porphyrinsTemplates",
  generateTemplates: () => entries.map(({ cid, ...entry }) => ({
    ...entry, family: "porphyrins", category: "supramolecular", charge: 0,
    source: { database: "PubChem", cid }, layout: porphyrinLayout(entry.smiles)
  }))
};

runFamilyIfMain(import.meta.url, generator);
