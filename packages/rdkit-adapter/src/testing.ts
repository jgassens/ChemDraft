import { installNodeRdkitModuleLoader } from "./node";

/**
 * Point the adapter at the real WASM builds bundled under `vendor/`. Node-only: reads the Emscripten
 * glue and binaries from disk. Suites pair it with `resetRdkitForTesting()` in afterAll.
 *
 * Installs **both** engines an analysis run uses. The isotope envelope is one of the methods a default
 * run reports, and a suite that installed only RDKit would exercise its "engine unavailable" decline
 * on every structure while looking like full coverage.
 */
export function installRealRdkitModuleLoader(): void {
  installNodeRdkitModuleLoader();
}
