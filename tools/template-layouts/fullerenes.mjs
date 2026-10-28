import { normaliseMeanBondLength } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

// C60 is intentionally withheld: a crossing-free embedding cannot meet the existing bounds.
// Its 3-connected planar graph has only pentagonal/hexagonal faces (including the outer face).
// With every bond <= 1.15 the convex hull perimeter P is <= 6 * 1.15 = 6.9.
// All atom pairs must be >= 0.6 apart (bonded pairs are >= 0.85), so 60 disjoint
// radius-0.3 discs must fit inside the hull expanded by 0.3. Isoperimetry and Steiner's
// formula bound that area by P^2/(4*pi) + 0.3*P + pi*0.3^2 <= 6.1415,
// whereas the discs require 60*pi*0.3^2 = 16.9646. Nonlinear radial spacing cannot fix this.
// Even this loose packing bound requires a maximum bond >= pi*(sqrt(60)-1)/10 > 2.119.
// No template-specific exceptions or changes to the tests/types are made here.
// A sweep in 0.01 steps over exponent 0.01..2 and eye offset 0.01..0.30 achieved its
// smallest max/min ratio at (0.52, 0.22): mean-normalised bonds 0.480592..4.472180,
// 60 vertices, 90 edges and zero crossings. This is an attempted construction, not an optimum.

/** Original diagnostic geometry, NOT a registered template or database-derived coordinates.
 * Truncate a regular icosahedron at each edge's trisection, then project through a pentagon.
 * Radius exponents allow reproducible experiments with nonlinear radial spacing. Unit edge
 * weights encode topology only, without Kekulé assignments; this is not a chemical entry.
 */
export function c60SchlegelDiagnostic(radialExponent = 1, eyeOffset = 0.1) {
  if (!(radialExponent > 0) || !(eyeOffset > 0 && eyeOffset < 1 / 3)) throw new Error("Invalid Schlegel parameters.");
  const phi = (1 + Math.sqrt(5)) / 2;
  const vertices = [];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) {
    vertices.push([0, a, b], [a, b, 0], [b, 0, a]);
  }
  const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const norm = (a) => a.map((value) => value / Math.hypot(...a));
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const adjacent = vertices.map((a) => vertices.flatMap((b, i) => Math.abs(distance(a, b) - 2) < 1e-8 ? [i] : []));
  const points = [], indices = new Map();
  for (let a = 0; a < vertices.length; a += 1) for (const b of adjacent[a]) {
    indices.set(`${a}:${b}`, points.length);
    points.push(vertices[a].map((value, i) => (2 * value + vertices[b][i]) / 3));
  }
  const bonds = [];
  for (let a = 0; a < vertices.length; a += 1) for (const b of adjacent[a]) {
    if (a < b) bonds.push([indices.get(`${a}:${b}`), indices.get(`${b}:${a}`), 1]);
    for (const c of adjacent[a]) if (b < c && adjacent[b].includes(c)) {
      bonds.push([indices.get(`${a}:${b}`), indices.get(`${a}:${c}`), 1]);
    }
  }
  const axis = norm(vertices[0]);
  const horizontal = norm(cross(axis, [1, 0, 0]));
  const vertical = cross(axis, horizontal);
  const faceHeight = dot(points[indices.get(`0:${adjacent[0][0]}`)], axis);
  const eye = faceHeight + eyeOffset;
  const atoms = points.map((point) => {
    const scale = eye / (eye - dot(point, axis));
    const x = dot(point, horizontal) * scale, y = dot(point, vertical) * scale;
    const radialScale = Math.hypot(x, y) ** (radialExponent - 1);
    return { element: "C", x: x * radialScale, y: y * radialScale };
  });
  const layout = normaliseMeanBondLength({ atoms, bonds });
  const lengths = bonds.map(([a, b]) => distance([layout.atoms[a].x, layout.atoms[a].y], [layout.atoms[b].x, layout.atoms[b].y]));
  let minimumSeparation = Infinity;
  for (let a = 0; a < atoms.length; a += 1) for (let b = a + 1; b < atoms.length; b += 1) {
    minimumSeparation = Math.min(minimumSeparation, distance([layout.atoms[a].x, layout.atoms[a].y], [layout.atoms[b].x, layout.atoms[b].y]));
  }
  return { radialExponent, eyeOffset, minimumBond: Math.min(...lengths), maximumBond: Math.max(...lengths), minimumSeparation, layout };
}

export const generator = {
  scriptName: "fullerenes.mjs",
  fileName: "fullerenes.ts",
  exportName: "fullerenesTemplates",
  generateTemplates: () => []
};

runFamilyIfMain(import.meta.url, generator);
