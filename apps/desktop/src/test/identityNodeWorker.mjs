import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
registerCjs();
register();
const { ensureRdkit } = await import("../../../../packages/rdkit-adapter/src/conformer.ts");
const { installNodeRdkitModuleLoader } = await import("../../../../packages/rdkit-adapter/src/node.ts");
const { inspectStructureInWorker } = await import("../depiction2d/identityInspect.ts");
installNodeRdkitModuleLoader();
const module = await ensureRdkit();
parentPort.on("message", ({ id, value, stereoReference }) => {
  try {
    if (workerData.slowStereoReference && workerData.slowStereoReference === stereoReference) {
      // Inject a synchronous stuck check: only the caller's worker termination can stop it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    parentPort.postMessage({ id, stage: "result",
      result: inspectStructureInWorker(module, value, stereoReference) });
  } catch (error) {
    parentPort.postMessage({ id, stage: "error",
      message: error instanceof Error ? error.message : String(error) });
  }
});
parentPort.postMessage({ id: 0, stage: "ready" });
