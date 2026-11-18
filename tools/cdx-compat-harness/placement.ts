import { cdxmlToCssPx } from "../../packages/cdx-compat/src/coordinates";

// CDX can round through CDXML before rounding to 16.16 points. Budget one
// coarsest-format quantum per operand of a rebased point or box extent, on both sides.
const coordinateQuantum = cdxmlToCssPx(Math.max(10 ** -4, 1 / 65536));
export const placementTolerance = 4 * coordinateQuantum;

export interface Point { x: number; y: number }
export interface Placement extends Point {
  page: number; type: string; width?: number; height?: number;
  id?: string;
  structure?: string;
  graphicKind?: string;
  line?: [Point, Point];
}
export interface AtomSite extends Point {
  element: string;
  isotope?: number;
  neighbours?: AtomSite[];
}
export type BondSite = [from: AtomSite, to: AtomSite];
export interface MoleculeSites { atoms: AtomSite[]; bonds: BondSite[] }

const near = (a: number, b: number) => Math.abs(a - b) <= placementTolerance +
  Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
export const samePoint = (a: Point, b: Point) => near(a.x, b.x) && near(a.y, b.y);
export const samePlacement = (a: Placement, b: Placement) => a.page === b.page && a.type === b.type
  && (a.structure === undefined || b.structure === undefined || a.structure === b.structure)
  && samePoint(a, b)
  && (a.width === undefined || b.width === undefined || near(a.width, b.width))
  && (a.height === undefined || b.height === undefined || near(a.height, b.height))
  && (!a.graphicKind || !b.graphicKind || a.graphicKind === b.graphicKind)
  && (!a.line || !b.line || (samePoint(a.line[0], b.line[0]) && samePoint(a.line[1], b.line[1]))
    || (samePoint(a.line[0], b.line[1]) && samePoint(a.line[1], b.line[0])));

export function positionIndex<T>(items: readonly T[], locate: (item: T) => (Point & { scope: string | number }) | undefined) {
  const buckets = new Map<string, { item: T; point: Point }[]>();
  const cell = (coordinate: number) => Math.floor(coordinate / (2 * placementTolerance));
  const key = (scope: string | number, x: number, y: number) => JSON.stringify([scope, x, y]);
  for (const item of items) {
    const point = locate(item);
    if (!point) continue;
    const bucket = key(point.scope, cell(point.x), cell(point.y));
    const entries = buckets.get(bucket);
    if (entries) entries.push({ item, point });
    else buckets.set(bucket, [{ item, point }]);
  }
  return (point: (Point & { scope: string | number }) | undefined, accepts: (item: T) => boolean) => {
    const candidates: T[] = [];
    if (!point) return candidates;
    const x = cell(point.x), y = cell(point.y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of buckets.get(key(point.scope, x + dx, y + dy)) ?? []) {
        if (samePoint(point, other.point) && accepts(other.item)) candidates.push(other.item);
        if (candidates.length === 2) return candidates;
      }
    }
    return candidates;
  };
}

function upToTwo<T>(items: readonly T[], accepts: (item: T) => boolean) {
  const matches: T[] = [];
  for (const item of items) {
    if (accepts(item)) matches.push(item);
    if (matches.length === 2) break;
  }
  return matches;
}

/** Pair only reciprocal singletons. Same-side checks keep rounding from creating an
 * apparent unique match between otherwise indistinguishable candidates. */
export function pairUnique<T>(
  before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean,
  candidates = (items: readonly T[]) => (item: T) => upToTwo(items, other => same(item, other))
) {
  const onLeft = candidates(before), onRight = candidates(after);
  const paired = new Map<T, T>();
  const ambiguousBefore = new Set<T>(), ambiguousAfter = new Set<T>();
  const match = (item: T, local: (item: T) => T[], remote: (item: T) => T[], ambiguous: Set<T>) => {
    const possible = remote(item);
    if (local(item).length > 1 || possible.length > 1 ||
      (possible.length === 1 && (local(possible[0]).length > 1 || remote(possible[0]).length > 1))) {
      ambiguous.add(item);
      return undefined;
    }
    return possible[0];
  };
  for (const item of before) {
    const other = match(item, onLeft, onRight, ambiguousBefore);
    if (other !== undefined) paired.set(item, other);
  }
  for (const item of after) match(item, onRight, onLeft, ambiguousAfter);
  return { paired, ambiguousBefore, ambiguousAfter };
}

const sameAtomPosition = (a: AtomSite, b: AtomSite) => a.element === b.element && a.isotope === b.isotope && samePoint(a, b);

/** Neighbours are a fingerprint of an atom, so repeated neighbours count with multiplicity. */
export const sameAtomSite = (a: AtomSite, b: AtomSite) => {
  if (!sameAtomPosition(a, b)) return false;
  const remaining = [...(b.neighbours ?? [])];
  for (const neighbour of a.neighbours ?? []) {
    const index = remaining.findIndex(candidate => sameAtomPosition(neighbour, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return !remaining.length;
};
export const sameDirectedBond = (a: BondSite, b: BondSite) => sameAtomSite(a[0], b[0]) && sameAtomSite(a[1], b[1]);
export const sameBondSite = (a: BondSite, b: BondSite) => sameDirectedBond(a, b)
  || (sameAtomSite(a[0], b[1]) && sameAtomSite(a[1], b[0]));

export type SiteComparison = "match" | "changed" | "ambiguous";
function siteIsAmbiguous<T>(site: T, before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean) {
  const nearby = (items: readonly T[]) => upToTwo(items, item => same(site, item)).length > 1;
  return nearby(before) || nearby(after);
}

export function compareAtomSite(a: AtomSite, b: AtomSite, before?: MoleculeSites, after?: MoleculeSites): SiteComparison {
  if (!sameAtomSite(a, b)) return "changed";
  if ([a, b].some(site => siteIsAmbiguous(site, before?.atoms ?? [], after?.atoms ?? [], sameAtomSite))) return "ambiguous";
  return "match";
}

export function compareBondSite(a: BondSite, b: BondSite, before?: MoleculeSites, after?: MoleculeSites, directed = false): SiteComparison {
  if (!sameBondSite(a, b)) return "changed";
  if ([a, b].some(site => siteIsAmbiguous(site, before?.bonds ?? [], after?.bonds ?? [], sameBondSite))
    || [...a, ...b].some(site => siteIsAmbiguous(site, before?.atoms ?? [], after?.atoms ?? [], sameAtomSite))
    || (directed && [a, b].some(([from, to]) => sameAtomSite(from, to)))) return "ambiguous";
  return !directed || sameDirectedBond(a, b) ? "match" : "changed";
}
