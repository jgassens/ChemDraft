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

export function longestNativePath(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const atomIds = atoms.map((atom) => atom.id).sort();
  return atomIds
    .flatMap((fromAtomId) => atomIds.map((toAtomId) => pathBetweenAtoms(fromAtomId, toAtomId, adjacency)))
    .filter((path): path is readonly string[] => path !== undefined)
    .sort((left, right) => right.length - left.length || left.join(".").localeCompare(right.join(".")))[0] ?? [atomIds[0] ?? "C"];
}

function pathBetweenAtoms(
  fromAtomId: string,
  toAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
  const pending: Array<readonly string[]> = [[fromAtomId]];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const path = pending.shift();
    const atomId = path?.[path.length - 1];
    if (!path || !atomId || visited.has(atomId)) {
      continue;
    }
    if (atomId === toAtomId) {
      return path;
    }

    visited.add(atomId);
    for (const neighborId of adjacency.get(atomId) ?? []) {
      if (!visited.has(neighborId)) {
        pending.push([...path, neighborId]);
      }
    }
  }

  return undefined;
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
