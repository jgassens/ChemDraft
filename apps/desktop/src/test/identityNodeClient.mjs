import { Worker } from "node:worker_threads";
import { createIdentityWorkerClient } from "../depiction2d/identityWorkerClient.ts";

export function createNodeIdentityInspector(options = {}) {
  const { onTerminate, budgetMs, startupMs = 60_000, ...workerOptions } = options;
  return createIdentityWorkerClient(() => {
    const entry = "./identityNodeWorker.mjs";
    const worker = new Worker(new URL(entry, import.meta.url), { execArgv: [], workerData: workerOptions });
    const port = {
      postMessage: request => worker.postMessage(request),
      terminate: () => { onTerminate?.(); void worker.terminate(); },
      ref: () => { worker.ref(); }, unref: () => { worker.unref(); },
      onmessage: null, onerror: null, onmessageerror: null
    };
    worker.on("message", data => port.onmessage?.({ data }));
    worker.on("error", error => port.onerror?.({ message: error.message }));
    worker.on("exit", code => port.onerror?.({ message: `Chemical identity worker exited (${code}).` }));
    worker.on("messageerror", () => port.onmessageerror?.());
    worker.unref();
    return port;
  }, budgetMs, startupMs);
}

export const inspectStructureOffThread = createNodeIdentityInspector();
