/** Plain-data evidence from the loaded RDKit graph, not inferred from a formula. */
export interface ResonanceGraph {
  atoms: { z: number; isotope: number; radical: number; h: number; charge: number }[];
  bonds: { atoms: [number, number]; order: number }[];
}
export type ResonanceResult = "reachable" | "atom-or-hydrogen-mismatch" | "sigma-skeleton-mismatch"
  | "disconnected-conjugation" | "invalid-lewis-structure" | "unreachable" | "undetermined";

const valenceElectrons: Record<number, number> = { 1: 1, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 14: 4, 15: 5, 16: 6, 17: 7, 35: 7, 53: 7 };
const atomKey = (a: ResonanceGraph["atoms"][number]) => JSON.stringify([a.z, a.isotope, a.radical, a.h]);
const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
function adjacency(g: ResonanceGraph) {
  const edges = g.atoms.map(() => new Map<number, number>());
  g.bonds.forEach((b, i) => { edges[b.atoms[0]].set(b.atoms[1], i); edges[b.atoms[1]].set(b.atoms[0], i); });
  return edges;
}

/** Detect charge relocation even when canonicalisation swaps equivalent O atoms.
 * Only use the input's indexed correspondence when its entire labelled sigma graph agrees.
 * Kekule-only changes canonicalised by aromaticity remain PASS. */
export function indexedChargeChange(a?: ResonanceGraph, b?: ResonanceGraph): boolean {
  if (!a || !b || a.atoms.length !== b.atoms.length || a.bonds.length !== b.bonds.length
    || a.atoms.some((atom, i) => atomKey(atom) !== atomKey(b.atoms[i]))) return false;
  const edges = new Set(a.bonds.map(e => edgeKey(...e.atoms)));
  return b.bonds.every(e => edges.has(edgeKey(...e.atoms))) && a.atoms.some((atom, i) => atom.charge !== b.atoms[i].charge);
}

/** Bounded graph isomorphism followed by actual electron-pair pushes.
 * Never moves H, sigma bonds, atoms or unpaired electrons. Missing proof is a failure.
 * The budget covers mapping and generated states, including rejected pushes. */
