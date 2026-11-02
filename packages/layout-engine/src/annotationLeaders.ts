import { annotationLabelBoxesOverlap, estimateAnnotationTextWidth, obstacleIndex, segmentIntersectsBox, type AnnotationAtom, type AnnotationLabelBox } from "./atomAnnotationLabels";

interface Point { x: number; y: number }
interface Segment { a: Point; b: Point }
export interface AnnotationLeader {
  index: number;
  points: Point[];
  /** True only for an atom enclosed by bond geometry; paint this route below bonds. */
  crossesBonds: boolean;
  /** Final slot; relocation preserves the label's atom assignment. */
  label: AnnotationLabelBox;
}

const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Inclusive intersection: touching another vertex or a collinear stroke also obstructs a leader. */
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const epsilon = 1e-7;
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - epsilon ||
      Math.max(c.x, d.x) < Math.min(a.x, b.x) - epsilon ||
      Math.max(a.y, b.y) < Math.min(c.y, d.y) - epsilon ||
      Math.max(c.y, d.y) < Math.min(a.y, b.y) - epsilon) return false;
  return cross(a, b, c) * cross(a, b, d) <= epsilon && cross(c, d, a) * cross(c, d, b) <= epsilon;
}

function corners(box: AnnotationLabelBox, margin = 0): Point[] {
  return [
    { x: box.x - margin, y: box.y - margin },
    { x: box.x + box.width + margin, y: box.y - margin },
    { x: box.x + box.width + margin, y: box.y + box.height + margin },
    { x: box.x - margin, y: box.y + box.height + margin }
  ];
}

