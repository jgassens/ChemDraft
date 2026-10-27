/** Synchronous startup: WebKit can dispatch/drop jobs while a module's top-level await is pending.
 * Vite's worker manualChunks keeps shared bindings in the runtime, never this entry. */
import { recordWorkerEntryEvaluation } from "./workers/entryEvaluation";
import { startConformerWorker } from "./conformerWorkerRuntime";
recordWorkerEntryEvaluation("conformer", import.meta.url);
startConformerWorker();

// Type-only compatibility for existing clients; erased from emitted JavaScript.
export type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorkerShared";
