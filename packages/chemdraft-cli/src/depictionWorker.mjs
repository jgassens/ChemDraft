import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
registerCjs();
register();
const { depictSmilesInWorker } = await import("./document.ts");
const { ensureRdkit } = await import("@chemdraft/rdkit-adapter");
const { installNodeEngines } = await import("./engine.ts");
const { loadDepictionEngines } = await import("@chemdraft/rdkit-adapter/depiction");
const engines = await loadDepictionEngines(async () => { installNodeEngines(); await ensureRdkit(); },
  () => import("@chemdraft/ocl-adapter"));

parentPort.on("message", async ({ id, smiles, standardOnly }) => {
  try {
    const result = await depictSmilesInWorker(smiles,
      (standard) => parentPort.postMessage({ id, stage: "standard", result: standard }), { standardOnly, ...engines });
    parentPort.postMessage({ id, stage: "result", result });
  } catch (error) {
    parentPort.postMessage({ id, stage: "error", message: error instanceof Error ? error.message : String(error),
      name: error?.name, smilesChemistryRefusal: error?.smilesChemistryRefusal === true });
  }
});
parentPort.postMessage({ id: 0, stage: "ready" });