function segmentBounds({ a, b }: Segment): AnnotationLabelBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Largest unoccupied angular sectors first; break ties away from the molecule centroid. */
function freeDirections(atom: AnnotationAtom, neighbors: readonly Point[], center: Point): number[] {
  const outward = Math.atan2(atom.y - center.y, atom.x - center.x);
  if (!neighbors.length) return [outward];
  const angles = neighbors.map(p => Math.atan2(p.y - atom.y, p.x - atom.x)).sort((a, b) => a - b);
  return angles.map((angle, i) => {
    const gap = (angles[(i + 1) % angles.length] - angle + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
    const direction = angle + gap / 2;
    return { direction, score: gap + 0.25 * Math.cos(direction - outward) };
  }).sort((a, b) => b.score - a.score).map(entry => entry.direction);
}

/** Route fitted annotation geometry without changing label order or assignments.
 * Leaders leave through a free angular sector, then take a visibility path around labels, bond
 * strokes and earlier leaders. Relocate inaccessible slots before considering an enclosed atom
 * for a direct route beneath the bonds.
 * All coordinates use the same fitted geometry as annotationBondLines/layoutAtomAnnotationLabels.
 */
export function routeAtomAnnotationLeaders(input: {
  atoms: readonly AnnotationAtom[];
  bonds: readonly { from: number; to: number }[];
  bondLines: readonly { x1: number; y1: number; x2: number; y2: number }[];
  labels: readonly (AnnotationLabelBox & { index: number })[];
  fitScale: number;
  atomFontSize: number;
}): AnnotationLeader[] {
  const { atoms } = input;
  const labels = input.labels.map(label => ({ ...label }));
  if (!atoms.length) return [];
  const scale = input.fitScale;
  const gap = Math.max(0.05, 1.5 * scale);
  const minimumLength = 2 * gap;
  const byIndex = new Map(atoms.map(atom => [atom.index, atom]));
  const center = {
    x: atoms.reduce((sum, atom) => sum + atom.x, 0) / atoms.length,
    y: atoms.reduce((sum, atom) => sum + atom.y, 0) / atoms.length
  };
  const atomBoxes = atoms.map(atom => {
    const width = atom.element === "C" ? 6 * scale : estimateAnnotationTextWidth(atom.element, input.atomFontSize) + 4 * scale;
    const height = atom.element === "C" ? 6 * scale : 26 * scale;
    return { index: atom.index, x: atom.x - width / 2, y: atom.y - height / 2, width, height };
  });
  const padded = (label: AnnotationLabelBox): AnnotationLabelBox => ({
    x: label.x - gap, y: label.y - gap, width: label.width + gap * 2, height: label.height + gap * 2
  });
  const labelBoxes = labels.map(padded);
  const targets = new Map(labels.flatMap((label, i) => {
    const atom = byIndex.get(label.index);
    const box = labelBoxes[i];
    return atom ? [[label.index, {
      x: Math.max(box.x - gap, Math.min(box.x + box.width + gap, atom.x)),
      y: Math.max(box.y - gap, Math.min(box.y + box.height + gap, atom.y))
    }] as const] : [];
  }));
  const strokes = input.bondLines.map(line => ({ a: { x: line.x1, y: line.y1 }, b: { x: line.x2, y: line.y2 } }));
  const bondAxes = input.bonds.flatMap(bond => {
    const a = byIndex.get(bond.from);
    const b = byIndex.get(bond.to);
    return a && b ? [{ a, b }] : [];
  });
  const strokeIndex = obstacleIndex(strokes, segmentBounds);
  const axisIndex = obstacleIndex(bondAxes, segmentBounds);
  const neighborsOf = (index: number) => input.bonds.flatMap(bond => {
    const other = bond.from === index ? bond.to : bond.to === index ? bond.from : undefined;
    const neighbor = other === undefined ? undefined : byIndex.get(other);
    return neighbor ? [neighbor] : [];
  });
  // Reserve every atom's outward departure before routing the first label. Otherwise an early
  // route can cut across a later departure and trap that atom against its ring.
  const departures = atoms.filter(atom => labels.some(label => label.index === atom.index)).map(atom => {
    const direction = freeDirections(atom, neighborsOf(atom.index), center)[0];
    return { index: atom.index, a: atom, b: { x: atom.x + Math.cos(direction) * 12 * scale, y: atom.y + Math.sin(direction) * 12 * scale } };
  });
  const previous: Segment[] = [];
  const result: AnnotationLeader[] = [];
  // Connect local annotations before long shelf routes, so a distant label cannot fence off
  // a whole side of a fused ring. Restore the caller's label order in the returned data.
  const distanceToLabel = (label: AnnotationLabelBox & { index: number }) => {
    const atom = byIndex.get(label.index);
    const target = targets.get(label.index);
    return atom && target ? Math.hypot(atom.x - target.x, atom.y - target.y) : Infinity;
  };
  for (const label of [...labels].sort((a, b) => distanceToLabel(a) - distanceToLabel(b))) {
    const atom = byIndex.get(label.index);
    if (!atom) continue;
    const ownBox = atomBoxes.find(box => box.index === atom.index)!;
    const visibleFallback = (): Point[] => {
      const start = { x: atom.x, y: atom.y };
      const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
      const edges = [
        { x: label.x, y: clamp(atom.y, label.y, label.y + label.height) },
        { x: label.x + label.width, y: clamp(atom.y, label.y, label.y + label.height) },
        { x: clamp(atom.x, label.x, label.x + label.width), y: label.y },
        { x: clamp(atom.x, label.x, label.x + label.width), y: label.y + label.height }
      ].filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.hypot(p.x - atom.x, p.y - atom.y) >= minimumLength)
        .sort((a, b) => Math.hypot(a.x - atom.x, a.y - atom.y) - Math.hypot(b.x - atom.x, b.y - atom.y));
      const direction = freeDirections(atom, neighborsOf(atom.index), center)[0];
      return [start, edges[0] ?? { x: atom.x + Math.cos(direction) * minimumLength, y: atom.y + Math.sin(direction) * minimumLength }];
    };
    const search = (slot: AnnotationLabelBox, avoidLeaders = true, geometryOnly = false): Point[] => {
      const targetBox = padded(slot);
      const target = {
        x: Math.max(targetBox.x - gap, Math.min(targetBox.x + targetBox.width + gap, atom.x)),
        y: Math.max(targetBox.y - gap, Math.min(targetBox.y + targetBox.height + gap, atom.y))
      };
      const boxes = [
        ...(geometryOnly ? [] : labelBoxes.filter((_, i) => labels[i].index !== atom.index)), targetBox,
        ...(geometryOnly ? [] : atomBoxes.filter(box => box.index !== atom.index &&
          // Coincident vertices share a departure, rather than obstructing one another.
          Math.hypot(byIndex.get(box.index)!.x - atom.x, byIndex.get(box.index)!.y - atom.y) > gap)),
        ...(geometryOnly ? [] : [...targets]).filter(([index]) => index !== atom.index).map(([, point]) => ({
          x: point.x - gap / 2, y: point.y - gap / 2, width: gap, height: gap
        }))
      ];
      const neighbors = neighborsOf(atom.index);
      const directions = freeDirections(atom, neighbors, center);
      const ports = [target, ...corners(targetBox, gap),
        { x: targetBox.x + targetBox.width / 2, y: targetBox.y - gap },
        { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height + gap },
        { x: targetBox.x - gap, y: targetBox.y + targetBox.height / 2 },
        { x: targetBox.x + targetBox.width + gap, y: targetBox.y + targetBox.height / 2 }
      ];
      // Corners lie just outside the hard obstacles. Earlier bends also supply detour vertices.
      const detours = boxes.flatMap(box => corners(box, gap));
      const reserved = departures.filter(segment => segment.index !== atom.index && Math.hypot(segment.a.x - atom.x, segment.a.y - atom.y) > gap);
      const boxIndex = obstacleIndex(boxes, box => box);
      const reservedIndex = obstacleIndex(reserved, segmentBounds);
      const previousIndex = obstacleIndex(previous, segmentBounds);
      for (const segment of (avoidLeaders ? reserved : [])) detours.push(...corners({ ...segment.b, width: 0, height: 0 }, gap));
      for (const segment of (avoidLeaders ? previous : [])) {
        for (const p of [segment.a, segment.b]) detours.push(...corners({ ...p, width: 0, height: 0 }, gap / 2));
      }
      // Include bond tips in the visibility graph; label corners alone can miss an escape.
      for (const segment of [...strokes, ...bondAxes]) {
        for (const p of [segment.a, segment.b]) detours.push(...corners({ ...p, width: 0, height: 0 }, gap));
      }
      const unobstructed = (a: Point, b: Point, initial = false): boolean => {
        const bounds = segmentBounds({ a, b });
        if (boxIndex(bounds, box => segmentIntersectsBox(a, b, box))) return false;
        if (avoidLeaders && reservedIndex(bounds, segment => intersects(a, b, segment.a, segment.b))) return false;
        if (avoidLeaders && previousIndex(bounds, segment => intersects(a, b, segment.a, segment.b))) return false;
        if (axisIndex(bounds, segment => {
          const from = initial ? { x: a.x + (b.x - a.x) * 1e-5, y: a.y + (b.y - a.y) * 1e-5 } : a;
          return intersects(from, b, segment.a, segment.b);
        })) return false;
        return !strokeIndex(bounds, segment => {
          // Centered parallel strokes extend either side of a vertex. Allow the tiny part
          // beneath those incident strokes at the origin, never an entry into the ring.
          if (initial && Math.min(
            Math.hypot(segment.a.x - atom.x, segment.a.y - atom.y),
            Math.hypot(segment.b.x - atom.x, segment.b.y - atom.y)
          ) <= 4 * scale) {
            const distance = Math.hypot(b.x - a.x, b.y - a.y);
            const fraction = Math.min(0.9, 4 * scale / distance);
            const trimmed = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
            return intersects(trimmed, b, segment.a, segment.b);
          }
          return intersects(a, b, segment.a, segment.b);
        });
      };
      const connections = new Map<string, boolean>();
      const clear = (a: Point, b: Point, initial = false): boolean => {
        if (initial) return unobstructed(a, b, true);
        const from = `${a.x},${a.y}`, to = `${b.x},${b.y}`;
        const key = from < to ? `${from}/${to}` : `${to}/${from}`;
        let value = connections.get(key);
        if (value === undefined) { value = unobstructed(a, b); connections.set(key, value); }
        return value;
      };
      for (const departureLength of (avoidLeaders ? [12 * scale] : [12 * scale, gap / 4])) {
        const attempts = departureLength === 12 * scale ? directions : [...new Set([
          ...directions,
          ...Array.from({ length: 32 }, (_, i) => i * Math.PI / 16),
          ...detours.map(p => Math.atan2(p.y - atom.y, p.x - atom.x))
        ])];
        const departures: { start: Point; exit: Point }[] = [];
        for (const direction of attempts) {
          const dx = Math.cos(direction), dy = Math.sin(direction);
          const textRadius = atom.element === "C" ? 0 : Math.min(
            Math.abs(dx) > 1e-8 ? ownBox.width / 2 / Math.abs(dx) : Infinity,
            Math.abs(dy) > 1e-8 ? ownBox.height / 2 / Math.abs(dy) : Infinity
          ) + gap;
          const start = { x: atom.x + dx * textRadius, y: atom.y + dy * textRadius };
          const distance = Math.max(departureLength, textRadius + gap / 8);
          const exit = { x: atom.x + dx * distance, y: atom.y + dy * distance };
          if (!clear(start, exit, true)) continue;
          const direct = [...ports].sort((a, b) =>
            Math.hypot(a.x - exit.x, a.y - exit.y) - Math.hypot(b.x - exit.x, b.y - exit.y)
          ).find(port => clear(exit, port));
          if (direct) return [start, exit, direct];
          departures.push({ start, exit });
        }
        if (!departures.length) continue;
        const unique = new Map(detours.map(point => [`${point.x},${point.y}`, point]));
        const nodes = [...departures.map(d => d.exit), ...ports, ...unique.values()];
        const goalStart = departures.length, goalEnd = goalStart + ports.length;
        const distances = nodes.map((_, i) => i < goalStart ? Math.hypot(nodes[i].x - departures[i].start.x, nodes[i].y - departures[i].start.y) : Infinity);
        const parents = nodes.map(() => -1);
        const visited = new Set<number>();
        const remaining = nodes.map(point => Math.min(...ports.map(port => Math.hypot(point.x - port.x, point.y - port.y))));
        // Multi-source A*: explore all valid departures together, rather than repeating the
        // same visibility search for each angular sector of a crowded drawing.
        for (;;) {
          let current = -1;
          for (let i = 0; i < nodes.length; i++) {
            if (!visited.has(i) && Number.isFinite(distances[i]) &&
                (current < 0 || distances[i] + remaining[i] < distances[current] + remaining[current])) current = i;
          }
          if (current < 0) break;
          if (current >= goalStart && current < goalEnd) {
            const path = [nodes[current]];
            let root = current;
            while (parents[root] >= 0) { root = parents[root]; path.unshift(nodes[root]); }
            return [departures[root].start, ...path];
          }
          visited.add(current);
          for (let i = goalStart; i < nodes.length; i++) {
            if (visited.has(i)) continue;
            const distance = distances[current] + Math.hypot(nodes[i].x - nodes[current].x, nodes[i].y - nodes[current].y);
            if (distance >= distances[i] || !clear(nodes[current], nodes[i])) continue;
            distances[i] = distance;
            parents[i] = current;
          }
        }
      }
      return [];
    };
    // Avoiding previous leaders is a preference within the strict bond/text search.
    let points = search(label);
    if (!points.length) points = search(label, false);
    let crossesBonds = false;
    if (!points.length) {
      const molecularBounds = {
        left: Math.min(...atoms.map(a => a.x)), right: Math.max(...atoms.map(a => a.x)),
        top: Math.min(...atoms.map(a => a.y)), bottom: Math.max(...atoms.map(a => a.y))
      };
      const extent = [...atoms, ...strokes.flatMap(s => [s.a, s.b]), ...labels.flatMap(box => corners(box))];
      const left = Math.min(...extent.map(p => p.x));
      const right = Math.max(...extent.map(p => p.x));
      const top = Math.min(...extent.map(p => p.y));
      const bottom = Math.max(...extent.map(p => p.y));
      const exterior = { ...label, x: right + gap * 8, y: bottom + gap * 8 };
      const escape = search(exterior, false, true);
      const step = Math.max(label.height + gap * 4, 12 * scale);
      const candidates: AnnotationLabelBox[] = [exterior];
      for (let ring = 1; ring <= 6; ring++) {
        for (let direction = 0; direction < 32; direction++) {
          const angle = direction * Math.PI / 16;
          candidates.push({ ...label, x: label.x + Math.cos(angle) * ring * step, y: label.y + Math.sin(angle) * ring * step });
        }
      }
      // All four exterior shelves are available, including beyond the original frame.
      for (let i = 0; i <= labels.length; i++) {
        candidates.push(
          { ...label, x: left - label.width - gap * 4 - i * step, y: atom.y - label.height / 2 },
          { ...label, x: right + gap * 4 + i * step, y: atom.y - label.height / 2 },
          { ...label, x: atom.x - label.width / 2, y: top - label.height - gap * 4 - i * step },
          { ...label, x: atom.x - label.width / 2, y: bottom + gap * 4 + i * step }
        );
      }
      const clearSlots = candidates.filter(slot => {
        const box = padded(slot);
        // An enclosed atom cannot reach an exterior slot. Still try slots inside the
        // molecule before deciding that a crossing is necessary.
        if (!escape.length && (box.x < molecularBounds.left ||
            box.y < molecularBounds.top ||
            box.x + box.width > molecularBounds.right ||
            box.y + box.height > molecularBounds.bottom)) return false;
        return !labelBoxes.some((other, i) => labels[i].index !== atom.index && annotationLabelBoxesOverlap(box, other)) &&
          !atomBoxes.some(other => annotationLabelBoxesOverlap(box, other)) &&
          !strokes.some(s => segmentIntersectsBox(s.a, s.b, box));
      }).sort((a, b) => Math.hypot(a.x - label.x, a.y - label.y) - Math.hypot(b.x - label.x, b.y - label.y));
      for (const slot of clearSlots) {
        // Existing leaders may cross in a degenerate drawing; bonds and text stay hard
        // obstacles. A previous route must never make an accessible atom look enclosed.
        points = search(slot, false);
        if (!points.length) continue;
        Object.assign(label, slot);
        break;
      }
      if (!points.length) {
        // Only bond geometry can justify a crossing, independently of prior routes or text.
        if (escape.length) {
          points = escape;
          Object.assign(label, exterior);
        } else {
          crossesBonds = true;
          const target = targets.get(atom.index)!;
          points = Math.hypot(target.x - atom.x, target.y - atom.y) >= minimumLength
            ? [{ x: atom.x, y: atom.y }, target] : visibleFallback();
        }
      }
      labelBoxes[labels.indexOf(label)] = padded(label);
    }
    // Guard every route, including short or degenerate visibility-graph paths.
    if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) ||
        !points.some(p => Math.hypot(p.x - points[0].x, p.y - points[0].y) >= minimumLength)) {
      points = visibleFallback();
    }
    targets.set(atom.index, points[points.length - 1]);
    result.push({ index: atom.index, points, crossesBonds, label: { x: label.x, y: label.y, width: label.width, height: label.height } });
    for (let i = 1; i < points.length; i++) previous.push({ a: points[i - 1], b: points[i] });
  }
  const routes = new Map(result.map(route => [route.index, route]));
  return labels.flatMap(label => routes.has(label.index) ? [routes.get(label.index)!] : []);
}
