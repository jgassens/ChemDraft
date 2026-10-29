import { ensureRdkit } from "@chemdraft/rdkit-adapter";
import { registerRdkitWasmLoader } from "../rdkitWasmLoader";
import { inspectStructureInWorker } from "./identityInspect";
import type { IdentityReply, IdentityRequest } from "./identityProtocol";

export function startIdentityWorker(scope: {
  listen(listener: (event: MessageEvent<IdentityRequest>) => void): void;
  postMessage(reply: IdentityReply): void;
}): void {
  registerRdkitWasmLoader();
  const loaded = ensureRdkit();
  scope.listen(({ data: { id, value, stereoReference } }) => {
    void loaded.then(module => {
      scope.postMessage({ id, stage: "result",
        result: inspectStructureInWorker(module, value, stereoReference) });
    }).catch(error => {
      scope.postMessage({ id, stage: "error",
        message: error instanceof Error ? error.message : String(error) });
    });
  });
  void loaded.then(() => scope.postMessage({ id: 0, stage: "ready" })).catch(error => {
    setTimeout(() => { throw error; }, 0);
  });
}
