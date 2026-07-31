import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { installRealIsoSpecModuleLoader } from "@chemdraft/isospec-adapter/testing";

import { setRdkitModuleLoader, type RdkitMinimalModule } from "./conformer";

/**
 * Point the adapter at the real WASM builds bundled under `vendor/`. Node-only: reads the Emscripten
 * glue and binaries from disk. Suites pair it with `resetRdkitForTesting()` in afterAll.
 *
 * Installs **both** engines an analysis run uses. The isotope envelope is one of the methods a default
 * run reports, and a suite that installed only RDKit would exercise its "engine unavailable" decline
 * on every structure while looking like full coverage.
 */
export function installRealRdkitModuleLoader(): void {
  installRealIsoSpecModuleLoader();

  const glueUrl = new URL("../vendor/RDKit_minimal.js", import.meta.url);
  const wasmUrl = new URL("../vendor/RDKit_minimal.wasm", import.meta.url);
  const glueSource = readFileSync(glueUrl, "utf8");
  const wasmBinary = new Uint8Array(readFileSync(wasmUrl));
  const factory = new Function("require", "__dirname", `${glueSource}\n;return initRDKitModule;`)(
    createRequire(import.meta.url),
    dirname(fileURLToPath(glueUrl))
  ) as (options: {
    locateFile: (file: string) => string;
    wasmBinary: Uint8Array;
  }) => Promise<RdkitMinimalModule>;
  setRdkitModuleLoader(() => factory({
    locateFile: () => fileURLToPath(wasmUrl),
    wasmBinary
  }));
}