export function testResonance(a: ResonanceGraph, b: ResonanceGraph, cap = 50_000): ResonanceResult {
  if (a.atoms.length !== b.atoms.length || a.bonds.length !== b.bonds.length) return "sigma-skeleton-mismatch";
  const aa = adjacency(a), ba = adjacency(b);
  const candidates = a.atoms.map((atom, i) => b.atoms.flatMap((other, j) =>
    atomKey(atom) === atomKey(other) && aa[i].size === ba[j].size ? [j] : []));
  if (candidates.some(c => !c.length)) return "atom-or-hydrogen-mismatch";
  const order = a.atoms.map((_, i) => i).sort((i, j) => candidates[i].length - candidates[j].length || aa[j].size - aa[i].size);
  const mapping = a.atoms.map(() => -1), used = new Set<number>();
  let work = 0, exhausted = false, matched = false;
  let rejection: ResonanceResult = "sigma-skeleton-mismatch";
  const spend = () => { if (++work > cap) exhausted = true; return !exhausted; };

  const reachable = (): ResonanceResult => {
    const targetOrders = a.bonds.map(e => b.bonds[ba[mapping[e.atoms[0]]].get(mapping[e.atoms[1]])!].order);
    const startOrders = a.bonds.map(e => e.order);
    const startCharges = a.atoms.map(atom => atom.charge), targetCharges = mapping.map(i => b.atoms[i].charge);
    if (startCharges.reduce((n, q) => n + q, 0) !== targetCharges.reduce((n, q) => n + q, 0)) return "invalid-lewis-structure";
    if ([...startOrders, ...targetOrders].some(o => !Number.isInteger(o) || o < 1 || o > 3)) return "undetermined";
    const sums = (orders: number[]) => a.atoms.map((atom, i) => atom.h + [...aa[i].values()].reduce((n, e) => n + orders[e], 0));
    const startSums = sums(startOrders), targetSums = sums(targetOrders);
    // Nonbonding electrons = group valence electrons - charge - bond-order sum - radicals.
    const lone = (i: number, sum: number, charge: number) => valenceElectrons[a.atoms[i].z] - charge - sum - a.atoms[i].radical;
    const valid = (i: number, sum: number, charge: number) => {
      const nonbonding = lone(i, sum, charge);
      const shell = 2 * sum + nonbonding + a.atoms[i].radical;
      // Deliberately conservative octet subset; hypervalent moves need another proof.
      return Number.isInteger(nonbonding) && nonbonding >= 0 && nonbonding % 2 === 0
        && shell <= (a.atoms[i].z === 1 ? 2 : 8) && Math.abs(charge) <= 2;
    };
    const pi = a.atoms.map((_, i) => [...aa[i].values()].some(e => startOrders[e] > 1 || targetOrders[e] > 1));
    const participates = a.atoms.map((atom, i) => pi[i] || !!startCharges[i] || !!targetCharges[i]
      || ([...aa[i].keys()].some(j => pi[j]) && (lone(i, startSums[i], startCharges[i]) >= 2 || lone(i, targetSums[i], targetCharges[i]) >= 2)));
    const changed = a.atoms.flatMap((_, i) => startCharges[i] !== targetCharges[i]
      || [...aa[i].values()].some(e => startOrders[e] !== targetOrders[e]) ? [i] : []);
    if (!changed.length) return "reachable";
    const component = new Set<number>(), pending = [changed[0]];
    while (pending.length) {
      const i = pending.pop()!;
      if (component.has(i) || !participates[i]) continue;
      component.add(i);
      pending.push(...aa[i].keys());
    }
    if (changed.some(i => !component.has(i))) return "disconnected-conjugation";
    if ([...component].some(i => valenceElectrons[a.atoms[i].z] === undefined || a.atoms[i].radical)) return "undetermined";
    if ([...component].some(i => !valid(i, startSums[i], startCharges[i]) || !valid(i, targetSums[i], targetCharges[i]))) return "invalid-lewis-structure";
    const edges = a.bonds.flatMap((e, i) => e.atoms.every(j => component.has(j)) ? [i] : []);
    const key = (orders: number[], charges: number[]) => `${orders.join(",")};${charges.join(",")}`;
    const target = key(targetOrders, targetCharges);
    const seen = new Set([key(startOrders, startCharges)]);
    const queue = [{ orders: startOrders, charges: startCharges, sums: startSums }];
    // Prioritise pushes on differing bonds; intermediate charge-separated structures
    // remain necessary (e.g. cleave C=O before donating the other O's lone pair).
    edges.sort((i, j) => Number(startOrders[j] !== targetOrders[j]) - Number(startOrders[i] !== targetOrders[i]));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const state = queue[cursor];
      for (const e of edges) for (const donor of a.bonds[e].atoms) for (const delta of [-1, 1]) {
        if (!spend()) return "undetermined";
        const acceptor = a.bonds[e].atoms.find(i => i !== donor)!;
        const nextOrder = state.orders[e] + delta;
        if (nextOrder < 1 || nextOrder > 3 || delta === 1 && lone(donor, state.sums[donor], state.charges[donor]) < 2) continue;
        // +1 donates a lone pair to a pi bond; -1 cleaves a pi pair onto donor.
        const donorCharge = state.charges[donor] + delta, acceptorCharge = state.charges[acceptor] - delta;
        if (!valid(donor, state.sums[donor] + delta, donorCharge) || !valid(acceptor, state.sums[acceptor] + delta, acceptorCharge)) continue;
        const orders = [...state.orders], charges = [...state.charges], nextSums = [...state.sums];
        orders[e] = nextOrder; charges[donor] = donorCharge; charges[acceptor] = acceptorCharge;
        nextSums[donor] += delta; nextSums[acceptor] += delta;
        const nextKey = key(orders, charges);
        if (nextKey === target) return "reachable";
        if (!seen.has(nextKey)) { seen.add(nextKey); queue.push({ orders, charges, sums: nextSums }); }
      }
    }
    return "unreachable";
  };
  const search = (depth: number): boolean => {
    if (!spend()) return false;
    if (depth === order.length) {
      matched = true;
      rejection = reachable();
      return rejection === "reachable";
    }
    const i = order[depth];
    // Preserve the indexed drawing correspondence first when it is valid.
    const choices = [...candidates[i]].sort((j, k) => Number(k === i) - Number(j === i));
    for (const j of choices) {
      if (used.has(j) || mapping.some((k, n) => k >= 0 && aa[i].has(n) !== ba[j].has(k))) continue;
      mapping[i] = j; used.add(j);
      if (search(depth + 1)) return true;
      mapping[i] = -1; used.delete(j);
      if (exhausted) return false;
    }
    return false;
  };
  return search(0) ? "reachable" : exhausted ? "undetermined" : matched ? rejection : "sigma-skeleton-mismatch";
}
