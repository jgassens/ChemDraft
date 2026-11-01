import { Worker } from "node:worker_threads";
import { URL } from "node:url";
import { createDepictionWorkerClient } from "../../../../packages/rdkit-adapter/src/depictionWorkerClient.ts";

export function createNodeDepictionClient({ warmupSmiles, onWarmup, holdFirstResult = false, deadlineMs } = {}) {
  let workers = 0;
  return createDepictionWorkerClient(() => {
    const holdResult = holdFirstResult && workers++ === 0;
    const workerEntry = "./depictionNodeWorker.mjs"; // Node URL, never a Vite web asset URL
    const worker = new Worker(new URL(workerEntry, import.meta.url), { execArgv: [] });
    const port = { initializing: true, postMessage: (request) => worker.postMessage(request), terminate: () => { void worker.terminate(); },
      ref: () => { worker.ref(); }, unref: () => { worker.unref(); },
      onmessage: null, onerror: null, onmessageerror: null };
    let warming = false;
    let warmStart;
    worker.on("message", (data) => {
      if (data.stage === "ready" && warmupSmiles) {
        warming = true;
        warmStart = performance.now();
        worker.postMessage({ id: -1, smiles: warmupSmiles });
      } else if (warming && data.id === -1) {
        if (data.stage === "result") {
          warming = false;
          onWarmup?.(data.result, performance.now() - warmStart);
          port.onmessage?.({ data: { id: 0, stage: "ready" } });
        } else if (data.stage === "error") {
          port.onerror?.({ message: data.message });
        }
      } else if (!(holdResult && data.stage === "result")) {
        port.onmessage?.({ data });
      }
    });
    worker.on("error", (error) => port.onerror?.({ message: error.message }));
    worker.on("exit", (code) => port.onerror?.({ message: `2D depiction worker exited (${code}).` }));
    worker.on("messageerror", () => port.onmessageerror?.());
    worker.unref();
    return port;
  }, deadlineMs);
}

export const depictSmilesOffThread = createNodeDepictionClient();
