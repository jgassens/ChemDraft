/** Both platform entries load the same runtime, never another worker entry. */
import { recordWorkerEntryEvaluation } from "../../workers/entryEvaluation";
import { startMassFragmentWorker } from "../../workers/massFragmentRuntime";
recordWorkerEntryEvaluation("mass-fragment", import.meta.url);
startMassFragmentWorker();
