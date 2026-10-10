import { describe, expect, it } from "vitest";
import type { MoleculeAtom, MoleculeBond } from "@chemdraft/chem-core";
import { longestNativePath, nativeAdjacency, nativeSingleBondGraphSmiles } from "../src/index";
import { longestNativePathWorkForTesting } from "../src/testing";

type Adjacency = ReadonlyMap<string, readonly string[]>;
type Edge = readonly [number, number];

// The pairwise search longestNativePath replaced, kept verbatim as the oracle: one breadth-first
// search per ordered pair of atoms, copying the path at every step. It is O(n³) or worse, so the
// property checks below stay small.
function legacyLongestNativePath(atoms: readonly MoleculeAtom[], adjacency: Adjacency): readonly string[] {
  const atomIds = atoms.map((atom) => atom.id).sort();
  return atomIds
    .flatMap((fromAtomId) => atomIds.map((toAtomId) => legacyPathBetweenAtoms(fromAtomId, toAtomId, adjacency)))
    .filter((path): path is readonly string[] => path !== undefined)
    .sort((left, right) => right.length - left.length || left.join(".").localeCompare(right.join(".")))[0] ?? [atomIds[0] ?? "C"];
}

function legacyPathBetweenAtoms(fromAtomId: string, toAtomId: string, adjacency: Adjacency): readonly string[] | undefined {
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

/** mulberry32: a seeded generator, so a failure names a reproducible case. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function molecule(
  ids: readonly string[],
  edges: readonly Edge[],
  elements: readonly string[] = []
): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } {
  const atoms = ids.map((id, index): MoleculeAtom => ({ id, element: elements[index] ?? "C", x: index * 10, y: 0, formalCharge: 0 }));
  const bonds = edges.map(([from, to], index): MoleculeBond => ({
    id: `b${index}`,
    fromAtomId: ids[from]!,
    toAtomId: ids[to]!,
    order: "single"
  }));
  return { atoms, bonds };
}

const paddedIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `atom_${String(index + 1).padStart(3, "0")}`);

// Ids built to stress the tie-break: mixed case, digits that order differently as text and as
// numbers, "_" and "-" (which collation weighs differently from code-unit order), a non-ASCII
// letter, and "." itself, the join separator, so two different paths can join to one string.
const idPieces = ["a", "A", "b", "B", "c", "1", "9", "10", "_", "-", ".", "é"];

function awkwardIds(count: number, random: () => number): string[] {
  const ids = new Set<string>();
  while (ids.size < count) {
    const length = 1 + Math.floor(random() * 3);
    ids.add(Array.from({ length }, () => idPieces[Math.floor(random() * idPieces.length)]).join(""));
  }
  return [...ids];
}

function randomTreeEdges(count: number, random: () => number, offset = 0): Edge[] {
  const degrees = new Array<number>(count).fill(0);
  const edges: Edge[] = [];
  for (let child = 1; child < count; child += 1) {
    let parent = Math.floor(random() * child);
    while (degrees[parent]! >= 4) {
      parent = (parent + 1) % child;
    }
    degrees[parent]! += 1;
    degrees[child]! += 1;
    edges.push([offset + parent, offset + child]);
  }
  return edges;
}

/** Equal legs from one center: every pair of leg ends is a longest path, so everything ties. */
function spiderEdges(legs: number, legLength: number): Edge[] {
  const edges: Edge[] = [];
  let next = 1;
  for (let leg = 0; leg < legs; leg += 1) {
    let previous = 0;
    for (let step = 0; step < legLength; step += 1) {
      edges.push([previous, next]);
      previous = next;
      next += 1;
    }
  }
  return edges;
}

function completeBinaryTreeEdges(depth: number): Edge[] {
  const count = 2 ** (depth + 1) - 1;
  return Array.from({ length: count - 1 }, (_, index): Edge => [Math.floor(index / 2), index + 1]);
}

function expectSameAsLegacy(
  atoms: readonly MoleculeAtom[],
  adjacency: Adjacency,
  label: string
): void {
  expect(longestNativePath(atoms, adjacency), label).toEqual(legacyLongestNativePath(atoms, adjacency));
}

describe("longestNativePath", () => {
  it("chooses the same path as the pairwise search on random trees and forests", () => {
    let checked = 0;
    for (const count of [1, 2, 3, 4, 5, 6, 8, 10, 13, 17, 21, 26, 34]) {
      for (let seed = 1; seed <= 16; seed += 1) {
        const random = seededRandom(count * 1000 + seed);
        const ids = seed % 2 === 0 ? awkwardIds(count, random) : paddedIds(count);
        // Every third case is a forest: the atoms split into up to three trees.
        const split = seed % 3 === 0 ? [0, Math.floor(count / 3), Math.floor((2 * count) / 3), count] : [0, count];
        const edges = split.slice(1).flatMap((end, index) =>
          randomTreeEdges(end - split[index]!, random, split[index]!)
        );
        const { atoms, bonds } = molecule(ids, edges);
        expectSameAsLegacy(atoms, nativeAdjacency(atoms, bonds), `${count} atoms, seed ${seed}`);
        checked += 1;
      }
    }
    expect(checked).toBe(13 * 16);
  });

  it("breaks ties among equal longest paths exactly as before", () => {
    const shapes: Array<[string, number, Edge[]]> = [
      ["star", 9, spiderEdges(8, 1)],
      ["spider 3×2", 7, spiderEdges(3, 2)],
      ["spider 5×4", 21, spiderEdges(5, 4)],
      ["binary tree, depth 4", 31, completeBinaryTreeEdges(4)]
    ];
    for (const [name, count, edges] of shapes) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const ids = awkwardIds(count, seededRandom(seed * 7919 + count));
        const { atoms, bonds } = molecule(ids, edges);
        expectSameAsLegacy(atoms, nativeAdjacency(atoms, bonds), `${name}, seed ${seed}`);
      }
    }
  });

  it("keeps the old candidate order when the comparator calls two paths equal", () => {
    // "é" precomposed and "e" + combining acute are canonically equivalent, so localeCompare says
    // the two directions of this chain are equal and the sort keeps whichever came first.
    const precomposed = "é";
    const combining = "é";
    expect(`${precomposed}.c.${combining}`.localeCompare(`${combining}.c.${precomposed}`)).toBe(0);
    const { atoms, bonds } = molecule([precomposed, "c", combining], [[0, 1], [1, 2]]);
    const adjacency = nativeAdjacency(atoms, bonds);
    expectSameAsLegacy(atoms, adjacency, "canonically equivalent ends");
    expect(longestNativePath(atoms, adjacency)).toEqual([combining, "c", precomposed]);

    // Ids containing the join separator: ["a.b", "c"] and ["a", "b.c"] both join to "a.b.c".
    const dotted = molecule(["a.b", "c", "x", "a", "b.c"], [[0, 1], [1, 2], [2, 3], [3, 4]]);
    expectSameAsLegacy(dotted.atoms, nativeAdjacency(dotted.atoms, dotted.bonds), "dotted ids");
  });

  it("chooses the same path as the pairwise search on graphs with rings", () => {
    for (const count of [3, 5, 8, 12, 20, 30]) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const random = seededRandom(count * 31 + seed);
        const ids = seed % 2 === 0 ? awkwardIds(count, random) : paddedIds(count);
        const edges = randomTreeEdges(count, random);
        const bonded = new Set(edges.map(([from, to]) => `${Math.min(from, to)}:${Math.max(from, to)}`));
        for (let extra = 0; extra < 1 + (seed % 3); extra += 1) {
          const from = Math.floor(random() * count);
          const to = Math.floor(random() * count);
          const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
          if (from !== to && !bonded.has(key)) {
            bonded.add(key);
            edges.push([from, to]);
          }
        }
        const { atoms, bonds } = molecule(ids, edges);
        expectSameAsLegacy(atoms, nativeAdjacency(atoms, bonds), `${count} atoms with rings, seed ${seed}`);
      }
    }
  });

  it("chooses the same path when the adjacency is not a closed forest", () => {
    const chain = molecule(paddedIds(8), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]);
    const chainAdjacency = nativeAdjacency(chain.atoms, chain.bonds);
    // Endpoints restricted to some atoms while the search runs through the rest of the molecule.
    expectSameAsLegacy(chain.atoms.filter((_, index) => index % 3 !== 0), chainAdjacency, "atom subset");
    // Two bonds between one pair: a two-membered cycle.
    const doubled = molecule(paddedIds(4), [[0, 1], [1, 2], [1, 2], [2, 3]]);
    expectSameAsLegacy(doubled.atoms, nativeAdjacency(doubled.atoms, doubled.bonds), "duplicate bond");
    // A bond from an atom to itself.
    const looped = molecule(paddedIds(4), [[0, 1], [1, 1], [1, 2], [2, 3]]);
    expectSameAsLegacy(looped.atoms, nativeAdjacency(looped.atoms, looped.bonds), "self bond");
    // Lists that do not mirror each other, whose lengths still add up to a tree's (four entries,
    // three atoms, one component). Only the last atom has a short list, yet the longest path
    // starts at the first: a leaf-only search here would answer ["atom_003"].
    const oneWay: Adjacency = new Map([
      ["atom_001", ["atom_002", "atom_002"]],
      ["atom_002", ["atom_003", "atom_003"]],
      ["atom_003", []]
    ]);
    const oneWayAtoms = molecule(paddedIds(3), []).atoms;
    expectSameAsLegacy(oneWayAtoms, oneWay, "one-way adjacency");
    expect(longestNativePath(oneWayAtoms, oneWay)).toEqual(["atom_001", "atom_002", "atom_003"]);
    expectSameAsLegacy([], new Map(), "no atoms");
  });

  it("writes the same SMILES as before for tied and branched trees", () => {
    // Captured from the writer before the search was replaced (AGENTS.md §7: chemistry unchanged).
    const cases: Array<[string, ReturnType<typeof molecule>]> = [
      ["CC(C)(C)C", molecule(paddedIds(5), [[0, 1], [0, 2], [0, 3], [0, 4]])],
      ["CCC(C(C))CC", molecule(paddedIds(7), spiderEdges(3, 2))],
      ["NC(S)CO", molecule(["a0", "a1", "a2", "a3", "a4"], [[0, 1], [0, 2], [1, 3], [0, 4]], ["C", "C", "N", "O", "S"])],
      ["CNCOC", molecule(["z9", "a1", "m5", "b2", "c3"], [[0, 1], [1, 2], [2, 3], [3, 4]], ["C", "O", "C", "N", "C"])],
      ["CCO.NC(C)C", molecule(["a0", "a1", "a2", "a3", "a4", "a5", "a6"], [[0, 1], [1, 2], [3, 4], [4, 5], [4, 6]], ["C", "C", "O", "N", "C", "C", "C"])]
    ];
    for (const [smiles, { atoms, bonds }] of cases) {
      expect(nativeSingleBondGraphSmiles(atoms, bonds)).toBe(smiles);
    }
  });

  it("searches a chain in linear work", () => {
    // The pairwise search did n² breadth-first searches on a chain, each copying its path at every
    // step: a 200-carbon chain took 1.6 s per chain-tool drag frame. A chain has two leaves, so it
    // now takes two searches and rebuilds two paths.
    const work = (count: number): number => {
      const { atoms, bonds } = molecule(paddedIds(count), Array.from({ length: count - 1 }, (_, index): Edge => [index, index + 1]));
      const adjacency = nativeAdjacency(atoms, bonds);
      const before = longestNativePathWorkForTesting();
      expect(longestNativePath(atoms, adjacency)).toEqual(atoms.map((atom) => atom.id));
      return longestNativePathWorkForTesting() - before;
    };
    expect(work(200)).toBeLessThanOrEqual(4 * 200);
    expect(work(400)).toBeLessThan(work(200) * 2.2);
  });

  it("writes a 200-carbon chain's SMILES in linear search work", () => {
    const count = 200;
    const { atoms, bonds } = molecule(paddedIds(count), Array.from({ length: count - 1 }, (_, index): Edge => [index, index + 1]));
    const before = longestNativePathWorkForTesting();
    expect(nativeSingleBondGraphSmiles(atoms, bonds)).toBe("C".repeat(count));
    expect(longestNativePathWorkForTesting() - before).toBeLessThanOrEqual(4 * count);
  });
});
