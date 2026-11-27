import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installRealRdkitModuleLoader } from "../../packages/rdkit-adapter/src/testing";
import { resetRdkitForTesting } from "../../packages/rdkit-adapter/src/index";
import type { PluginHandoffStructureGraph } from "@chemdraft/plugin-api";
import { createChemistry3dProviders } from "../../apps/desktop/src/chemistry3d/client";
import { runChemistry3dJob } from "../../apps/desktop/src/chemistry3d/protocol";
import { ModelTokenAuthority } from "../../apps/desktop/src/chemistry3d/token";
import { EXPECTED } from "./hostEmbedDeterminism.expected";

/**
 * "Send to Crystal Builder" writes these coordinates (4 decimals) into a file for another
 * program, so every supported host (macOS arm64/x64, Windows x64, Linux x64) must produce the
 * same numbers. This drives the same host functions plugins get (chemistry.embed3d: RDKit
 * ETKDGv3, seed 42; chemistry.minimize3d: MMFF94s, interfragment false) on the real RDKit WASM.
 *
 * The expected values in hostEmbedDeterminism.expected.ts were generated on darwin x86_64
 * (Intel iMac-class host, Node's process.arch "x64") on 2026-11-26. A failure on another host
 * is real drift: investigate, do not loosen TOLERANCE.
 */
const TOLERANCE = 5e-5; // what a 4-decimal file resolves
const stop = () => new AbortController().signal;
const providers = createChemistry3dProviders(job => runChemistry3dJob(job), new ModelTokenAuthority());

/** Kekulé order per heavy-atom bond (0 = plain single bond). Hydrogen-capped linker graph as the plugin sends it: explicit H atoms, no implicit counts. */
function capped(heavy: string[], bonds: Array<[number, number]>, kekule: Array<0 | 1 | 2>): PluginHandoffStructureGraph {
  const atom = (element: string) => ({ element, charge: 0, radicalElectrons: 0, hydrogenCount: 0 });
  const atoms = heavy.map(atom);
  const edges: PluginHandoffStructureGraph["bonds"] = bonds.map(([a, b], i) => kekule[i] === 0 ? { a, b, order: 1 as const } : { a, b, order: "aromatic" as const, kekuleOrder: kekule[i] as 1 | 2 });
  const degree = heavy.map(() => 0);
  bonds.forEach(([a, b]) => { degree[a]++; degree[b]++; });
  heavy.forEach((_, i) => {
    if (degree[i] < 3) {
      atoms.push(atom("H"));
      edges.push({ a: i, b: atoms.length - 1, order: 1 });
    }
  });
  return { atoms, bonds: edges };
}

const ring6 = (o: number): Array<[number, number]> => [0, 1, 2, 3, 4, 5].map(i => [o + i, o + (i + 1) % 6]);
const GRAPHS: Record<string, PluginHandoffStructureGraph> = {
  // terephthalic acid, both COOH replaced by H: benzene
  terephthalic: capped(Array(6).fill("C"), ring6(0), [1, 2, 1, 2, 1, 2]),
  // biphenyl-4,4'-dicarboxylic acid capped: biphenyl (flexible inter-ring torsion)
  biphenyl: capped(Array(12).fill("C"), [...ring6(0), ...ring6(6), [3, 9]] as Array<[number, number]>,
    [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 0]),
  // 2,6-naphthalenedicarboxylic acid capped: naphthalene
  naphthalene: capped(Array(10).fill("C"), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [4, 6], [6, 7], [7, 8], [8, 9], [9, 5]],
    [2, 1, 2, 1, 2, 1, 1, 2, 1, 2, 1])
};

interface Snapshot { elements: string[]; coords: number[] }
async function run(name: string): Promise<Snapshot> {
  const embedded = await providers.embed3d({ components: [{ graph: GRAPHS[name] }], seed: 42 }, stop());
  const minimized = await providers.minimize3d({ model: embedded.model, forceField: "mmff94s", interfragment: false }, stop());
  return { elements: minimized.model.atoms.map(a => a.element), coords: [...minimized.model.coords] };
}

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

describe("host 3D engine is deterministic across hosts", () => {
  for (const name of Object.keys(GRAPHS)) {
    it(`${name}: matches fixed coordinates and repeats in one process`, async () => {
      const first = await run(name);
      const second = await run(name);
      expect(second).toEqual(first);
      if (process.env.DUMP_HOST_3D) console.log(`DUMP ${name} ${JSON.stringify({ elements: first.elements, coords: first.coords.map(c => Number(c.toFixed(4))) })}`);
      const expected = EXPECTED[name];
      expect(first.elements).toEqual(expected.elements);
      expect(first.coords).toHaveLength(expected.coords.length);
      first.coords.forEach((c, i) => {
        expect(Math.abs(c - expected.coords[i]), `${name} coordinate ${i}: ${c} vs ${expected.coords[i]}`).toBeLessThanOrEqual(TOLERANCE);
      });
    }, 60000);
  }
});
