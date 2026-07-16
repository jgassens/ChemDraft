/**
 * The plugin's Web Worker entry — what `pnpm plugin:package` bundles into the installable package's
 * `entry.js`, and the module a host runs when it loads this plugin from that package (ADR-0029, M35).
 *
 * This is the hard case, and the reason the entry must belong to the *plugin* rather than to the
 * packaging tool: wiring this runtime is plugin-specific knowledge that no generic tool could infer.
 *
 *  1. **Nested worker.** `createNmrWorkerClient()` does `new Worker(new URL("./nmrWorker.ts",
 *     import.meta.url), { type: "module" })` *from inside this worker* — a worker spawning a worker,
 *     confirmed to run in the Tauri macOS WKWebView (M34, reports/0029). When this plugin is loaded
 *     from a built package, that URL resolves against **this module's own URL inside the package**, so
 *     the nested worker chunk and its reference database must be co-located siblings served from a real
 *     URL. That is exactly what `plugin:package`'s relative base (`base: "./"`) arranges, and what a
 *     blob-URL load would break. See reports/0030.
 *  2. **Panel-close cancellation across the boundary (ADR-0012).** `createNmrRegistration` owns the
 *     shared `AbortController`; its `onPanelClosed` runs here when the host forwards `panelClosed`, so a
 *     late result cannot revive a dismissed panel.
 *
 * The in-thread fallback mirrors the desktop's bundled entry: if a nested Worker cannot be created, the
 * OCL predictor runs in this same thread, lazily imported so its reference database stays a separate
 * chunk rather than being pulled into `entry.js`. The nested-worker verdict is reported from observed
 * evidence, never silently swallowed by this fallback.
 *
 * Stays inside the ADR-0028 SDK boundary (`@chemdraft/plugin-api` + this plugin's own relative modules).
 * It has a **top-level side effect** — it starts the worker runtime — so it is deliberately not
 * re-exported from `src/index.ts`.
 */
import { runPluginWorker } from "@chemdraft/plugin-api";

import { createWorkerBackedPredictor } from "./application/workerPredictor";
import type { NmrPredictor } from "./domain/contracts";
import { nmrPredictorManifest } from "./manifest";
import { createNmrRegistration } from "./register";
import { createNmrWorkerClient } from "./worker/nmrWorkerClient";

/** In-thread OCL predictor for the case where a nested Worker cannot be created here. The lazy dynamic
 *  import keeps the reference database in its own chunk, fetched only if this path is actually taken. */
function createLazyOclPredictor(): NmrPredictor {
  let loaded: Promise<NmrPredictor> | undefined;
  const load = (): Promise<NmrPredictor> =>
    (loaded ??= import("./providers/ocl/OclHosePredictor").then((module) => new module.OclHosePredictor()));
  return {
    getCapabilities: async () => (await load()).getCapabilities(),
    predict: async (request, signal) => (await load()).predict(request, signal)
  };
}

const nestedClient = createNmrWorkerClient();
const predictor: NmrPredictor = nestedClient ? createWorkerBackedPredictor(nestedClient) : createLazyOclPredictor();
const registration = createNmrRegistration({ predictor });

runPluginWorker({
  manifest: nmrPredictorManifest,
  commandHandlers: registration.commandHandlers,
  onPanelClosed: registration.onPanelClosed
});
