// The native SMILES writer and its bond-order resolution.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomValenceForCharge } from "@chemdraft/layout-engine";
import {
  atomBondOrderUsageMap,
  nativeBondValenceContribution,
  nativeElementFromAtomLabel,
  type NativeElementSymbol,
  nativeImplicitHydrogenCount,
  nativeSingleHeavyElementLabelValence
} from "./atoms";
import {
  atomPairKey,
  findSingleCycleAtomIds,
  isForestGraph,
  longestNativePath,
  nativeAdjacency,
  nativeBondByAtomPair,
  nativeComponents,
  subtreeSize
} from "./graph";

/** Labels whose native atoms have to become dummy `[*]` atoms in SMILES. */
export function nativeMoleculeUnspellableLabels(molecule: MoleculeObject): string[] {
  return [...new Set(molecule.atoms
    .filter((atom) =>
      atom.element !== "D" && atom.element !== "T" &&
      nativeElementFromAtomLabel(atom.element) === undefined &&
      nativeSingleHeavyElementLabelValence(atom.element) === undefined
    )
    .map((atom) => atom.element))];
}

/**
 * Bond orders a SMILES string can carry are single, double and triple. Two drawn orders cannot be
 * written as they are: `aromatic` (a molfile type-4 bond, which the app otherwise counts as one
 * covalent slot) and `unknown`. Aromatic bonds are kekulized here — resolved into an alternating
 * single/double pattern — so every writer and the bracket-atom hydrogen count below see ordinary
 * orders; an aromatic bond outside a ring, or a ring system with no such pattern, is written
 * single and reported. `unknown` is written single and reported: "~" would read back in
 * OpenChemLib as an any-bond with no hydrogens. The report goes to `warningsOut` when the caller
 * can surface it (Copy As, the structure-list export); `refreshNativeSingleBondGraph`, which
 * only stores the string, passes nothing.
 */
export function nativeSmilesWritableBonds(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  warningsOut?: string[]
): MoleculeBond[] {
  const { bonds: kekulized, warnings } = nativeSmilesBondOrderResolution(atoms, bonds);
  warningsOut?.push(...warnings.unknown, ...warnings.aromatic);
  return kekulized;
}

/**
 * The two warning groups separately, for callers whose engine route differs from the native
 * writer's: an unknown-order bond writes as single on every route (the V2000 writer has no code
 * for it either), but the aromatic downgrades happen only when the native writer is the one
 * producing the string — RDKit reads the molfile's type-4 bonds and resolves them itself.
 */
export function nativeSmilesBondOrderResolution(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): { bonds: MoleculeBond[]; warnings: { unknown: string[]; aromatic: string[] } } {
  const warnings = { unknown: [] as string[], aromatic: [] as string[] };
  const unknownCount = bonds.filter((bond) => bond.order === "unknown").length;
  if (unknownCount > 0) {
    warnings.unknown.push(
      `${unknownCount} bond${unknownCount === 1 ? "" : "s"} of unknown order written to SMILES as single.`
    );
  }
  const kekulized = kekulizeNativeAromaticBonds(atoms, bonds);
  if (kekulized.nonRing > 0) {
    warnings.aromatic.push(
      `${kekulized.nonRing} aromatic bond${kekulized.nonRing === 1 ? "" : "s"} outside any ring written to SMILES as single.`
    );
  }
  if (kekulized.unresolved > 0) {
    warnings.aromatic.push(
      `${kekulized.unresolved} aromatic bond${kekulized.unresolved === 1 ? "" : "s"} could not be resolved into alternating single and double bonds; written to SMILES as single.`
    );
  }
  return {
    bonds: kekulized.bonds.map((bond) =>
      bond.order === "unknown" || bond.order === "aromatic" ? { ...bond, order: "single" } : bond
    ),
    warnings
  };
}

/** Node-visit budget for one ring system's matching search; past it the system is reported. */
const KEKULE_SEARCH_BUDGET = 200000;

