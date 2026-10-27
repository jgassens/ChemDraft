/** Start listening before entry evaluation ends; shared bindings stay in the runtime chunk. */
import { recordWorkerEntryEvaluation } from "./workers/entryEvaluation";
import { startAnalysisWorker } from "./analysisWorkerRuntime";
recordWorkerEntryEvaluation("analysis", import.meta.url);
startAnalysisWorker();
export type { AnalysisWorkRequest, AnalysisWorkResponse } from "./analysisWorkerRuntime";
