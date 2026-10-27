import { ensureRdkit, generateSmiles2DMolfile, type DepictionReply } from "@chemdraft/rdkit-adapter";
import { loadDepictionEngines } from "@chemdraft/rdkit-adapter/depiction";
import { registerRdkitWasmLoader } from "../rdkitWasmLoader";
import { depictInWorker, type PasteDepiction } from "./depict";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<{ id: number; smiles: string; standardOnly?: boolean }>) => void;
  postMessage(reply: DepictionReply<PasteDepiction>): void;
};
// Bootstrap includes engine fetch/compile/import; only layout starts after readiness.
const engines = await loadDepictionEngines(async () => { registerRdkitWasmLoader(); await ensureRdkit(); },
  () => import("@chemdraft/ocl-adapter"));
scope.onmessage = async ({ data: { id, smiles, standardOnly } }) => {
  try {
    const result = await depictInWorker(smiles, generateSmiles2DMolfile,
      (standard) => scope.postMessage({ id, stage: "standard", result: standard }), { standardOnly, ...engines });
    scope.postMessage({ id, stage: "result", result });
  } catch (error) {
    scope.postMessage({ id, stage: "error", message: error instanceof Error ? error.message : String(error),
      smilesChemistryRefusal: (error as { smilesChemistryRefusal?: boolean })?.smilesChemistryRefusal === true,
      notSmiles: (error as { notSmiles?: boolean })?.notSmiles === true });
  }
};
scope.postMessage({ id: 0, stage: "ready" });
