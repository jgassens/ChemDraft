import type { MoleculeBond } from "./schemas";

/**
 * Bonds (by index) whose removal disconnects the graph of included bonds — the bonds in no ring.
 * Tarjan's low-link walk, iterative so a long chain cannot overflow the stack.
 */
export function bridgeBondIndices(
  bonds: readonly MoleculeBond[],
  otherEnd: (index: number, atomId: string) => string,
  include: (bond: MoleculeBond) => boolean
): Set<number> {
  const adjacency = new Map<string, number[]>();
  bonds.forEach((bond, index) => {
    if (bond.fromAtomId === bond.toAtomId || !include(bond)) return;
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      adjacency.set(atomId, [...(adjacency.get(atomId) ?? []), index]);
    }
  });
  const discovered = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  let clock = 0;
  for (const start of adjacency.keys()) {
    if (discovered.has(start)) continue;
    discovered.set(start, clock);
    low.set(start, clock);
    clock += 1;
    const stack: { atomId: string; viaBond: number; next: number }[] = [{ atomId: start, viaBond: -1, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const incident = adjacency.get(frame.atomId)!;
      if (frame.next < incident.length) {
        const index = incident[frame.next]!;
        frame.next += 1;
        if (index === frame.viaBond) continue;
        const next = otherEnd(index, frame.atomId);
        const seen = discovered.get(next);
        if (seen !== undefined) {
          low.set(frame.atomId, Math.min(low.get(frame.atomId)!, seen));
          continue;
        }
        discovered.set(next, clock);
        low.set(next, clock);
        clock += 1;
        stack.push({ atomId: next, viaBond: index, next: 0 });
        continue;
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent) continue;
      low.set(parent.atomId, Math.min(low.get(parent.atomId)!, low.get(frame.atomId)!));
      if (low.get(frame.atomId)! > discovered.get(parent.atomId)!) bridges.add(frame.viaBond);
    }
  }
  return bridges;
}