/**
 * Assign alternating single/double orders to the aromatic bonds so the result is a valid Kekulé
 * structure. Returns the bonds with every resolvable aromatic bond rewritten, plus how many
 * aromatic bonds were left as they are because they sit outside any ring (`nonRing`) or belong to
 * a ring system with no assignment (`unresolved`); the caller writes those as single.
 *
 * Each atom on a ring aromatic bond either takes exactly one double bond or none. The app's own
 * valence model decides what an atom CAN do: with no spare slot beyond its bonds (furan's O,
 * thiophene's S, N-methylpyrrole's N) it takes none and keeps its lone pair. A neutral carbon
 * (or boron) with a spare slot must take one — a ring carbon holds no lone pair. Everything
 * else with a spare slot is flexible: pyridine's N, pyrrole's N–H, a C⁻, an O⁺. The search
 * per ring system finds a perfect matching over the must-take atoms plus as many flexible atoms
 * as possible — pyridazine's two adjacent nitrogens pair with each other, pyrrole's lone N is
 * the one atom left out of a five-ring, tropylium's C⁺ likewise, and the cyclopentadienyl C⁻
 * keeps its hydrogen. An atom left out keeps the hydrogen count the valence model gives it.
 * Ring systems are solved independently so one unresolvable ring never spoils another, and the
 * search stops at the first assignment that leaves no flexible atom out.
 */
