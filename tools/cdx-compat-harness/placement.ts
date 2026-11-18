// Native coordinates are CSS pixels. Allow for four-decimal CDXML serialization
// and CDX fixed-point rounding, including separately rounded box endpoints.
const tolerance = 0.001;

export interface Point { x: number; y: number }
export interface Placement extends Point {
  page: number; type: string; width?: number; height?: number;
  graphicKind?: string;
  line?: [Point, Point];
}
export interface AtomSite extends Point {
  element: string;
  /** Only needed when vertices of the same element overlap in the drawing. */
  neighbours?: AtomSite[];
}
export type BondSite = [from: AtomSite, to: AtomSite];

const near = (a: number, b: number) => Math.abs(a - b) < tolerance;
export const samePoint = (a: Point, b: Point) => near(a.x, b.x) && near(a.y, b.y);
export const samePlacement = (a: Placement, b: Placement) => a.page === b.page && a.type === b.type && samePoint(a, b)
  && (a.width === undefined || b.width === undefined || near(a.width, b.width))
  && (a.height === undefined || b.height === undefined || near(a.height, b.height))
  && (!a.graphicKind || !b.graphicKind || a.graphicKind === b.graphicKind)
  && (!a.line || !b.line || (samePoint(a.line[0], b.line[0]) && samePoint(a.line[1], b.line[1]))
    || (samePoint(a.line[0], b.line[1]) && samePoint(a.line[1], b.line[0])));

export function positionIndex<T>(items: readonly T[], locate: (item: T) => (Point & { scope: string | number }) | undefined) {
  const buckets = new Map<string, T[]>();
  const cell = (coordinate: number) => Math.floor(coordinate / tolerance);
  const key = (scope: string | number, x: number, y: number) => JSON.stringify([scope, x, y]);
  for (const item of items) {
    const point = locate(item);
    if (!point) continue;
    const bucket = key(point.scope, cell(point.x), cell(point.y));
    const entries = buckets.get(bucket);
    if (entries) entries.push(item);
    else buckets.set(bucket, [item]);
  }
  return (item: T): T[] => {
    const point = locate(item);
    if (!point) return [];
    const candidates: T[] = [];
    const x = cell(point.x), y = cell(point.y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of buckets.get(key(point.scope, x + dx, y + dy)) ?? []) {
        if (samePoint(point, locate(other)!)) candidates.push(other);
      }
    }
    return candidates;
  };
}

export function matchedItems<T>(before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean): [T, T][] {
  const remaining = [...after];
  return before.flatMap(item => {
    const index = remaining.findIndex(candidate => same(item, candidate));
    return index < 0 ? [] : [[item, remaining.splice(index, 1)[0]]];
  });
}

export const sameItems = <T>(a: readonly T[], b: readonly T[], same: (left: T, right: T) => boolean) =>
  a.length === b.length && matchedItems(a, b, same).length === a.length;

const sameAtomPosition = (a: AtomSite, b: AtomSite) => a.element === b.element && samePoint(a, b);
export const sameAtomSite = (a: AtomSite, b: AtomSite) => sameAtomPosition(a, b)
  && sameItems(a.neighbours ?? [], b.neighbours ?? [], sameAtomPosition);
export const sameDirectedBond = (a: BondSite, b: BondSite) => sameAtomSite(a[0], b[0]) && sameAtomSite(a[1], b[1]);
export const sameBondSite = (a: BondSite, b: BondSite) => sameDirectedBond(a, b)
  || (sameAtomSite(a[0], b[1]) && sameAtomSite(a[1], b[0]));
