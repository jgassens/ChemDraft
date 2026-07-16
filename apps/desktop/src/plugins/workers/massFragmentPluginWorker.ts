/**
 * Worker entry that hosts the bundled mass-fragment analyzer inside a per-plugin Web Worker
 * (ADR-0029, M34). Instantiated as `new Worker(new URL("./massFragmentPluginWorker.ts",
 * import.meta.url), { type: "module" })`, so Vite bundles it exactly like the conformer/NMR workers.
 *
 * The plugin's own source is imported unchanged and behind the single `@chemdraft/plugin-api` SDK
 * import ({@link runPluginWorker}); its command handler runs here, and every capability call it makes
 * (selection / analysis / panels) crosses back to the main thread over the versioned protocol. This is
 * the simple baseline: pure computation, no nested worker, no cancellation.
 */
import { runPluginWorker } from "@chemdraft/plugin-api";
import { createMassRegistration, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";

runPluginWorker({
  manifest: massFragmentManifest,
  commandHandlers: createMassRegistration().commandHandlers
});
