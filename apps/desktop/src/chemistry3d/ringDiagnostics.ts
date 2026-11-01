/** Test-only geometric evidence for trapped starts. Enumerate small chemical rings and
 * test foreign bonds against a triangle fan spanning each ring. Not a chemistry validator. */
import type { Plugin3DModel } from "@chemdraft/plugin-api";

type V = number[];
const sub = (a: V, b: V) => a.map((v, i) => v - b[i]);
const dot = (a: V, b: V) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function pierces(p: V, q: V, a: V, b: V, c: V): boolean {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-8) return false;
  const s = sub(p, a), u = dot(s, h) / det;
  const v = dot(d, cross(s, e1)) / det, t = dot(e2, cross(s, e1)) / det;
  return u > -1e-7 && v > -1e-7 && u + v < 1 + 1e-7 && t > 1e-6 && t < 1 - 1e-6;
}

export function smallRingPiercings(model: Plugin3DModel): { ring: number[]; bond: number[] }[] {
  const adjacency = model.atoms.map(() => [] as number[]);
  for (const { a, b } of model.bonds) if (model.atoms[a].element !== "H" && model.atoms[b].element !== "H") {
    adjacency[a].push(b); adjacency[b].push(a);
  }
  const rings: number[][] = [];
  const walk = (path: number[]) => {
    for (const next of adjacency[path[path.length - 1]]) {
      if (next === path[0] && path.length >= 5 && path[1] < path[path.length - 1]) rings.push(path);
      else if (path.length < 6 && next > path[0] && !path.includes(next)) walk([...path, next]);
    }
  };
  model.atoms.forEach((_, i) => walk([i]));
  const point = (i: number) => model.coords.slice(i * 3, i * 3 + 3);
  return rings.flatMap(ring => {
    const center = [0, 1, 2].map(axis => ring.reduce((sum, i) => sum + point(i)[axis], 0) / ring.length);
    return model.bonds.filter(bond => model.atoms[bond.a].element !== "H" && model.atoms[bond.b].element !== "H" &&
      model.atoms[bond.a].component !== model.atoms[ring[0]].component &&
      ring.some((atom, i) => pierces(point(bond.a), point(bond.b), center, point(atom), point(ring[(i + 1) % ring.length]))))
      .map(bond => ({ ring: ring.map(i => i + 1), bond: [bond.a + 1, bond.b + 1] }));
  });
}
