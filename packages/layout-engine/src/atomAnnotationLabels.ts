export interface AnnotationLabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationAtom {
  index: number;
  x: number;
  y: number;
  element: string;
  annotation?: string;
}

/** Centered bond strokes for declarative annotation figures, scaled with the fitted drawing. */
export function annotationBondLines(
  a: { x: number; y: number },
  b: { x: number; y: number },
  order: number,
  fitScale = 1
): { x1: number; y1: number; x2: number; y2: number }[] {
  if (![a.x, a.y, b.x, b.y, order, fitScale].every(Number.isFinite)) return [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const gap = 3 * fitScale;
  const count = order >= 1 && order <= 3 ? order : 1;
  const offsets = count === 1 ? [0] : count === 2 ? [-gap / 2, gap / 2] : [-gap, 0, gap];
  const round = (value: number): number => Math.round(value * 10) / 10;
  return offsets.map((offset) => ({
    x1: round(a.x + nx * offset),
    y1: round(a.y + ny * offset),
    x2: round(b.x + nx * offset),
    y2: round(b.y + ny * offset)
  })).filter((line) => Object.values(line).every(Number.isFinite));
}

/** Conservative advance, including bold/italic text, without browser font measurement. */
export function estimateAnnotationTextWidth(text: string, fontSize: number): number {
  return (Array.from(text).length + 0.5) * fontSize;
}

export function annotationLabelBoxesOverlap(a: AnnotationLabelBox, b: AnnotationLabelBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Place annotations clear of vertices, element labels and bonds, then fit the complete drawing.
 * Text and geometry share the final scale, so fitting cannot introduce new collisions. */
export function layoutAtomAnnotationLabels(input: {
  atoms: readonly AnnotationAtom[];
  bonds: readonly { from: number; to: number }[];
  width: number;
  height: number;
  padding?: number;
}) {
  const padding = Number.isFinite(input.padding) ? input.padding! : 8;
  const finiteAtoms = input.atoms.filter((atom) =>
    Number.isFinite(atom.index) && Number.isFinite(atom.x) && Number.isFinite(atom.y)
  );
  if (finiteAtoms.length === 0 || !Number.isFinite(input.width) || !Number.isFinite(input.height)) {
    return { atoms: [], labels: [], labelFontSize: 14, atomFontSize: 15, fitScale: 1 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const atom of finiteAtoms) {
    minX = Math.min(minX, atom.x);
    minY = Math.min(minY, atom.y);
    maxX = Math.max(maxX, atom.x);
    maxY = Math.max(maxY, atom.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = Math.min((input.width - 68) / (spanX || 1), (input.height - 68) / (spanY || 1));
  const atoms = finiteAtoms.map((atom) => ({
    ...atom,
    x: (input.width - spanX * scale) / 2 + (atom.x - minX) * scale,
    y: (input.height - spanY * scale) / 2 + (atom.y - minY) * scale
  })).filter((atom) => Number.isFinite(atom.x) && Number.isFinite(atom.y));
  if (atoms.length === 0) return { atoms: [], labels: [], labelFontSize: 14, atomFontSize: 15, fitScale: 1 };
  const byIndex = new Map(atoms.map((atom) => [atom.index, atom]));
  const bonds = input.bonds.flatMap((bond) => {
    const a = byIndex.get(bond.from);
    const b = byIndex.get(bond.to);
    return a && b ? [{ a, b }] : [];
  });
  const lengths = bonds.map(({ a, b }) => Math.hypot(a.x - b.x, a.y - b.y))
    .filter((length) => length > 0).sort((a, b) => a - b);
  const fontSize = Math.max(6.5, Math.min(14, (lengths[Math.floor(lengths.length / 2)] ?? 40) * 0.34));
  const atomBoxes = atoms.map((atom) => ({
    x: atom.x - Math.max(13, estimateAnnotationTextWidth(atom.element, 15) / 2 + 2),
    y: atom.y - 13,
    width: Math.max(26, estimateAnnotationTextWidth(atom.element, 15) + 4),
    height: 26
  }));
  const atomIndex = obstacleIndex(atomBoxes, (box) => box);
  const bondIndex = obstacleIndex(bonds, ({ a, b }) => ({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)
  }));
  // Only local labels enter the grid; shelf labels are below every occupied box and cannot collide
  // with an in-frame candidate. Keep their extents incrementally for both shelf placement and fit.
  const labelCells = new Map<string, AnnotationLabelBox[]>();
  const cellKeys = (box: AnnotationLabelBox): string[] => {
    const keys: string[] = [];
    const left = Math.max(0, Math.floor(box.x / 32));
    const right = Math.min(Math.floor(input.width / 32), Math.floor((box.x + box.width) / 32));
    const top = Math.max(0, Math.floor(box.y / 32));
    const bottom = Math.min(Math.floor(input.height / 32), Math.floor((box.y + box.height) / 32));
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) keys.push(`${x},${y}`);
    }
    return keys;
  };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (box: AnnotationLabelBox): void => {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  };
  for (const box of atomBoxes) include(box);
  const labels: (AnnotationLabelBox & { index: number; text: string })[] = [];
  const center = { x: input.width / 2, y: input.height / 2 };
  for (const atom of atoms) {
    if (!atom.annotation) continue;
    const width = estimateAnnotationTextWidth(atom.annotation, fontSize);
    const height = fontSize * 1.25;
    const angle = Math.atan2(atom.y - center.y, atom.x - center.x);
    let box: AnnotationLabelBox | undefined;
    for (let ring = 0; ring < 5 && !box; ring += 1) {
      for (let step = 0; step < 16; step += 1) {
        const direction = angle + step * Math.PI / 8;
        const radius = 22 + ring * (height + 5);
        const candidate = {
          x: atom.x + Math.cos(direction) * (radius + width / 2) - width / 2,
          y: atom.y + Math.sin(direction) * (radius + height / 2) - height / 2,
          width,
          height
        };
        const clearance = { x: candidate.x - 3, y: candidate.y - 3, width: width + 6, height: height + 6 };
        if (candidate.x >= padding && candidate.y >= padding &&
            candidate.x + width <= input.width - padding && candidate.y + height <= input.height - padding &&
            !atomIndex(clearance, (other) => annotationLabelBoxesOverlap(clearance, other)) &&
            !cellKeys(clearance).some((key) => labelCells.get(key)?.some((other) => annotationLabelBoxesOverlap(clearance, other))) &&
            !bondIndex(clearance, ({ a, b }) => segmentIntersectsBox(a, b, clearance))) {
          box = candidate;
          break;
        }
      }
    }
    // An unbounded shelf guarantees even coincident atoms or long comparison labels can be placed.
    box ??= { x: atom.x - width / 2, y: bottom + 6, width, height };
    labels.push({ ...box, index: atom.index, text: atom.annotation });
    include(box);
    for (const key of cellKeys(box)) {
      const cell = labelCells.get(key) ?? [];
      cell.push(box);
      labelCells.set(key, cell);
    }
  }
  const width = right - left;
  const height = bottom - top;
  const fitScale = Math.min(1, (input.width - padding * 2) / width, (input.height - padding * 2) / height);
  const project = (x: number, y: number) => ({
    x: (input.width - width * fitScale) / 2 + (x - left) * fitScale,
    y: (input.height - height * fitScale) / 2 + (y - top) * fitScale
  });
  return {
    atoms: atoms.map((atom) => ({ ...atom, ...project(atom.x, atom.y) })),
    labels: labels.map((label) => {
      const atom = byIndex.get(label.index)!;
      const leader = project(
        Math.max(label.x, Math.min(label.x + label.width, atom.x)),
        Math.max(label.y, Math.min(label.y + label.height, atom.y))
      );
      return {
        ...label, ...project(label.x, label.y), width: label.width * fitScale, height: label.height * fitScale,
        leaderX: leader.x, leaderY: leader.y
      };
    }),
    labelFontSize: fontSize * fitScale,
    atomFontSize: 15 * fitScale,
    fitScale
  };
}

/** Bounding hierarchy for static obstacles. Exact predicates and candidate order stay unchanged. */
function obstacleIndex<T>(items: readonly T[], boundsOf: (item: T) => AnnotationLabelBox) {
  interface Node {
    left: number; top: number; right: number; bottom: number;
    items?: { item: T; box: AnnotationLabelBox }[];
    children?: Node[];
  }
  const build = (entries: { item: T; box: AnnotationLabelBox }[]): Node => {
    const node: Node = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const { box } of entries) {
      node.left = Math.min(node.left, box.x);
      node.top = Math.min(node.top, box.y);
      node.right = Math.max(node.right, box.x + box.width);
      node.bottom = Math.max(node.bottom, box.y + box.height);
    }
    if (entries.length <= 8) node.items = entries;
    else {
      const axis = node.right - node.left >= node.bottom - node.top ? "x" : "y";
      entries.sort((a, b) => a.box[axis] - b.box[axis]);
      const middle = Math.floor(entries.length / 2);
      node.children = [build(entries.slice(0, middle)), build(entries.slice(middle))];
    }
    return node;
  };
  const root = build(items.map((item) => ({ item, box: boundsOf(item) })));
  return (box: AnnotationLabelBox, intersects: (item: T) => boolean): boolean => {
    const visit = (node: Node): boolean => {
      if (box.x > node.right || box.y > node.bottom ||
          box.x + box.width < node.left || box.y + box.height < node.top) return false;
      return node.items ? node.items.some(({ item }) => intersects(item)) : node.children!.some(visit);
    };
    return visit(root);
  };
}

function segmentIntersectsBox(a: { x: number; y: number }, b: { x: number; y: number }, box: AnnotationLabelBox): boolean {
  let low = 0;
  let high = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, box.x, box.x + box.width],
    [a.y, b.y - a.y, box.y, box.y + box.height]
  ]) {
    if (delta === 0) {
      if (start < min || start > max) return false;
    } else {
      const t1 = (min - start) / delta;
      const t2 = (max - start) / delta;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
  }
  return true;
}
