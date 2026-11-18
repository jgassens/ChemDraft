import { cdxmlToCssPx } from "../../packages/cdx-compat/src/coordinates";

// CDX can round through CDXML before rounding to 16.16 points. Budget one
// coarsest-format quantum per operand of a rebased point or box extent, on both sides.
const coordinateQuantum = cdxmlToCssPx(Math.max(10 ** -4, 1 / 65536));
export const placementTolerance = 4 * coordinateQuantum;

export interface Point { x: number; y: number }
interface Extents { width?: number; height?: number }
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
const sameExtent = (a?: number, b?: number) => a === undefined || b === undefined ? a === b : near(a, b);
const sameExtents = (a: Extents, b: Extents) => sameExtent(a.width, b.width) && sameExtent(a.height, b.height);
export const samePlacement = (a: Placement, b: Placement) => a.page === b.page && a.type === b.type
  && a.structure === b.structure && a.graphicKind === b.graphicKind
  && samePoint(a, b) && sameExtents(a, b)
  && (!a.line || !b.line || (samePoint(a.line[0], b.line[0]) && samePoint(a.line[1], b.line[1]))
    || (samePoint(a.line[0], b.line[1]) && samePoint(a.line[1], b.line[0])));

type IndexedPosition = Point & Extents & { scope: string | number };

export function positionIndex<T>(items: readonly T[], locate: (item: T) => IndexedPosition | undefined, onInspect?: () => void) {
  const buckets = new Map<string, { item: T; point: IndexedPosition }[]>();
  // Saturate before floating-point spacing can make adjacent cells identical
  // or let the relative part of the tolerance span several cells.
  const limit = 2 ** 50;
  const cell = (coordinate: number) => Math.max(-limit, Math.min(limit, Math.floor(coordinate / (2 * placementTolerance))));
  const extentCell = (extent?: number) => extent === undefined ? undefined : cell(extent);
  const nearbyCells = (coordinate?: number) => {
    const centre = extentCell(coordinate);
    return centre === undefined ? [undefined] : [centre - 1, centre, centre + 1];
  };
  const key = (scope: string | number, x?: number, y?: number, w?: number, h?: number) => JSON.stringify([scope, x, y, w, h]);
  for (const item of items) {
    const point = locate(item);
    if (!point) continue;
    const bucket = key(point.scope, cell(point.x), cell(point.y), extentCell(point.width), extentCell(point.height));
    const entries = buckets.get(bucket);
    if (entries) entries.push({ item, point });
    else buckets.set(bucket, [{ item, point }]);
  }
  return (point: IndexedPosition | undefined, accepts: (item: T) => boolean) => {
    const candidates: T[] = [];
    if (!point) return candidates;
    const [xs, ys, widths, heights] = [point.x, point.y, point.width, point.height].map(nearbyCells);
    for (const x of xs) for (const y of ys) for (const width of widths) for (const height of heights) {
      for (const other of buckets.get(key(point.scope, x, y, width, height)) ?? []) {
        onInspect?.();
        if (samePoint(point, other.point) && sameExtents(point, other.point) && accepts(other.item)) candidates.push(other.item);
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

export type SiteComparison = "match" | "changed" | "ambiguous";

export const maxSiteNeighbours = 64;

/** A perfect matching establishes that these two fixed targets have compatible neighbourhoods.
 * The choice of neighbour assignment does not change either target. */
function atomFingerprint(a: AtomSite, b: AtomSite): SiteComparison {
  if (!sameAtomPosition(a, b)) return "changed";
  const left = a.neighbours ?? [], right = b.neighbours ?? [];
  if (left.length > maxSiteNeighbours || right.length > maxSiteNeighbours) return "ambiguous";
  if (left.length !== right.length) return "changed";
  if (a === b || !left.length) return "match";
  if (left.length === 1) return sameAtomPosition(left[0], right[0]) ? "match" : "changed";
  const edges = left.map(site => right.flatMap((candidate, i) => sameAtomPosition(site, candidate) ? [i] : []));
  const owners = Array<number>(right.length).fill(-1);
  const assigned = Array<number>(left.length).fill(-1);
  // At most one breadth-first augmenting-path search per left vertex, O(V*(V+E)).
  for (let start = 0; start < left.length; start++) {
    const queue = [start];
    const parent = Array<number>(right.length).fill(-1);
    let free = -1;
    for (let head = 0; head < queue.length && free < 0; head++) {
      const i = queue[head];
      for (const j of edges[i]) {
        if (parent[j] >= 0) continue;
        parent[j] = i;
        if (owners[j] < 0) { free = j; break; }
        queue.push(owners[j]);
      }
    }
    if (free < 0) return "changed";
    for (let j = free; j >= 0;) {
      const i = parent[j];
      owners[j] = i;
      [assigned[i], j] = [j, assigned[i]];
    }
  }
  return "match";
}

function directedFingerprint(a: BondSite, b: BondSite): SiteComparison {
  const from = atomFingerprint(a[0], b[0]);
  if (from === "changed") return "changed";
  const to = atomFingerprint(a[1], b[1]);
  return to === "match" ? from : to;
}

function bondFingerprint(a: BondSite, b: BondSite): SiteComparison {
  const forward = directedFingerprint(a, b);
  if (forward === "match") return forward;
  const reverse = directedFingerprint(a, [b[1], b[0]]);
  return reverse === "changed" ? forward : reverse;
}

function siteIsAmbiguous<T>(site: T, before: readonly T[], after: readonly T[], compare: (a: T, b: T) => SiteComparison) {
  const nearby = (items: readonly T[]) => {
    let matches = 0;
    for (const item of items) {
      const status = compare(site, item);
      if (status === "ambiguous" || (status === "match" && ++matches > 1)) return true;
    }
    return false;
  };
  return nearby(before) || nearby(after);
}

export function compareAtomSite(a: AtomSite, b: AtomSite, before?: MoleculeSites, after?: MoleculeSites): SiteComparison {
  const fingerprint = atomFingerprint(a, b);
  if (fingerprint !== "match") return fingerprint;
  if ([a, b].some(site => siteIsAmbiguous(site, before?.atoms ?? [], after?.atoms ?? [], atomFingerprint))) return "ambiguous";
  return "match";
}

export function compareBondSite(a: BondSite, b: BondSite, before?: MoleculeSites, after?: MoleculeSites, directed = false): SiteComparison {
  const fingerprint = bondFingerprint(a, b);
  if (fingerprint !== "match") return fingerprint;
  if ([a, b].some(site => siteIsAmbiguous(site, before?.bonds ?? [], after?.bonds ?? [], bondFingerprint))) return "ambiguous";
  if (!directed) return "match";
  const forward = directedFingerprint(a, b);
  if ([a, b].some(([from, to]) => atomFingerprint(from, to) !== "changed") ||
    forward === "match" && directedFingerprint(a, [b[1], b[0]]) !== "changed") return "ambiguous";
  return forward;
}
