/**
 * The plugin's Web Worker entry — what `pnpm plugin:package` bundles into the installable package's
 * `entry.js`, and the module a host runs when it loads this plugin from that package (ADR-0029, M35).
 *
 * A packageable plugin owns this file because only the plugin knows how to wire its own runtime: it
 * constructs whatever services its command handlers need and hands the finished registration to
 * {@link runPluginWorker}. (The mass analyzer is the simple baseline — it needs nothing. Contrast the
 * NMR predictor, which must first stand up its nested OpenChemLib worker.)
 *
 * The file stays inside the ADR-0028 SDK boundary: `@chemdraft/plugin-api` plus this plugin's own
 * relative modules, nothing else. It has a **top-level side effect** (it starts the worker runtime), so
 * it is deliberately not re-exported from `src/index.ts` — importing the plugin's public surface must
 * never start a worker runtime.
 */
import { runPluginWorker } from "@chemdraft/plugin-api";

import { massFragmentManifest } from "./manifest";
import { createMassRegistration } from "./register";

runPluginWorker({
  manifest: massFragmentManifest,
  commandHandlers: createMassRegistration().commandHandlers
});
