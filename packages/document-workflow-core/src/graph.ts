// Graph walks over native molecule atoms and bonds.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import type { MoleculeAtom, MoleculeBond } from "@chemdraft/chem-core";

export function findSingleCycleAtomIds(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
  const remaining = new Set(atoms.map((atom) => atom.id));
  const degrees = new Map(atoms.map((atom) => [atom.id, adjacency.get(atom.id)?.length ?? 0]));
  const pending = [...degrees.entries()]
    .filter(([, degree]) => degree <= 1)
    .map(([atomId]) => atomId);

  while (pending.length > 0) {
    const atomId = pending.pop();
    if (!atomId || !remaining.has(atomId)) {
      continue;
    }

    remaining.delete(atomId);
    (adjacency.get(atomId) ?? []).forEach((neighborId) => {
      if (!remaining.has(neighborId)) {
        return;
      }

      const nextDegree = (degrees.get(neighborId) ?? 0) - 1;
      degrees.set(neighborId, nextDegree);
      if (nextDegree <= 1) {
        pending.push(neighborId);
      }
    });
  }

  const cycleAtomIds = [...remaining].sort();
  if (cycleAtomIds.length < 3) {
    return undefined;
  }

  return cycleAtomIds;
}

export function isForestGraph(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  components: readonly (readonly string[])[]
): boolean {
  const atomIds = new Set(atoms.map((atom) => atom.id));
  if (bonds.some((bond) => !atomIds.has(bond.fromAtomId) || !atomIds.has(bond.toAtomId))) {
    return false;
  }

  return bonds.length === atoms.length - components.length;
}

export function nativeComponents(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const components: string[][] = [];

  atoms.map((atom) => atom.id).sort().forEach((startAtomId) => {
    if (visited.has(startAtomId)) {
      return;
    }

    const component: string[] = [];
    const pending = [startAtomId];
    while (pending.length > 0) {
      const atomId = pending.pop();
      if (!atomId || visited.has(atomId)) {
        continue;
      }

      visited.add(atomId);
      component.push(atomId);
      pending.push(...(adjacency.get(atomId) ?? []).filter((neighborId) => !visited.has(neighborId)));
    }

    components.push(component.sort());
  });

  return components;
}

