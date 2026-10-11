import { createEmptyDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { planPageSvgRender, type LayoutBounds, type LayoutPoint } from "./index";
import { elementFragments } from "./testing";

export function filledRingFixture(): MoleculeObject {
  const atoms: MoleculeAtom[] = [[100, 100], [180, 100], [180, 180], [100, 180]].map(([x, y], index) => ({
    id: `a${index}`, element: "C", x: x!, y: y!, formalCharge: 0
  }));
  return {
    id: "notched-ring", type: "molecule", x: 90, y: 90, width: 100, height: 100, rotation: 0,
    structureFormat: "smiles", structure: "C1CCC1", superatoms: [], rGroups: [],
    atoms,
    bonds: atoms.map((atom, index) => ({
      id: `b${index}`, fromAtomId: atom.id, toAtomId: atoms[(index + 1) % atoms.length]!.id, order: "single"
    })),
    style: { source: "chemdraft-native-drawing", fillColor: "#ff0000", atomLabelBackgroundColor: "transparent" }
  };
}

export const renderRingFixture = (object: MoleculeObject) => planPageSvgRender({
  ...createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" }).pages[0]!, objects: [structuredClone(object)]
});
export const ringFixtureFragments = (object: MoleculeObject) => renderRingFixture(object).fragments.flatMap(elementFragments);
export const ringFixtureFills = (object: MoleculeObject) => ringFixtureFragments(object)
  .filter((fragment) => fragment.attrs["data-molecule-fill-ring"] === "true");

/** Synthetic fused-ring depictions exercising oxetane corners and inward steroid substituents. */
export function naturalProductLikeFixture(kind: "paclitaxel-like" | "cholesterol-like"): MoleculeObject {
  const object = filledRingFixture();
  object.id = kind;
  object.structure = "synthetic rendering fixture";
  object.atoms = [];
  object.bonds = [];
  const atomForPoint = (x: number, y: number) => {
    let atom = object.atoms.find((candidate) => candidate.x === x && candidate.y === y);
    if (!atom) {
      atom = { id: `a${object.atoms.length}`, element: "C", x, y, formalCharge: 0 };
      object.atoms.push(atom);
    }
    return atom;
  };
  const addRing = (points: number[][]) => {
    const atoms = points.map(([x, y]) => atomForPoint(x!, y!));
    atoms.forEach((atom, index) => {
      const next = atoms[(index + 1) % atoms.length]!;
      if (!object.bonds.some((bond) => [bond.fromAtomId, bond.toAtomId].includes(atom.id)
        && [bond.fromAtomId, bond.toAtomId].includes(next.id))) {
        object.bonds.push({ id: `b${object.bonds.length}`, fromAtomId: atom.id, toAtomId: next.id, order: "single" });
      }
    });
  };
  if (kind === "paclitaxel-like") {
    addRing([[100, 100], [140, 100], [140, 140], [100, 140]]);
    object.atoms[0]!.element = "O";
    addRing([[140, 100], [180, 80], [220, 100], [220, 140], [180, 160], [140, 140]]);
    addRing([[220, 100], [260, 80], [300, 100], [300, 140], [260, 160], [220, 140]]);
    addRing([[180, 160], [220, 140], [260, 160], [270, 200], [250, 230], [210, 240], [170, 220], [160, 190]]);
    object.atoms.find((atom) => atom.x === 260 && atom.y === 160)!.element = "O";
  } else {
    for (let i = 0; i < 3; i++) {
      const x = 100 + i * 80;
      addRing([[x, 100], [x + 40, 80], [x + 80, 100], [x + 80, 140], [x + 40, 160], [x, 140]]);
    }
    addRing([[340, 100], [380, 85], [410, 120], [380, 155], [340, 140]]);
    const oh = atomForPoint(85, 120);
    oh.element = "O";
    object.bonds.push({ id: "oh-bond", fromAtomId: "a0", toAtomId: oh.id, order: "single" });
  }
  const methyl = atomForPoint(165, 120);
  methyl.element = "Me";
  object.bonds.push({ id: "methyl-bond", fromAtomId: "a1", toAtomId: methyl.id, order: "single" });
  const hydrogen = atomForPoint(250, 120);
  hydrogen.element = "H";
  object.bonds.push({ id: "hydrogen-bond", fromAtomId: "a7", toAtomId: hydrogen.id, order: "single" });
  return object;
}

/** Read only the emitted plain polygon paths, independently of the production boolean code. */
export function polygonPathFaces(pathD: string): LayoutPoint[][] {
  return pathD.split(/Z/i).filter((face) => face.trim()).map((face) => {
    const values = face.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    return Array.from({ length: values.length / 2 }, (_, i) => ({ x: values[i * 2]!, y: values[i * 2 + 1]! }));
  });
}

const signedArea = (points: LayoutPoint[]) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]!;
  return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;

/** Independent Sutherland–Hodgman clipping of each oriented face to a text box. */
export function fillAreaInsideBox(pathD: string, box: LayoutBounds): number {
  return Math.abs(polygonPathFaces(pathD).reduce((area, face) => {
    let points = face;
    for (const [axis, boundary, sign] of [
      ["x", box.x, 1], ["x", box.x + box.width, -1],
      ["y", box.y, 1], ["y", box.y + box.height, -1]
    ] as const) {
      const input = points;
      points = [];
      input.forEach((end, index) => {
        const start = input[(index + input.length - 1) % input.length]!;
        const startInside = (start[axis] - boundary) * sign >= 0;
        const endInside = (end[axis] - boundary) * sign >= 0;
        if (startInside !== endInside) {
          const t = (boundary - start[axis]) / (end[axis] - start[axis]);
          points.push({ x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) });
        }
        if (endInside) points.push(end);
      });
    }
    return area + signedArea(points);
  }, 0));
}
