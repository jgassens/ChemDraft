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

export function positionIndex<T>(items: readonly T[], locate: (item: T) => IndexedPosition | undefined) {
  const buckets = new Map<string, { item: T; point: IndexedPosition }[]>();
  const cell = (coordinate: number) => Math.floor(coordinate / (2 * placementTolerance));
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

/** Find a complete assignment even when the first suitable neighbour is needed elsewhere. */
function atomFingerprint(a: AtomSite, b: AtomSite, checkAmbiguity: boolean): SiteComparison {
  if (!sameAtomPosition(a, b)) return "changed";
  const left = a.neighbours ?? [], right = b.neighbours ?? [];
  if (left.length !== right.length) return "changed";
  if (a === b || !left.length) return "match";
  if (left.length === 1) return sameAtomPosition(left[0], right[0]) ? "match" : "changed";
  const edges = left.map(site => right.flatMap((candidate, i) => sameAtomPosition(site, candidate) ? [i] : []));
  const owners: number[] = Array(right.length).fill(-1);
  const assign = (i: number, visited: Set<number>): boolean => {
    for (const j of edges[i]) {
      if (visited.has(j)) continue;
      visited.add(j);
      if (owners[j] < 0 || assign(owners[j], visited)) {
        owners[j] = i;
        return true;
      }
    }
    return false;
  };
  if (!left.every((_, i) => assign(i, new Set()))) return "changed";
  if (!checkAmbiguity) return "match";

  const exact = (site: AtomSite) => JSON.stringify([site.element, site.isotope, site.x, site.y]);
  const leftKeys = left.map(exact), rightKeys = right.map(exact);
  // Group identical descriptors before looking for alternating cycles. A cycle
  // through distinct pairs changes the correspondence; swapping copies does not.
  const possible = new Map<string, string[]>(), assigned = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, source: string, target: string) => {
    const destinations = map.get(source) ?? [];
    if (!destinations.includes(target)) destinations.push(target);
    map.set(source, destinations);
  };
  edges.forEach((choices, i) => choices.forEach(j => add(possible, leftKeys[i], rightKeys[j])));
  owners.forEach((i, j) => add(assigned, rightKeys[j], leftKeys[i]));
  const hasAlternative = (start: string, first: string) => {
    const visited = new Set<string>();
    const canReturn = (candidate: string): boolean => {
      if (visited.has(candidate)) return false;
      visited.add(candidate);
      return assigned.get(candidate)!.some(owner => owner === start
        ? candidate !== first : possible.get(owner)!.some(canReturn));
    };
    return canReturn(first);
  };
  for (const [site, choices] of possible) if (choices.some(candidate => hasAlternative(site, candidate))) return "ambiguous";
  return "match";
}

const sameAtomSite = (a: AtomSite, b: AtomSite) => atomFingerprint(a, b, false) === "match";
const sameDirectedBond = (a: BondSite, b: BondSite) => sameAtomSite(a[0], b[0]) && sameAtomSite(a[1], b[1]);
const sameBondSite = (a: BondSite, b: BondSite) => sameDirectedBond(a, b)
  || (sameAtomSite(a[0], b[1]) && sameAtomSite(a[1], b[0]));

function directedFingerprint(a: BondSite, b: BondSite): SiteComparison {
  const from = atomFingerprint(a[0], b[0], true), to = atomFingerprint(a[1], b[1], true);
  if (from === "changed" || to === "changed") return "changed";
  if (from === "ambiguous" || to === "ambiguous") return "ambiguous";
  return "match";
}

function siteIsAmbiguous<T>(site: T, before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean) {
  const nearby = (items: readonly T[]) => upToTwo(items, item => same(site, item)).length > 1;
  return nearby(before) || nearby(after);
}

export function compareAtomSite(a: AtomSite, b: AtomSite, before?: MoleculeSites, after?: MoleculeSites): SiteComparison {
  const fingerprint = atomFingerprint(a, b, true);
  if (fingerprint !== "match") return fingerprint;
  if ([a, b].some(site => siteIsAmbiguous(site, before?.atoms ?? [], after?.atoms ?? [], sameAtomSite))) return "ambiguous";
  return "match";
}

export function compareBondSite(a: BondSite, b: BondSite, before?: MoleculeSites, after?: MoleculeSites, directed = false): SiteComparison {
  if (!sameBondSite(a, b)) return "changed";
  if ([a, b].some(site => siteIsAmbiguous(site, before?.bonds ?? [], after?.bonds ?? [], sameBondSite))
    || [...a, ...b].some(site => siteIsAmbiguous(site, before?.atoms ?? [], after?.atoms ?? [], sameAtomSite))
    || (directed && [a, b].some(([from, to]) => sameAtomSite(from, to)))) return "ambiguous";
  const forward = directedFingerprint(a, b);
  return directed || forward !== "changed" ? forward : directedFingerprint(a, [b[1], b[0]]);
}
