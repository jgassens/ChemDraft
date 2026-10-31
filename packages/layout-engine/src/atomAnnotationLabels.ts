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
  }));
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
  const padding = input.padding ?? 8;
  if (input.atoms.length === 0) {
    return { atoms: [], labels: [], labelFontSize: 14, atomFontSize: 15, fitScale: 1 };
  }
  const minX = Math.min(...input.atoms.map((atom) => atom.x));
  const minY = Math.min(...input.atoms.map((atom) => atom.y));
  const spanX = Math.max(...input.atoms.map((atom) => atom.x)) - minX;
  const spanY = Math.max(...input.atoms.map((atom) => atom.y)) - minY;
  const scale = Math.min((input.width - 68) / (spanX || 1), (input.height - 68) / (spanY || 1));
  const atoms = input.atoms.map((atom) => ({
    ...atom,
    x: (input.width - spanX * scale) / 2 + (atom.x - minX) * scale,
    y: (input.height - spanY * scale) / 2 + (atom.y - minY) * scale
  }));
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
  const occupied = [...atomBoxes];
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
            !occupied.some((other) => annotationLabelBoxesOverlap(clearance, other)) &&
            !bonds.some(({ a, b }) => segmentIntersectsBox(a, b, clearance))) {
          box = candidate;
          break;
        }
      }
    }
    // An unbounded shelf guarantees even coincident atoms or long comparison labels can be placed.
    box ??= { x: atom.x - width / 2, y: Math.max(...occupied.map((other) => other.y + other.height)) + 6, width, height };
    labels.push({ ...box, index: atom.index, text: atom.annotation });
    occupied.push(box);
  }
  const left = Math.min(...occupied.map((box) => box.x));
  const top = Math.min(...occupied.map((box) => box.y));
  const width = Math.max(...occupied.map((box) => box.x + box.width)) - left;
  const height = Math.max(...occupied.map((box) => box.y + box.height)) - top;
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
