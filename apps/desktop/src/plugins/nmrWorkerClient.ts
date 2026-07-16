import { createNmrWorkerClient, type NmrWorkerClient } from "@chemdraft/plugin-nmr-predictor";

/**
 * Desktop-side lazily-created singleton for the NMR worker client. The client object is cheap; the
 * worker itself spawns only on the first `initialize`/`predict`, so a rarely-used feature costs
 * nothing at startup. M8 wires this into the predict command; M7 creates it (and, by importing the
 * plugin's `new Worker(new URL("./nmrWorker.ts", import.meta.url))`, anchors that worker in the
 * desktop's Vite build graph — the bundling question this milestone had to answer).
 */
let client: NmrWorkerClient | null | undefined;

/** Returns the worker client, or `null` where `Worker` is unavailable (callers fall back in-thread). */
export function getNmrWorkerClient(): NmrWorkerClient | null {
  if (client === undefined) {
    client = createNmrWorkerClient();
  }
  return client;
}

export function disposeNmrWorkerClient(): void {
  client?.dispose();
  client = undefined;
}
