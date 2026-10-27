/** Worker-only RDKit chemistry. All handles are transient and deleted in finally blocks. */
import { ensureRdkit, generate3DConformerProgressive, type RdkitJsMol, type RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import {
  PluginEmbed3DRequestSchema, PluginMinimize3DRequestSchema, PluginFlatten3DRequestSchema,
  type Plugin3DModel, type PluginEmbed3DRequest, type PluginEmbed3DResult,
  type PluginMinimize3DRequest, type PluginMinimize3DResult, type PluginFlatten3DRequest,
  type PluginFlatten3DResult, type Plugin3DMethod
} from "@chemdraft/plugin-api";
import { appendComponent, closestHeavyContactPair, heavyContactDescription, INTER_COMPONENT_CLASH_A, modelMolblock, readGraph } from "./model";
import { chemistry3dMethod } from "./method";
import { SPIN3D_EMBED_CANDIDATES } from "./settings";
import { assertComponentStereo } from "./stereo";
import type { Chemistry3dTimingSink } from "./timing";

interface OptimizePayload { embedOk: boolean; coords3dByEngineAtom: number[];
  forceField: { status: "converged" | "not-converged" | "setup-failed"; energy?: number } }

export async function initializeChemistry3dWorker(): Promise<void> {
  // Load all lazy job code before readiness too, including the shared flatten helper.
  await Promise.all([ensureRdkit(), import("./flatten")]);
}

function requireMol(rdkit: RdkitMinimalModule, input: string, context: string): RdkitJsMol {
  const mol = rdkit.get_mol(input, JSON.stringify({ removeHs: false }));
  if (!mol) throw new Error(`${context}: RDKit could not parse the structure.`);
  return mol;
}

/** Reparse the coordinate-only CTAB as 3D, so RDKit assigns both tetrahedral
 * and double-bond stereo from geometry rather than trusting stored tags. */
function assertModelStereo(rdkit: RdkitMinimalModule, model: Plugin3DModel, phase: string): void {
  model.components.forEach((_, index) => assertComponentStereo(rdkit, model, index, phase));
}

/** Reuse Spin 3D's adapter, including its ETKDG settings, random-coordinate retry and candidate
 * ranking. Make Hs explicit BEFORE calling it so its original-atom mapping returns ALL coordinates,
 * rather than discarding the generated Hs that a plugin needs for subsequent minimization.
 * RDKit appends Hs after original atoms; no new valence or hydrogen model is implemented here. */
async function embedComponent(rdkit: RdkitMinimalModule, smiles: string, seed: number, atomCount: number) {
  const source = requireMol(rdkit, smiles, "3D embedding");
  let molblock: string;
  try {
    const hydrogenSource = source as RdkitJsMol & { add_hs?(): string };
    if (!hydrogenSource.add_hs) throw new Error("RDKit explicit-hydrogen generation is unavailable.");
    molblock = hydrogenSource.add_hs();
  } finally { source.delete(); }
  const started = Date.now();
  const { embedded } = await generate3DConformerProgressive(
    // The adapter derives its full mapping count from atom properties. This input count controls
    // only its existing size-based retry/ranking policy, preserving Spin's heavy-input thresholds.
    { molfile: molblock, originalAtomCount: atomCount },
    { seed, optimize: "none", embedCandidates: SPIN3D_EMBED_CANDIDATES }
  );
  if (Date.now() - started > 15000) throw new Error("3D embedding timed out after 15 seconds for a component.");
  if (embedded.embed.status !== "ok") throw new Error(
    "RDKit ETKDGv3 found no 3D conformer (or timed out), including the useRandomCoords retry where applicable." +
    (embedded.warnings.length ? " " + embedded.warnings.map(warning => warning.message).join("; ") : "")
  );
  const coords = Array.from(embedded.mapping.coords3dByOriginalAtom);
  const added = Array.from({ length: coords.length / 3 - atomCount }, (_, i) => atomCount + i);
  return { molblock, coords, added, warnings: embedded.warnings.map(warning => warning.message) };
}

export async function embed3dInWorker(input: PluginEmbed3DRequest, progress: () => void = () => undefined, timing?: Chemistry3dTimingSink): Promise<PluginEmbed3DResult> {
  const request = PluginEmbed3DRequestSchema.parse(input);
  const rdkit = await ensureRdkit();
  const seed = request.seed ?? 42;
  const counts = request.components.map(({ smiles }, index) => {
    const mol = requireMol(rdkit, smiles, `Component ${index + 1}`);
    try {
      const json = readGraph(mol);
      const graph = json.molecules[0];
      if (!graph?.atoms.length) throw new Error(`Component ${index + 1}: the structure has no atoms.`);
      const seen = new Set<number>([0]);
      const adjacency = graph.atoms.map(() => [] as number[]);
      graph.bonds.forEach(({ atoms: [a, b] }) => { adjacency[a].push(b); adjacency[b].push(a); });
      const queue = [0];
      while (queue.length) for (const b of adjacency[queue.pop()!]) if (!seen.has(b)) { seen.add(b); queue.push(b); }
      if (json.molecules.length !== 1 || seen.size !== graph.atoms.length) throw new Error(`Component ${index + 1}: each SMILES must describe one connected component.`);
      return { atoms: graph.atoms.length, heavy: graph.atoms.filter(atom => (atom.z ?? json.defaults?.atom?.z ?? 6) !== 1).length };
    } finally { mol.delete(); }
  });
  if (counts.reduce((sum, count) => sum + count.heavy, 0) > 500) throw new Error("3D chemistry accepts at most 500 heavy atoms total.");
  const model: Plugin3DModel = { atoms: [], bonds: [], coords: [], components: [], modelToken: "unsigned-worker-model" };
  let right = 0;
  const warnings: string[] = [];
  for (const [index, { smiles }] of request.components.entries()) {
    progress();
    const started = timing ? performance.now() : 0;
    const payload = await embedComponent(rdkit, smiles, seed, counts[index].atoms);
    timing?.({ stage: "embed.component", ms: performance.now() - started, details: { component: index + 1, inputAtoms: counts[index].atoms } });
    warnings.push(...payload.warnings.map(message => `Component ${index + 1}: ${message}`));
    const mol = requireMol(rdkit, payload.molblock, `Component ${index + 1}`);
    try {
      const coords = [...payload.coords];
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < coords.length; i += 3) { minX = Math.min(minX, coords[i]); maxX = Math.max(maxX, coords[i]); }
      const shift = right - minX;
      for (let i = 0; i < coords.length; i += 3) coords[i] += shift;
      right += maxX - minX + 4; // all atoms, including Hs, have >=4 A x-separation
      appendComponent(model, mol, smiles, coords, payload.added);
    } finally { mol.delete(); }
  }
  return { model, method: chemistry3dMethod(seed), warnings };
}

