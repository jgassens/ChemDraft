import { recordWorkerEntryEvaluation } from "../workers/entryEvaluation";
import { startIdentityWorker } from "./identityRuntime";

recordWorkerEntryEvaluation("chemicalIdentity", import.meta.url);
startIdentityWorker({
  listen: listener => self.addEventListener("message", listener),
  postMessage: reply => self.postMessage(reply)
});
