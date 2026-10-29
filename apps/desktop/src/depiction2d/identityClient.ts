import { createIdentityWorkerClient } from "./identityWorkerClient";
import type { IdentityWorkerPort, StructureInspector } from "./identityProtocol";

let browserInspect: StructureInspector | undefined;

/** Shared by paste, plugins and assistant inspections; no in-thread fallback. */
export const inspectStructureOffThread: StructureInspector = async (format, value, stereoReference) => {
  if (typeof Worker !== "undefined") {
    browserInspect ??= createIdentityWorkerClient(() => {
      const worker = new Worker(new URL("./identityWorker.ts", import.meta.url), { type: "module" });
      const port: IdentityWorkerPort = {
        postMessage: request => worker.postMessage(request),
        terminate: () => worker.terminate(),
        onmessage: null, onerror: null, onmessageerror: null
      };
      worker.onmessage = event => port.onmessage?.({ data: event.data });
      worker.onerror = event => port.onerror?.({ message: event.message });
      worker.onmessageerror = () => port.onmessageerror?.();
      return port;
    });
    return browserInspect(format, value, stereoReference);
  }
  // Test-only Node transport, excluded from the web bundle. Desktop WebViews always have Worker.
  if (typeof process !== "undefined" && process.versions?.node) {
    const nodeEntry = "../test/identityNodeClient.mjs";
    const node: { inspectStructureOffThread: StructureInspector } =
      await import(/* @vite-ignore */ nodeEntry);
    return node.inspectStructureOffThread(format, value, stereoReference);
  }
  throw new Error("Chemical identity verification requires a module worker in this environment.");
};
