import type { GraphicObject, GraphicObjectData } from "@chemdraft/chem-core";

type PagePoint = { x: number; y: number };

/**
 * Size of a newly placed orbital, in bond lengths of the document's active drawing style.
 *
 * This is the one number to tune. It is the length of one lobe, measured along the orbital's
 * axis from the nucleus (the lobe's pointed end, which sits on the atom) to the far end of the
 * drawn outline. Every orbital tool is sized from it, keeping its own proportions:
 *
 * - a single lobe (plain or shaded) is this long;
 * - a p orbital is two such lobes, so it is twice this long tip to tip;
 * - an s orbital's diameter equals this length.
 *
 * Only new placements use it. Orbitals already in a document keep the size they were saved with.
 */
export const ORBITAL_LOBE_LENGTH_IN_BOND_LENGTHS = 0.8;

/** The page-unit length of one orbital lobe for a style whose bonds are `bondLengthPx` long. */
export function orbitalLobeLengthPx(bondLengthPx: number): number {
  return ORBITAL_LOBE_LENGTH_IN_BOND_LENGTHS * bondLengthPx;
}

/** The parts of an orbital tool definition that sizing reads and rewrites. */
export interface OrbitalToolShape {
  id: string;
  graphicKind: GraphicObject["graphicKind"];
  width: number;
  height: number;
  data: GraphicObjectData;
}

/**
 * One lobe's length in the tool's own frame units: the nucleus to the far end of the drawn
 * outline along the orbital's axis, or an s orbital's diameter. A single lobe's nucleus is the
 * bottom centre of its frame and a p orbital's is its frame centre; both point up unrotated.
 */
export function orbitalToolLobeLength(tool: OrbitalToolShape): number {
  if (tool.graphicKind === "ellipse") {
    return Math.min(tool.width, tool.height);
  }
  const nucleusY = tool.id === "pOrbital" ? tool.height / 2 : tool.height;
  const topY = closedBezierMinimumY(tool.data.pathNodes ?? []);
  return topY === undefined ? tool.height : nucleusY - topY;
}

/**
 * The tool scaled uniformly so one lobe is `orbitalLobeLengthPx(bondLengthPx)` long. The frame
 * and every path node scale about the frame's origin, so a lobe's tip stays at its frame's
 * bottom centre and a p orbital's node at its frame centre, which is what placement relies on.
 */
export function sizeOrbitalToolForBondLength<T extends OrbitalToolShape>(tool: T, bondLengthPx: number): T {
  const lobeLength = orbitalToolLobeLength(tool);
  const scale = orbitalLobeLengthPx(bondLengthPx) / lobeLength;
  if (!Number.isFinite(scale) || scale <= 0) {
    return tool;
  }
  const scalePoint = (point: PagePoint): PagePoint => ({ x: point.x * scale, y: point.y * scale });
  return {
    ...tool,
    width: tool.width * scale,
    height: tool.height * scale,
    data: tool.data.pathNodes
      ? {
          ...tool.data,
          pathNodes: tool.data.pathNodes.map((node) => ({
            point: scalePoint(node.point),
            ...(node.inControl ? { inControl: scalePoint(node.inControl) } : {}),
            ...(node.outControl ? { outControl: scalePoint(node.outControl) } : {})
          }))
        }
      : { ...tool.data }
  };
}

type PathNode = NonNullable<GraphicObjectData["pathNodes"]>[number];

/** The smallest y reached by a closed cubic-bezier outline, exactly (curve extremes, not samples). */
function closedBezierMinimumY(nodes: readonly PathNode[]): number | undefined {
  if (nodes.length === 0) {
    return undefined;
  }
  let minimum = Infinity;
  nodes.forEach((node, index) => {
    const next = nodes[(index + 1) % nodes.length]!;
    const p0 = node.point.y;
    const p1 = (node.outControl ?? node.point).y;
    const p2 = (next.inControl ?? next.point).y;
    const p3 = next.point.y;
    for (const t of [0, 1, ...cubicDerivativeRoots(p0, p1, p2, p3)]) {
      minimum = Math.min(minimum, cubicAt(p0, p1, p2, p3, t));
    }
  });
  return minimum;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Roots in (0, 1) of the derivative of a one-dimensional cubic bezier. */
function cubicDerivativeRoots(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t)/3 = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrt = Math.sqrt(discriminant);
      roots.push((-b + sqrt) / (2 * a), (-b - sqrt) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}
