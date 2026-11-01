// ESM evaluates this dependency before the runtime's plugin dependencies, including nested workers.
import "./installWindowsWorkerShim";
import { recordWorkerEntryEvaluation } from "../../workers/entryEvaluation";
import { startMassFragmentWorker } from "../../workers/massFragmentRuntime";

recordWorkerEntryEvaluation("mass-fragment-windows", import.meta.url);
startMassFragmentWorker();

export {};
