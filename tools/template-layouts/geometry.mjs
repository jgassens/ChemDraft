// Original, dependency-free construction geometry; no depiction engine or database coordinates.

/**
 * Orthographic camera, screen y up; angles in degrees. At azimuth 0 its view normal
 * is viewerSide * (0, cos(elevation), sin(elevation)); positive depth faces the viewer.
 * viewerSide selects the oriented normal without changing the screen-plane geometry.
 */
export function projectOrthographic(model, { elevation = 18, azimuth = 0, viewerSide = 1, centre = { x: 0, y: 0, z: 0 } } = {}) {
  const e = elevation * Math.PI / 180, a = azimuth * Math.PI / 180;
  return { ...model, atoms: model.atoms.map(({ z, ...atom }) => {
    const x = atom.x - centre.x, y = atom.y - centre.y;
    const right = x * Math.cos(a) - y * Math.sin(a);
    const toward = x * Math.sin(a) + y * Math.cos(a);
    return { ...atom, x: right, y: (z - centre.z) * Math.cos(e) - toward * Math.sin(e),
      depth: viewerSide * (toward * Math.cos(e) + (z - centre.z) * Math.sin(e)) };
  }) };
}

/** Cosmetic front-half line weight. Directed stereo always wins over depth styling. */
export function cueBondDepth(layout, deadZone = 0.15) {
  return { ...layout, bonds: layout.bonds.map(([from, to, order, display]) => {
    if (display === "wedge" || display === "hash") return [from, to, order, display];
    return (layout.atoms[from].depth + layout.atoms[to].depth) / 2 > deadZone
      ? [from, to, order, "bold"] : [from, to, order];
  }) };
}

/** The native renderer stacks a molecule's bonds by array order at a crossing. */
export function orderBondsByDepth(layout) {
  // Quantize ties so insignificant trig differences cannot reorder generated files across hosts.
  const depth = ([a, b]) => Math.round((layout.atoms[a].depth + layout.atoms[b].depth) / 2 * 1e9);
  return { ...layout, bonds: [...layout.bonds].sort((a, b) => depth(a) - depth(b)) };
}

export function rotate(points, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  return points.map((point) => ({ ...point, x: point.x * c - point.y * s, y: point.x * s + point.y * c }));
}

export function translate(points, dx, dy) {
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
}

export function centre(points) {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return translate(points, -(Math.min(...xs) + Math.max(...xs)) / 2, -(Math.min(...ys) + Math.max(...ys)) / 2);
}

/** Counterclockwise vertices, with unit-length edges. */
export function regularPolygon(count, rotation = Math.PI / 2) {
  if (!Number.isInteger(count) || count < 3) throw new Error("A polygon needs at least three vertices.");
  const radius = 1 / (2 * Math.sin(Math.PI / count));
  return Array.from({ length: count }, (_, index) => {
    const angle = rotation + 2 * Math.PI * index / count;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/**
 * Fuse an original regular hexagon outside a counterclockwise macrocycle edge.
 * The shared edge becomes double; the four new carbon atoms go around its exterior.
 */
export function fuseBenzeneOnEdge(layout, from, to) {
  const a = layout.atoms[from], b = layout.atoms[to];
  const edge = layout.bonds.find((bond) => bond[0] === from && bond[1] === to);
  if (!a || !b || !edge) throw new Error("The fused edge must exist and follow the macrocycle's winding.");
  edge[2] = 2;
  const start = layout.atoms.length;
  let point = b;
  const heading = Math.atan2(b.y - a.y, b.x - a.x);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  for (let step = 1; step <= 4; step += 1) {
    const angle = heading - step * Math.PI / 3;
    point = { element: "C", x: point.x + length * Math.cos(angle), y: point.y + length * Math.sin(angle) };
    layout.atoms.push(point);
    layout.bonds.push([step === 1 ? to : start + step - 2, start + step - 1, step % 2 === 0 ? 2 : 1]);
  }
  layout.bonds.push([start + 3, from, 1]);
  return layout;
}

/** Mean (flat) or longest (projection) bond is 1 before four-decimal serialization. */
function normaliseBondLength(layout, projection) {
  if (layout.bonds.length === 0) throw new Error("Cannot normalise a layout without bonds.");
  const stretched = new Set((layout.stretchedBonds ?? []).map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
  const lengths = layout.bonds.filter(([a, b]) => projection !== "perspective" || !stretched.has(`${Math.min(a, b)}:${Math.max(a, b)}`)).map(([from, to]) => {
    const a = layout.atoms[from], b = layout.atoms[to];
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  const referenceLength = projection === "perspective" ? Math.max(...lengths)
    : lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  if (!Number.isFinite(referenceLength) || referenceLength <= 0) throw new Error("Invalid bond length.");
  return { ...layout, atoms: layout.atoms.map((atom) => ({ ...atom, x: atom.x / referenceLength, y: atom.y / referenceLength })) };
}

export function round4(value) {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function finishLayout(layout, projection) {
  const normalised = normaliseBondLength(layout, projection);
  return {
    ...normalised,
    atoms: centre(normalised.atoms).map((atom) => ({ ...atom, x: round4(atom.x), y: round4(atom.y) }))
  };
}