function kekulizeNativeAromaticBonds(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): { bonds: MoleculeBond[]; nonRing: number; unresolved: number } {
  const aromaticIndices = bonds.flatMap((bond, index) => bond.order === "aromatic" ? [index] : []);
  if (aromaticIndices.length === 0) {
    return { bonds: [...bonds], nonRing: 0, unresolved: 0 };
  }
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const otherEnd = (index: number, atomId: string): string =>
    bonds[index]!.fromAtomId === atomId ? bonds[index]!.toAtomId : bonds[index]!.fromAtomId;

  // Ring membership within the aromatic subgraph: a bond is a bridge (in no ring) when removing
  // it disconnects its ends. Bridges are written single; only ring bonds enter the matching.
  const aromaticByAtom = new Map<string, number[]>();
  for (const index of aromaticIndices) {
    for (const atomId of [bonds[index]!.fromAtomId, bonds[index]!.toAtomId]) {
      aromaticByAtom.set(atomId, [...(aromaticByAtom.get(atomId) ?? []), index]);
    }
  }
  const connectedWithout = (skip: number, from: string, to: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const atomId = queue.pop()!;
      if (atomId === to) return true;
      for (const index of aromaticByAtom.get(atomId) ?? []) {
        if (index === skip) continue;
        const next = otherEnd(index, atomId);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  const ringIndices = aromaticIndices.filter((index) =>
    connectedWithout(index, bonds[index]!.fromAtomId, bonds[index]!.toAtomId)
  );
  const nonRing = aromaticIndices.length - ringIndices.length;
  const ringByAtom = new Map<string, number[]>();
  for (const index of ringIndices) {
    for (const atomId of [bonds[index]!.fromAtomId, bonds[index]!.toAtomId]) {
      ringByAtom.set(atomId, [...(ringByAtom.get(atomId) ?? []), index]);
    }
  }

  // Valence already spent on everything but ring aromatic bonds (a non-ring aromatic bond
  // counts as the single it becomes), then each atom's class.
  const spent = new Map<string, number>();
  const ringIndexLookup = new Set(ringIndices);
  bonds.forEach((bond, index) => {
    if (ringIndexLookup.has(index)) return;
    const value = bond.order === "aromatic" || bond.order === "unknown" ? 1 : nativeBondValenceContribution(bond);
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      spent.set(atomId, (spent.get(atomId) ?? 0) + value);
    }
  });
  type AtomClass = "must" | "never" | "flex";
  const classOf = new Map<string, AtomClass>();
  for (const atomId of ringByAtom.keys()) {
    const atom = atomById.get(atomId);
    const element = atom ? nativeElementFromAtomLabel(atom.element) : undefined;
    if (!atom || !element) {
      classOf.set(atomId, "never");
      continue;
    }
    const spare = nativeAtomValenceForCharge(element, atom.formalCharge)
      - (spent.get(atomId) ?? 0) - (ringByAtom.get(atomId)?.length ?? 0) - (atom.markRadicals ?? 0);
    classOf.set(atomId, kekuleAtomClass(element, atom.formalCharge, spare));
  }
  // Deterministic search: neighbours in id order, whatever order the bond array arrived in.
  for (const [atomId, indices] of ringByAtom) {
    ringByAtom.set(atomId, [...indices].sort((left, right) => otherEnd(left, atomId).localeCompare(otherEnd(right, atomId))));
  }

  // Ring systems: connected components of the ring aromatic bonds, solved one at a time.
  const doubleIndices = new Set<number>();
  const unresolvedIndices = new Set<number>();
  const ringIndexSet = new Set(ringIndices);
  const assignedAtoms = new Set<string>();
  for (const seedAtomId of ringByAtom.keys()) {
    if (assignedAtoms.has(seedAtomId)) continue;
    const systemAtoms: string[] = [];
    const queue = [seedAtomId];
    assignedAtoms.add(seedAtomId);
    while (queue.length > 0) {
      const atomId = queue.pop()!;
      systemAtoms.push(atomId);
      for (const index of ringByAtom.get(atomId) ?? []) {
        const next = otherEnd(index, atomId);
        if (!assignedAtoms.has(next)) {
          assignedAtoms.add(next);
          queue.push(next);
        }
      }
    }
    const systemBonds = new Set(systemAtoms.flatMap((atomId) => ringByAtom.get(atomId) ?? []));
    const solution = kekuleMatching(systemAtoms, classOf, ringByAtom, otherEnd);
    if (solution) {
      for (const index of solution) doubleIndices.add(index);
    } else {
      // The whole system stays `aromatic` here; the caller downgrades it to single and reports it.
      for (const index of systemBonds) unresolvedIndices.add(index);
    }
  }
  return {
    bonds: bonds.map((bond, index) => {
      if (bond.order !== "aromatic") return bond;
      if (doubleIndices.has(index)) return { ...bond, order: "double" };
      if (!ringIndexSet.has(index) || unresolvedIndices.has(index)) return bond;
      return { ...bond, order: "single" };
    }),
    nonRing,
    unresolved: unresolvedIndices.size
  };
}

/**
 * What an aromatic ring atom may do in the Kekulé pattern, from its element, charge and the
 * valence it has to spare. "never": takes no double bond and keeps its lone pair (or, for a
 * cation carbon, its empty orbital): any atom with no spare slot, any anion, a C⁺. "must": takes
 * exactly one — a neutral carbon or boron, a B⁻ (carbon-like), and a cationic heteroatom such as pyrylium's O⁺ or
 * an N-alkyl pyridinium N⁺, which has no lone pair left to hold. "flex": the neutral N/P/As
 * with a spare slot, which is pyridine-type or pyrrole-type depending on the ring — the search
 * decides. Charges are never "flex": a C⁺ must not trade its role with a neutral nitrogen.
 */
function kekuleAtomClass(element: NativeElementSymbol, formalCharge: number, spare: number): "must" | "never" | "flex" {
  if (spare < 1) return "never";
  // A B⁻ is carbon-like (boratabenzene's B⁻ takes a double bond); every other anion holds a pair.
  if (formalCharge < 0) return element === "B" ? "must" : "never";
  if (formalCharge > 0) return element === "C" || element === "B" ? "never" : "must";
  if (element === "C" || element === "B") return "must";
  return element === "N" || element === "P" || element === "As" ? "flex" : "never";
}

/**
 * Branch-and-bound matching for one ring system: every "must" atom takes exactly one bond, no
 * "never" atom takes any, and as few "flex" atoms as possible are left out. Returns the chosen
 * bond indices, or undefined when no assignment covers the must atoms — or when the visit budget
 * ran out before an assignment leaving no flexible atom out was found, since a provisional best
 * is then unproven and must not reach the document silently.
 */
function kekuleMatching(
  systemAtoms: readonly string[],
  classOf: ReadonlyMap<string, "must" | "never" | "flex">,
  ringByAtom: ReadonlyMap<string, readonly number[]>,
  otherEnd: (index: number, atomId: string) => string
): Set<number> | undefined {
  const order = [
    ...systemAtoms.filter((atomId) => classOf.get(atomId) === "must"),
    ...systemAtoms.filter((atomId) => classOf.get(atomId) === "flex")
  ].sort((left, right) => (classOf.get(left) === classOf.get(right) ? left.localeCompare(right) : classOf.get(left) === "must" ? -1 : 1));
  const matched = new Set<string>();
  const chosen = new Set<number>();
  let best: Set<number> | undefined;
  let bestLeftOut = Number.POSITIVE_INFINITY;
  let visits = 0;
  let exhausted = false;
  const search = (position: number, leftOut: number): void => {
    if (best && bestLeftOut === 0) return;
    if (leftOut >= bestLeftOut) return;
    if (visits++ > KEKULE_SEARCH_BUDGET) {
      exhausted = true;
      return;
    }
    let index = position;
    while (index < order.length && matched.has(order[index]!)) index += 1;
    if (index >= order.length) {
      bestLeftOut = leftOut;
      best = new Set(chosen);
      return;
    }
    const atomId = order[index]!;
    for (const bondIndex of ringByAtom.get(atomId) ?? []) {
      const other = otherEnd(bondIndex, atomId);
      if (matched.has(other) || classOf.get(other) === "never") continue;
      matched.add(atomId);
      matched.add(other);
      chosen.add(bondIndex);
      search(index + 1, leftOut);
      chosen.delete(bondIndex);
      matched.delete(atomId);
      matched.delete(other);
    }
    if (classOf.get(atomId) === "flex") {
      matched.add(atomId);
      search(index + 1, leftOut + 1);
      matched.delete(atomId);
    }
  };
  search(0, 0);
  return exhausted && bestLeftOut > 0 ? undefined : best;
}

export function nativeSingleBondGraphSmiles(
  atoms: readonly MoleculeAtom[],
  inputBonds: readonly MoleculeBond[],
  warningsOut?: string[]
): string {
  if (atoms.length === 0) {
    return "";
  }
  const bonds = nativeSmilesWritableBonds(atoms, inputBonds, warningsOut);
  const smilesByAtomId = nativeAtomSmilesById(atoms, bonds);
  const adjacency = nativeAdjacency(atoms, bonds);
  const bondByAtomPair = nativeBondByAtomPair(bonds);
  const components = nativeComponents(atoms, adjacency);
  const singleCycleSmiles = renderSingleCycleWithBranchesSmiles(atoms, bonds, components, adjacency, smilesByAtomId, bondByAtomPair);
  if (singleCycleSmiles) {
    return singleCycleSmiles;
  }
  if (!isForestGraph(atoms, bonds, components)) {
    // Any graph the single-cycle renderer can't linearize — fused/bridged/spiro polycyclics
    // (naphthalene, decalin, steroids, …) or multiple components where at least one has a
    // ring — goes through the general DFS spanning-tree writer. The former fallback here
    // concatenated bare atom symbols, which SMILES reads as a bonded chain, silently turning
    // every multi-ring molecule into an acyclic one (10-carbon naphthalene → "CCCCCCCCCC").
    return nativeGeneralGraphSmiles(components, adjacency, smilesByAtomId, bondByAtomPair);
  }

  return components.map((componentIds) => {
    if (componentIds.length === 1) {
      return smilesByAtomId.get(componentIds[0]) ?? "C";
    }

    const componentAtoms = atoms.filter((atom) => componentIds.includes(atom.id));
    const mainPath = longestNativePath(componentAtoms, adjacency);
    return renderNativePath(mainPath, adjacency, smilesByAtomId, bondByAtomPair);
  }).join(".");
}

/**
 * General SMILES writer for arbitrary connected graphs. It builds a depth-first spanning tree
 * and turns each non-tree ("back") edge into a ring-closure digit, so it linearizes any ring
 * system — fused, bridged, or spiro — that the single-cycle renderer above cannot. Bond orders
 * come from `bondOrderSymbol` and atom tokens from the precomputed `smilesByAtomId` map (see
 * `nativeAtomSmilesById`); it is a pure graph→string function with no OpenChemLib dependency,
 * keeping OCL worker-only.
 */
function nativeGeneralGraphSmiles(
  components: readonly (readonly string[])[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  smilesByAtomId: ReadonlyMap<string, string>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  return components
    .map((componentIds) => renderConnectedGraphSmiles(componentIds, adjacency, smilesByAtomId, bondByAtomPair))
    .join(".");
}

function renderConnectedGraphSmiles(
  componentIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  smilesByAtomId: ReadonlyMap<string, string>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  if (componentIds.length <= 1) {
    return smilesByAtomId.get(componentIds[0]) ?? "C";
  }

  const rootAtomId = [...componentIds].sort()[0];

  // Phase 1 — carve a spanning tree out of the component. Every undirected edge (keyed by
  // atomPairKey) is classified exactly once: an edge into an unvisited atom is a tree edge,
  // an edge into an already-visited atom is a back edge and becomes a ring closure.
  const visited = new Set<string>();
  const classifiedEdges = new Set<string>();
  const ringClosureEdgeKeys = new Set<string>();
  const treeChildren = new Map<string, string[]>();

  const buildSpanningTree = (atomId: string): void => {
    visited.add(atomId);
    const children: string[] = [];
    (adjacency.get(atomId) ?? []).forEach((neighborId) => {
      const edgeKey = atomPairKey(atomId, neighborId);
      if (classifiedEdges.has(edgeKey)) {
        return;
      }
      classifiedEdges.add(edgeKey);
      if (visited.has(neighborId)) {
        ringClosureEdgeKeys.add(edgeKey);
      } else {
        children.push(neighborId);
        buildSpanningTree(neighborId);
      }
    });
    treeChildren.set(atomId, children);
  };
  buildSpanningTree(rootAtomId);

  // Phase 2 — emit in the same pre-order the tree was built. A ring-closure digit is allocated
  // the first time an atom touches a closure edge (the opening end, always emitted before its
  // partner) and released when the partner closes it, so digits stay small and get reused.
  const openRingDigits = new Map<string, number>();
  const freedRingDigits: number[] = [];
  let nextRingDigit = 1;

  const acquireRingDigit = (): number => {
    if (freedRingDigits.length > 0) {
      freedRingDigits.sort((left, right) => left - right);
      return freedRingDigits.shift() as number;
    }
    const digit = nextRingDigit;
    nextRingDigit += 1;
    return digit;
  };

  const emitAtom = (atomId: string): string => {
    const ringClosures = (adjacency.get(atomId) ?? [])
      .map((neighborId) => atomPairKey(atomId, neighborId))
      .filter((edgeKey) => ringClosureEdgeKeys.has(edgeKey))
      .map((edgeKey) => {
        const openDigit = openRingDigits.get(edgeKey);
        if (openDigit !== undefined) {
          openRingDigits.delete(edgeKey);
          freedRingDigits.push(openDigit);
          return ringClosureDigitToken(openDigit);
        }
        const digit = acquireRingDigit();
        openRingDigits.set(edgeKey, digit);
        // The ring bond order is written once, at the opening end (SMILES allows it at either).
        return `${bondOrderSymbol(bondByAtomPair.get(edgeKey)?.order)}${ringClosureDigitToken(digit)}`;
      })
      .join("");

    const renderedChildren = (treeChildren.get(atomId) ?? []).map((childId) =>
      `${bondOrderSymbol(bondByAtomPair.get(atomPairKey(atomId, childId))?.order)}${emitAtom(childId)}`
    );
    const branches = renderedChildren.slice(0, -1).map((child) => `(${child})`).join("");
    const continuation = renderedChildren.length > 0 ? renderedChildren[renderedChildren.length - 1] : "";

    return `${smilesByAtomId.get(atomId) ?? "C"}${ringClosures}${branches}${continuation}`;
  };

  return emitAtom(rootAtomId);
}

function ringClosureDigitToken(digit: number): string {
  return digit < 10 ? String(digit) : `%${String(digit).padStart(2, "0")}`;
}

function renderSingleCycleWithBranchesSmiles(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  components: readonly (readonly string[])[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  smilesByAtomId: ReadonlyMap<string, string>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string | undefined {
  if (components.length !== 1 || atoms.length < 3 || bonds.length !== atoms.length) {
    return undefined;
  }

  const cycleAtomIds = findSingleCycleAtomIds(atoms, adjacency);
  if (!cycleAtomIds || cycleAtomIds.length < 3) {
    return undefined;
  }

  const cycleAtomIdSet = new Set(cycleAtomIds);
  const cycleAdjacency = new Map(cycleAtomIds.map((atomId) => [
    atomId,
    (adjacency.get(atomId) ?? []).filter((neighborId) => cycleAtomIdSet.has(neighborId)).sort()
  ]));
  if ([...cycleAdjacency.values()].some((neighbors) => neighbors.length !== 2)) {
    return undefined;
  }

  const startAtomId = [...cycleAtomIds].sort()[0];
  const firstNeighborId = cycleAdjacency.get(startAtomId)?.[0];
  if (!firstNeighborId) {
    return undefined;
  }

  const cyclePath = [startAtomId];
  let previousAtomId = startAtomId;
  let currentAtomId = firstNeighborId;
  while (currentAtomId !== startAtomId) {
    cyclePath.push(currentAtomId);
    const nextAtomId = (cycleAdjacency.get(currentAtomId) ?? []).find((neighborId) => neighborId !== previousAtomId);
    if (!nextAtomId || cyclePath.length > cycleAtomIds.length) {
      return undefined;
    }

    previousAtomId = currentAtomId;
    currentAtomId = nextAtomId;
  }

  if (cyclePath.length !== cycleAtomIds.length) {
    return undefined;
  }

  return cyclePath.map((atomId, index) => {
    const symbol = smilesByAtomId.get(atomId) ?? "C";
    const previousAtomId = cyclePath[index - 1];
    const bondPrefix = previousAtomId ? bondOrderSymbol(bondByAtomPair.get(atomPairKey(previousAtomId, atomId))?.order) : "";
    // The closure bond (last atom back to the first) is not a chain bond, so its order has to
    // ride on the ring digit. SMILES lets it sit at either end; write it once, at the opening
    // end, as the general DFS writer does. A bare "1" silently downgraded a double closure to
    // single, turning drawn benzene into cyclohexa-1,3-diene ("C1C=CC=CC1").
    const ringClosure = index === 0
      ? `${bondOrderSymbol(bondByAtomPair.get(atomPairKey(atomId, cyclePath[cyclePath.length - 1]))?.order)}1`
      : index === cyclePath.length - 1 ? "1" : "";
    const cycleNeighbors = new Set(cycleAdjacency.get(atomId) ?? []);
    const branches = (adjacency.get(atomId) ?? [])
      .filter((neighborId) => !cycleNeighbors.has(neighborId))
      .sort((left, right) =>
        subtreeSize(right, atomId, adjacency) - subtreeSize(left, atomId, adjacency) || left.localeCompare(right)
      )
      .map((branchId) => `(${renderNativeBranch(branchId, atomId, adjacency, smilesByAtomId, bondByAtomPair)})`)
      .join("");
    return `${bondPrefix}${symbol}${ringClosure}${branches}`;
  }).join("");
}

function renderNativePath(
  path: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  smilesByAtomId: ReadonlyMap<string, string>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  return path.map((atomId, index) => {
    const previousAtomId = path[index - 1];
    const nextAtomId = path[index + 1];
    const bondPrefix = previousAtomId ? bondOrderSymbol(bondByAtomPair.get(atomPairKey(previousAtomId, atomId))?.order) : "";
    const branches = (adjacency.get(atomId) ?? [])
      .filter((neighborId) => neighborId !== previousAtomId && neighborId !== nextAtomId)
      .sort((left, right) =>
        subtreeSize(right, atomId, adjacency) - subtreeSize(left, atomId, adjacency) || left.localeCompare(right)
      );
    return `${bondPrefix}${smilesByAtomId.get(atomId) ?? "C"}${branches.map((branchId) =>
      `(${renderNativeBranch(branchId, atomId, adjacency, smilesByAtomId, bondByAtomPair)})`
    ).join("")}`;
  }).join("");
}

function renderNativeBranch(
  atomId: string,
  parentAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  smilesByAtomId: ReadonlyMap<string, string>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  const bondPrefix = bondOrderSymbol(bondByAtomPair.get(atomPairKey(parentAtomId, atomId))?.order);
  const branches = (adjacency.get(atomId) ?? [])
    .filter((neighborId) => neighborId !== parentAtomId)
    .sort((left, right) =>
      subtreeSize(right, atomId, adjacency) - subtreeSize(left, atomId, adjacency) || left.localeCompare(right)
    );
  return `${bondPrefix}${smilesByAtomId.get(atomId) ?? "C"}${branches.map((branchId) =>
    `(${renderNativeBranch(branchId, atomId, adjacency, smilesByAtomId, bondByAtomPair)})`
  ).join("")}`;
}

/**
 * Only single, double and triple ever reach the writers: `nativeSmilesWritableBonds` kekulizes
 * aromatic bonds and downgrades (with a warning) whatever cannot be written, so the two
 * orders this function cannot spell never arrive here silently.
 */
function bondOrderSymbol(order: MoleculeBond["order"] | undefined): string {
  if (order === "double") {
    return "=";
  }
  if (order === "triple") {
    return "#";
  }

  return "";
}

/**
 * The SMILES "organic subset" — the only elements that may appear UNBRACKETED. Anything else
 * (Zn, Li, Si, …) written bare is either invalid SMILES or, worse, valid-but-wrong: a literal
 * typed "C" emitted bare reparses as methane, a typed "N" as ammonia.
 */
const smilesOrganicSubset = new Set(["B", "C", "N", "O", "P", "S", "F", "Cl", "Br", "I"]);

/**
 * One atom's SMILES token. Neutral organic-subset drawn atoms stay bare (ethanol stays "CCO");
 * everything that bare emission would misrepresent is bracketed:
 * - charged atoms: `[NH3+]`, `[Zn+2]` (brackets already carry the charge; parsers add no implicit H);
 * - literal (text-typed) atoms: `[C]`, `[N]` — a bracket atom gets NO implicit hydrogens, which is
 *   exactly the literal contract: the label means what it says (verified against OpenChemLib:
 *   `[C]` reparses to C, bare `C` to CH4);
 * - hydrogen: `[H]`;
 * - non-subset elements: `[Zn]`, `[Li]`, `[SiH2]` — bracketed, with the skeletal implicit
 *   hydrogens SPELLED (bracket atoms get none from the parser), so a drawn silane carbon analog
 *   keeps its hydrogens. The count is the same derivation the formula and the drawn label use.
 *
 * `implicitHydrogens` matters for every non-literal element atom written in brackets;
 * `nativeAtomSmilesById` computes it.
 */
/**
 * A bracket atom's charge in SMILES order — sign then magnitude (`[Zn+2]`). The DISPLAY
 * convention is the reverse ("2+", `atomChargeLabelSuffix`); writing that into SMILES makes
 * the string invalid, and the mistake only became reachable when charge marks learned to
 * stack past ±1.
 */
function smilesChargeSuffix(charge: number): string {
  if (charge === 0) {
    return "";
  }
  const sign = charge > 0 ? "+" : "-";
  const magnitude = Math.abs(charge);
  return magnitude === 1 ? sign : `${sign}${magnitude}`;
}

function nativeAtomSmiles(atom: MoleculeAtom | undefined, implicitHydrogens = 0): string {
  if (!atom) {
    return "C";
  }

  if (atom.element === "D" || atom.element === "T") {
    return `[${atom.element === "D" ? 2 : 3}H${smilesChargeSuffix(atom.formalCharge)}]`;
  }

  const element = nativeElementFromAtomLabel(atom.element);
  if (!element) {
    // Condensed labels store the whole group in the atom's element string ("CH3", "CO2H", "Ph").
    // A single SMILES atom can spell only labels that reduce to ONE heavy element plus its
    // hydrogens ("CH3" → "[CH3]", "NH2" → "[NH2]") — exactly what the label says. Anything else
    // (multi-heavy "CO2H", abbreviations like "Ph") has no single-atom spelling: emit a dummy
    // atom so the SMILES stays parseable, and let the Copy As path warn that the label exported
    // as [*] rather than silently writing "CH3" (which a SMILES parser reads as C + garbage).
    const spelled = nativeSingleHeavyElementLabelValence(atom.element);
    if (!spelled) {
      return `[*${smilesChargeSuffix(atom.formalCharge)}]`;
    }
    const hydrogens = spelled.hydrogens > 0 ? `H${spelled.hydrogens === 1 ? "" : spelled.hydrogens}` : "";
    return `[${spelled.element}${hydrogens}${smilesChargeSuffix(atom.formalCharge)}]`;
  }

  if (atom.formalCharge !== 0) {
    const hydrogens = implicitHydrogens > 0 ? `H${implicitHydrogens === 1 ? "" : implicitHydrogens}` : "";
    return `[${element}${hydrogens}${smilesChargeSuffix(atom.formalCharge)}]`;
  }

  if (element === "H") {
    return "[H]";
  }

  if (atom.labelLiteral === true) {
    return `[${element}]`;
  }

  if (!smilesOrganicSubset.has(element)) {
    const hydrogens = implicitHydrogens > 0 ? `H${implicitHydrogens === 1 ? "" : implicitHydrogens}` : "";
    return `[${element}${hydrogens}]`;
  }

  return element;
}

/**
 * Per-atom SMILES tokens for the graph writers above, precomputed in one pass: the bracketed
 * charged/non-subset form must spell the atom's implicit hydrogens, and that count depends on the
 * whole bond set (`atomBondOrderUsageMap`), not on the atom alone.
 */
function nativeAtomSmilesById(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): Map<string, string> {
  const valenceUsage = atomBondOrderUsageMap(atoms, bonds);
  return new Map(atoms.map((atom) => {
    const element = nativeElementFromAtomLabel(atom.element);
    const needsSpelledHydrogens = element !== undefined &&
      element !== "H" &&
      atom.labelLiteral !== true &&
      (atom.formalCharge !== 0 || !smilesOrganicSubset.has(element));
    // The dative-deprotonation rule (a pyrrole-type N–H donating to a metal) never reaches
    // this spelling: it applies only to a neutral nitrogen, which is organic-subset and written
    // bare, and the dative bond itself is written as a single bond, so a parser already gives
    // that nitrogen no hydrogen.
    const implicitHydrogens = needsSpelledHydrogens
      ? nativeImplicitHydrogenCount(
          element,
          valenceUsage.get(atom.id) ?? 0,
          atom.formalCharge,
          atom.markRadicals ?? 0
        )
      : 0;
    return [atom.id, nativeAtomSmiles(atom, implicitHydrogens)] as const;
  }));
}
