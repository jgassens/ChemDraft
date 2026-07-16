/**
 * Worker entry that hosts the bundled NMR predictor inside a per-plugin Web Worker (ADR-0029, M34) —
 * the hard case. Instantiated as `new Worker(new URL("./nmrPredictorPluginWorker.ts",
 * import.meta.url), { type: "module" })` so Vite bundles it like the other workers.
 *
 * Two things make this the milestone's real test:
 *
 *  1. **Nested worker.** `createNmrWorkerClient()` does `new Worker(new URL("./nmrWorker.ts", ...))`
 *     *from inside this plugin worker* — a worker spawning a worker. Whether that runs in the Tauri
 *     webview is the single largest unknown M34 exists to answer. If a nested Worker cannot be created
 *     here, we fall back to running the OCL predictor in this same thread (lazy-loaded so its reference
 *     database is a separate chunk), so the feature still works; the nested-worker verdict is reported
 *     from a build/run observation, never silently swallowed by this fallback.
 *  2. **Panel-close cancellation across the boundary (ADR-0012).** `createNmrRegistration` owns the
 *     shared `AbortController`; its `onPanelClosed` runs here when the host forwards a `panelClosed`
 *     signal, aborting the in-flight prediction so a late result cannot revive a dismissed panel.
 */
import { runPluginWorker } from "@chemdraft/plugin-api";
import {
  createNmrRegistration,
  createNmrWorkerClient,
  createWorkerBackedPredictor,
  nmrPredictorManifest,
  type NmrPredictor
} from "@chemdraft/plugin-nmr-predictor";

/** In-thread OCL predictor for the case where a nested Worker cannot be created here. Lazy dynamic
 *  import keeps the ~800 KB reference database in its own chunk, fetched only if this path is taken. */
function createLazyOclPredictor(): NmrPredictor {
  let loaded: Promise<NmrPredictor> | undefined;
  const load = (): Promise<NmrPredictor> =>
    (loaded ??= import("@chemdraft/plugin-nmr-predictor").then((module) => new module.OclHosePredictor()));
  return {
    getCapabilities: async () => (await load()).getCapabilities(),
    predict: async (request, signal) => (await load()).predict(request, signal)
  };
}

// Spawn the plugin's OpenChemLib worker as a NESTED worker; fall back in-thread where unavailable.
const nestedClient = createNmrWorkerClient();
const predictor: NmrPredictor = nestedClient ? createWorkerBackedPredictor(nestedClient) : createLazyOclPredictor();
const registration = createNmrRegistration({ predictor });

runPluginWorker({
  manifest: nmrPredictorManifest,
  commandHandlers: registration.commandHandlers,
  onPanelClosed: registration.onPanelClosed
});
