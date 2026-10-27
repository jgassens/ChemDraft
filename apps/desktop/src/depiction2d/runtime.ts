import { ensureRdkit, generateSmiles2DMolfile, type DepictionReply } from "@chemdraft/rdkit-adapter";
import { loadDepictionEngines, type DepictionEngineAvailability } from "@chemdraft/rdkit-adapter/depiction";
import { registerRdkitWasmLoader } from "../rdkitWasmLoader";
import { depictInWorker, type PasteDepiction } from "./depict";

type DepictionRequest = { id: number; smiles: string; standardOnly?: boolean };

/** Install the listener during entry evaluation, before any asynchronous engine loading. */
export function startDepictionWorker(): void {
  const scope = self as unknown as {
    onmessage: (event: MessageEvent<DepictionRequest>) => void;
    postMessage(reply: DepictionReply<PasteDepiction>): void;
  };
  const queue: DepictionRequest[] = [];
  let engines: DepictionEngineAvailability | undefined;
  let processing = false;

  async function drain(): Promise<void> {
    if (!engines || processing) return;
    processing = true;
    try {
      let request: DepictionRequest | undefined;
      while ((request = queue.shift())) {
        const { id, smiles, standardOnly } = request;
        try {
          const result = await depictInWorker(smiles, generateSmiles2DMolfile,
            (standard) => scope.postMessage({ id, stage: "standard", result: standard }), { standardOnly, ...engines });
          scope.postMessage({ id, stage: "result", result });
        } catch (error) {
          scope.postMessage({ id, stage: "error", message: error instanceof Error ? error.message : String(error),
            smilesChemistryRefusal: (error as { smilesChemistryRefusal?: boolean })?.smilesChemistryRefusal === true,
            notSmiles: (error as { notSmiles?: boolean })?.notSmiles === true });
        }
      }
    } finally { processing = false; }
  }

  scope.onmessage = ({ data }) => { queue.push(data); return drain(); };
  // Bootstrap includes engine fetch/compile/import; only layout starts after readiness.
  void loadDepictionEngines(async () => { registerRdkitWasmLoader(); await ensureRdkit(); },
    () => import("@chemdraft/ocl-adapter")).then(loaded => {
    engines = loaded;
    scope.postMessage({ id: 0, stage: "ready" });
    return drain();
  }).catch(error => {
    // Preserve a worker error on total bootstrap failure (and the client's load-failure path).
    // A rejected startup promise alone would only dispatch unhandledrejection in browsers.
    setTimeout(() => { throw error; }, 0);
  });
}