export function nativeAdjacency(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, readonly string[]> {
  const atomIds = new Set(atoms.map((atom) => atom.id));
  const adjacency = new Map(atoms.map((atom) => [atom.id, [] as string[]]));

  bonds.forEach((bond) => {
    if (!atomIds.has(bond.fromAtomId) || !atomIds.has(bond.toAtomId)) {
      return;
    }
    adjacency.get(bond.fromAtomId)?.push(bond.toAtomId);
    adjacency.get(bond.toAtomId)?.push(bond.fromAtomId);
  });

  adjacency.forEach((neighbors) => {
    neighbors.sort();
  });

  return adjacency;
}

export function nativeBondByAtomPair(bonds: readonly MoleculeBond[]): ReadonlyMap<string, MoleculeBond> {
  return new Map(bonds.map((bond) => [atomPairKey(bond.fromAtomId, bond.toAtomId), bond]));
}

export function atomPairKey(leftAtomId: string, rightAtomId: string): string {
  return [leftAtomId, rightAtomId].sort().join("::");
}

let longestPathWork = 0;

/**
 * Cumulative longest-path search work (atoms dequeued plus path steps rebuilt) since the module
 * loaded. A test reads it before and after a call to prove the search stays near-linear on a chain
 * without timing it.
 */
export function longestNativePathWorkForTesting(): number {
  return longestPathWork;
}

/**
 * The path the SMILES writer and 2D cleanup lay a component along: the longest of the shortest
 * paths between two of `atoms`, ties broken by `compareNativePaths`.
 *
 * This used to search every ordered pair of atoms and copy the path at every step, O(n³) or worse:
 * 1.6 s for a 200-carbon chain, paid on every chain-tool drag frame. Now each start atom gets one
 * breadth-first pass with parent pointers, and only paths of the winning length are rebuilt. In a
 * forest a longest path runs leaf to leaf (an end with a second neighbor could be extended), so
 * only leaves start a search; any other graph starts one from every atom. Neighbors are visited in
 * adjacency order, so each path is the one the pairwise search found, and candidates reach the
 * comparator in the same (from, to) order: the chosen path, and the SMILES, are unchanged.
 */
export function longestNativePath(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const atomIds = atoms.map((atom) => atom.id).sort();
  if (atomIds.length === 0) {
    return ["C"];
  }

  const startAtomIds = isClosedNativeForest(atoms, adjacency)
    ? atomIds.filter((atomId) => (adjacency.get(atomId)?.length ?? 0) <= 1)
    : atomIds;
  let longestLength = 0;
  let candidates: (readonly string[])[] = [];
  for (const fromAtomId of startAtomIds) {
    const { parentById, depthById } = breadthFirstTree(fromAtomId, adjacency);
    // Endpoints are the given atoms only; the search may pass through others the adjacency names.
    const reachedAtomIds = atomIds.filter((atomId) => depthById.has(atomId));
    const farthest = reachedAtomIds.reduce((most, atomId) => Math.max(most, depthById.get(atomId) ?? 0), 0);
    if (farthest + 1 < longestLength) {
      continue;
    }
    if (farthest + 1 > longestLength) {
      longestLength = farthest + 1;
      candidates = [];
    }
    reachedAtomIds
      .filter((atomId) => depthById.get(atomId) === farthest)
      .forEach((toAtomId) => candidates.push(pathFromParents(toAtomId, parentById)));
  }

  return candidates.sort(compareNativePaths)[0] ?? [atomIds[0]];
}

/** Longer first; equal lengths by their dot-joined atom ids under `localeCompare`, as always. */
function compareNativePaths(left: readonly string[], right: readonly string[]): number {
  return right.length - left.length || left.join(".").localeCompare(right.join("."));
}

/**
 * Whether only leaves need to start a longest-path search: `atoms` form a forest under `adjacency`,
 * and the adjacency stays inside them. Anything else, including adjacency `nativeAdjacency` would
 * never build, answers false and gets the every-atom search, which is exact on any graph.
 */
function isClosedNativeForest(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): boolean {
  const atomIds = new Set(atoms.map((atom) => atom.id));
  if (atomIds.size !== atoms.length) {
    return false;
  }

  let bondEnds = 0;
  for (const atomId of atomIds) {
    for (const neighborId of adjacency.get(atomId) ?? []) {
      // A self-bond, a neighbor outside the atoms, or a list the neighbor does not mirror.
      if (neighborId === atomId || !atomIds.has(neighborId) || !(adjacency.get(neighborId) ?? []).includes(atomId)) {
        return false;
      }
      bondEnds += 1;
    }
  }

  // Mirrored lists hold each bond twice, and a forest has one bond fewer than atoms per component.
  // A ring, or a pair listed twice, pushes the count over.
  return bondEnds === 2 * (atomIds.size - nativeComponents(atoms, adjacency).length);
}

function breadthFirstTree(
  fromAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>
): { parentById: ReadonlyMap<string, string>; depthById: ReadonlyMap<string, number> } {
  const parentById = new Map<string, string>();
  const depthById = new Map([[fromAtomId, 0]]);
  const queue = [fromAtomId];
  for (let head = 0; head < queue.length; head += 1) {
    const atomId = queue[head];
    const neighborDepth = (depthById.get(atomId) ?? 0) + 1;
    longestPathWork += 1;
    for (const neighborId of adjacency.get(atomId) ?? []) {
      if (!depthById.has(neighborId)) {
        depthById.set(neighborId, neighborDepth);
        parentById.set(neighborId, atomId);
        queue.push(neighborId);
      }
    }
  }

  return { parentById, depthById };
}

function pathFromParents(toAtomId: string, parentById: ReadonlyMap<string, string>): readonly string[] {
  const path = [toAtomId];
  for (let atomId = parentById.get(toAtomId); atomId !== undefined; atomId = parentById.get(atomId)) {
    path.push(atomId);
  }
  longestPathWork += path.length;
  return path.reverse();
}

export function subtreeSize(
  atomId: string,
  parentAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>
): number {
  return 1 + (adjacency.get(atomId) ?? [])
    .filter((neighborId) => neighborId !== parentAtomId)
    .reduce((sum, neighborId) => sum + subtreeSize(neighborId, atomId, adjacency), 0);
}
