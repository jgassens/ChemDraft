import type { DepictionRequestOptions, DepictionWorkerPort } from "@chemdraft/rdkit-adapter/depiction";
import type { PasteDepiction } from "./depict";

let browserDepict: ((smiles: string, options?: DepictionRequestOptions) => Promise<PasteDepiction>) | undefined;

/** No engine runs here. Worker failure never enables an in-thread fallback. */
export async function depictSmilesOffThread(smiles: string, options?: DepictionRequestOptions): Promise<PasteDepiction> {
  if (typeof Worker !== "undefined") {
    const { createDepictionWorkerClient } = await import("@chemdraft/rdkit-adapter/depiction");
    browserDepict ??= createDepictionWorkerClient<PasteDepiction>(() =>
      Object.assign(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }), {
        initializing: true
      }) as unknown as DepictionWorkerPort<PasteDepiction>);
    return browserDepict(smiles, options);
  }
  // Test-only Node transport, excluded from the web bundle. Desktop WebViews always have Worker.
  if (typeof process !== "undefined" && process.versions?.node) {
    const nodeEntry = "../test/depictionNodeClient.mjs";
    const node = await import(/* @vite-ignore */ nodeEntry) as {
      depictSmilesOffThread(smiles: string, options?: DepictionRequestOptions): Promise<PasteDepiction>;
    };
    return node.depictSmilesOffThread(smiles, options);
  }
  throw new Error("2D depiction requires a module worker in this environment.");
}
