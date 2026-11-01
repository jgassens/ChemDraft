import { Worker } from "node:worker_threads";
import { URL } from "node:url";
import { createDepictionWorkerClient } from "../../../../packages/rdkit-adapter/src/depictionWorkerClient.ts";

export const depictSmilesOffThread = createDepictionWorkerClient(() => {
  const workerEntry = "./depictionNodeWorker.mjs"; // Node URL, never a Vite web asset URL
  const worker = new Worker(new URL(workerEntry, import.meta.url), { execArgv: [] });
  const port = { initializing: true, postMessage: (request) => worker.postMessage(request), terminate: () => { void worker.terminate(); },
    ref: () => { worker.ref(); }, unref: () => { worker.unref(); },
    onmessage: null, onerror: null, onmessageerror: null };
  worker.on("message", (data) => port.onmessage?.({ data }));
  worker.on("error", (error) => port.onerror?.({ message: error.message }));
  worker.on("exit", (code) => port.onerror?.({ message: `2D depiction worker exited (${code}).` }));
  worker.on("messageerror", () => port.onmessageerror?.());
  worker.unref();
  return port;
});
