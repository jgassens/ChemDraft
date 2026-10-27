import { Worker } from "node:worker_threads";
import { createDepictionWorkerClient, type DepictionWorkerPort } from "@chemdraft/rdkit-adapter";
import type { SmilesDepictionResult } from "./document";

/** Used by CLI commands and MCP alike; no synchronous coordinate generation in either caller. */
export function createNodeDepictionWorker(): DepictionWorkerPort<SmilesDepictionResult> {
  const worker = new Worker(new URL("./depictionWorker.mjs", import.meta.url), { execArgv: [] });
  const port: DepictionWorkerPort<SmilesDepictionResult> = {
    initializing: true,
    postMessage: (request) => worker.postMessage(request),
    terminate: () => { void worker.terminate(); },
    ref: () => { worker.ref(); },
    unref: () => { worker.unref(); },
    onmessage: null,
    onerror: null
  };
  worker.on("message", (data) => port.onmessage?.({ data }));
  worker.on("error", (error) => port.onerror?.({ message: error instanceof Error ? error.message : String(error) }));
  worker.on("messageerror", () => port.onmessageerror?.());
  worker.on("exit", (code) => port.onerror?.({ message: `2D depiction worker exited (${code}).` }));
  worker.unref();
  return port;
}

export const depictSmilesWithDeadline = createDepictionWorkerClient(createNodeDepictionWorker);
