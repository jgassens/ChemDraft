import { DocumentObjectSchema, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";

/** Original native depictions for threading tests, not engine predictions. CBPQT4+ comprises
 * two 4,4'-bipyridinium units and two p-xylylene bridges (C36H32N4, +4). The crown fixture is
 * 30-crown-10 (C20H40O10). These exercise figure topology, not predicted conformations. */
class FigureGraph {
  atoms: MoleculeAtom[] = [];
  bonds: MoleculeBond[] = [];
  atom(x: number, y: number, element = "C", charge = 0): string {
    const id = `a${this.atoms.length}`;
    this.atoms.push({ id, element, x, y, formalCharge: charge });
    return id;
  }
  bond(fromAtomId: string, toAtomId: string, order: MoleculeBond["order"] = "single") {
    this.bonds.push({ id: `b${this.bonds.length}`, fromAtomId, toAtomId, order });
  }
  hexagon(x: number, y: number, angle: number, pyridinium = false) {
    const ids = Array.from({ length: 6 }, (_, i) => this.atom(x + 20 * Math.cos(angle + i * Math.PI / 3),
      y + 20 * Math.sin(angle + i * Math.PI / 3), pyridinium && i === 0 ? "N" : "C", pyridinium && i === 0 ? 1 : 0));
    ids.forEach((id, i) => this.bond(id, ids[(i + 1) % 6]!, i % 2 === 0 ? "double" : "single"));
    return ids;
  }
  finish(id: string): MoleculeObject {
    const x = Math.min(...this.atoms.map(a => a.x)), y = Math.min(...this.atoms.map(a => a.y));
    return DocumentObjectSchema.parse({ id, type: "molecule", structure: "", x, y,
      width: Math.max(...this.atoms.map(a => a.x)) - x, height: Math.max(...this.atoms.map(a => a.y)) - y,
      atoms: this.atoms, bonds: this.bonds }) as MoleculeObject;
  }
}
export function cbpqt(id: string): MoleculeObject {
  const g = new FigureGraph();
  const leftTop = g.hexagon(-60, -35, -Math.PI / 2, true);
  const leftBottom = g.hexagon(-60, 35, Math.PI / 2, true);
  const rightTop = g.hexagon(60, -35, -Math.PI / 2, true);
  const rightBottom = g.hexagon(60, 35, Math.PI / 2, true);
  g.bond(leftTop[3]!, leftBottom[3]!); g.bond(rightTop[3]!, rightBottom[3]!);
  for (const [y, left, right] of [[-90, leftTop, rightTop], [90, leftBottom, rightBottom]] as const) {
    const phenyl = g.hexagon(0, y, 0);
    const ch2Left = g.atom(-40, y), ch2Right = g.atom(40, y);
    g.bond(left[0]!, ch2Left); g.bond(ch2Left, phenyl[3]!);
    g.bond(right[0]!, ch2Right); g.bond(ch2Right, phenyl[0]!);
  }
  return g.finish(id);
}
export function ttf(id: string): MoleculeObject {
  const g = new FigureGraph();
  const centers: string[] = [];
  for (const sign of [-1, 1]) {
    const center = g.atom(sign * 16, 0);
    centers.push(center);
    const s1 = g.atom(sign * 40, -26, "S"), c1 = g.atom(sign * 80, -15);
    const c2 = g.atom(sign * 80, 15), s2 = g.atom(sign * 40, 26, "S");
    g.bond(center, s1); g.bond(s1, c1); g.bond(c1, c2, "double"); g.bond(c2, s2); g.bond(s2, center);
  }
  g.bond(centers[0]!, centers[1]!, "double");
  return g.finish(id);
}
export function crown(id: string): MoleculeObject {
  const g = new FigureGraph();
  const ids = Array.from({ length: 30 }, (_, i) => {
    const angle = (i + 0.27) * 2 * Math.PI / 30;
    return g.atom(85 * Math.cos(angle), 38 * Math.sin(angle), i % 3 === 0 ? "O" : "C");
  });
  ids.forEach((id, i) => g.bond(id, ids[(i + 1) % ids.length]!));
  return g.finish(id);
}
