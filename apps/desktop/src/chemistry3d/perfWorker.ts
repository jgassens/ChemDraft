/** Node-only opt-in benchmark worker. Same job protocol/engine as the desktop worker;
 * local asset reads replace Tauri fetch, so this does not claim WebView timing parity. */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ensureRdkit, setRdkitModuleLoader, type RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { runChemistry3dJob, type Chemistry3dJob } from "./protocol";
import { closestHeavyContactPair, modelMolblock } from "./model";
import type { Plugin3DModel } from "@chemdraft/plugin-api";

const assets = workerData.assets as string;
let loads = 0;
setRdkitModuleLoader(async () => {
  loads++;
  let start = performance.now();
  const glue = readFileSync(join(assets, "RDKit_minimal.js"), "utf8");
  const wasmBinary = new Uint8Array(readFileSync(join(assets, "RDKit_minimal.wasm")));
  parentPort!.postMessage({ timing: { stage: "cold.asset-read", ms: performance.now() - start } });
  start = performance.now();
  const factory = new Function("require", "__dirname", `${glue}\n;return initRDKitModule;`)(
    createRequire(import.meta.url), dirname(assets)) as (options: { wasmBinary: Uint8Array }) => Promise<RdkitMinimalModule>;
  const module = await factory({ wasmBinary });
  parentPort!.postMessage({ timing: { stage: "cold.glue+compile+init", ms: performance.now() - start } });
  return module;
});

async function diagnose(model: Plugin3DModel, budget: number, passes: number) {
  const rdkit = await ensureRdkit();
  const mol = rdkit.get_mol(modelMolblock(model), JSON.stringify({ removeHs: false }))!;
  const rows = [];
  let previous = model;
  try {
    for (let pass = 0; pass < passes; pass++) {
      const start = performance.now();
      const result = JSON.parse(mol.optimize_3d_conformer(JSON.stringify({ forceField: "mmff94s", maxIters: budget,
        ignoreInterfragInteractions: false }))) as { coords3dByEngineAtom: number[]; forceField: unknown };
      const current = { ...model, coords: result.coords3dByEngineAtom };
      const contact = closestHeavyContactPair(current)!;
      const { a, b } = contact;
      const before = Math.hypot(...[0, 1, 2].map(axis => previous.coords[a * 3 + axis] - previous.coords[b * 3 + axis]));
      rows.push({ pass: pass + 1, ms: performance.now() - start, ...result.forceField as object,
        distance: contact.distance, a: a + 1, b: b + 1, pairDistanceAtPassStart: before });
      previous = current;
    }
  } finally { mol.delete(); }
  return rows;
}

parentPort!.on("message", async (message: { id: number; job?: Chemistry3dJob; diagnose?: Plugin3DModel; budget?: number; passes?: number }) => {
  try {
    const result = message.job ? await runChemistry3dJob(message.job, undefined,
      timing => parentPort!.postMessage({ timing })) : await diagnose(message.diagnose!, message.budget!, message.passes!);
    parentPort!.postMessage({ id: message.id, result, loads });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.stack : String(error), loads }); }
});
