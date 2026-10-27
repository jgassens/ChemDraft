import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
registerCjs();
register();
const { ensureRdkit, generateSmiles2DMolfile } = await import("../../../../packages/rdkit-adapter/src/conformer.ts");
const { installNodeRdkitModuleLoader } = await import("../../../../packages/rdkit-adapter/src/node.ts");
const { depictInWorker } = await import("../depiction2d/depict.ts");
const { loadDepictionEngines } = await import("../../../../packages/rdkit-adapter/src/depictionEngines.ts");
const engines = await loadDepictionEngines(async () => { installNodeRdkitModuleLoader(); await ensureRdkit(); },
  () => import("@chemdraft/ocl-adapter"));
parentPort.on("message", async ({ id, smiles, standardOnly }) => {
  try {
    const result = await depictInWorker(smiles, generateSmiles2DMolfile,
      (standard) => parentPort.postMessage({ id, stage: "standard", result: standard }), { standardOnly, ...engines });
    parentPort.postMessage({ id, stage: "result", result });
  } catch (error) {
    parentPort.postMessage({ id, stage: "error", message: error instanceof Error ? error.message : String(error),
      smilesChemistryRefusal: error?.smilesChemistryRefusal === true, notSmiles: error?.notSmiles === true });
  }
});
parentPort.postMessage({ id: 0, stage: "ready" });