export async function minimize3dInWorker(input: PluginMinimize3DRequest, method: Plugin3DMethod, timing?: Chemistry3dTimingSink): Promise<PluginMinimize3DResult> {
  // Strict boolean validation MUST precede JSON/C++ as_bool (including direct worker calls).
  const request = PluginMinimize3DRequestSchema.parse(input);
  const rdkit = await ensureRdkit();
  const name = request.forceField ?? "mmff94s";
  assertModelStereo(rdkit, request.model, "minimize3d input");
  const maxIters = request.maxIters ?? 20000;
  const mol = requireMol(rdkit, modelMolblock(request.model), "3D minimization");
  let coords = [...request.model.coords];
  let iterationsBudget = 0;
  let status: PluginMinimize3DResult["forceField"]["status"] = "not-converged";
  let energy: number | null = null;
  try {
    while (iterationsBudget < maxIters) {
      const pass = Math.min(1000, maxIters - iterationsBudget);
      const started = timing ? performance.now() : 0;
      const result = JSON.parse(mol.optimize_3d_conformer(JSON.stringify({ forceField: name, maxIters: pass,
        ignoreInterfragInteractions: !request.interfragment }))) as OptimizePayload;
      if (timing) {
        const contact = result.embedOk ? closestHeavyContactPair({ ...request.model, coords: result.coords3dByEngineAtom }) : undefined;
        const pairStart = contact ? Math.hypot(...[0, 1, 2].map(axis => coords[contact.a * 3 + axis] - coords[contact.b * 3 + axis])) : undefined;
        timing({ stage: "minimize.pass", ms: performance.now() - started, details: {
          pass: iterationsBudget / 1000 + 1, budget: pass, ...result.forceField, contact, pairDistanceAtPassStart: pairStart } });
      }
      iterationsBudget += pass;
      status = result.forceField?.status;
      if (!["converged", "not-converged", "setup-failed"].includes(status)) throw new Error("RDKit returned an invalid force-field status.");
      energy = status !== "setup-failed" && Number.isFinite(result.forceField.energy) ? result.forceField.energy! : null;
      if (status === "setup-failed") break;
      if (!result.embedOk || result.coords3dByEngineAtom.length !== coords.length || !result.coords3dByEngineAtom.every(Number.isFinite)) {
        throw new Error("RDKit minimization returned invalid 3D coordinates.");
      }
      coords = result.coords3dByEngineAtom;
      if (status === "converged") break;
    }
  } finally { mol.delete(); }
  const model = { ...request.model, coords };
  assertModelStereo(rdkit, model, "minimize3d result");
  const closest = closestHeavyContactPair(model);
  const clash = closest !== undefined && closest.distance < INTER_COMPONENT_CLASH_A;
  return { model, clash, forceField: { name, status, energy, iterationsBudget },
    ...(closest === undefined ? {} : { closestInterComponentHeavyAtomA: closest.distance }),
    method: chemistry3dMethod(method.seed, name, request.interfragment),
    warnings: [...(clash ? [`minimize3d clash: closest inter-component heavy-atom contact is ${heavyContactDescription(model, closest!)}; below 2.2 A. Do not insert this model; retry with another arrangement.`] : []),
      ...(status === "converged" ? [] : [status === "setup-failed" ?
        `RDKit could not set up ${name} for this graph; coordinates are unchanged.` : `${name} did not converge within ${iterationsBudget} requested iterations.`])] };
}

export async function flatten3dInWorker(input: PluginFlatten3DRequest, method: Plugin3DMethod): Promise<PluginFlatten3DResult> {
  const request = PluginFlatten3DRequestSchema.parse(input);
  const { flattenPluginModel } = await import("./flatten");
  return flattenPluginModel(request, method, await ensureRdkit());
}
