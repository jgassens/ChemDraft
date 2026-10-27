/** Bootstrap only; the runtime owns all engine bindings and readiness messages. */
import { recordWorkerEntryEvaluation } from "../workers/entryEvaluation";
import { startDepictionWorker } from "./runtime";
recordWorkerEntryEvaluation("depiction2d", import.meta.url);
startDepictionWorker();
