import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { installNodeIsoSpecModuleLoader } from "@chemdraft/isospec-adapter/node";

import {
  setRdkitModuleLoader,
  type RdkitMinimalModule,
  type RdkitModuleLoader
} from "./conformer";

let realLoader: RdkitModuleLoader | undefined;

function cachedRealLoader(): RdkitModuleLoader {
  if (realLoader) return realLoader;

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

  realLoader = () => factory({
    locateFile: () => fileURLToPath(wasmUrl),
    wasmBinary
  });
  return realLoader;
}

/**
 * Install the vendored RDKit MinimalLib and IsoSpec WASM loaders for Node.js.
 *
 * The installation is process-wide and idempotent. Both engines remain lazy: this function reads
 * their bootstrap assets from disk, but the WASM modules are instantiated only when an adapter asks
 * its registered loader for an engine.
 */
export function installNodeRdkitModuleLoader(): void {
  installNodeIsoSpecModuleLoader();
  setRdkitModuleLoader(cachedRealLoader());
}
