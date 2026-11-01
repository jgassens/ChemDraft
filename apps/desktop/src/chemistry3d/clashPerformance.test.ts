import { afterAll, beforeAll, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { PluginEmbed3DResult, PluginMinimize3DResult, PluginFlatten3DResult } from "@chemdraft/plugin-api";
import type { Chemistry3dTiming } from "./timing";
import type { Chemistry3dJob } from "./protocol";
import { CBPQT, pegTtf, centerGuest } from "./perfFixtures";
import { closestHeavyContact } from "./model";
import { smallRingPiercings } from "./ringDiagnostics";

const enabled = process.env.CHEMDRAFT_PROFILE_CLASH_3D === "1";
let worker: Worker;
let directory: string;
let events: Chemistry3dTiming[] = [];
let nextId = 0;
let workerStarted = 0;
function call(message: object): Promise<unknown> {
  return new Promise((resolveCall, reject) => {
    const id = ++nextId;
    const handler = (reply: { id?: number; timing?: Chemistry3dTiming; error?: string; result?: unknown; loads?: number }) => {
      if (reply.timing) {
        events.push(reply.timing);
        if (reply.timing.stage !== "rdkit.parse") console.log("timing", JSON.stringify(reply.timing));
        return;
      }
      if (reply.id !== id) return;
      worker.off("message", handler);
      worker.off("error", failed);
      if (reply.loads !== 1) { reject(new Error(`Expected one WASM initialization, got ${reply.loads}.`)); return; }
      if (reply.error) reject(new Error(reply.error)); else resolveCall(reply.result);
    };
    const failed = (error: Error) => { worker.off("message", handler); reject(error); };
    worker.on("message", handler);
    worker.once("error", failed);
    worker.postMessage({ id, ...message });
  });
}
async function job<T>(value: Chemistry3dJob): Promise<T> {
  events = [];
  const started = performance.now();
  let result: T | undefined;
  let failure: unknown;
  try { result = await call({ job: value }) as T; }
  catch (error) { failure = error; }
  const roundtrip = performance.now() - started;
  const compute = events.filter(e => e.stage === "worker.job" || e.stage.startsWith("wasm.ensure")).reduce((sum, e) => sum + e.ms, 0);
  events.push({ stage: `${value.method}.roundtrip`, ms: roundtrip },
    { stage: "transport+dispatch+module-import residual", ms: roundtrip - compute });
  console.log(value.method, JSON.stringify(events));
  console.table(events.filter(event => event.stage !== "rdkit.parse" && event.stage !== "minimize.binding")
    .map(event => ({ stage: event.stage, ms: +event.ms.toFixed(2), ...event.details })));
  if (failure) throw failure;
  return result!;
}

beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "chemdraft-3d-perf-"));
  const bundled = await build({ entryPoints: [resolve("apps/desktop/src/chemistry3d/perfWorker.ts")],
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
    // Browser asset imports are reachable through the shared flatten helper but unused here;
    // the worker installs the real local WASM loader explicitly.
    plugins: [{ name: "unused-browser-assets", setup(builder) {
      builder.onResolve({ filter: /\?(raw|url)$/ }, args => ({ path: args.path, namespace: "unused-asset" }));
      builder.onLoad({ filter: /.*/, namespace: "unused-asset" }, () => ({ contents: 'export default ""', loader: "js" }));
    } }] });
  const entry = join(directory, "worker.mjs");
  await writeFile(entry, bundled.outputFiles[0].text);
  workerStarted = performance.now();
  worker = new Worker(entry, { workerData: { assets: resolve("packages/rdkit-adapter/vendor") } });
}, 30000);
afterAll(async () => { if (worker) await worker.terminate(); if (directory) await rm(directory, { recursive: true }); });

it.skipIf(!enabled)("profiles PEG2/PEG8 in a real Node worker and diagnoses centred PEG8", async () => {
  console.log("benchmark host", JSON.stringify({ cpu: cpus()[0]?.model, cores: cpus().length, node: process.version,
    arch: process.arch, loadAverage: loadavg() }));
  for (const repeats of [2, 8]) {
    console.log(`PEG${repeats}`);
    const embedded = await job<PluginEmbed3DResult>({ method: "embed3d", request: { components: [{ smiles: CBPQT }, { smiles: pegTtf(repeats) }], seed: 42 } });
    if (repeats === 2) console.log(`worker cold startup + first embed: ${(performance.now() - workerStarted).toFixed(1)} ms`);
    console.log(`atoms ${embedded.model.atoms.length}, heavy ${embedded.model.atoms.filter(a => a.element !== "H").length}`);
    const centred = centerGuest(embedded.model);
    console.log(`centred start contact ${closestHeavyContact(centred)}`);
    console.log("start small-ring piercings", JSON.stringify(smallRingPiercings(centred)));
    const minimized = await job<PluginMinimize3DResult>({ method: "minimize3d", request: { model: centred, interfragment: true, maxIters: 20000 }, provenance: embedded.method });
    console.log("minimum", JSON.stringify({ ...minimized.forceField, distance: minimized.closestInterComponentHeavyAtomA, clash: minimized.clash }));
    if (repeats === 8) {
      expect(minimized.clash).toBe(true);
      const piercings = smallRingPiercings(minimized.model);
      console.log("minimum small-ring piercings", JSON.stringify(piercings));
      expect(piercings.length).toBeGreaterThan(0);
      await expect(job({ method: "flatten3d", request: { model: minimized.model, view: "auto" }, provenance: embedded.method }))
        .rejects.toThrow("flatten3d refused a clashing model");
      console.log("restart converged", JSON.stringify(await call({ diagnose: minimized.model, budget: 20000, passes: 3 })));
      console.log("single 20000 pass", JSON.stringify(await call({ diagnose: centred, budget: 20000, passes: 1 })));
    }
    const clean = await job<PluginMinimize3DResult>({ method: "minimize3d", request: { model: embedded.model, interfragment: true, maxIters: 20000 }, provenance: embedded.method });
    console.log("clean minimum", JSON.stringify({ ...clean.forceField, distance: clean.closestInterComponentHeavyAtomA, clash: clean.clash }));
    expect(clean.clash).toBe(false);
    const flattened = await job<PluginFlatten3DResult>({ method: "flatten3d", request: { model: clean.model, view: "auto" }, provenance: embedded.method });
    expect(flattened.objects).toHaveLength(2);
  }
}, 300000);
