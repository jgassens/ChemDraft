// Original, dependency-free construction geometry; no depiction engine or database coordinates.

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

/** Circular arc from (-chord/2, 0) to (chord/2, 0), including both endpoints; each bond is 1. */
export function equalBondArc(bondCount, chord, side = 1) {
  if (!Number.isInteger(bondCount) || bondCount < 2 || chord <= 0 || chord >= bondCount) {
    throw new Error("An arc needs at least two bonds and a chord shorter than its contour.");
  }
  let low = 0, high = 2 * Math.PI;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const sweep = (low + high) / 2;
    const span = Math.sin(sweep / 2) / Math.sin(sweep / (2 * bondCount));
    if (span > chord) low = sweep;
    else high = sweep;
  }
  const sweep = (low + high) / 2;
  const radius = 1 / (2 * Math.sin(sweep / (2 * bondCount)));
  return Array.from({ length: bondCount + 1 }, (_, index) => {
    const angle = -sweep / 2 + sweep * index / bondCount;
    return { x: radius * Math.sin(angle), y: side * radius * (Math.cos(angle) - Math.cos(sweep / 2)) };
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

/** Mean bond length is exactly 1 before the final four-decimal serialization. */
export function normaliseMeanBondLength(layout) {
  if (layout.bonds.length === 0) throw new Error("Cannot normalise a layout without bonds.");
  const mean = layout.bonds.reduce((sum, [from, to]) => {
    const a = layout.atoms[from], b = layout.atoms[to];
    return sum + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0) / layout.bonds.length;
  if (!Number.isFinite(mean) || mean <= 0) throw new Error("Invalid mean bond length.");
  return { ...layout, atoms: layout.atoms.map((atom) => ({ ...atom, x: atom.x / mean, y: atom.y / mean })) };
}

export function round4(value) {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function finishLayout(layout) {
  const normalised = normaliseMeanBondLength(layout);
  return {
    ...normalised,
    atoms: centre(normalised.atoms).map((atom) => ({ ...atom, x: round4(atom.x), y: round4(atom.y) }))
  };
}
